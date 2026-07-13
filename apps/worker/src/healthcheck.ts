import "dotenv/config";
import IORedis from "ioredis";
import { redisConnectionOptions } from "./redis.js";
import { HEARTBEAT_KEY, isHeartbeatFresh } from "./lib/heartbeat.js";

/**
 * compose healthcheck 進入點（007 US5；contracts/supervision-runtime.md §3–§4）。
 *
 * **獨立進入點、不 import main**（避免 bootstrap 副作用）：建短命 Redis 連線讀
 * `PTTL worker:heartbeat` → fresh 則 exit 0、否則 exit 1。連線逾時／失敗一律 exit 1
 * （heartbeat 無法確認＝不健康）。整體以 watchdog 自我了斷，保證在 compose
 * `timeout: 5s` 內給出結果、不掛住探針。
 */

const WATCHDOG_MS = 4000;
setTimeout(() => process.exit(1), WATCHDOG_MS);

const redis = new IORedis({
  ...redisConnectionOptions(),
  connectTimeout: 3000,
  maxRetriesPerRequest: 1,
  retryStrategy: () => null, // 短命探針不重連：失敗即判不健康
});
redis.on("error", () => {
  /* 錯誤由 pttl 的 rejection 收束為 exit 1，這裡吞掉避免 error event 噪音 */
});

redis
  .pttl(HEARTBEAT_KEY)
  .then((pttl) => process.exit(isHeartbeatFresh(pttl) ? 0 : 1))
  .catch(() => process.exit(1));
