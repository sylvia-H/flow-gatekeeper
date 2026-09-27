import { WorkerMetricsSchema } from "@flow-gatekeeper/contracts";
import type { SystemMetrics, WorkerMetrics } from "@flow-gatekeeper/contracts";

/** api 自行掌握的那一半指標（`SystemMetrics` 去掉 `type` 與 worker 側）。 */
export type ApiMetricsPart = Omit<SystemMetrics, "type" | "worker">;

/**
 * 解析單一 worker 實例的快照字串；key 不存在、`JSON.parse` 失敗、不符 `WorkerMetricsSchema`
 * 一律回 `null`，永不拋錯。
 *
 * 快照跨 process 經 Redis 傳遞，形狀以 contracts 的 schema 為單一來源——api 不在此另寫
 * 一份平行的手工驗證，形狀變更只需改 contracts 一處，兩端同步生效。
 */
export function parseWorkerSnapshot(raw: string | null): WorkerMetrics | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null; // 畸形 JSON → 略過，不拋錯
  }
  const result = WorkerMetricsSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

/** ISO 時間比較用；無法解析者視為最舊，避免一筆壞時間戳蓋掉其他實例的新鮮時間。 */
function timeOf(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
}

/**
 * 把多個 worker 實例的快照合併成單一 `WorkerMetrics`（契約形狀不變，面板與日誌讀者無感）。
 *
 * - `llmLatency.count`、`cache.hits`／`misses`：加總。
 * - `avgMs`：以各實例 `count` 加權平均（只納入 `count > 0` 者；各實例的 avg 已四捨五入，
 *   加權後再取整一次，誤差在 1ms 內）。
 * - `p95Ms`：取各實例 p95 的**最大值**——這是近似值。真正的合併 p95 需要原始樣本，快照只帶
 *   摘要；取最大值是保守上界（不會低估尾端延遲），對「是否有實例變慢」的判讀方向正確。
 * - `maxMs`：取最大值（精確）。
 * - `hitRate`：以加總後的 hits／misses 重新計算，分母 0 → `null`（不是各實例比值的平均，
 *   那會讓流量小的實例與流量大的實例同權）。
 * - `snapshotAt`：取最新，代表「最近一次有實例回報」。
 *
 * 零筆 → `null`，維持「worker 全數缺席時整塊降級」的既有語意。
 * 純函式：不讀 Redis、不看時鐘。
 */
export function mergeWorkerSnapshots(snapshots: readonly WorkerMetrics[]): WorkerMetrics | null {
  const [first] = snapshots;
  if (first === undefined) return null;
  // 單筆也走完整合併：WorkerMetricsSchema 不強制 count=0 ⟹ null，捷徑直接回傳會讓單實例與多實例
  // 對同一份自相矛盾的快照給出不同結果（前端把「沒有樣本」顯示成 0ms）。

  let count = 0;
  let weightedSum = 0;
  let weightedCount = 0;
  let p95Ms: number | null = null;
  let maxMs: number | null = null;
  let hits = 0;
  let misses = 0;
  let snapshotAt = first.snapshotAt;

  for (const s of snapshots) {
    const { llmLatency, cache } = s;
    count += llmLatency.count;
    if (llmLatency.count > 0 && llmLatency.avgMs !== null) {
      weightedSum += llmLatency.avgMs * llmLatency.count;
      weightedCount += llmLatency.count;
    }
    if (llmLatency.p95Ms !== null) p95Ms = p95Ms === null ? llmLatency.p95Ms : Math.max(p95Ms, llmLatency.p95Ms);
    if (llmLatency.maxMs !== null) maxMs = maxMs === null ? llmLatency.maxMs : Math.max(maxMs, llmLatency.maxMs);
    hits += cache.hits;
    misses += cache.misses;
    if (timeOf(s.snapshotAt) > timeOf(snapshotAt)) snapshotAt = s.snapshotAt;
  }

  // 契約不變量：count === 0 時三項統計 MUST 為 null（不是 0），即使某實例快照自相矛盾也不外洩。
  const empty = count === 0;
  const total = hits + misses;
  return {
    snapshotAt,
    llmLatency: {
      count,
      avgMs: empty || weightedCount === 0 ? null : Math.round(weightedSum / weightedCount),
      p95Ms: empty ? null : p95Ms,
      maxMs: empty ? null : maxMs,
    },
    cache: { hits, misses, hitRate: total === 0 ? null : hits / total },
  };
}

