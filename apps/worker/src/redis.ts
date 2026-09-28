import IORedis from "ioredis";
import type { Redis, RedisOptions } from "ioredis";
import type { RedisEnv } from "./lib/env-schema.js";

/**
 * Redis 連線設定（單一來源，憲章 IV、research D3）。
 *
 * 兩種連線刻意分開設定：
 * - **BullMQ 連線**（Worker 內部的 blocking 指令）：BullMQ 要求 `maxRetriesPerRequest: null`，
 *   斷線時由它自己排隊重送。
 * - **一般指令連線**（`cache`／`pub`）：若也用 `null`，Redis 斷線時命令會無限排隊、永不 reject
 *   ——processor 就卡在 `await cache.get()`，走不到 `ai/error` 與重試路徑，佔住 concurrency 槽。
 *   因此改為有限重試 + `commandTimeout` + 關閉 offline queue：斷線時命令立即 reject。
 */

function baseOptions(env: RedisEnv): RedisOptions {
  return {
    host: env.REDIS_HOST,
    port: env.REDIS_PORT,
    password: env.REDIS_PASSWORD,
  };
}

/** BullMQ Worker／QueueEvents／subscriber 專用。 */
export function bullmqConnectionOptions(env: RedisEnv): RedisOptions {
  return { ...baseOptions(env), maxRetriesPerRequest: null };
}

/** cache／pub 等一般指令連線的設定（斷線時命令快速失敗）。 */
export function commandConnectionOptions(env: RedisEnv): RedisOptions {
  return {
    ...baseOptions(env),
    maxRetriesPerRequest: 3,
    commandTimeout: env.REDIS_COMMAND_TIMEOUT_MS,
    // 關閉 offline queue 的代價：連線尚未 ready 前送出的命令也會立即 reject，
    // 所以 bootstrap 必須先 `waitForReady()` 再開始用這條連線。
    enableOfflineQueue: false,
  };
}

/** 建立一般指令連線（worker main 產出分離的 `pub`／`cache`，避免 Pub/Sub 與一般 command 互卡）。 */
export function createCommandConnection(env: RedisEnv): Redis {
  return new IORedis(commandConnectionOptions(env));
}

/** 等連線進入 ready；逾時 reject（bootstrap 據此 fail-fast，而不是帶著半死連線啟動）。 */
export function waitForReady(redis: Redis, timeoutMs: number): Promise<void> {
  if (redis.status === "ready") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      redis.off("ready", onReady);
      reject(new Error(`Redis 連線於 ${timeoutMs}ms 內未就緒`));
    }, timeoutMs);
    const onReady = (): void => {
      clearTimeout(timer);
      resolve();
    };
    redis.once("ready", onReady);
  });
}
