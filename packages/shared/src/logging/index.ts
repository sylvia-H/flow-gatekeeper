import pino from "pino";
import { resolveLogLevel, resolveMetricsLogLevel, resolvePretty } from "./level.js";

export type Service = "api" | "worker";

/**
 * 本 feature 的 logger：根 logger 綁定 `service`，並附帶一個**專屬的 metrics child logger**
 * （level 由 `METRICS_LOG_LEVEL` 獨立釘定，不受 `LOG_LEVEL` 影響，contracts/log-fields.md §5）。
 * 一般 context-bound child logger 直接用 pino 原生的 `.child({ context, ...關聯鍵 })`。
 */
export type FlowLogger = pino.Logger & {
  metrics: pino.Logger;
};

/**
 * 一般（非根）logger 的型別——`FlowLogger.child(...)` 或其子代的回傳型別。呼叫端（api/worker）
 * 若要把 context-bound logger 當參數傳遞（如 worker 的 `processorLogger`／`jl`），MUST 用此型別
 * 而非 `FlowLogger`——後者要求 `.metrics`，只有根 logger 才有。export 出來是為了讓 apps/worker
 * 不需直接依賴 `pino`（架構上僅透過本 package 存取，見 research R10 的子路徑隔離精神）。
 */
export type ChildLogger = pino.Logger;

/** 遮蔽值：取代 `command.args` 等祕密欄位。 */
export const REDACTED = "[redacted]";

/**
 * pino `redact` 路徑。ioredis 的 `ReplyError` 會把整條命令掛在 error 上
 * （`err.command = { name, args }`），AUTH 失敗（`WRONGPASS`／`NOAUTH`）時 `args` 就是
 * `REDIS_PASSWORD`；BullMQ 的 Lua 錯誤則帶整包 `evalsha` 參數。這些都不得進日誌。
 */
export const REDACT_PATHS: readonly string[] = [
  "err.command.args",
  "err.*.command.args",
  "*.err.command.args",
  "command.args",
  "*.command.args",
];

type SerializedError = ReturnType<typeof pino.stdSerializers.err>;

/**
 * 回傳剝掉 `command.args` 的**新**結構，只保留 `command.name`——命令名有助判讀（如 `auth`、
 * `evalsha`），參數可能是密碼或大量 Lua 參數。
 *
 * 走訪序列化結果的**所有**自有可列舉屬性，不只 `cause`／`aggregateErrors`：ioredis 的
 * `ClusterAllFailedError.lastNodeError` 這類巢狀 error 屬性同樣帶 `command.args`。
 *
 * 不改動任何既有物件：std serializer 會把 error 上的可列舉屬性（例如 plain object 的 `cause`）
 * 以**原參考**放進結果，就地修改會改到呼叫端的物件，故一律複製後再改。只複製陣列、plain object
 * 與序列化 error（`cloneable` 判定），原生 Error 先經標準序列化；Date、Buffer 等其他類別實例原樣保留
 * （複製會破壞其 `toJSON`）。
 * `seen` 記錄已處理的物件→副本，循環參考沿用同一副本，不會無窮遞迴。
 */
function stripCommandArgs(
  value: unknown,
  cloneable: (proto: unknown) => boolean,
  seen: Map<object, unknown>,
): unknown {
  if (typeof value !== "object" || value === null) return value;
  const done = seen.get(value);
  if (done !== undefined) return done;

  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    seen.set(value, copy);
    for (const item of value) copy.push(stripCommandArgs(item, cloneable, seen));
    return copy;
  }
  // 陣列或 plain object 裡的原生 Error（std serializer 只轉換 error 自身的直接屬性）：JSON 化時
  // 其可列舉屬性（含 `command`）照樣輸出，故先以標準序列化轉成 plain 形狀再處理。
  if (value instanceof Error) {
    const serialized: unknown = pino.stdSerializers.err(value);
    seen.set(value, serialized);
    const result = stripCommandArgs(serialized, cloneable, seen);
    seen.set(value, result);
    return result;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  if (!cloneable(proto)) return value;

  const copy = Object.create(proto as object | null) as Record<string, unknown>;
  seen.set(value, copy);
  for (const [key, child] of Object.entries(value)) {
    if (key === "command" && typeof child === "object" && child !== null && !Array.isArray(child)) {
      const name = (child as Record<string, unknown>).name;
      copy[key] = typeof name === "string" ? { name } : {};
    } else {
      copy[key] = stripCommandArgs(child, cloneable, seen);
    }
  }
  return copy;
}

