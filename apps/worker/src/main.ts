import "dotenv/config";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "bullmq";
import type { Job } from "bullmq";
import { MongoClient } from "mongodb";
import type { Db } from "mongodb";
import { DIAGNOSIS_QUEUE } from "@flow-gatekeeper/contracts";
import type { AiStreamEvent, DiagnosisJobPayload, DiagnosisResult } from "@flow-gatekeeper/contracts";
import { createRedisConnection, redisConnectionOptions } from "./redis.js";
import type { Redis } from "ioredis";
import type { AiProvider } from "./ai/provider.js";
import { GeminiProvider } from "./ai/gemini-provider.js";
import { buildPrompt } from "./ai/prompt.js";
import { buildDiagnosisContext } from "./context/context-builder.js";
import { buildDiagnosisSignature } from "./cache/signature.js";
import { parseResult } from "./lib/parse-result.js";

/**
 * apps/worker entry（003）——BullMQ Worker 消化診斷 job（憲章 IV worker isolation）。
 *
 * 連線分離（憲章 IV／research D3）：`pub`（發布 token）／`cache`（cache/lock 一般 command）；
 * BullMQ queue 連線由 BullMQ 自管。流程（US1 compute + US2 cache/lock/limiter）：
 *   context → signature → cache 命中直接 ai/done(cached:true)；未命中取 `ai-lock` 去重
 *   → prompt → AiProvider 串流（token → Pub/Sub `ai-stream:<jobId>`）→ parseResult（失敗
 *   ai/error 並 throw）→ 寫 cache + diagnoses + diagnosisTriggers → ai/done(cached:false)。
 * import 保持 side-effect-free：僅在被直接執行時才 bootstrap（保 001 entry smoke）。
 */

const POLL_INTERVAL_MS = 300;

function log(level: "log" | "warn" | "error", msg: string): void {
  console[level === "log" ? "log" : level](`[worker] ${msg}`);
}

