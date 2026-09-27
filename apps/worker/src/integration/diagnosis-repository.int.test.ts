import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { MongoClient } from "mongodb";
import type { Db } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DiagnosisResult } from "@flow-gatekeeper/contracts";
import {
  TRIGGER_TTL_SECONDS,
  createMongoDiagnosisRepository,
  ensureDiagnosisIndexes,
} from "../diagnosis-repository.js";
import type { IndexLogger } from "../diagnosis-repository.js";

/**
 * 真 Mongo 整合測試（第二輪審查報告 §6 Batch D：85／86／11000 退回與恢復路徑）。
 *
 * 隔離：每個測試一個獨立資料庫 `flow-gatekeeper-int-<本輪隨機>-<序號>`，afterAll 全數 dropDatabase；
 * 絕不碰 `MONGO_DB`（正式 `flow-gatekeeper`）。連線位址取 `MONGO_URL`（讀 `apps/worker/.env`，shell 優先），
 * 只用來連線、不用來選庫。
 */

loadDotenv({ path: fileURLToPath(new URL("../../.env", import.meta.url)), quiet: true });
const MONGO_URL = process.env.MONGO_URL?.trim() || "mongodb://127.0.0.1:27017";
const RUN_ID = randomBytes(4).toString("hex");
const UNREACHABLE_HINT =
  "無法連線 MongoDB（MONGO_URL）。請先在 repo 根目錄執行 `docker compose up -d`，" +
  "並以 `docker compose ps` 確認 mongo 為 healthy。";

const VALID_RESULT: DiagnosisResult = {
  summary: "主軸振動偏高",
  severity: "warning",
  likelyCauses: ["軸承磨損"],
  suggestedActions: [{ label: "安排檢修", priority: "medium" }],
  evidence: [{ source: "telemetry", excerpt: "振動 max 9.1" }],
};

class RecordingLogger implements IndexLogger {
  readonly errors: { obj: unknown; msg?: string }[] = [];
  error(obj: unknown, msg?: string) {
    this.errors.push({ obj, msg });
  }
}

type IndexInfo = { name?: string; key: Record<string, unknown>; unique?: boolean; expireAfterSeconds?: number };

async function jobIdIndex(db: Db): Promise<IndexInfo | undefined> {
  const all = (await db.collection("diagnoses").indexes()) as IndexInfo[];
  return all.find((i) => JSON.stringify(i.key) === JSON.stringify({ jobId: 1 }));
}

function errCode(obj: unknown): unknown {
  return (obj as { err?: { code?: unknown } } | null)?.err?.code;
}

