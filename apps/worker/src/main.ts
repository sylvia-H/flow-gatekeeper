import "dotenv/config";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "bullmq";
import type { Job } from "bullmq";
import { MongoClient } from "mongodb";
import type { Db } from "mongodb";
import { DIAGNOSIS_QUEUE } from "@flow-gatekeeper/contracts";
import type { AiStreamEvent, DiagnosisJobPayload } from "@flow-gatekeeper/contracts";
import { createRedisConnection, redisConnectionOptions } from "./redis.js";
import type { AiProvider } from "./ai/provider.js";
import { GeminiProvider } from "./ai/gemini-provider.js";
import { buildPrompt } from "./ai/prompt.js";
import { buildDiagnosisContext } from "./context/context-builder.js";
import { parseResult } from "./lib/parse-result.js";

/**
 * apps/worker entry（003）——BullMQ Worker 消化診斷 job（憲章 IV worker isolation）。
 *
 * 連線分離（憲章 IV／research D3）：`queueConnection`（BullMQ）／`pub`（發布 token）。
 * 流程（US1 compute path，**尚無 cache**——cache/lock 於 US2 T024 疊加）：
 *   context → prompt → AiProvider 串流（每 token → Pub/Sub `ai-stream:<jobId>`）
 *   → parseResult（失敗發 ai/error 並 throw）→ 寫 diagnoses+diagnosisTriggers → ai/done。
 * import 保持 side-effect-free：僅在被直接執行時才 bootstrap（保 001 entry smoke）。
 */

function log(level: "log" | "warn" | "error", msg: string): void {
  // worker 非 NestJS process，用 console 記錄（FR-019）。
  console[level === "log" ? "log" : level](`[worker] ${msg}`);
}

/** 發布 AI 串流事件到 Redis Pub/Sub（worker MUST NOT 直接 emit ws，憲章 IV）。 */
function publish(pub: ReturnType<typeof createRedisConnection>, jobId: string, event: AiStreamEvent): void {
  void pub.publish(`ai-stream:${jobId}`, JSON.stringify(event));
}

/** 建立 job processor（閉包持有 db／pub／ai）。 */
function createProcessor(db: Db, pub: ReturnType<typeof createRedisConnection>, ai: AiProvider) {
  return async (job: Job<DiagnosisJobPayload>): Promise<void> => {
    const { jobId, machineId, requestedBy, windowMinutes } = job.data;
    log("log", `job active: ${jobId} machine=${machineId}`);
    await job.updateProgress(5);

    const context = await buildDiagnosisContext({ mongo: db, machineId, windowMinutes });
    const prompt = buildPrompt({ machineId, context });
    await job.updateProgress(20);

    let seq = 0;
    log("log", `LLM call: ${jobId} (compute path, no cache)`);
    const fullText = await ai.streamDiagnosis(prompt, (text) => {
      publish(pub, jobId, { type: "ai/token", jobId, seq: seq++, text });
    });

    let result;
    try {
      result = parseResult(fullText);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log("error", `schema invalid: ${jobId} ${message}`);
      publish(pub, jobId, { type: "ai/error", jobId, code: "schema_invalid", message });
      throw err; // 讓 BullMQ 依 attempts 判定；用盡後由 failed handler（T026）通知
    }

    await db.collection("diagnoses").insertOne({ machineId, jobId, cached: false, result, createdAt: new Date() });
    await db
      .collection("diagnosisTriggers")
      .insertOne({ machineId, jobId, requestedBy, cached: false, createdAt: new Date() });
    await job.updateProgress(100);
    publish(pub, jobId, { type: "ai/done", jobId, cached: false, result });
    log("log", `job completed: ${jobId}`);
  };
}

export async function bootstrap(): Promise<void> {
  const mongoClient = new MongoClient(process.env.MONGO_URL ?? "mongodb://127.0.0.1:27017/flow-gatekeeper");
  await mongoClient.connect();
  const db = mongoClient.db(process.env.MONGO_DB ?? "flow-gatekeeper");
  await db.collection("diagnoses").createIndex({ machineId: 1, createdAt: -1 });
  await db.collection("diagnosisTriggers").createIndex({ machineId: 1, createdAt: -1 });

  // pub 為 worker 專用發布連線；BullMQ 的 queue 連線由 BullMQ 以 options 自管（連線分離，憲章 IV）。
  const pub = createRedisConnection();

  const ai: AiProvider = new GeminiProvider(
    process.env.GEMINI_API_KEY ?? "",
    process.env.GEMINI_MODEL ?? "gemini-2.5-flash",
    Number(process.env.AI_TIMEOUT_MS ?? 30000),
  );

  const worker = new Worker<DiagnosisJobPayload>(DIAGNOSIS_QUEUE, createProcessor(db, pub, ai), {
    connection: redisConnectionOptions(),
  });

  worker.on("ready", () => log("log", `worker ready, consuming queue '${DIAGNOSIS_QUEUE}'`));
  log("log", "flow-gatekeeper worker (003) bootstrapped");
}

// 僅在被直接執行時才啟動；被 import（含 001 entry smoke）時不產生副作用。
const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && resolve(fileURLToPath(import.meta.url)) === invokedPath) {
  void bootstrap().catch((err: unknown) => {
    log("error", `bootstrap failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
