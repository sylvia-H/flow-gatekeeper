import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Queue, QueueEvents, Worker } from "bullmq";
import { config as loadDotenv } from "dotenv";
import IORedis from "ioredis";
import type { Redis, RedisOptions } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DiagnosisJobProgressSchema,
  DiagnosisJobReturnValueSchema,
} from "@flow-gatekeeper/contracts";
import type {
  DiagnosisJobPayload,
  DiagnosisJobReturnValue,
  DiagnosisResult,
} from "@flow-gatekeeper/contracts";
import { AiProviderError } from "../ai/provider.js";
import type { AiProvider, AiStreamRequest, AiStreamResult } from "../ai/provider.js";
import { createRedisStore } from "../cache/redis-store.js";
import type { DiagnosisContext } from "../context/context-builder.js";
import type { DiagnosisRepository } from "../diagnosis-repository.js";
import { LOCK_DURATION_MS, MAX_STALLED_COUNT, STALLED_INTERVAL_MS, WORKER_LOCK_OPTIONS } from "../lib/bullmq-options.js";
import { RedisEnvSchema } from "../lib/env-schema.js";
import { createProcessor } from "../processor.js";
import type { ProcessorLogger } from "../processor.js";
import { bullmqConnectionOptions } from "../redis.js";

/**
 * 真 BullMQ × QueueEvents 整合測試（012 T061；FR-001、FR-018、FR-020；SC-002、SC-009）。
 *
 * 驗的是「worker 送出的形狀經 BullMQ 真的到得了 api 端讀的位置」：processor 回傳值在 QueueEvents `completed` 的
 * `returnvalue` 讀回 `{ result, cached }`、`updateProgress` 物件在 `progress` 事件的 `data` 讀回
 * `{ value, attempt, execution }`；Worker 帶 `WORKER_LOCK_OPTIONS`（15／5／2）能正常啟動並處理 job。
 *
 * 隔離：獨立 db（預設 15，`INTEGRATION_REDIS_DB` 可改）＋本輪隨機的 BullMQ prefix 與 store keyPrefix；結束時
 * obliterate 佇列並 SCAN 刪掉本輪 key。Mongo、LLM、Pub/Sub 換成 in-memory fake。
 */

loadDotenv({ path: fileURLToPath(new URL("../../.env", import.meta.url)), quiet: true });
const env = RedisEnvSchema.parse(process.env);
const INTEGRATION_DB_RAW = process.env.INTEGRATION_REDIS_DB?.trim() ?? "";
const INTEGRATION_DB = INTEGRATION_DB_RAW === "" ? 15 : Number(INTEGRATION_DB_RAW);
const INTEGRATION_DB_VALID = Number.isInteger(INTEGRATION_DB) && INTEGRATION_DB >= 0 && INTEGRATION_DB <= 15;
const RUN_ID = randomBytes(6).toString("hex");
const BULL_PREFIX = `int-bull-${RUN_ID}`;
const STORE_PREFIX = `int:${RUN_ID}:`;
const QUEUE = `lifecycle-${RUN_ID}`;
const UNREACHABLE_HINT =
  `無法連線 Redis（${env.REDIS_HOST}:${env.REDIS_PORT}，db ${INTEGRATION_DB}）。請先在 repo 根目錄執行 ` +
  "`docker compose up -d`，並以 `docker compose ps` 確認 redis 為 healthy。";

/** processor 的 LLM 每分鐘上限（限流案例把窗計數預先填到這個值）。 */
const AI_RPM = 1000;

const VALID_RESULT: DiagnosisResult = {
  summary: "主軸振動偏高",
  severity: "warning",
  likelyCauses: ["軸承磨損"],
  suggestedActions: [{ label: "安排檢修", priority: "medium" }],
  evidence: [{ source: "telemetry", excerpt: "振動 max 9.1" }],
};

