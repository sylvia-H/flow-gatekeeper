import "dotenv/config";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "bullmq";
import type { Job } from "bullmq";
import { MongoClient } from "mongodb";
import type { Db } from "mongodb";
import { DIAGNOSIS_QUEUE } from "@flow-gatekeeper/contracts";
import type { AiStreamEvent, DiagnosisJobPayload, DiagnosisResult } from "@flow-gatekeeper/contracts";
import { createLogger } from "@flow-gatekeeper/shared/logging";
import type { ChildLogger } from "@flow-gatekeeper/shared/logging";
import { createRedisConnection, redisConnectionOptions } from "./redis.js";
import type { Redis } from "ioredis";
import type { AiProvider } from "./ai/provider.js";
import { GeminiProvider } from "./ai/gemini-provider.js";
import { buildPrompt } from "./ai/prompt.js";
import { buildDiagnosisContext } from "./context/context-builder.js";
import { buildDiagnosisSignature } from "./cache/signature.js";
import { armChaos, parseChaosConfig } from "./lib/chaos.js";
import { fatal } from "./lib/fatal.js";
import { startHeartbeat, stopHeartbeat } from "./lib/heartbeat.js";
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

/**
 * 發布 AI 串流事件到 Redis Pub/Sub（worker MUST NOT 直接 emit ws，憲章 IV）。
 * `jl` MUST 已綁定 `context: "processor"` 與 `jobId`（contracts/log-fields.md §2 規則 3）。
 */
