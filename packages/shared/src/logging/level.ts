import { isProductionEnv } from "../env.js";

/** pino 標準等級（不含自訂等級）。 */
export type PinoLevel = "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";

const VALID_LEVELS: readonly PinoLevel[] = [
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
  "silent",
];

export const DEFAULT_LOG_LEVEL: PinoLevel = "info";

export type ResolvedLogLevel = {
  level: PinoLevel;
  /** 非 null 表示收到的原始值無法辨識、已回退，呼叫端 MUST 記一則 warn（FR-003）。 */
  invalidValue: string | null;
};

/**
 * 解析 `LOG_LEVEL`：未設定回預設 `info`；無法辨識的值回退 `info` 並回報原始值供呼叫端記警告
 * （contracts/log-fields.md §4）。純函式，不輸出任何東西——輸出警告是 createLogger 的職責。
 */
export function resolveLogLevel(env: Record<string, string | undefined>): ResolvedLogLevel {
  const raw = env.LOG_LEVEL;
  if (raw === undefined || raw === "") {
    return { level: DEFAULT_LOG_LEVEL, invalidValue: null };
  }
  if ((VALID_LEVELS as readonly string[]).includes(raw)) {
    return { level: raw as PinoLevel, invalidValue: null };
  }
  return { level: DEFAULT_LOG_LEVEL, invalidValue: raw };
}

/**
 * 解析是否 pretty-print：`LOG_PRETTY` 可顯式覆寫（`"true"`/`"false"`）；
 * 未顯式設定時由 `NODE_ENV` 推導——非 production 預設 pretty，production 預設純 JSON（research R3）。
 */
export function resolvePretty(env: Record<string, string | undefined>): boolean {
  if (env.LOG_PRETTY === "true") return true;
  if (env.LOG_PRETTY === "false") return false;
  return !isProductionEnv(env.NODE_ENV);
}

/**
 * 解析指標摘要專屬等級：預設 `info`，獨立於 `LOG_LEVEL`（contracts/log-fields.md §5）。
 * 無法辨識的值靜默回退預設——此變數無獨立的 FR-003 式警告義務。
 */
export function resolveMetricsLogLevel(env: Record<string, string | undefined>): PinoLevel {
  const raw = env.METRICS_LOG_LEVEL;
  if (raw !== undefined && (VALID_LEVELS as readonly string[]).includes(raw)) {
    return raw as PinoLevel;
  }
  return DEFAULT_LOG_LEVEL;
}
