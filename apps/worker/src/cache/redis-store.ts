import type { Redis } from "ioredis";

/**
 * processor 對 Redis 的最小需求（cache-aside、去重鎖、LLM 限流窗）。
 *
 * 抽成介面而非直接吃 ioredis：processor 的並發語意（兩個 job 搶同一把鎖、持鎖者失敗換手）
 * 需要可決定性的單元測試，用 in-memory fake 實作這個介面即可，不必起真的 Redis。
 */
export interface ProcessorStore {
  get(key: string): Promise<string | null>;
  setWithTtl(key: string, value: string, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
  /** SET NX EX；取得回 true。`token` 是本持有者的唯一值，釋放時用來驗明正身。 */
  tryAcquireLock(key: string, token: string, ttlSeconds: number): Promise<boolean>;
  /** 只在鎖值仍等於 `token` 時刪除（回傳是否真的刪了）。 */
  releaseLock(key: string, token: string): Promise<boolean>;
  /** 固定窗計數：INCR，第一次建立時設 EXPIRE；回傳遞增後的值。 */
  incrementWindow(key: string, windowSeconds: number): Promise<number>;
}

/**
 * compare-and-del：GET 與 DEL 必須原子完成。若分兩步，持鎖者在 GET 之後、DEL 之前鎖剛好
 * 過期並被別人取得，DEL 就會刪掉別人的鎖——等於又放行一次重複的 LLM 呼叫。
 */
export const RELEASE_LOCK_SCRIPT = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;

/** INCR 與首次 EXPIRE 原子化：避免 INCR 成功後行程掛掉、key 永不過期而永久限流。 */
export const INCR_WINDOW_SCRIPT = `local n = redis.call("incr", KEYS[1]) if n == 1 then redis.call("expire", KEYS[1], ARGV[1]) end return n`;

/** 結構相依：只取 ProcessorStore 需要的 ioredis 指令，方便以假物件驗證送出的參數。 */
export type StoreRedis = Pick<Redis, "get" | "set" | "del" | "eval">;

export function createRedisStore(redis: StoreRedis): ProcessorStore {
  return {
    get: (key) => redis.get(key),
    async setWithTtl(key, value, ttlSeconds) {
      await redis.set(key, value, "EX", ttlSeconds);
    },
    async del(key) {
      await redis.del(key);
    },
    async tryAcquireLock(key, token, ttlSeconds) {
      return (await redis.set(key, token, "EX", ttlSeconds, "NX")) === "OK";
    },
    async releaseLock(key, token) {
      return Number(await redis.eval(RELEASE_LOCK_SCRIPT, 1, key, token)) === 1;
    },
    async incrementWindow(key, windowSeconds) {
      return Number(await redis.eval(INCR_WINDOW_SCRIPT, 1, key, String(windowSeconds)));
    },
  };
}