describe.runIf(process.env.FG_INTEGRATION === "1")("diagnosis-repository × 真 Mongo（整合）", () => {
  let client: MongoClient;
  const dbNames: string[] = [];

  /** 每個測試一個全新資料庫。 */
  function freshDb(): Db {
    const name = `flow-gatekeeper-int-${RUN_ID}-${dbNames.length}`;
    dbNames.push(name);
    return client.db(name);
  }

  beforeAll(async () => {
    client = new MongoClient(MONGO_URL, { serverSelectionTimeoutMS: 3000 });
    try {
      await client.connect();
      await client.db("admin").command({ ping: 1 });
    } catch (err) {
      await client.close().catch(() => {});
      throw new Error(`${UNREACHABLE_HINT}\n原始錯誤：${err instanceof Error ? err.message : String(err)}`);
    }
  });

  afterAll(async () => {
    try {
      for (const name of dbNames) await client.db(name).dropDatabase();
    } finally {
      await client?.close();
    }
  });

  it("全新資料庫：建立 jobId unique、machineId+createdAt 與 diagnosisTriggers 的 TTL 索引，不記 error", async () => {
    const db = freshDb();
    const log = new RecordingLogger();
    await ensureDiagnosisIndexes(db, log);
    // 重跑一次（模擬重啟）仍冪等。
    await ensureDiagnosisIndexes(db, log);

    expect(log.errors).toEqual([]);
    expect((await jobIdIndex(db))?.unique).toBe(true);
    const diag = (await db.collection("diagnoses").indexes()) as IndexInfo[];
    expect(diag.some((i) => JSON.stringify(i.key) === JSON.stringify({ machineId: 1, createdAt: -1 }))).toBe(true);

    const triggers = (await db.collection("diagnosisTriggers").indexes()) as IndexInfo[];
    const ttl = triggers.find((i) => JSON.stringify(i.key) === JSON.stringify({ createdAt: 1 }));
    expect(ttl?.expireAfterSeconds).toBe(TRIGGER_TTL_SECONDS);
    expect(triggers.some((i) => JSON.stringify(i.key) === JSON.stringify({ machineId: 1, createdAt: -1 }))).toBe(true);
  });

  it("同 jobId 二次 insertDiagnosis：真的撞 11000，repository 視為成功、不覆寫、不拋", async () => {
    const db = freshDb();
    await ensureDiagnosisIndexes(db, new RecordingLogger());
    const repo = createMongoDiagnosisRepository(db);
    const jobId = `job-${randomUUID()}`;

    await repo.insertDiagnosis({ machineId: "press-01", jobId, result: VALID_RESULT });
    // 先確認底層確實回 11000（不是 repository 自己吞了別的錯）。
    await expect(db.collection("diagnoses").insertOne({ jobId })).rejects.toMatchObject({ code: 11000 });
    await expect(
      repo.insertDiagnosis({ machineId: "press-01", jobId, result: { ...VALID_RESULT, summary: "第二次" } }),
    ).resolves.toBeUndefined();

    const docs = await db.collection("diagnoses").find({ jobId }).toArray();
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ machineId: "press-01", cached: false, result: { summary: VALID_RESULT.summary } });
    expect(docs[0]?.createdAt).toBeInstanceOf(Date);

    await repo.insertTrigger({ machineId: "press-01", jobId, requestedBy: "integration", cached: true });
    const trigger = await db.collection("diagnosisTriggers").findOne({ jobId });
    expect(trigger).toMatchObject({ requestedBy: "integration", cached: true });
    expect(trigger?.createdAt).toBeInstanceOf(Date);
  });

  it("退回→仍重複→恢復（依序三次啟動）：11000 退回非 unique；重複未清時 86 保留舊索引不白做；清掉後恢復 unique", async () => {
    const db = freshDb();
    const diagnoses = db.collection("diagnoses");
    await diagnoses.insertMany([{ jobId: "dup" }, { jobId: "dup" }]);

    // 第一次啟動：既有重複資料 → 建 unique 撞 11000 → 記 error、退回非 unique（預設名 jobId_1）。
    const first = new RecordingLogger();
    await ensureDiagnosisIndexes(db, first);
    expect(first.errors).toHaveLength(1);
    expect(errCode(first.errors[0]?.obj)).toBe(11000);
    expect(await jobIdIndex(db)).toMatchObject({ name: "jobId_1" });
    expect((await jobIdIndex(db))?.unique).not.toBe(true);
    // 退回後 insert 不再被 unique 擋（冪等不再有保證，這正是 error log 要人處理的原因）。
    await createMongoDiagnosisRepository(db).insertDiagnosis({ machineId: "m", jobId: "dup", result: VALID_RESULT });
    expect(await diagnoses.countDocuments({ jobId: "dup" })).toBe(3);

    // 第二次啟動、重複未清：同名 jobId_1 擋路 → 86 → 探測到重複 → 只記 error、保留舊索引。
    const second = new RecordingLogger();
    await ensureDiagnosisIndexes(db, second);
    expect(second.errors).toHaveLength(1);
    expect(errCode(second.errors[0]?.obj)).toBe(86);
    expect(second.errors[0]?.msg).toContain("仍有重複資料");
    expect((await jobIdIndex(db))?.unique).not.toBe(true);

    // 第三次啟動、重複已清：移除擋路的非 unique 索引並重建 unique，不記 error。
    await diagnoses.deleteMany({ jobId: "dup" });
    await diagnoses.insertOne({ jobId: "dup" });
    const third = new RecordingLogger();
    await ensureDiagnosisIndexes(db, third);
    expect(third.errors).toEqual([]);
    expect(await jobIdIndex(db)).toMatchObject({ name: "jobId_1", unique: true });
  });

  it("不同名的舊非 unique jobId 索引＋重複資料：Mongo 7 先回 11000（非 85），退回時舊索引保留、不新增", async () => {
    const db = freshDb();
    const diagnoses = db.collection("diagnoses");
    await diagnoses.createIndex({ jobId: 1 }, { name: "legacy_jobId" });
    await diagnoses.insertMany([{ jobId: "dup" }, { jobId: "dup" }]);
    const log = new RecordingLogger();

    await ensureDiagnosisIndexes(db, log);

    // 實測：同鍵不同名的非 unique 索引不構成 85，Mongo 直接建 unique 並在掃描時撞 11000。
    expect(log.errors).toHaveLength(1);
    expect(errCode(log.errors[0]?.obj)).toBe(11000);
    // 退回建非 unique jobId_1 時撞「同鍵不同名」85，被 tryCreateIndex 吞掉——最終只剩舊索引。
    const all = (await diagnoses.indexes()) as IndexInfo[];
    const sameKey = all.filter((i) => JSON.stringify(i.key) === JSON.stringify({ jobId: 1 }));
    expect(sameKey.map((i) => i.name)).toEqual(["legacy_jobId"]);

    // 清掉重複後重跑：unique 直接建立成功，與舊的非 unique 索引「同鍵並存」
    // （Mongo 7 允許 unique 與非 unique 同鍵共存；程式註解「同鍵最多一個」在此情形不成立，但結果正確）。
    await diagnoses.deleteOne({ jobId: "dup" });
    const again = new RecordingLogger();
    await ensureDiagnosisIndexes(db, again);
    expect(again.errors).toEqual([]);
    const after = ((await diagnoses.indexes()) as IndexInfo[]).filter(
      (i) => JSON.stringify(i.key) === JSON.stringify({ jobId: 1 }),
    );
    expect(after.map((i) => [i.name, i.unique === true]).sort()).toEqual([
      ["jobId_1", true],
      ["legacy_jobId", false],
    ]);
  });

  it("已有不同名的 unique jobId 索引（85）：視為目的已達成，不記 error、不新增索引", async () => {
    const db = freshDb();
    const diagnoses = db.collection("diagnoses");
    await diagnoses.createIndex({ jobId: 1 }, { unique: true, name: "custom_jobId_unique" });
    const log = new RecordingLogger();

    await ensureDiagnosisIndexes(db, log);

    expect(log.errors).toEqual([]);
    const ix = await jobIdIndex(db);
    expect(ix).toMatchObject({ name: "custom_jobId_unique", unique: true });
  });

  it("不同名的舊非 unique jobId 索引與不同名的 unique 索引並存（85）：不 drop 舊索引、不記 error", async () => {
    const db = freshDb();
    const diagnoses = db.collection("diagnoses");
    // 先建的非 unique 在 indexes() 中排在前面——findJobIdIndex 不能因此誤判為「尚無 unique」。
    await diagnoses.createIndex({ jobId: 1 }, { name: "legacy_jobId" });
    await diagnoses.createIndex({ jobId: 1 }, { unique: true, name: "custom_jobId_unique" });
    const log = new RecordingLogger();

    await ensureDiagnosisIndexes(db, log);

    expect(log.errors).toEqual([]);
    const sameKey = ((await diagnoses.indexes()) as IndexInfo[])
      .filter((i) => JSON.stringify(i.key) === JSON.stringify({ jobId: 1 }))
      .map((i) => [i.name, i.unique === true])
      .sort();
    expect(sameKey).toEqual([
      ["custom_jobId_unique", true],
      ["legacy_jobId", false],
    ]);
  });

  it("同名 jobId_1 但鍵不同（86 IndexKeySpecsConflict）：不拋、記 error，保留原索引（需人工處理）", async () => {
    const db = freshDb();
    const diagnoses = db.collection("diagnoses");
    await diagnoses.createIndex({ jobId: -1 }, { name: "jobId_1" });
    const log = new RecordingLogger();

    await expect(ensureDiagnosisIndexes(db, log)).resolves.toBeUndefined();

    expect(log.errors).toHaveLength(1);
    expect(errCode(log.errors[0]?.obj)).toBe(86);
    const named = ((await diagnoses.indexes()) as IndexInfo[]).find((i) => i.name === "jobId_1");
    expect(named?.key).toEqual({ jobId: -1 });
    // TTL 等其餘索引照常建立，不受 diagnoses 的衝突影響。
    const triggers = (await db.collection("diagnosisTriggers").indexes()) as IndexInfo[];
    expect(triggers.some((i) => i.expireAfterSeconds === TRIGGER_TTL_SECONDS)).toBe(true);
  });

  it("diagnosisTriggers 已有不同秒數的 TTL 索引（85）：記 error、不拋，原 TTL 保留", async () => {
    const db = freshDb();
    await db.collection("diagnosisTriggers").createIndex({ createdAt: 1 }, { expireAfterSeconds: 60 });
    const log = new RecordingLogger();

    await ensureDiagnosisIndexes(db, log);

    expect(log.errors).toHaveLength(1);
    expect(errCode(log.errors[0]?.obj)).toBe(85);
    expect(log.errors[0]?.msg).toContain("diagnosisTriggers");
    const ttl = ((await db.collection("diagnosisTriggers").indexes()) as IndexInfo[]).find(
      (i) => JSON.stringify(i.key) === JSON.stringify({ createdAt: 1 }),
    );
    expect(ttl?.expireAfterSeconds).toBe(60);
    // diagnoses 的 unique 不受影響。
    expect((await jobIdIndex(db))?.unique).toBe(true);
  });
});