/** pino 標準 err serializer 之上剝掉 `command.args`（標準版會複製 error 上所有可列舉屬性）。 */
function serializeError(err: Error): SerializedError {
  const serialized = pino.stdSerializers.err(err);
  // 非 Error-like 的輸入會被原樣回傳；不去改呼叫端自己的物件，交給 redact 路徑遮蔽。
  if (serialized === (err as unknown)) return serialized;
  const errProto: unknown = Object.getPrototypeOf(serialized);
  const cloneable = (proto: unknown): boolean =>
    proto === Object.prototype || proto === null || proto === errProto;
  return stripCommandArgs(serialized, cloneable, new Map()) as SerializedError;
}

/**
 * 建立本 feature 的結構化 logger（contracts/log-fields.md 為單一來源，FR-001/FR-002）。
 *
 * pretty 模式僅在 `pretty === true`（dev 預設）時才把 `pino-pretty` 交給 pino 的 transport
 * 機制載入；`pretty === false`（production 預設）路徑完全不觸碰該模組名稱，使其可安全留在
 * devDependency、不需隨 production image 一起部署（research R3；api/worker 的 Dockerfile
 * 皆以 `pnpm deploy --prod` 裁剪 devDependencies）。
 */
export function createLogger(
  service: Service,
  env: Record<string, string | undefined> = process.env,
  destination?: pino.DestinationStream,
): FlowLogger {
  const { level, invalidValue } = resolveLogLevel(env);
  const pretty = resolvePretty(env);
  const metricsLevel = resolveMetricsLogLevel(env);

  const options: pino.LoggerOptions = {
    level,
    base: { service },
    // `err` 欄位採 pino 標準序列化（type/message/stack，data-model E1）：Error 物件的
    // message/stack 非可列舉屬性，不設此 serializer 會被預設 JSON 化成空物件 `{}`。
    // 在標準序列化之上再剝掉 `command.args`（見 serializeError）。
    serializers: { err: serializeError },
    // 第二道防線：不經 `err` 鍵、而以其他鍵名或巢狀物件記下的 ioredis 錯誤／命令物件，
    // 其 `command.args` 一樣遮蔽（serializer 只作用在 `err` 鍵）。
    redact: { paths: [...REDACT_PATHS], censor: REDACTED },
    ...(pretty
      ? {
          transport: {
            target: "pino-pretty",
            options: {
              colorize: true,
              translateTime: "HH:MM:ss.l",
              ignore: "pid,hostname,service",
            },
          },
        }
      : {}),
  };
  // 自訂 destination 只在非 pretty 模式生效（pretty 走 transport，兩者 pino 不允許並用）；
  // 供測試捕捉輸出。
  const logger = (
    destination !== undefined && !pretty ? pino(options, destination) : pino(options)
  ) as FlowLogger;

  logger.metrics = logger.child({ context: "metrics" }, { level: metricsLevel });

  // FR-003：LOG_LEVEL 收到無法辨識的值時，MUST 於 logger 建立後立即輸出一則 warn（T011a）。
  // 職責邊界（analyze E3）：本函式只處理 LOG_LEVEL 這一則；METRICS_INTERVAL_MS 的下限回退
  // 警告歸屬各自呼叫端（api → config.service、worker → metrics-collector），不在此重複判斷，
  // 避免同一類判定散在兩處而重複輸出或雙方互推致漏輸出。
  if (invalidValue !== null) {
    // 走 child logger 綁 `context`：data-model E1 要求每筆日誌都有 `context` 欄位，
    // 此警告發生在任何呼叫端 child logger 建立之前，故在此自帶一個。
    logger.child({ context: "logger" }).warn(
      { invalidLogLevel: invalidValue, fallbackLevel: level },
      `LOG_LEVEL="${invalidValue}" 無法辨識，已回退至 "${level}"`,
    );
  }

  return logger;
}

export type { PinoLevel, ResolvedLogLevel } from "./level.js";
export { resolveLogLevel, resolveMetricsLogLevel, resolvePretty } from "./level.js";
export type { ResolvedMetricsInterval } from "./interval.js";
export {
  DEFAULT_METRICS_INTERVAL_MS,
  MAX_METRICS_INTERVAL_MS,
  MIN_METRICS_INTERVAL_MS,
  resolveMetricsInterval,
} from "./interval.js";
export type { ThrottleDecision } from "./throttle.js";
export { ConnectionErrorThrottle, ERROR_LOG_THROTTLE_MS, LogThrottle } from "./throttle.js";
