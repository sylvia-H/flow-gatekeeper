import type { SystemMetrics, WorkerMetrics } from "@flow-gatekeeper/contracts";

/** api 自行掌握的那一半指標（`SystemMetrics` 去掉 `type` 與 worker 側）。 */
export type ApiMetricsPart = Omit<SystemMetrics, "type" | "worker">;

/** 數值或 null——`avgMs`／`p95Ms`／`maxMs`／`hitRate` 的共同型態（`null` ⟺ 樣本數為 0）。 */
function isNumberOrNull(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * 逐欄位驗證 worker 快照。**不用 Zod**：`WorkerMetrics` 依憲章 III 屬「型別分派用的傳輸形狀」，
 * 以 TS 型別為單一來源；此處只需一個對畸形輸入永不拋錯的守衛，不需要 schema 生態。
 */
function parseWorkerMetrics(value: unknown): WorkerMetrics | null {
  if (typeof value !== "object" || value === null) return null;
  const { snapshotAt, llmLatency, cache } = value as Record<string, unknown>;
  if (typeof snapshotAt !== "string") return null;

  if (typeof llmLatency !== "object" || llmLatency === null) return null;
  const { count, avgMs, p95Ms, maxMs } = llmLatency as Record<string, unknown>;
  if (!isCount(count) || !isNumberOrNull(avgMs) || !isNumberOrNull(p95Ms) || !isNumberOrNull(maxMs)) {
    return null;
  }

  if (typeof cache !== "object" || cache === null) return null;
  const { hits, misses, hitRate } = cache as Record<string, unknown>;
  if (!isCount(hits) || !isCount(misses) || !isNumberOrNull(hitRate)) return null;

  return {
    snapshotAt,
    llmLatency: { count, avgMs, p95Ms, maxMs },
    cache: { hits, misses, hitRate },
  };
}

/**
 * 合併 api 側指標與 Redis `metrics:worker` 快照，產出完整的 `system/metrics` payload
 * （009 FR-008、contracts/metrics-summary.md §5）。
 *
 * **降級規則**：key 不存在（`workerRaw === null`）、`JSON.parse` 失敗、欄位缺漏或型別不符，
 * 一律降級為 `worker: null` 並照常回傳完整結構——**MUST NOT 拋錯**。指標蒐集自身的故障
 * 不得中斷摘要輸出，否則「監控台自己不可被監控」的缺口會在最需要時重現（spec Edge Case
 * 「指標蒐集自身失敗」）。key 過期（worker 缺席逾 3 個週期）在此表現為 `workerRaw === null`。
 *
 * 純函式：不讀 Redis、不記日誌、不看時鐘——所有 I/O 與時間戳由呼叫端（MetricsService）提供。
 */
export function mergeMetrics(apiPart: ApiMetricsPart, workerRaw: string | null): SystemMetrics {
  let parsed: unknown = null;
  if (workerRaw !== null) {
    try {
      parsed = JSON.parse(workerRaw);
    } catch {
      parsed = null; // 畸形 JSON → 降級，不拋錯
    }
  }

  return {
    type: "system/metrics",
    windowMs: apiPart.windowMs,
    collectedAt: apiPart.collectedAt,
    queue: apiPart.queue,
    wsConnections: apiPart.wsConnections,
    worker: parseWorkerMetrics(parsed),
  };
}
