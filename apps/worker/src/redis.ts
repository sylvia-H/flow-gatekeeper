import IORedis from "ioredis";
import type { Redis } from "ioredis";

/**
 * Redis 連線工廠（憲章 IV、research D3）。
 *
 * worker main 以此產出**分離**的連線：`queueConnection`（BullMQ）／`pub`（發布 token）／
 * `cache`（cache/lock 一般 command）。連線分離避免 Pub/Sub 與一般 command 互相卡住；
 * `maxRetriesPerRequest: null` 是 BullMQ blocking 操作的要求。
 */
export function createRedisConnection(): Redis {
  return new IORedis({
    host: process.env.REDIS_HOST ?? "127.0.0.1",
    port: Number(process.env.REDIS_PORT ?? 6379),
    password: process.env.REDIS_PASSWORD || undefined,
    maxRetriesPerRequest: null,
  });
}