const CONTEXT: DiagnosisContext = {
  machineId: "int-press",
  windowMinutes: 5,
  latestState: "warning",
  telemetry: null,
  recentErrors: [],
  topErrorCodes: ["warning"],
  maintenance: [],
};

const silentLogger: ProcessorLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};

class MemoryRepo implements DiagnosisRepository {
  private readonly results = new Map<string, DiagnosisResult>();
  async insertDiagnosis(doc: { jobId: string; result: DiagnosisResult }) {
    if (!this.results.has(doc.jobId)) this.results.set(doc.jobId, doc.result);
  }
  async upsertTrigger() {}
  async findDiagnosisResult(jobId: string) {
    return this.results.get(jobId) ?? null;
  }
}

class OneShotAi implements AiProvider {
  readonly id = "int-lifecycle";
  readonly model = `int-lifecycle-${RUN_ID}`; // 每輪不同：不會命中前一輪留下的快取
  /** 接下來幾次呼叫以可重試的 provider 錯誤失敗（每次遞減）。 */
  failNext = 0;
  async streamDiagnosis(req: AiStreamRequest): Promise<AiStreamResult> {
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new AiProviderError("503 overloaded", { retryable: true, code: "provider_error" });
    }
    const text = JSON.stringify(VALID_RESULT);
    req.onToken(text.slice(0, 10));
    req.onToken(text.slice(10));
    return { text, finishReason: "stop" };
  }
}

