import IORedis from "ioredis";
import type { Redis, RedisOptions } from "ioredis";

/**
 * Redis 連線設定（單一來源）——host/port 取自 env，`maxRetriesPerRequest: null` 是 BullMQ
 * blocking 操作的要求（憲章 IV、research D3）。
 */
export function redisConnectionOptions(): RedisOptions {
  return {
    host: process.env.REDIS_HOST ?? "127.0.0.1",
    port: Number(process.env.REDIS_PORT ?? 6379),
    password: process.env.REDIS_PASSWORD || undefined,
    maxRetriesPerRequest: null,
  };
}

/**
 * Redis 連線工廠（憲章 IV、research D3）。
 *
 * worker main 以此產出**分離**的連線：`pub`（發布 token）／`cache`（cache/lock 一般
 * command）；BullMQ 的 queue 連線由 BullMQ 以 {@link redisConnectionOptions} 自管。連線分離
 * 避免 Pub/Sub 與一般 command 互相卡住。
 */
export function createRedisConnection(): Redis {
  return new IORedis(redisConnectionOptions());
}
