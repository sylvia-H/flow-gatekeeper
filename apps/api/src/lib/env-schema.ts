import { z } from "zod";

/**
 * api 的環境變數 schema——啟動時一次驗證、設錯就拒絕啟動（fail-fast）。
 *
 * 為什麼不再用 `Number(process.env.X ?? d)`：`??` 對空字串不生效，而 `.env.example` 的常見寫法
 * 正是 `X=`（留空）。裸 `Number("")` 得 0、`Number("abc")` 得 NaN，兩者都會「靜默」變成災難：
 * `WS_HEARTBEAT_MS=0` 讓心跳 sweep 每 1ms 跑一次、所有連線秒斷；`MOCK_TELEMETRY_INTERVAL_MS=0`
 * 讓 Mongo 寫入放大數十倍；`API_PORT=abc` 則在 listen 時才以難懂的錯誤爆掉。與其讓服務帶著
 * 錯誤設定「看起來正常地」跑起來，不如在啟動當下說清楚哪個變數錯了。
 *
 * 語意：留空（含只有空白）一律視同未設定、套用預設值；有給值就必須合法，否則整體 parse 失敗。
 * 只涵蓋本檔列出的變數；`LOG_LEVEL`／`METRICS_INTERVAL_MS`／`HEALTH_PROBE_TIMEOUT_MS` 等 009
 * 變數維持各自 resolver 的「回退預設 + warn」語意（已有測試與文件承諾），不在此處改成拒絕啟動。
 */

/** 空字串先轉 undefined，讓 `.default()` 生效（`X=` 與「完全沒設」同義）。 */
function emptyToUndefined(value: unknown): unknown {
  return typeof value === "string" && value.trim() === "" ? undefined : value;
}

function positiveInt(defaultValue: number) {
  return z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(defaultValue));
}

/** Node `setTimeout`／`setInterval` 可接受的最大延遲；超過會退化成 1 ms。 */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * 心跳 sweep 間隔下限。sweep 會 terminate 上一輪沒回 pong 的連線，間隔過短時正常但稍慢的
 * client（行動網路、背景分頁）會被誤殺；1 秒已遠低於預設 15 秒，仍留得下一次 RTT。
 */
export const MIN_WS_HEARTBEAT_MS = 1_000;

/**
 * 遙測 tick 下限。README 明列「拉到 5ms 放大吞吐」為支援的 demo 設定，故下限取 5 而非更保守的值；
 * 低於 5ms（每秒 200 批以上）時 Gateway 廣播與 History buffer 的壓力已脫離設計量級。
 */
export const MIN_MOCK_TELEMETRY_INTERVAL_MS = 5;

/** 計時器間隔：整數、介於下限與 Node 計時器上限之間。 */
function timerInterval(defaultValue: number, min: number) {
  return z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(min).max(MAX_TIMER_DELAY_MS).default(defaultValue),
  );
}

function port(defaultValue: number) {
  return z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().positive().max(65_535).default(defaultValue),
  );
}

function stringWithDefault(defaultValue: string) {
  return z.preprocess(emptyToUndefined, z.string().default(defaultValue));
}

function optionalString() {
  return z.preprocess(emptyToUndefined, z.string().optional());
}

export const ApiEnvSchema = z.object({
  API_PORT: port(3000),
  MOCK_TELEMETRY_INTERVAL_MS: timerInterval(50, MIN_MOCK_TELEMETRY_INTERVAL_MS),
  WS_HEARTBEAT_MS: timerInterval(15_000, MIN_WS_HEARTBEAT_MS),
  /** 留空＝dev 開放訂閱（Gateway 僅在有設密鑰時才驗證 token）。 */
  WS_AUTH_SECRET: optionalString(),
  /** WS upgrade 的 Origin 白名單（逗號分隔）；留空＝不檢查。解析見 lib/ws-origin.ts。 */
  WS_ALLOWED_ORIGINS: optionalString(),
  MONGO_URL: stringWithDefault("mongodb://127.0.0.1:27017/flow-gatekeeper"),
  MONGO_DB: stringWithDefault("flow-gatekeeper"),
  TELEMETRY_TTL_SECONDS: positiveInt(604_800),
  REDIS_HOST: stringWithDefault("127.0.0.1"),
  REDIS_PORT: port(6379),
  /** 留空＝Redis 未啟用 requirepass；與 worker 讀同名變數，兩端必須一致。 */
  REDIS_PASSWORD: optionalString(),
});

export type ApiEnv = z.infer<typeof ApiEnvSchema>;

/** 錯誤訊息中不回顯原始值的變數（祕密不得出現在日誌或容器輸出）。 */
const SECRET_KEYS: ReadonlySet<string> = new Set(["WS_AUTH_SECRET", "REDIS_PASSWORD"]);

/**
 * 驗證並回傳型別化的 env。失敗時 throw 一個逐條列出「哪個變數、為什麼」的 Error——
 * 由 Nest 在建構 `AppConfigService` 時拋出，bootstrap 因此 reject，行程以非零退出碼收場，
 * 讓監督者（compose `restart: on-failure`）看得到這是設定錯誤而非正常關閉。
 */
export function parseApiEnv(env: Record<string, string | undefined>): ApiEnv {
  const result = ApiEnvSchema.safeParse(env);
  if (result.success) return result.data;

  const lines = result.error.issues.map((issue) => {
    const key = issue.path.join(".") || "(root)";
    const raw = typeof issue.path[0] === "string" ? env[issue.path[0]] : undefined;
    const received = SECRET_KEYS.has(key) || raw === undefined ? "" : `（收到 "${raw}"）`;
    return `  - ${key}：${issue.message}${received}`;
  });
  throw new Error(`api 環境變數設定錯誤，拒絕啟動：\n${lines.join("\n")}`);
}
