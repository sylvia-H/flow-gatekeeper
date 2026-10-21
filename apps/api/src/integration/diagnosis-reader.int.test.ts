import { randomBytes, randomUUID } from "node:crypto";
import { MongoClient } from "mongodb";
import type { Db } from "mongodb";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DiagnosisResultSchema } from "@flow-gatekeeper/contracts";
import { silenceNestLogger } from "../test-support/nest-logger.js";
import { loadApiDotenv } from "../lib/env-file.js";
import { AppConfigService } from "../modules/config/config.service.js";
import { HistoryService } from "../modules/history/history.service.js";

/**
 * 真 Mongo 整合測試：`HistoryService.findDiagnosisResult`（012 T033，GET `/diagnoses/:jobId` 的 Mongo 後援，P5）。
 * 以 worker `createMongoDiagnosisRepository().insertDiagnosis` 寫入的同一形狀（`{ machineId, jobId, cached, result,
 * createdAt }`）塞文件，確認 api 讀得回、且讀回的 `result` 通過 `DiagnosisResultSchema`；查無回 null。
 *
 * 隔離同 history.int.test.ts：每個測試一個 `flow-gatekeeper-int-<本輪隨機>-<序號>` 資料庫，測後 drop。
 */

loadApiDotenv();
const MONGO_URL = process.env.MONGO_URL?.trim() || "mongodb://127.0.0.1:27017";
const RUN_ID = randomBytes(4).toString("hex");
const UNREACHABLE_HINT =
  "無法連線 MongoDB（MONGO_URL）。請先在 repo 根目錄執行 `docker compose up -d`，" +
  "並以 `docker compose ps` 確認 mongo 為 healthy。";

const RESULT = {
  summary: "主軸溫度偏高",
  severity: "warning",
  likelyCauses: ["冷卻液不足"],
  suggestedActions: [{ label: "補充冷卻液", priority: "high" }],
  evidence: [{ source: "telemetry", excerpt: "temp=92" }],
};

describe.runIf(process.env.FG_INTEGRATION === "1")("HistoryService.findDiagnosisResult × 真 Mongo（整合）", () => {
  let client: MongoClient;
  let restoreLogger: () => void = () => undefined;
  const dbNames: string[] = [];
  const services: HistoryService[] = [];

  async function startService(): Promise<{ svc: HistoryService; db: Db }> {
    const name = `flow-gatekeeper-int-${RUN_ID}-reader-${dbNames.length}`;
    dbNames.push(name);
    vi.stubEnv("MONGO_URL", MONGO_URL);
    vi.stubEnv("MONGO_DB", name);
    vi.stubEnv("TELEMETRY_TTL_SECONDS", "3600");
    const svc = new HistoryService(new AppConfigService());
    services.push(svc);
    await svc.onModuleInit();
    return { svc, db: client.db(name) };
  }

  beforeAll(async () => {
    restoreLogger = silenceNestLogger();
    client = new MongoClient(MONGO_URL, { serverSelectionTimeoutMS: 3000 });
    try {
      await client.connect();
      await client.db("admin").command({ ping: 1 });
    } catch (err) {
      await client.close().catch(() => {});
      throw new Error(`${UNREACHABLE_HINT}\n原始錯誤：${err instanceof Error ? err.message : String(err)}`);
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    try {
      await Promise.all(services.map((s) => s.onModuleDestroy()));
      for (const name of dbNames) await client.db(name).dropDatabase();
    } finally {
      await client?.close();
      restoreLogger();
    }
  });

  it("讀回 worker 形狀文件的 result，且通過 DiagnosisResultSchema", async () => {
    const { svc, db } = await startService();
    const jobId = randomUUID();
    await db.collection("diagnoses").insertMany([
      { machineId: "cnc-01", jobId: randomUUID(), cached: false, result: { ...RESULT, summary: "別的 job" }, createdAt: new Date() },
      { machineId: "cnc-01", jobId, cached: false, result: RESULT, createdAt: new Date() },
    ]);

    const raw = await svc.findDiagnosisResult(jobId);
    expect(raw).toEqual(RESULT);
    expect(DiagnosisResultSchema.safeParse(raw).success).toBe(true);
  });

  it("查無此 jobId → null（collection 不存在時也一樣）", async () => {
    const { svc, db } = await startService();
    await expect(svc.findDiagnosisResult(randomUUID())).resolves.toBeNull();
    await db.collection("diagnoses").insertOne({ machineId: "cnc-01", jobId: randomUUID(), result: RESULT });
    await expect(svc.findDiagnosisResult(randomUUID())).resolves.toBeNull();
  });

  it("文件形狀不合法照原值回傳（驗證由呼叫端負責）", async () => {
    const { svc, db } = await startService();
    const jobId = randomUUID();
    await db.collection("diagnoses").insertOne({ machineId: "cnc-01", jobId, result: { summary: 1 } });
    const raw = await svc.findDiagnosisResult(jobId);
    expect(raw).toEqual({ summary: 1 });
    expect(DiagnosisResultSchema.safeParse(raw).success).toBe(false);
  });
});
