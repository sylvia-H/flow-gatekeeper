import "dotenv/config";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "bullmq";
import { MongoClient } from "mongodb";
import { DIAGNOSIS_QUEUE } from "@flow-gatekeeper/contracts";
import type { DiagnosisJobPayload } from "@flow-gatekeeper/contracts";
import { createLogger } from "@flow-gatekeeper/shared/logging";
import { bullmqConnectionOptions, createCommandConnection, waitForReady } from "./redis.js";
import type { AiProvider } from "./ai/provider.js";
import { GeminiProvider } from "./ai/gemini-provider.js";
import { createRedisStore } from "./cache/redis-store.js";
import { buildDiagnosisContext } from "./context/context-builder.js";
import { createMongoDiagnosisRepository, ensureDiagnosisIndexes } from "./diagnosis-repository.js";
import { armChaos, parseChaosConfig } from "./lib/chaos.js";
import { parseWorkerEnv } from "./lib/env-schema.js";
import { fatal } from "./lib/fatal.js";
import { startHeartbeat, stopHeartbeat } from "./lib/heartbeat.js";
import { createLivenessTracker } from "./lib/liveness.js";
import { createMetricsCollector } from "./lib/metrics-collector.js";
import { heartbeatKey, resolveInstanceId, workerMetricsKey } from "./lib/redis-keys.js";
import { createProcessor, isTerminalFailure } from "./processor.js";

/**
 * apps/worker entry（003）——BullMQ Worker 消化診斷 job（憲章 IV worker isolation）。
 *
 * 本檔只負責組裝：env 驗證 → 連線（Mongo、`pub`／`cache` 一般指令連線、BullMQ 自管連線）
 * → 依賴注入建立 processor（流程與重試語意見 `processor.ts`）→ 事件監聽與優雅關閉。
 * import 保持 side-effect-free：僅在被直接執行時才 bootstrap（保 001 entry smoke）。
 */

/** 啟動期等待 Redis 就緒的上限；超過即 fail-fast，交由監督者重啟。 */
const REDIS_READY_TIMEOUT_MS = 10_000;

