import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import IORedis from "ioredis";
import type { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AiStreamEvent, DiagnosisJobPayload, DiagnosisResult } from "@flow-gatekeeper/contracts";
import { PROMPT_VERSION } from "../ai/prompt.js";
import type { AiProvider, AiStreamRequest, AiStreamResult } from "../ai/provider.js";
import { createRedisStore } from "../cache/redis-store.js";
import type { ProcessorStore } from "../cache/redis-store.js";
import { buildDiagnosisSignature } from "../cache/signature.js";
import type { DiagnosisContext } from "../context/context-builder.js";
import type { DiagnosisRepository } from "../diagnosis-repository.js";
import { RedisEnvSchema } from "../lib/env-schema.js";
import { createProcessor } from "../processor.js";
import type { ProcessorJob, ProcessorLogger } from "../processor.js";

/**
 * 真 Redis 整合測試（第二輪審查報告 §6 Batch D；解前輪 §1.7「Lua 只驗送出參數」與 TQ-13
 * 「FakeStore 忽略 TTL」）。對象是 production 的 `createRedisStore`＋`createProcessor`，只把
 * Pub/Sub、Mongo、LLM 換成 in-memory fake。
 *
 * 隔離：獨立 db（預設 15，`INTEGRATION_REDIS_DB` 可改）＋本輪隨機 key prefix `int:<隨機>:`；
 * BullMQ 與正式資料都在 db 0，不會被碰到。結束時以 SCAN 刪掉本輪 prefix 下所有 key。
 * 連線參數沿用 worker 的 `RedisEnvSchema`（讀 `apps/worker/.env`，shell 既有值優先）。
 */

loadDotenv({ path: fileURLToPath(new URL("../../.env", import.meta.url)), quiet: true });
const env = RedisEnvSchema.parse(process.env);
const INTEGRATION_DB_RAW = process.env.INTEGRATION_REDIS_DB?.trim() ?? "";
/** 留空＝預設 15；其餘必須是 0–15 的整數（Redis 預設 16 個 db）。不合法時於 beforeAll 明確失敗，不靜默帶入 NaN。 */
const INTEGRATION_DB = INTEGRATION_DB_RAW === "" ? 15 : Number(INTEGRATION_DB_RAW);
const INTEGRATION_DB_VALID = Number.isInteger(INTEGRATION_DB) && INTEGRATION_DB >= 0 && INTEGRATION_DB <= 15;
const PREFIX = `int:${randomBytes(6).toString("hex")}:`;
const UNREACHABLE_HINT =
  `無法連線 Redis（${env.REDIS_HOST}:${env.REDIS_PORT}，db ${INTEGRATION_DB}）。請先在 repo 根目錄執行 ` +
  "`docker compose up -d`，並以 `docker compose ps` 確認 redis 為 healthy；" +
  "若 Redis 設了 requirepass，apps/worker/.env 的 REDIS_PASSWORD 須一致。";

const connections: Redis[] = [];

/** 開一條真實連線；`prefixed=false` 給清理與原始 key 驗證用。連不上即明確失敗（不 skip）。 */
async function connect(prefixed = true): Promise<Redis> {
  const redis = new IORedis({
    host: env.REDIS_HOST,
    port: env.REDIS_PORT,
    password: env.REDIS_PASSWORD,
    db: INTEGRATION_DB,
    ...(prefixed ? { keyPrefix: PREFIX } : {}),
    lazyConnect: true,
    connectTimeout: 3000,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });
  connections.push(redis);
  try {
    await redis.connect();
    await redis.ping();
  } catch (err) {
    throw new Error(`${UNREACHABLE_HINT}\n原始錯誤：${err instanceof Error ? err.message : String(err)}`);
  }
  return redis;
}

const VALID_RESULT: DiagnosisResult = {
  summary: "主軸振動偏高",
  severity: "warning",
  likelyCauses: ["軸承磨損"],
  suggestedActions: [{ label: "安排檢修", priority: "medium" }],
  evidence: [{ source: "telemetry", excerpt: "振動 max 9.1" }],
};

const silentLogger: ProcessorLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

