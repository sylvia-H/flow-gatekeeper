import { hostname } from "node:os";

/**
 * worker 寫入 Redis 的「每實例」key 集中處（heartbeat／metrics 快照）。
 *
 * 為什麼要帶實例識別：水平擴展 worker 時若共用單一 key，任一副本活著就會替其他已死的副本
 * 續命（healthcheck 永遠看得到新鮮心跳），指標快照也會互相覆寫、api 只讀得到 1/N 的數字。
 * 每個實例各寫各的 key，healthcheck 只看自己的，api 以 pattern 掃描後合併。
 *
 * 命名與 api 端 `WORKER_METRICS_PATTERN` 必須一致（目前兩端各持一份字串；集中到 contracts
 * 屬後續 feature 的範圍）。
 */

/** healthcheck 與主行程必須推導出同一個 id，否則探針永遠讀不到自己的心跳。 */
export function resolveInstanceId(
  configured: string | undefined,
  fallback: () => string = hostname,
): string {
  // 容器內 hostname 預設即 container id，天然唯一且在同一容器的探針與主行程間一致；
  // 本機同機多開時才需要以 WORKER_INSTANCE_ID 手動區分。
  return configured ?? fallback();
}

export function heartbeatKey(instanceId: string): string {
  return `worker:heartbeat:${instanceId}`;
}

export function workerMetricsKey(instanceId: string): string {
  return `metrics:worker:${instanceId}`;
}

/** api 以 SCAN MATCH 掃描所有實例快照時使用的 pattern。 */
export const WORKER_METRICS_PATTERN = "metrics:worker:*";