export async function bootstrap(): Promise<void> {
  // 致命錯誤語意（007 let it crash）：未捕捉例外／未處理拒絕代表行程狀態未定義，
  // 記錄明確標示「致命」的訊息後**立即 exit(1)**、不嘗試收尾——重建交由監督者
  // （compose `restart: on-failure`）重啟後的乾淨行程；優雅關閉走 exit(0)、不觸發重啟。
  // 進行中與佇列中的 job 由 BullMQ 既有 stalled/attempts 機制重派，不需自行收尾。
  // 運維層契約（exit code／log 格式／演練旗標）見
  // specs/007-worker-process-supervision/contracts/supervision-runtime.md；
  // 雙模式差異（dev 直跑無監督者、致命後停在等待檔案變更）見 README「執行模式」章節。
  process.on("unhandledRejection", (reason) => fatal("unhandledRejection", reason));
  process.on("uncaughtException", (err) => fatal("uncaughtException", err));

  // env 必須最先驗：設定錯誤（空字串變 0、鎖 TTL 短於 AI 逾時）若放行，worker 會照樣啟動、
  // 照樣 healthy，直到 job 一筆筆失敗才被發現。啟動當下 exit 1 最容易查。
  // GEMINI_API_KEY 例外地永遠可選：缺席只記 warn，每筆診斷由 provider 立即以不可重試錯誤結束。
  const parsedEnv = parseWorkerEnv(process.env);
  if (!parsedEnv.ok) {
    fatal("invalidConfig", new Error(`環境變數不合法：${parsedEnv.error}`));
  }
  const env = parsedEnv.env;

  // logger 於 bootstrap() 內建立（而非模組頂層）：確保被單純 import（含 001 entry smoke）
  // 時不產生任何副作用（不建立 pino 實例、不觸發 pretty transport 的 worker thread）。
  const logger = createLogger("worker");
  const bootLogger = logger.child({ context: "bootstrap" });
  const heartbeatLogger = logger.child({ context: "heartbeat" });
  const chaosLogger = logger.child({ context: "chaos" });
  const shutdownLogger = logger.child({ context: "shutdown" });
  const processorLogger = logger.child({ context: "processor" });
  const redisLogger = logger.child({ context: "redis" });
  for (const w of parsedEnv.warnings) bootLogger.warn(w);

  // 逾時全數設上限：驅動預設 socketTimeoutMS 0（永不逾時），Mongo 掛住時 processor 會無限期
  // 佔住 concurrency 槽。socketTimeoutMS 需長於單一查詢的 maxTimeMS（context-builder 5s）。
  const mongoClient = new MongoClient(env.MONGO_URL, {
    serverSelectionTimeoutMS: 3000,
    socketTimeoutMS: 20_000,
  });
  await mongoClient.connect();
  const db = mongoClient.db(env.MONGO_DB);
  await ensureDiagnosisIndexes(db, bootLogger);

  // 連線分離（憲章 IV）：pub 發布、cache 一般 command；BullMQ 連線由 BullMQ 以 options 自管。
  // 這兩條是「斷線即 reject」的一般指令連線（見 redis.ts），必須等 ready 後才開始使用。
  const pub = createCommandConnection(env);
  const cache = createCommandConnection(env);
  // 沒掛 error 監聽時 ioredis 會把每次重連失敗印成未處理的 error 事件；這裡改走結構化日誌。
  pub.on("error", (err: Error) => redisLogger.warn({ err, conn: "pub" }, "Redis 連線錯誤"));
  cache.on("error", (err: Error) => redisLogger.warn({ err, conn: "cache" }, "Redis 連線錯誤"));
  await Promise.all([waitForReady(pub, REDIS_READY_TIMEOUT_MS), waitForReady(cache, REDIS_READY_TIMEOUT_MS)]);

  // 實例識別：heartbeat／metrics 快照都寫帶此後綴的 key，水平擴展時各副本互不掩蓋、互不覆寫。
  // healthcheck 以同一套 resolveInstanceId 推導，兩者必須一致。
  const instanceId = resolveInstanceId(env.WORKER_INSTANCE_ID);

  const ai: AiProvider = new GeminiProvider(env.GEMINI_API_KEY ?? "", env.GEMINI_MODEL);

  // 指標收集器：累加於記憶體，每 METRICS_INTERVAL_MS 結算一次——寫 Redis 快照
  // `metrics:worker:<instanceId>`（供 api 掃描合併廣播）並記一則 worker 自身的 metrics 摘要。摘要走
  // `logger.metrics`（level 由 METRICS_LOG_LEVEL 獨立釘定），LOG_LEVEL=warn 時不會被濾掉
  // （運維調低日誌等級時仍看得到指標）。掛既有 cache 連線；與 worker:heartbeat:<instanceId> 各自獨立、互不干涉。
  const metrics = createMetricsCollector({
    redis: cache,
    key: workerMetricsKey(instanceId),
    logger: logger.metrics,
  });
  metrics.start();

  // 處理槽活性：一次正常 job 的最長無進度區間約為「首 token 前的 LLM 等待（≤ AI_TIMEOUT_MS）」
  // 或單一 Mongo 查詢（≤ 5s），再加 30s 緩衝；超過代表槽真的卡住了。
  const liveness = createLivenessTracker({
    slots: env.WORKER_CONCURRENCY,
    stallMs: env.AI_TIMEOUT_MS + 30_000,
  });

  let closing = false;
  const worker = new Worker<DiagnosisJobPayload>(
    DIAGNOSIS_QUEUE,
    createProcessor({
      store: createRedisStore(cache),
      publisher: pub,
      repo: createMongoDiagnosisRepository(db),
      ai,
      buildContext: ({ machineId, windowMinutes }) => buildDiagnosisContext({ mongo: db, machineId, windowMinutes }),
      logger: processorLogger,
      metrics,
      config: {
        aiTimeoutMs: env.AI_TIMEOUT_MS,
        lockTtlSeconds: env.AI_DEDUPE_LOCK_SECONDS,
        cacheTtlSeconds: env.AI_CACHE_TTL_SECONDS,
        aiRpm: env.AI_RPM,
      },
      isClosing: () => closing,
      liveness,
    }),
    {
      connection: bullmqConnectionOptions(env),
      concurrency: env.WORKER_CONCURRENCY,
      // 刻意不設 BullMQ `limiter`：它計的是 job 啟動數（cache 命中、等待者、重試都吃額度），
      // 不是 LLM 呼叫數。LLM 限流改在 processor 取鎖後以 Redis 固定窗計數（AI_RPM）。
    },
  );

  // BullMQ 內部錯誤（連線中斷、腳本失敗）預設完全靜默；記下來才查得到「佇列為何不動」。
  worker.on("error", (err) => bootLogger.error({ err }, "BullMQ worker error"));

  worker.on("ready", () => {
    bootLogger.info({ queue: DIAGNOSIS_QUEUE }, "worker ready");
    // 存活訊號（供 compose healthcheck）：ready 後每 10s 寫 worker:heartbeat:<instanceId>（TTL 30s，掛既有 cache 連線）。
    // 事件迴圈被卡死時 timer 停擺、key 過期；所有處理槽都長時間無進度時也停止刷新
    // （liveness）→ compose healthcheck 轉 unhealthy（僅示警）。
    // ready 於連線重建時會重複觸發——startHeartbeat 冪等，重入只重設 timer。
    startHeartbeat(cache, heartbeatKey(instanceId), (msg) => heartbeatLogger.warn(msg), () => liveness.isAlive());
  });

  // 故障注入旗標：未設定＝關閉、零程式路徑差異；非法值 warn 後視為關閉。
  // 供 quickstart 場景 3/4 可重現演練「致命 → 重啟 → 恢復」，不改 code、不重建。
  // 硬防護：production 一律拒絕武裝——chaos 是測試專用機制，遺留在 production .env 會靜默
  // 造成崩潰迴圈（restart:on-failure:5 用盡後 worker 停擺）。演練請在非 production 環境進行。
  const chaos = parseChaosConfig(process.env);
  for (const w of chaos.warnings) chaosLogger.warn(w);
  if (chaos.config) {
    if (env.NODE_ENV === "production") {
      chaosLogger.error(
        { kind: chaos.config.kind, at: chaos.config.at },
        "WORKER_CHAOS 於 production 一律忽略（測試專用機制，勿留在 production .env）",
      );
    } else {
      armChaos(chaos.config, worker, (msg) => chaosLogger.warn(msg));
    }
  }

  // 失敗處理：對前端的最終通知由 api 經 QueueEvents `failed` 送 `ai/error(worker_failed)`——
  // worker 在這裡 publish 已到不了前端（api 收到 failed 即解除 jobId 綁定，此時才 PUBLISH 會被丟棄）。
  // AI 管線自身的終態錯誤已由 processor 在 throw 前送出。這裡只負責補寫最終失敗的 trigger。
  worker.on("failed", (job, err) => {
    if (!job) return;
    const { jobId, machineId, requestedBy } = job.data;
    const jl = processorLogger.child({ jobId, machineId, attempt: job.attemptsMade });
    if (isTerminalFailure(job, err)) {
      jl.error({ err }, "job failed (final)");
      // 失敗（含重試用盡、不可重試）也是一次觸發，補寫輕量稽核（cached:false），使每次觸發皆可追溯。
      void createMongoDiagnosisRepository(db)
        .insertTrigger({ machineId, jobId, requestedBy, cached: false })
        .catch((e: unknown) => jl.error({ err: e }, "failure trigger write failed"));
    } else {
      jl.warn({ err }, "job attempt failed (will retry)");
    }
  });

  // 優雅關閉：worker.close → mongo.close → redis quit，確保崩潰/關閉不殘留、可被 BullMQ 重派。
  const shutdown = async (signal: string): Promise<void> => {
    shutdownLogger.info({ signal }, "received signal, shutting down worker");
    // 先立旗標：dedupe 等待中的 job 看到後立刻交回佇列，worker.close() 只需等真正在打 LLM 的 job。
    closing = true;
    try {
      // 先 drain 在途 job 再停心跳：worker.close() 會等在途 job（含長串流）收尾，期間仍需
      // 持續寫 heartbeat，否則 key 於 TTL 過期、healthcheck 在正常優雅關閉途中誤翻 unhealthy。
      // 致命路徑不走這裡、不清 timer，key 靠 TTL 過期（data-model E2）。
      await worker.close();
      stopHeartbeat();
      // 指標 timer 與心跳同時停：關閉時**不輸出未滿一窗的殘窗摘要**——優雅關閉的日誌尾端
      // 出現一則低值摘要會被誤讀為系統異常（data-model E3）。
      metrics.stop();
      // 主動刪掉本實例的 key：優雅縮減副本時，healthcheck／api 不必再等 TTL 才發現這個實例已離開，
      // 殘留快照也不會被 api 加總。失敗只記 warn、不中斷後續收尾；崩潰路徑刪不到，由 TTL 與
      // api 端的過期快照過濾兜底。
      await cache
        .del(heartbeatKey(instanceId), workerMetricsKey(instanceId))
        .catch((err: unknown) => shutdownLogger.warn({ err }, "刪除本實例 heartbeat／metrics key 失敗"));
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

  bootLogger.info(
    { provider: ai.id, model: ai.model, concurrency: env.WORKER_CONCURRENCY, aiRpm: env.AI_RPM },
    "flow-gatekeeper worker (003) bootstrapped",
  );
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