class CollectingPublisher {
  readonly events: AiStreamEvent[] = [];
  async publish(_channel: string, message: string) {
    this.events.push(JSON.parse(message) as AiStreamEvent);
    return 1;
  }
}

class MemoryRepo implements DiagnosisRepository {
  readonly diagnoses: string[] = [];
  readonly triggers: { jobId: string; cached: boolean }[] = [];
  async insertDiagnosis(doc: { jobId: string }) {
    this.diagnoses.push(doc.jobId);
  }
  async insertTrigger(doc: { jobId: string; cached: boolean }) {
    this.triggers.push({ jobId: doc.jobId, cached: doc.cached });
  }
}

class ScriptedAi implements AiProvider {
  readonly id = "int-fake";
  readonly model = "int-fake-model";
  calls = 0;
  constructor(private readonly onCall: () => Promise<void> = async () => {}) {}
  async streamDiagnosis(req: AiStreamRequest): Promise<AiStreamResult> {
    this.calls += 1;
    await this.onCall();
    const text = JSON.stringify(VALID_RESULT);
    req.onToken(text);
    return { text, finishReason: "stop" };
  }
}

function contextFor(machineId: string): DiagnosisContext {
  return {
    machineId,
    windowMinutes: 5,
    latestState: "warning",
    telemetry: null,
    recentErrors: [],
    topErrorCodes: ["warning"],
    maintenance: [],
  };
}

function signatureFor(machineId: string, ai: AiProvider): string {
  const ctx = contextFor(machineId);
  return buildDiagnosisSignature({
    machineId,
    state: ctx.latestState,
    topErrorCodes: ctx.topErrorCodes,
    promptVersion: PROMPT_VERSION,
    providerId: ai.id,
    model: ai.model,
  });
}

function makeJob(jobId: string, machineId: string): ProcessorJob {
  const data: DiagnosisJobPayload = {
    jobId,
    machineId,
    requestedBy: "integration",
    requestedAt: new Date().toISOString(),
    windowMinutes: 5,
  };
  return {
    data,
    attemptsMade: 0,
    opts: { attempts: 3 },
    async updateProgress() {},
    async moveToDelayed() {},
  };
}

function buildProcessor(
  store: ProcessorStore,
  ai: AiProvider,
  opts: { cacheTtlSeconds: number; lockTtlSeconds: number },
) {
  const publisher = new CollectingPublisher();
  const repo = new MemoryRepo();
  const processor = createProcessor({
    store,
    publisher,
    repo,
    ai,
    buildContext: async ({ machineId }) => contextFor(machineId),
    logger: silentLogger,
    metrics: { recordCacheHit: () => {}, recordCacheMiss: () => {}, recordLatency: () => {} },
    config: {
      aiTimeoutMs: 5000,
      lockTtlSeconds: opts.lockTtlSeconds,
      cacheTtlSeconds: opts.cacheTtlSeconds,
      aiRpm: 1000,
      pollIntervalMs: 25,
    },
  });
  return { processor, publisher, repo };
}

/** SCAN 迴圈到 cursor 回 "0"：單輪 SCAN 不保證涵蓋所有符合的 key。 */
async function scanAll(redis: Redis, pattern: string): Promise<string[]> {
  const found: string[] = [];
  let cursor = "0";
  do {
    const [next, keys] = await redis.scan(cursor, "MATCH", pattern, "COUNT", 500);
    cursor = next;
    found.push(...keys);
  } while (cursor !== "0");
  return found;
}

/** 等到 key 真的過期（PTTL 回 -2），上限 `limitMs`；不用固定 sleep，避免負載高時假紅。 */
async function waitUntilExpired(redis: Redis, key: string, limitMs: number): Promise<void> {
  const deadline = Date.now() + limitMs;
  while ((await redis.pttl(key)) !== -2) {
    if (Date.now() > deadline) throw new Error(`${key} 未在 ${limitMs}ms 內過期`);
    await sleep(50);
  }
}

