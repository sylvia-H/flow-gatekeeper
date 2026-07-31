export const DEFAULT_HEALTH_PROBE_TIMEOUT_MS = 2_000;

export type ResolvedHealthProbeTimeout = {
  timeoutMs: number;
  /** true 表示原始設定值不合法、已回退預設，呼叫端 MUST 記一則 warn。 */
  fellBackToDefault: boolean;
  rawValue: string | undefined;
};

/**
 * 解析 `HEALTH_PROBE_TIMEOUT_MS`（contracts/health-endpoint.md §4，預設 2000ms）。
 *
 * 為什麼需要驗證而非裸 `Number()`：`??` 不會對空字串生效，`HEALTH_PROBE_TIMEOUT_MS=`（留空，
 * 這正是 `.env.example` 其他變數的常見寫法）會得到 `0`、非數值會得到 `NaN`——兩者都會讓
 * `HealthService.probe()` 的逾時 promise 立刻 reject，Redis／Mongo 永遠判 `down`、`/healthz`
 * 恆 503、容器永久 unhealthy。設定打錯字不該讓健康端點永遠說謊。
 *
 * 與 `resolveMetricsInterval` 同語意（回退預設而非 clamp），但**不設下限**：逾時多短是使用者
 * 對「多快算 down」的取捨，只要是有限正數就照用；不合法者一律回退預設。純函式，不輸出任何
 * 東西——輸出警告是呼叫端（`AppConfigService`）的職責。
 */
export function resolveHealthProbeTimeout(
  env: Record<string, string | undefined>,
): ResolvedHealthProbeTimeout {
  const raw = env.HEALTH_PROBE_TIMEOUT_MS;
  // 留空視同未設定（與 `resolveMetricsInterval` 一致）：沿用預設、不記警告。
  if (raw === undefined || raw === "") {
    return { timeoutMs: DEFAULT_HEALTH_PROBE_TIMEOUT_MS, fellBackToDefault: false, rawValue: raw };
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return { timeoutMs: DEFAULT_HEALTH_PROBE_TIMEOUT_MS, fellBackToDefault: true, rawValue: raw };
  }
  return { timeoutMs: parsed, fellBackToDefault: false, rawValue: raw };
}
