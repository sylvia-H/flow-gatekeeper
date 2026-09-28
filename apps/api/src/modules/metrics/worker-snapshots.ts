/**
 * 讀取所有 worker 實例的指標快照原始字串（`metrics:worker:<instanceId>`）。
 *
 * worker 每個實例各寫一把帶實例後綴的 key（水平擴展時才不會互相覆寫、只剩 1/N），api 端
 * 因此必須先列舉再批次讀取。命名須與 worker 的 `lib/redis-keys.ts` 一致——目前兩端各持一份
 * 字串，集中到 contracts 屬後續 feature 的範圍。
 */
export const WORKER_METRICS_PATTERN = "metrics:worker:*";

/** 每次 SCAN 的建議批量：只是提示值，Redis 可能多回或少回。 */
const SCAN_COUNT = 100;

/** 最小結構相依：只需要 SCAN 與 MGET（ioredis `Redis` 結構上相容，測試可直接給假物件）。 */
export interface WorkerSnapshotRedis {
  scan(cursor: string, match: "MATCH", pattern: string, count: "COUNT", n: number): Promise<[string, string[]]>;
  mget(...keys: string[]): Promise<(string | null)[]>;
}

/**
 * 以 `SCAN` 游標分頁列舉 → 去重 → `MGET` 一次讀回。
 *
 * 為什麼用 SCAN 而不是 KEYS：KEYS 會在 Redis 單執行緒上一次走完整個 keyspace，BullMQ 佇列
 * 與 telemetry 相關 key 一多就會阻塞其他指令；SCAN 分批進行、每批成本有上限。
 * SCAN 語意允許同一 key 被回傳多次，故以 Set 去重，否則同一實例會被重複計入合併。
 * SCAN 與 MGET 之間 key 可能恰好過期 → 該筆為 `null`，交給合併端略過。
 * 錯誤直接拋給呼叫端（MetricsService 會降級為 `worker: null` 並記 warn）。
 */
export async function readWorkerSnapshots(
  redis: WorkerSnapshotRedis,
  pattern: string = WORKER_METRICS_PATTERN,
): Promise<(string | null)[]> {
  const keys = new Set<string>();
  let cursor = "0";
  do {
    const [next, batch] = await redis.scan(cursor, "MATCH", pattern, "COUNT", SCAN_COUNT);
    for (const k of batch) keys.add(k);
    cursor = next;
  } while (cursor !== "0");

  // MGET 不接受零個 key（Redis 會回 wrong number of arguments），沒有實例時直接回空陣列。
  if (keys.size === 0) return [];
  return redis.mget(...keys);
}
