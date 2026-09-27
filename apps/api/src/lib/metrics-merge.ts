import { WorkerMetricsSchema } from "@flow-gatekeeper/contracts";
import type { SystemMetrics, WorkerMetrics } from "@flow-gatekeeper/contracts";

/** api 自行掌握的那一半指標（`SystemMetrics` 去掉 `type` 與 worker 側）。 */
export type ApiMetricsPart = Omit<SystemMetrics, "type" | "worker">;

/**
 * 以契約的 `WorkerMetricsSchema` 驗證 worker 快照；任何不符一律回 `null`，永不拋錯。
 * 快照跨 process 經 Redis 傳遞，形狀以 contracts 的 schema 為單一來源——api 不在此另寫
 * 一份平行的手工驗證，形狀變更只需改 contracts 一處，兩端同步生效。
 */
function parseWorkerMetrics(value: unknown): WorkerMetrics | null {
  const result = WorkerMetricsSchema.safeParse(value);
  return result.success ? result.data : null;
}

/**
 * 合併 api 側指標與 Redis `metrics:worker` 快照，產出完整的 `system/metrics` payload
 * （009 FR-008、contracts/metrics-summary.md §5）。
 *
 * **降級規則**：key 不存在（`workerRaw === null`）、`JSON.parse` 失敗、不符 `WorkerMetricsSchema`，
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