function publish(pub: Redis, jobId: string, event: AiStreamEvent, jl: ChildLogger): void {
  // fire-and-forget，但在源頭接住 publish 失敗並記 log：單筆 token 發布失敗不該拖垮整個 worker
  // ——若放任成浮空 rejection，會觸發全域致命守門（let it crash → exit(1) 重啟），把 job 級
  // 小故障放大成行程級重啟。真正的 Redis 中斷會由後續被 await 的 cache 指令（get/set/del）
  // 拋出，走 processor 的 ai/error 與重試路徑收尾。
  void pub.publish(`ai-stream:${jobId}`, JSON.stringify(event)).catch((err: unknown) => {
    jl.warn({ eventType: event.type, err }, "publish 失敗");
  });
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

/** 建立 job processor（閉包持有 db／pub／cache／ai／logger 與可調參數）。 */
function createProcessor(db: Db, pub: Redis, cache: Redis, ai: AiProvider, processorLogger: ChildLogger) {
  const model = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
  const cacheTtl = Number(process.env.AI_CACHE_TTL_SECONDS ?? 600);
  const lockTtl = Number(process.env.AI_DEDUPE_LOCK_SECONDS ?? 45);
  const aiTimeoutMs = Number(process.env.AI_TIMEOUT_MS ?? 30000);

  return async (job: Job<DiagnosisJobPayload>): Promise<void> => {
    const { jobId, machineId, requestedBy, windowMinutes, promptVersion } = job.data;
    // 長流程以 child logger 綁定一次（contracts/log-fields.md §2 規則 3）：本次 job 生命週期
    // 內所有事件皆帶 jobId／machineId 結構化欄位，SC-002 的跨行程串接不需訊息字串子字串比對。
    const jl = processorLogger.child({ jobId, machineId });
    jl.info("job active");
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
      publish(pub, jobId, { type: "ai/done", jobId, cached: true, result }, jl);
      await writeTrigger(db, machineId, jobId, requestedBy, true);
      await job.updateProgress(100);
      jl.info({ sig }, "cache hit");
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
          jl.info({ sig }, "LLM call");
          const fullText = await ai.streamDiagnosis(
            buildPrompt({ machineId, context }),
            (text) => {
              const s = seq++;
              publish(pub, jobId, { type: "ai/token", jobId, seq: s, text }, jl);
              if (s === 0) firstTokenProgress = job.updateProgress(60).catch(() => {}); // 首個 token：真實進入串流
            },
          );

          let result: DiagnosisResult;
          try {
            result = parseResult(fullText);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            jl.error({ err }, "schema invalid");
            publish(pub, jobId, { type: "ai/error", jobId, code: "schema_invalid", message }, jl);
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
          publish(pub, jobId, { type: "ai/done", jobId, cached: false, result }, jl);
          jl.info("job completed");
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
  // logger 於 bootstrap() 內建立（而非模組頂層）：確保被單純 import（含 001 entry smoke）
  // 時不產生任何副作用（不建立 pino 實例、不觸發 pretty transport 的 worker thread）。
  const logger = createLogger("worker");
  const bootLogger = logger.child({ context: "bootstrap" });
  const heartbeatLogger = logger.child({ context: "heartbeat" });
  const chaosLogger = logger.child({ context: "chaos" });
  const shutdownLogger = logger.child({ context: "shutdown" });
  const processorLogger = logger.child({ context: "processor" });

  // 致命錯誤語意（007 let it crash）：未捕捉例外／未處理拒絕代表行程狀態未定義，
  // 記錄明確標示「致命」的訊息後**立即 exit(1)**、不嘗試收尾——重建交由監督者
  // （compose `restart: on-failure`）重啟後的乾淨行程；優雅關閉走 exit(0)、不觸發重啟。
  // 進行中與佇列中的 job 由 BullMQ 既有 stalled/attempts 機制重派（FR-005）。
  // 運維層契約（exit code／log 格式／演練旗標）見
  // specs/007-worker-process-supervision/contracts/supervision-runtime.md；
  // 雙模式差異（dev 直跑無監督者、致命後停在等待檔案變更）見 README「執行模式」章節。
  process.on("unhandledRejection", (reason) => fatal("unhandledRejection", reason));
  process.on("uncaughtException", (err) => fatal("uncaughtException", err));

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

  const worker = new Worker<DiagnosisJobPayload>(
    DIAGNOSIS_QUEUE,
    createProcessor(db, pub, cache, ai, processorLogger),
    {
      connection: redisConnectionOptions(),
      concurrency: 2,
      limiter: { max: Number(process.env.AI_RPM ?? 8), duration: 60_000 },
    },
  );

  worker.on("ready", () => {
    bootLogger.info({ queue: DIAGNOSIS_QUEUE }, "worker ready");
    // 存活訊號（FR-007）：ready 後每 10s 寫 worker:heartbeat（TTL 30s，掛既有 cache 連線）。
    // 事件迴圈被卡死時 timer 停擺、key 過期 → compose healthcheck 轉 unhealthy（僅示警）。
    // ready 於連線重建時會重複觸發——startHeartbeat 冪等，重入只重設 timer。
    startHeartbeat(cache, (msg) => heartbeatLogger.warn(msg));
  });

  // 故障注入旗標（FR-008）：未設定＝關閉、零程式路徑差異；非法值 warn 後視為關閉。
  // 供 quickstart 場景 3/4 可重現演練「致命 → 重啟 → 恢復」，不改 code、不重建。
  // 硬防護：production 一律拒絕武裝——chaos 是測試專用機制，遺留在 production .env 會靜默
  // 造成崩潰迴圈（restart:on-failure:5 用盡後 worker 停擺）。演練請在非 production 環境進行。
  const chaos = parseChaosConfig(process.env);
  for (const w of chaos.warnings) chaosLogger.warn(w);
  if (chaos.config) {
    if (process.env.NODE_ENV === "production") {
      chaosLogger.error(
        { kind: chaos.config.kind, at: chaos.config.at },
        "WORKER_CHAOS 於 production 一律忽略（測試專用機制，勿留在 production .env）",
      );
    } else {
      armChaos(chaos.config, worker, (msg) => chaosLogger.warn(msg));
    }
  }

  // 失敗處理（US3）：僅在 attempts **用盡**（最終終態）後通知 ai/error（FR-020／US3 案例3）；
  // 尚有重試時只記 warn，交由 BullMQ 指數退避重試。
  worker.on("failed", (job, err) => {
    if (!job) return;
    const { jobId, machineId, requestedBy } = job.data;
    const jl = processorLogger.child({ jobId, machineId });
    const attempts = job.opts.attempts ?? 1;
    if (job.attemptsMade >= attempts) {
      jl.error({ err }, "job failed (final)");
      publish(pub, jobId, { type: "ai/error", jobId, code: "worker_failed", message: err.message }, jl);
      // FR-013a：失敗（含重試用盡）也是一次觸發，補寫輕量稽核（cached:false），使每次觸發皆可追溯。
      void writeTrigger(db, machineId, jobId, requestedBy, false).catch((e: unknown) =>
        jl.error({ err: e }, "failure trigger write failed"),
      );
    } else {
      jl.warn({ err }, "job attempt failed (will retry)");
    }
  });

  // 優雅關閉（US3）：worker.close → mongo.close → redis quit，確保崩潰/關閉不殘留、可被 BullMQ 重派。
  const shutdown = async (signal: string): Promise<void> => {
    shutdownLogger.info({ signal }, "received signal, shutting down worker");
    try {
      // 先 drain 在途 job 再停心跳：worker.close() 會等在途 job（含長串流）收尾，期間仍需
      // 持續寫 heartbeat，否則 key 於 TTL 過期、healthcheck 在正常優雅關閉途中誤翻 unhealthy。
      // 致命路徑不走這裡、不清 timer，key 靠 TTL 過期（data-model E2）。
      await worker.close();
      stopHeartbeat();
      await mongoClient.close();
      await pub.quit();
      await cache.quit();
    } catch (err) {
      shutdownLogger.error({ err }, "shutdown error");
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  bootLogger.info("flow-gatekeeper worker (003) bootstrapped");
}

// 僅在被直接執行時才啟動；被 import（含 001 entry smoke）時不產生副作用。
// 去 .js/.mjs/.cjs 副檔名再比對，兼容以無副檔名路徑啟動的執行器（與 api 對齊）。
const stripJs = (p: string): string => p.replace(/\.[cm]?js$/, "");
const invokedPath = process.argv[1] ? stripJs(resolve(process.argv[1])) : "";
if (invokedPath && stripJs(resolve(fileURLToPath(import.meta.url))) === invokedPath) {
  void bootstrap().catch((err: unknown) => {
    // 僅在真正以 entry 執行且 bootstrap() 失敗時才建立 logger——維持模組 import 期
    // side-effect-free（不因單純 import 而建立 pino 實例／pretty transport worker thread）。
    createLogger("worker").child({ context: "bootstrap" }).error({ err }, "bootstrap failed");
    process.exit(1);
  });
}