describe.runIf(process.env.FG_INTEGRATION === "1")("BullMQ lifecycle × 真 Redis（整合）", () => {
  const connection: RedisOptions = { ...bullmqConnectionOptions(env), db: INTEGRATION_DB };
  let storeRedis: Redis;
  let queue: Queue<DiagnosisJobPayload, DiagnosisJobReturnValue>;
  let events: QueueEvents;
  let worker: Worker<DiagnosisJobPayload, DiagnosisJobReturnValue>;
  const ai = new OneShotAi();

  beforeAll(async () => {
    if (!INTEGRATION_DB_VALID) {
      throw new Error(`INTEGRATION_REDIS_DB="${INTEGRATION_DB_RAW}" 不合法：須為 0–15 的整數（留空＝15）。`);
    }
    storeRedis = new IORedis({
      ...connection,
      keyPrefix: STORE_PREFIX,
      maxRetriesPerRequest: 1,
      lazyConnect: true,
      connectTimeout: 3000,
      retryStrategy: () => null,
    });
    try {
      await storeRedis.connect();
      await storeRedis.ping();
    } catch (err) {
      throw new Error(`${UNREACHABLE_HINT}\n原始錯誤：${err instanceof Error ? err.message : String(err)}`);
    }
    queue = new Queue(QUEUE, { connection, prefix: BULL_PREFIX });
    events = new QueueEvents(QUEUE, { connection, prefix: BULL_PREFIX });
    await events.waitUntilReady();

    // Pub/Sub 不在本測試範圍：只要 PUBLISH 成功即可。
    const publisher = { publish: async () => 1 };
    worker = new Worker<DiagnosisJobPayload, DiagnosisJobReturnValue>(
      QUEUE,
      createProcessor({
        store: createRedisStore(storeRedis),
        publisher,
        repo: new MemoryRepo(),
        ai,
        buildContext: async () => CONTEXT,
        logger: silentLogger,
        metrics: { recordCacheHit: () => {}, recordCacheMiss: () => {}, recordLatency: () => {} },
        config: { aiTimeoutMs: 5000, lockTtlSeconds: 30, cacheTtlSeconds: 60, aiRpm: AI_RPM, pollIntervalMs: 50 },
      }),
      { connection, prefix: BULL_PREFIX, concurrency: 1, ...WORKER_LOCK_OPTIONS },
    );
    await worker.waitUntilReady();
  });

  afterAll(async () => {
    await worker?.close();
    await events?.close();
    if (queue) {
      await queue.obliterate({ force: true }).catch(() => {});
      await queue.close();
    }
    if (storeRedis?.status === "ready") {
      const raw = new IORedis({ ...connection, maxRetriesPerRequest: 1 });
      try {
        let cursor = "0";
        do {
          const [next, keys] = await raw.scan(cursor, "MATCH", `${STORE_PREFIX}*`, "COUNT", 500);
          cursor = next;
          if (keys.length > 0) await raw.del(...keys);
        } while (cursor !== "0");
      } finally {
        await raw.quit().catch(() => raw.disconnect());
      }
    }
    await storeRedis?.quit().catch(() => storeRedis.disconnect());
  });

  it("Worker 帶 WORKER_LOCK_OPTIONS 啟動：lockDuration／stalledInterval／maxStalledCount 為 15000／5000／2", () => {
    expect(worker.opts).toMatchObject({
      lockDuration: LOCK_DURATION_MS,
      stalledInterval: STALLED_INTERVAL_MS,
      maxStalledCount: MAX_STALLED_COUNT,
    });
    expect(worker.isRunning()).toBe(true);
  });

  it("completed 的 returnvalue 讀回 { result, cached }；progress 事件讀回 { value, attempt, execution }", async () => {
    const jobId = randomUUID();
    const progress: unknown[] = [];
    const onProgress = ({ jobId: id, data }: { jobId: string; data: unknown }) => {
      if (id === jobId) progress.push(data);
    };
    events.on("progress", onProgress);
    let onCompleted: ((args: { jobId: string; returnvalue: unknown }) => void) | undefined;
    const completed = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("等待 completed 逾時")), 20_000);
      onCompleted = ({ jobId: id, returnvalue }) => {
        if (id !== jobId) return;
        clearTimeout(timer);
        resolve(returnvalue);
      };
      events.on("completed", onCompleted);
    });

    await queue.add(
      "diagnose",
      { jobId, machineId: CONTEXT.machineId, requestedBy: "integration", requestedAt: new Date().toISOString(), windowMinutes: 5 },
      { jobId, attempts: 3 },
    );
    const returnvalue = await completed.finally(() => {
      if (onCompleted) events.off("completed", onCompleted);
    });
    events.off("progress", onProgress);

    expect(DiagnosisJobReturnValueSchema.parse(returnvalue)).toEqual({ result: VALID_RESULT, cached: false });
    const parsed = progress.map((p) => DiagnosisJobProgressSchema.parse(p));
    expect(parsed.map((p) => p.value)).toEqual([0, 20, 40, 60, 80, 100]);
    expect(parsed.every((p) => p.attempt === 1 && p.execution === 1)).toBe(true);

    // job hash 上同樣存的是物件與回傳值（api 的 GET 讀這裡）。
    const job = await queue.getJob(jobId);
    expect(DiagnosisJobProgressSchema.parse(job?.progress)).toMatchObject({ value: 100, attempt: 1, execution: 1 });
    expect(job?.returnvalue).toEqual({ result: VALID_RESULT, cached: false });
  });

  it("第 1 次嘗試拋錯、BullMQ 重試：第 2 次的 progress 為 { attempt: 2, execution: 2 }", async () => {
    const jobId = randomUUID();
    const progress: unknown[] = [];
    const onProgress = ({ jobId: id, data }: { jobId: string; data: unknown }) => {
      if (id === jobId) progress.push(data);
    };
    events.on("progress", onProgress);
    let onCompleted: ((args: { jobId: string; returnvalue: unknown }) => void) | undefined;
    const completed = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("等待 completed 逾時")), 20_000);
      onCompleted = ({ jobId: id, returnvalue }) => {
        if (id !== jobId) return;
        clearTimeout(timer);
        resolve(returnvalue);
      };
      events.on("completed", onCompleted);
    });

    ai.failNext = 1;
    await queue.add(
      "diagnose",
      // 不同 machineId → 不同簽章：不會命中上一條測試寫下的快取，第 1 次一定走到 LLM。
      { jobId, machineId: `int-retry-${RUN_ID}`, requestedBy: "integration", requestedAt: new Date().toISOString(), windowMinutes: 5 },
      { jobId, attempts: 2 },
    );
    const returnvalue = await completed.finally(() => {
      if (onCompleted) events.off("completed", onCompleted);
    });
    events.off("progress", onProgress);

    expect(DiagnosisJobReturnValueSchema.parse(returnvalue)).toEqual({ result: VALID_RESULT, cached: false });
    const parsed = progress.map((p) => DiagnosisJobProgressSchema.parse(p));
    const first = parsed.filter((p) => p.attempt === 1);
    const second = parsed.filter((p) => p.attempt === 2);
    expect(first.length).toBeGreaterThan(0);
    expect(first.every((p) => p.execution === 1)).toBe(true);
    expect(second.map((p) => p.value)).toEqual([0, 20, 40, 60, 80, 100]);
    expect(second.every((p) => p.execution === 2)).toBe(true);
  });

  it("限流延後（moveToDelayed，不消耗 attempt）後再執行：progress 為 { attempt: 1, execution: 2 }", async () => {
    const jobId = randomUUID();
    const progress: unknown[] = [];
    const onProgress = ({ jobId: id, data }: { jobId: string; data: unknown }) => {
      if (id === jobId) progress.push(data);
    };
    events.on("progress", onProgress);
    let onCompleted: ((args: { jobId: string; returnvalue: unknown }) => void) | undefined;
    const completed = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("等待 completed 逾時")), 30_000);
      onCompleted = ({ jobId: id, returnvalue }) => {
        if (id !== jobId) return;
        clearTimeout(timer);
        resolve(returnvalue);
      };
      events.on("completed", onCompleted);
    });
    let onDelayed: ((args: { jobId: string }) => void) | undefined;
    const delayed = new Promise<void>((resolve) => {
      onDelayed = ({ jobId: id }) => {
        if (id === jobId) resolve();
      };
      events.on("delayed", onDelayed);
    });

    // 本窗（與下一窗，防跨窗）的 LLM 計數先打滿：processor 取鎖後 INCR 超過 aiRpm → moveToDelayed 到下一窗。
    const windowIndex = Math.floor(Date.now() / 60_000);
    const windowKeys = [`ai-rpm:${windowIndex}`, `ai-rpm:${windowIndex + 1}`];
    for (const k of windowKeys) await storeRedis.set(k, String(AI_RPM), "EX", 120);

    await queue.add(
      "diagnose",
      { jobId, machineId: `int-delay-${RUN_ID}`, requestedBy: "integration", requestedAt: new Date().toISOString(), windowMinutes: 5 },
      { jobId, attempts: 2 },
    );
    await delayed;
    // 解除限流並立即提前執行（不必等到下一窗）。
    await storeRedis.del(...windowKeys);
    await (await queue.getJob(jobId))?.promote();

    const returnvalue = await completed.finally(() => {
      if (onCompleted) events.off("completed", onCompleted);
      if (onDelayed) events.off("delayed", onDelayed);
    });
    events.off("progress", onProgress);

    expect(DiagnosisJobReturnValueSchema.parse(returnvalue)).toEqual({ result: VALID_RESULT, cached: false });
    const parsed = progress.map((p) => DiagnosisJobProgressSchema.parse(p));
    expect(parsed.every((p) => p.attempt === 1)).toBe(true); // 延後不消耗 attempt
    const firstRun = parsed.filter((p) => p.execution === 1);
    const secondRun = parsed.filter((p) => p.execution === 2);
    expect(firstRun.length).toBeGreaterThan(0);
    expect(secondRun.map((p) => p.value)).toEqual([0, 20, 40, 60, 80, 100]);
  });
});
