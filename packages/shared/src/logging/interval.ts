export const DEFAULT_METRICS_INTERVAL_MS = 60_000;

/** 下限 5000ms（analyze/research R11 定案）——低於此值一律回退預設，而非 clamp 到下限。 */
export const MIN_METRICS_INTERVAL_MS = 5_000;

export type ResolvedMetricsInterval = {
  intervalMs: number;
  /** true 表示原始設定值不合法或低於下限、已回退預設，呼叫端 MUST 記一則 warn（FR-008）。 */
  fellBackToDefault: boolean;
  rawValue: string | undefined;
};

/**
 * 解析 `METRICS_INTERVAL_MS`：未設定回預設 60000ms；非數值、負數或低於下限 5000ms 的設定值
 * 一律**回退至預設值**（不是 clamp 到下限）——避免誤設落在邊界上，且與 FR-009（高頻路徑
 * 禁止逐筆日誌）相容。純函式，不輸出任何東西——輸出警告是呼叫端（api/worker 各自）的職責，
 * 見 tasks.md T042／T048（analyze E3：職責邊界收斂，避免與 createLogger 的 LOG_LEVEL 警告重疊）。
 */
export function resolveMetricsInterval(
  env: Record<string, string | undefined>,
): ResolvedMetricsInterval {
  const raw = env.METRICS_INTERVAL_MS;
  if (raw === undefined || raw === "") {
    return { intervalMs: DEFAULT_METRICS_INTERVAL_MS, fellBackToDefault: false, rawValue: raw };
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < MIN_METRICS_INTERVAL_MS) {
    return { intervalMs: DEFAULT_METRICS_INTERVAL_MS, fellBackToDefault: true, rawValue: raw };
  }
  return { intervalMs: parsed, fellBackToDefault: false, rawValue: raw };
}
