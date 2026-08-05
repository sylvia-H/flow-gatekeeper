export type DependencyStatus = "up" | "down";

/** 單一依賴的探測結果（contracts/health-endpoint.md §3、data-model E2）。 */
export type DependencyProbe = {
  status: DependencyStatus;
  latencyMs: number | null;
  error: string | null;
};

export type HealthStatus = "healthy" | "unhealthy";

/**
 * 二態聚合（spec Clarifications）：全部依賴 `up` → `healthy`；任一 `down` → `unhealthy`。
 * 不設 degraded 中間態。純函式，對任意數量的依賴皆成立（呼叫端目前固定傳
 * `{ redis, mongo }` 兩項）。
 *
 * 不變量：回傳 `"unhealthy"` 若且唯若至少一個依賴 `status === "down"`——此不變量由 `every()`
 * 的語意保證成立，不需額外檢核（data-model E2）。
 */
export function aggregateHealth(
  dependencies: Readonly<Record<string, DependencyProbe>>,
): HealthStatus {
  const allUp = Object.values(dependencies).every((probe) => probe.status === "up");
  return allUp ? "healthy" : "unhealthy";
}
