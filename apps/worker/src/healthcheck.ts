import "dotenv/config";
import IORedis from "ioredis";
import { bullmqConnectionOptions } from "./redis.js";
import { parseRedisEnv } from "./lib/env-schema.js";
import { isHeartbeatFresh } from "./lib/heartbeat.js";
import { heartbeatKey, resolveInstanceId } from "./lib/redis-keys.js";

/**
 * compose healthcheck 進入點（007 US5；contracts/supervision-runtime.md §3–§4）。
 *
 * **獨立進入點、不 import main**（避免 bootstrap 副作用）：建短命 Redis 連線讀
 * `PTTL worker:heartbeat:<instanceId>` → fresh 則 exit 0、否則 exit 1。連線逾時／失敗一律 exit 1
 * （heartbeat 無法確認＝不健康）。整體以 watchdog 自我了斷，保證在 compose
 * `timeout: 5s` 內給出結果、不掛住探針。
 *
 * 只看**自己實例**的 key：探針與主行程在同一容器內，以同一套 `resolveInstanceId`
 * （WORKER_INSTANCE_ID ?? hostname）推導出相同 id。若改看任一實例的心跳，水平擴展時
 * 活著的副本會替已死的副本掩蓋 unhealthy。
 */

const WATCHDOG_MS = 4000;
setTimeout(() => process.exit(1), WATCHDOG_MS);

// 探針只驗 Redis 子集：Redis 設定不合法本身就代表不健康（parse 拋錯 → 浮空例外 → 非零退出）。
const redisEnv = parseRedisEnv(process.env);
const key = heartbeatKey(resolveInstanceId(redisEnv.WORKER_INSTANCE_ID));

const redis = new IORedis({
  ...bullmqConnectionOptions(redisEnv),
  connectTimeout: 3000,
  maxRetriesPerRequest: 1,
  retryStrategy: () => null, // 短命探針不重連：失敗即判不健康
});
redis.on("error", () => {
  /* 錯誤由 pttl 的 rejection 收束為 exit 1，這裡吞掉避免 error event 噪音 */
});

redis
  .pttl(key)
  .then((pttl) => process.exit(isHeartbeatFresh(pttl) ? 0 : 1))
  .catch(() => process.exit(1));