// FG_INTEGRATION 由 vitest.integration.config.ts 設定；被單元測試設定誤收時整組 skip（可見於報表），
// 不影響「由整合設定啟動卻連不上 infra → 明確失敗」的語意。
describe.runIf(process.env.FG_INTEGRATION === "1")("RedisStore × 真 Redis（整合）", () => {
  let a: Redis;
  let b: Redis;
  let raw: Redis;
  let storeA: ProcessorStore;
  let storeB: ProcessorStore;

  beforeAll(async () => {
    if (!INTEGRATION_DB_VALID) {
      throw new Error(`INTEGRATION_REDIS_DB="${INTEGRATION_DB_RAW}" 不合法：須為 0–15 的整數（留空＝15）。`);
    }
    // 兩條獨立連線模擬兩個 worker 副本；raw 不帶 prefix，用來驗證實際落地的 key 與清理。
    a = await connect();
    b = await connect();
    raw = await connect(false);
    storeA = createRedisStore(a);
    storeB = createRedisStore(b);
  });

  afterAll(async () => {
    try {
      if (raw?.status === "ready") {
        const keys = await scanAll(raw, `${PREFIX}*`);
        if (keys.length > 0) await raw.del(...keys);
      }
    } finally {
      await Promise.all(connections.map((c) => c.quit().catch(() => c.disconnect())));
    }
  });

  describe("(a) 取鎖與 Lua compare-and-del", () => {
    it("持有者能釋放；非持有者的 token 刪不掉鎖，鎖值維持原持有者", async () => {
      const key = `ai-lock:a-${randomUUID()}`;
      const owner = randomUUID();
      expect(await storeA.tryAcquireLock(key, owner, 30)).toBe(true);
      // 已被持有：同 key 再取（不論哪個副本）一律失敗。
      expect(await storeB.tryAcquireLock(key, randomUUID(), 30)).toBe(false);

      expect(await storeB.releaseLock(key, randomUUID())).toBe(false);
      expect(await raw.get(`${PREFIX}${key}`)).toBe(owner);

      expect(await storeA.releaseLock(key, owner)).toBe(true);
      expect(await raw.exists(`${PREFIX}${key}`)).toBe(0);
      // 已不存在時再釋放：回 false、不拋。
      expect(await storeA.releaseLock(key, owner)).toBe(false);
    });

    it("keyPrefix 會套到 EVAL 的 KEYS：Lua 操作的是帶前綴的 key，不會誤刪同名的無前綴 key", async () => {
      const key = `ai-lock:prefix-${randomUUID()}`;
      const token = randomUUID();
      // 在「無前綴」位置放一把同名、同值的鎖（位於本輪命名空間外，測後手動清）。
      await raw.set(key, token, "EX", 30);
      try {
        expect(await storeA.tryAcquireLock(key, token, 30)).toBe(true);
        expect(await storeA.releaseLock(key, token)).toBe(true);
        expect(await raw.get(key)).toBe(token);
      } finally {
        await raw.del(key);
      }
    });
  });

  describe("(b) 並發去重", () => {
    it("兩個副本各 10 個請求同時搶同一 signature 的鎖，恰好只有一個成功", async () => {
      const key = `ai-lock:b-${randomUUID()}`;
      const attempts = Array.from({ length: 20 }, (_, i) =>
        (i % 2 === 0 ? storeA : storeB).tryAcquireLock(key, `token-${i}`, 30),
      );
      const results = await Promise.all(attempts);
      expect(results.filter(Boolean)).toHaveLength(1);
      const winner = results.findIndex(Boolean);
      expect(await raw.get(`${PREFIX}${key}`)).toBe(`token-${winner}`);
    });

    it("兩個 processor（各自連線）同時處理同 signature 的 job：LLM 只被呼叫一次，另一個共用 cache 結果", async () => {
      const machineId = `int-m-${randomUUID()}`;
      // 持鎖者的 LLM 故意拖 400ms，確保另一個 job 必定落入「取不到鎖 → 輪詢 cache」路徑。
      const ai = new ScriptedAi(() => sleep(400));
      const p1 = buildProcessor(storeA, ai, { cacheTtlSeconds: 600, lockTtlSeconds: 45 });
      const p2 = buildProcessor(storeB, ai, { cacheTtlSeconds: 600, lockTtlSeconds: 45 });

      await Promise.all([
        p1.processor(makeJob(`job-${randomUUID()}`, machineId)),
        p2.processor(makeJob(`job-${randomUUID()}`, machineId)),
      ]);

      expect(ai.calls).toBe(1);
      const cachedFlags = [...p1.publisher.events, ...p2.publisher.events].flatMap((e) =>
        e.type === "ai/done" ? [e.cached] : [],
      );
      expect(cachedFlags.sort()).toEqual([false, true]);
      // diagnoses 只收真正由 LLM 產生的那一筆。
      expect(p1.repo.diagnoses.length + p2.repo.diagnoses.length).toBe(1);
      // 兩個 job 結束後鎖都已釋放。
      const sig = signatureFor(machineId, ai);
      expect(await raw.exists(`${PREFIX}ai-lock:${sig}`)).toBe(0);
    });
  });

  describe("(c) 鎖換手", () => {
    it("持鎖者的鎖 TTL 到期後等待者取得；原持有者遲到的釋放不會刪掉新持有者的鎖", async () => {
      const key = `ai-lock:c-${randomUUID()}`;
      const first = randomUUID();
      const second = randomUUID();
      expect(await storeA.tryAcquireLock(key, first, 1)).toBe(true);
      expect(await storeB.tryAcquireLock(key, second, 1)).toBe(false);

      await waitUntilExpired(raw, `${PREFIX}${key}`, 3000);

      expect(await storeB.tryAcquireLock(key, second, 30)).toBe(true);
      // 模擬「GET 與 DEL 非原子」會出事的時序：舊持有者此時才來釋放。
      expect(await storeA.releaseLock(key, first)).toBe(false);
      expect(await raw.get(`${PREFIX}${key}`)).toBe(second);
      expect(await storeB.releaseLock(key, second)).toBe(true);
    });
  });

  describe("(d) 限流窗 INCR＋首次 EXPIRE 原子", () => {
    it("兩個副本並發 25 次：回傳值恰為 1..25、窗口 key 有 TTL", async () => {
      const key = `ai-rpm:d-${randomUUID()}`;
      const results = await Promise.all(
        Array.from({ length: 25 }, (_, i) => (i % 2 === 0 ? storeA : storeB).incrementWindow(key, 120)),
      );
      expect([...results].sort((x, y) => x - y)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
      expect(await raw.get(`${PREFIX}${key}`)).toBe("25");
      const ttl = await raw.pttl(`${PREFIX}${key}`);
      expect(ttl).toBeGreaterThan(115_000);
      expect(ttl).toBeLessThanOrEqual(120_000);
    });

    it("只有首次 INCR 設 EXPIRE：後續呼叫不會把 TTL 往後推（窗口不會被持續延長）", async () => {
      const key = `ai-rpm:d2-${randomUUID()}`;
      expect(await storeA.incrementWindow(key, 120)).toBe(1);
      // 手動把剩餘 TTL 縮短到 5 秒，若後續 INCR 也 EXPIRE 就會被重設回 120 秒。
      await raw.pexpire(`${PREFIX}${key}`, 5000);
      expect(await storeB.incrementWindow(key, 120)).toBe(2);
      expect(await raw.pttl(`${PREFIX}${key}`)).toBeLessThanOrEqual(5000);
    });

    it("窗口 key 過期後重新計數，且新窗口重新帶 TTL", async () => {
      const key = `ai-rpm:d3-${randomUUID()}`;
      expect(await storeA.incrementWindow(key, 1)).toBe(1);
      expect(await storeA.incrementWindow(key, 1)).toBe(2);
      await waitUntilExpired(raw, `${PREFIX}${key}`, 3000);
      expect(await storeB.incrementWindow(key, 1)).toBe(1);
      expect(await raw.pttl(`${PREFIX}${key}`)).toBeGreaterThan(0);
    });
  });

  describe("(e) TQ-13：cache TTL 與 lock TTL 各自正確", () => {
    it("store 層：setWithTtl 與 tryAcquireLock 各自以傳入秒數設定 PTTL", async () => {
      const cacheKey = `ai-cache:e-${randomUUID()}`;
      const lockKey = `ai-lock:e-${randomUUID()}`;
      await storeA.setWithTtl(cacheKey, "{}", 600);
      await storeA.tryAcquireLock(lockKey, randomUUID(), 45);
      const cacheTtl = await raw.pttl(`${PREFIX}${cacheKey}`);
      const lockTtl = await raw.pttl(`${PREFIX}${lockKey}`);
      expect(cacheTtl).toBeGreaterThan(595_000);
      expect(cacheTtl).toBeLessThanOrEqual(600_000);
      expect(lockTtl).toBeGreaterThan(40_000);
      expect(lockTtl).toBeLessThanOrEqual(45_000);
    });

    it("processor 層：持鎖期間 lock PTTL ≈ lockTtlSeconds，完成後 cache PTTL ≈ cacheTtlSeconds（兩者不互換）", async () => {
      const machineId = `int-m-${randomUUID()}`;
      let lockTtlDuringCall = Number.NaN;
      let lockKeyRaw = "";
      const ai = new ScriptedAi(async () => {
        lockTtlDuringCall = await raw.pttl(lockKeyRaw);
      });
      const sig = signatureFor(machineId, ai);
      lockKeyRaw = `${PREFIX}ai-lock:${sig}`;
      const { processor, publisher } = buildProcessor(storeA, ai, { cacheTtlSeconds: 600, lockTtlSeconds: 45 });

      await processor(makeJob(`job-${randomUUID()}`, machineId));

      expect(ai.calls).toBe(1);
      expect(lockTtlDuringCall).toBeGreaterThan(40_000);
      expect(lockTtlDuringCall).toBeLessThanOrEqual(45_000);
      const cacheTtl = await raw.pttl(`${PREFIX}ai-cache:${sig}`);
      expect(cacheTtl).toBeGreaterThan(595_000);
      expect(cacheTtl).toBeLessThanOrEqual(600_000);
      expect(await raw.exists(lockKeyRaw)).toBe(0);
      // 限流窗 key 帶兩個窗長（120s）的 TTL。
      const rpmKeys = await scanAll(raw, `${PREFIX}ai-rpm:*`);
      const numericWindow = rpmKeys.find((k) => /ai-rpm:\d+$/.test(k));
      expect(numericWindow).toBeDefined();
      expect(await raw.pttl(numericWindow ?? "")).toBeGreaterThan(0);
      expect(await raw.pttl(numericWindow ?? "")).toBeLessThanOrEqual(120_000);
      expect(publisher.events.at(-1)).toMatchObject({ type: "ai/done", cached: false });
    });
  });

  describe("(f) cache 讀回畸形內容即 DEL", () => {
    it.each([
      ["非 JSON 字串", "{not-json"],
      ["合法 JSON 但不符 DiagnosisResultSchema", JSON.stringify({ summary: 42 })],
    ])("%s：processor 刪掉壞 cache、改打 LLM，並以合法結果覆寫", async (_label, garbage) => {
      const machineId = `int-m-${randomUUID()}`;
      let cacheExistsDuringCall = -1;
      let cacheKeyRaw = "";
      const ai = new ScriptedAi(async () => {
        cacheExistsDuringCall = await raw.exists(cacheKeyRaw);
      });
      const sig = signatureFor(machineId, ai);
      cacheKeyRaw = `${PREFIX}ai-cache:${sig}`;
      await raw.set(cacheKeyRaw, garbage, "EX", 600);
      const { processor, publisher } = buildProcessor(storeA, ai, { cacheTtlSeconds: 600, lockTtlSeconds: 45 });

      await processor(makeJob(`job-${randomUUID()}`, machineId));

      // 呼叫 LLM 當下壞 cache 已被刪除（safeParse 失敗 → DEL → 視為未命中）。
      expect(cacheExistsDuringCall).toBe(0);
      expect(ai.calls).toBe(1);
      const stored = await raw.get(cacheKeyRaw);
      expect(stored === null ? null : (JSON.parse(stored) as unknown)).toEqual(VALID_RESULT);
      expect(publisher.events.at(-1)).toMatchObject({ type: "ai/done", cached: false });
    });
  });
});