/**
 * 快照「新鮮」的容忍倍數：worker 每 windowMs 才刷新一次，api 讀到的正常年齡本就落在 0–1 個窗；
 * 漏寫一次（例如 Redis 瞬斷，command 連線會立刻 reject）年齡就落在 1–2 個窗。取 2.5 讓「漏一次」
 * 完整容忍，另留半個窗給時鐘偏差與排程抖動；仍短於 TTL（3 個窗），已消失實例的殘留快照會比 TTL
 * 更早被排除。
 */
export const STALE_SNAPSHOT_FACTOR = 2.5;

/**
 * 濾掉過期快照：`collectedAt - snapshotAt > 2.5 × windowMs` 者不計入。
 *
 * 為什麼不能只靠 TTL：快照 TTL 是 3 × 間隔，被重建或縮減掉的實例（容器 id 變了，舊 key 沒人刪）
 * 其最後一份快照會在這段期間持續被加總，數字偏高；而合併後 `snapshotAt` 取最新，又把它掩蓋掉。
 * TTL 保留原長度是為了「worker 暫時卡頓一兩個週期」時面板不致整塊消失——兩者目的不同，
 * 這裡以讀取端的時間窗收斂，不縮短 TTL。
 *
 * `snapshotAt` 無法解析者視為過期（無從證明新鮮）；`collectedAt` 無法解析時不過濾
 * （呼叫端的時間戳壞掉不該讓所有 worker 指標消失）。snapshotAt 略晚於 collectedAt
 * （跨主機時鐘偏差）視為新鮮。
 */
export function dropStaleSnapshots(
  snapshots: readonly WorkerMetrics[],
  collectedAt: string,
  windowMs: number,
): WorkerMetrics[] {
  const now = Date.parse(collectedAt);
  if (Number.isNaN(now)) return [...snapshots];
  const maxAgeMs = STALE_SNAPSHOT_FACTOR * windowMs;
  return snapshots.filter((s) => now - timeOf(s.snapshotAt) <= maxAgeMs);
}

/**
 * 合併 api 側指標與 Redis `metrics:worker:*` 各實例快照，產出完整的 `system/metrics` payload
 * （contracts/metrics-summary.md §5）。
 *
 * **降級規則**：個別快照不存在（SCAN 與 MGET 之間過期 → `null`）、`JSON.parse` 失敗、不符
 * `WorkerMetricsSchema` 者**逐筆略過**，不拖累其他實例；一筆有效快照都沒有時 `worker: null`，
 * 並照常回傳完整結構——**MUST NOT 拋錯**。指標蒐集自身的故障不得中斷摘要輸出，否則
 * 「監控台自己不可被監控」的缺口會在最需要時重現。快照過期（實例缺席逾 3 個週期）在此表現為
 * key 已不在掃描結果中；key 仍在但 `snapshotAt` 早於 2.5 個窗的快照（已消失實例的殘留）
 * 由 `dropStaleSnapshots` 排除，全部過期時同樣降級為 `worker: null`。
 *
 * 純函式：不讀 Redis、不記日誌、不看時鐘——所有 I/O 與時間戳由呼叫端（MetricsService）提供。
 */
export function mergeMetrics(apiPart: ApiMetricsPart, workerRaws: readonly (string | null)[]): SystemMetrics {
  const snapshots = workerRaws
    .map(parseWorkerSnapshot)
    .filter((s): s is WorkerMetrics => s !== null);
  const fresh = dropStaleSnapshots(snapshots, apiPart.collectedAt, apiPart.windowMs);

  return {
    type: "system/metrics",
    windowMs: apiPart.windowMs,
    collectedAt: apiPart.collectedAt,
    queue: apiPart.queue,
    wsConnections: apiPart.wsConnections,
    worker: mergeWorkerSnapshots(fresh),
  };
}