/** 發布 AI 串流事件到 Redis Pub/Sub（worker MUST NOT 直接 emit ws，憲章 IV）。 */
function publish(pub: Redis, jobId: string, event: AiStreamEvent): void {
  void pub.publish(`ai-stream:${jobId}`, JSON.stringify(event));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function writeTrigger(
  db: Db,
  machineId: string,
  jobId: string,
  requestedBy: string,
  cached: boolean,
): Promise<void> {
  await db
    .collection("diagnosisTriggers")
    .insertOne({ machineId, jobId, requestedBy, cached, createdAt: new Date() });
}

/** 建立 job processor（閉包持有 db／pub／cache／ai 與可調參數）。 */
function createProcessor(db: Db, pub: Redis, cache: Redis, ai: AiProvider) {
  const model = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
  const cacheTtl = Number(process.env.AI_CACHE_TTL_SECONDS ?? 600);
  const lockTtl = Number(process.env.AI_DEDUPE_LOCK_SECONDS ?? 45);
  const aiTimeoutMs = Number(process.env.AI_TIMEOUT_MS ?? 30000);

  return async (job: Job<DiagnosisJobPayload>): Promise<void> => {
    const { jobId, machineId, requestedBy, windowMinutes, promptVersion } = job.data;
    log("log", `job active: ${jobId} machine=${machineId}`);
    // FR-018 進度里程碑綁真實階段：0=job active、20=context 返回、40=取鎖將呼叫 LLM、
    // 60=首個 token、80=parseResult 成功、100=寫庫/快取（cached 直接 100）。
    await job.updateProgress(0);

    const context = await buildDiagnosisContext({ mongo: db, machineId, windowMinutes });
    await job.updateProgress(20);
    const sig = buildDiagnosisSignature({
      machineId,
      state: context.latestState,
      topErrorCodes: context.topErrorCodes,
      promptVersion,
      model,
    });
    const cacheKey = `ai-cache:${sig}`;
    const lockKey = `ai-lock:${sig}`;

    /** cache 命中：回 ai/done(cached:true)、記 trigger、**不**寫 diagnoses（FR-013/FR-013a）。 */
    const replyCached = async (): Promise<boolean> => {
      const raw = await cache.get(cacheKey);
      if (!raw) return false;
      const result = JSON.parse(raw) as DiagnosisResult;
      publish(pub, jobId, { type: "ai/done", jobId, cached: true, result });
      await writeTrigger(db, machineId, jobId, requestedBy, true);
      await job.updateProgress(100);
      log("log", `cache hit: ${jobId} sig=${sig}`);
      return true;
    };

    if (await replyCached()) return;

    // 「取鎖或等待」迴圈（SC-004 去重；F1：持鎖者逾時/崩潰後放行重算）。
    // lock TTL 保證進度：最遲於 lockTtl 後鎖過期，某 waiter 會搶到鎖改走計算路徑。
    const deadline = Date.now() + aiTimeoutMs + lockTtl * 1000 + 5000;
    for (;;) {
      const gotLock = await cache.set(lockKey, "1", "EX", lockTtl, "NX");
      if (gotLock) {
        try {
          await job.updateProgress(40);
          let seq = 0;
          // 首個 token 的 60 里程碑非致命：以 .catch 吞掉更新失敗、並保留 promise 供後續 await，
          // 確保 60 先於 80 落定（避免 fire-and-forget 與 await 80 交錯導致進度倒退）。
          let firstTokenProgress: Promise<void> = Promise.resolve();
          log("log", `LLM call: ${jobId} sig=${sig}`);
          const fullText = await ai.streamDiagnosis(
            buildPrompt({ machineId, context }),
            (text) => {
              const s = seq++;
              publish(pub, jobId, { type: "ai/token", jobId, seq: s, text });
              if (s === 0) firstTokenProgress = job.updateProgress(60).catch(() => {}); // 首個 token：真實進入串流
            },
          );

          let result: DiagnosisResult;
          try {
            result = parseResult(fullText);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            log("error", `schema invalid: ${jobId} ${message}`);
            publish(pub, jobId, { type: "ai/error", jobId, code: "schema_invalid", message });
            throw err; // 用盡 attempts 後由 failed handler（T026）通知
          }
          await firstTokenProgress; // 確保 60 里程碑先於 80 落定
          await job.updateProgress(80); // schema 解析成功

          await cache.set(cacheKey, JSON.stringify(result), "EX", cacheTtl);
          await db
            .collection("diagnoses")
            .insertOne({ machineId, jobId, cached: false, result, createdAt: new Date() });
          await writeTrigger(db, machineId, jobId, requestedBy, false);
          await job.updateProgress(100);
          publish(pub, jobId, { type: "ai/done", jobId, cached: false, result });
          log("log", `job completed: ${jobId}`);
        } finally {
          await cache.del(lockKey);
        }
        return;
      }

      // 取不到鎖：他人正在算 → 輪詢共用其結果。
      if (await replyCached()) return;
      if (Date.now() > deadline) {
        throw new Error(`dedupe wait exceeded for ${jobId}`); // 最終保護：交還 attempts 重試
      }
      await sleep(POLL_INTERVAL_MS);
      // 迴圈頂端重試 SET NX：若鎖已過期但 cache 仍空（持鎖者逾時/崩潰），本 waiter 搶到鎖改走
      // 計算路徑重算，未搶到者續輪詢——確保「放行重算」、不永久卡死（F1）。
    }
  };
}

export async function bootstrap(): Promise<void> {
  const mongoClient = new MongoClient(process.env.MONGO_URL ?? "mongodb://127.0.0.1:27017/flow-gatekeeper");
  await mongoClient.connect();
  const db = mongoClient.db(process.env.MONGO_DB ?? "flow-gatekeeper");
  await db.collection("diagnoses").createIndex({ machineId: 1, createdAt: -1 });
  await db.collection("diagnosisTriggers").createIndex({ machineId: 1, createdAt: -1 });

  // 連線分離（憲章 IV）：pub 發布、cache 一般 command；BullMQ queue 連線由 BullMQ 以 options 自管。
  const pub = createRedisConnection();
  const cache = createRedisConnection();

  const ai: AiProvider = new GeminiProvider(
    process.env.GEMINI_API_KEY ?? "",
    process.env.GEMINI_MODEL ?? "gemini-2.5-flash",
    Number(process.env.AI_TIMEOUT_MS ?? 30000),
  );

  const worker = new Worker<DiagnosisJobPayload>(DIAGNOSIS_QUEUE, createProcessor(db, pub, cache, ai), {
    connection: redisConnectionOptions(),
    concurrency: 2,
    limiter: { max: Number(process.env.AI_RPM ?? 8), duration: 60_000 },
  });

  worker.on("ready", () => log("log", `worker ready, consuming queue '${DIAGNOSIS_QUEUE}'`));

  // 失敗處理（US3）：僅在 attempts **用盡**（最終終態）後通知 ai/error（FR-020／US3 案例3）；
  // 尚有重試時只記 warn，交由 BullMQ 指數退避重試。
  worker.on("failed", (job, err) => {
    if (!job) return;
    const { jobId, machineId, requestedBy } = job.data;
    const attempts = job.opts.attempts ?? 1;
    if (job.attemptsMade >= attempts) {
      log("error", `job failed (final): ${jobId} ${err.message}`);
      publish(pub, jobId, { type: "ai/error", jobId, code: "worker_failed", message: err.message });
      // FR-013a：失敗（含重試用盡）也是一次觸發，補寫輕量稽核（cached:false），使每次觸發皆可追溯。
      void writeTrigger(db, machineId, jobId, requestedBy, false).catch((e) =>
        log("error", `failure trigger write failed for ${jobId}: ${e instanceof Error ? e.message : String(e)}`),
      );
    } else {
      log("warn", `job attempt failed (will retry): ${jobId} ${err.message}`);
    }
  });

  // 優雅關閉（US3）：worker.close → mongo.close → redis quit，確保崩潰/關閉不殘留、可被 BullMQ 重派。
  const shutdown = async (signal: string): Promise<void> => {
    log("log", `received ${signal}, shutting down worker...`);
    try {
      await worker.close();
      await mongoClient.close();
      await pub.quit();
      await cache.quit();
    } catch (err) {
      log("error", `shutdown error: ${err instanceof Error ? err.message : String(err)}`);
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  log("log", "flow-gatekeeper worker (003) bootstrapped");
}

// 僅在被直接執行時才啟動；被 import（含 001 entry smoke）時不產生副作用。
// 去 .js/.mjs/.cjs 副檔名再比對，兼容以無副檔名路徑啟動的執行器（與 api 對齊）。
const stripJs = (p: string): string => p.replace(/\.[cm]?js$/, "");
const invokedPath = process.argv[1] ? stripJs(resolve(process.argv[1])) : "";
if (invokedPath && stripJs(resolve(fileURLToPath(import.meta.url))) === invokedPath) {
  void bootstrap().catch((err: unknown) => {
    log("error", `bootstrap failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
