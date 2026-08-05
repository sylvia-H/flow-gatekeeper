import type { WorkerMetrics } from "@flow-gatekeeper/contracts";

/** `WorkerMetrics["llmLatency"]` 的窗內統計（型別以契約為單一來源，憲章 III）。 */
export type LatencySummary = WorkerMetrics["llmLatency"];

/**
 * 窗內 LLM 延遲統計（009 US3／data-model E3）。
 *
 * **空樣本時三項統計值一律回 `null`，不是 0**——`0ms` 是「有樣本且極快」的語意，
 * 與「本窗沒有任何呼叫」完全不同。混用會讓面板與日誌把閒置誤讀為超高效能。
 *
 * `p95` 採最近秩（nearest-rank）：升冪排序後取第 `ceil(0.95 × n)` 個樣本（1-based），
 * 不做插值——樣本數小時插值會造出實際不存在的延遲值。
 *
 * 純函式：不改動傳入陣列（內部先複製再排序）。
 */
export function summarizeLatency(samples: readonly number[]): LatencySummary {
  const count = samples.length;
  if (count === 0) return { count: 0, avgMs: null, p95Ms: null, maxMs: null };

  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const rank = Math.ceil(0.95 * count); // 1-based；count ≥ 1 保證 rank ≥ 1
  return {
    count,
    avgMs: Math.round(sum / count),
    p95Ms: sorted[rank - 1] ?? null,
    maxMs: sorted[count - 1] ?? null,
  };
}
