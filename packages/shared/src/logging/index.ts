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
): FlowLogger {
  const { level, invalidValue } = resolveLogLevel(env);
  const pretty = resolvePretty(env);
  const metricsLevel = resolveMetricsLogLevel(env);

  const logger = pino({
    level,
    base: { service },
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
  }) as FlowLogger;

  logger.metrics = logger.child({ context: "metrics" }, { level: metricsLevel });

  // FR-003：LOG_LEVEL 收到無法辨識的值時，MUST 於 logger 建立後立即輸出一則 warn（T011a）。
  // 職責邊界（analyze E3）：本函式只處理 LOG_LEVEL 這一則；METRICS_INTERVAL_MS 的下限回退
  // 警告歸屬各自呼叫端（api → config.service、worker → metrics-collector），不在此重複判斷，
  // 避免同一類判定散在兩處而重複輸出或雙方互推致漏輸出。
  if (invalidValue !== null) {
    logger.warn(
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
  MIN_METRICS_INTERVAL_MS,
  resolveMetricsInterval,
} from "./interval.js";
