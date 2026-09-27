import { randomBytes } from "node:crypto";
import { silenceNestLogger } from "../test-support/nest-logger.js";
import { MongoClient } from "mongodb";
import type { Db } from "mongodb";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { MachineState, TelemetryPoint } from "@flow-gatekeeper/contracts";
import { loadApiDotenv } from "../lib/env-file.js";
import { AppConfigService } from "../modules/config/config.service.js";
import { HistoryService, toPersistStats } from "../modules/history/history.service.js";

/**
 * 真 Mongo 整合測試：`HistoryService` 的寫入路徑（enqueue → flush → writeOnce，第二輪審查報告
 * TQ-7「writeOnce／flush 的計數協調沒測」）。成功批次讀回內容；失敗批次以 collection validator
 * 讓 server 逐筆拒絕（121 DocumentValidationFailure），驗證 `failedPoints`／`droppedErrorLogs`／
 * `persistFailures` 計數與「毒批次不重排」語意。
 *
 * 隔離同 mongo-ttl.int.test.ts：每個測試一個 `flow-gatekeeper-int-<本輪隨機>-<序號>` 資料庫，測後 drop。
 */

loadApiDotenv();
const MONGO_URL = process.env.MONGO_URL?.trim() || "mongodb://127.0.0.1:27017";
const RUN_ID = randomBytes(4).toString("hex");
const UNREACHABLE_HINT =
  "無法連線 MongoDB（MONGO_URL）。請先在 repo 根目錄執行 `docker compose up -d`，" +
  "並以 `docker compose ps` 確認 mongo 為 healthy。";

/** 任何沒有 `__never` 欄位的文件都會被拒——等同「注入必被 server 拒絕的文件」。 */
const REJECT_ALL_VALIDATOR = { __never: { $exists: true } };

function point(machineId: string, state: MachineState, secondsAgo: number): TelemetryPoint {
  return {
    type: "machine/data",
    machineId,
    timestamp: new Date(Date.now() - secondsAgo * 1000).toISOString(),
    telemetry: { temperature: 60, vibration: 3.2, throughput: 120, errorRate: 0.01 },
    state,
  };
}

describe.runIf(process.env.FG_INTEGRATION === "1")("HistoryService 寫入路徑 × 真 Mongo（整合）", () => {
  let client: MongoClient;
  let restoreLogger: () => void = () => undefined;
  const dbNames: string[] = [];
  const services: HistoryService[] = [];

  /** 在全新資料庫上啟動一個 HistoryService（含 ensureCollections）。 */
  async function startService(): Promise<{ svc: HistoryService; db: Db }> {
    const name = `flow-gatekeeper-int-${RUN_ID}-${dbNames.length}`;
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
      // onModuleDestroy 會清掉 1 秒 flush 計時器並關閉服務自己的 MongoClient，vitest 不會被未關 handle 卡住。
      await Promise.all(services.map((s) => s.onModuleDestroy()));
      for (const name of dbNames) await client.db(name).dropDatabase();
    } finally {
      await client?.close();
      restoreLogger();
    }
  });

  it("成功批次：telemetry 全數寫入 time-series 並可讀回，errorlog 只記狀態轉入 warning／critical", async () => {
    const { svc, db } = await startService();
    svc.enqueue([point("press-01", "healthy", 5), point("press-02", "healthy", 5)]);
    svc.enqueue([point("press-01", "warning", 4), point("press-02", "healthy", 4)]);
    svc.enqueue([point("press-01", "warning", 3), point("press-02", "healthy", 3)]);
    svc.enqueue([point("press-01", "critical", 2), point("press-02", "healthy", 2)]);

    await expect(svc.flush()).resolves.toBe(true);

    expect(await db.collection("telemetry").countDocuments()).toBe(8);
    const sample = await db.collection("telemetry").findOne({ "metadata.machineId": "press-01", state: "critical" });
    expect(sample?.timestamp).toBeInstanceOf(Date);
    expect(sample).toMatchObject({ telemetry: { temperature: 60, vibration: 3.2 } });
    expect(sample).not.toHaveProperty("type");

    const errors = await db.collection("errorlogs").find({}, { sort: { _id: 1 } }).toArray();
    expect(errors.map((e) => [e.machineId, e.state])).toEqual([
      ["press-01", "warning"],
      ["press-01", "critical"],
    ]);

    expect(svc.getWriteStats()).toEqual({
      bufferedPoints: 0,
      droppedPoints: 0,
      persistFailures: 0,
      failedPoints: 0,
      pendingErrorLogs: 0,
      droppedErrorLogs: 0,
    });
  });

  it("失敗批次：server 逐筆拒絕時 telemetry 計入 failedPoints、errorlog 計入 droppedErrorLogs 且不重排", async () => {
    const { svc, db } = await startService();
    // time-series 不支援 validator：把 telemetry 換成帶「全拒」validator 的一般 collection，
    // errorlogs 則直接以 collMod 加上同一 validator。
    await db.collection("telemetry").drop();
    await db.createCollection("telemetry", { validator: REJECT_ALL_VALIDATOR, validationAction: "error" });
    await db.command({ collMod: "errorlogs", validator: REJECT_ALL_VALIDATOR, validationAction: "error" });

    svc.enqueue([point("press-01", "warning", 3), point("press-02", "critical", 3)]);
    svc.enqueue([point("press-01", "warning", 2), point("press-02", "critical", 2)]);
    svc.enqueue([point("press-01", "healthy", 1), point("press-02", "healthy", 1)]);

    await expect(svc.flush()).resolves.toBe(true);

    // 真 Mongo 確實拒絕（不是測試自己沒寫進去）。
    expect(await db.collection("telemetry").countDocuments()).toBe(0);
    expect(await db.collection("errorlogs").countDocuments()).toBe(0);
    const stats = svc.getWriteStats();
    expect(stats).toEqual({
      bufferedPoints: 0,
      droppedPoints: 0,
      persistFailures: 2, // telemetry 一批＋errorlogs 一批
      failedPoints: 6,
      pendingErrorLogs: 0, // 121 為終局錯誤：不放回佇列
      droppedErrorLogs: 2,
    });
    expect(toPersistStats(stats)).toEqual({ dropped: 8, failed: 2 });

    // 再 flush 一次：毒批次沒有被重排，計數不再增加。
    await svc.flush();
    expect(svc.getWriteStats()).toMatchObject({ persistFailures: 2, failedPoints: 6, droppedErrorLogs: 2 });
  });

  it("errorlog 部分被拒：只有被拒的筆數計入 droppedErrorLogs，其餘照寫", async () => {
    const { svc, db } = await startService();
    // 只拒絕 press-02 的 errorlog。
    await db.command({
      collMod: "errorlogs",
      validator: { machineId: { $ne: "press-02" } },
      validationAction: "error",
    });

    svc.enqueue([point("press-01", "warning", 2), point("press-02", "warning", 2), point("press-03", "critical", 2)]);
    await svc.flush();

    const written = await db.collection("errorlogs").find().toArray();
    expect(written.map((e) => e.machineId).sort()).toEqual(["press-01", "press-03"]);
    expect(await db.collection("telemetry").countDocuments()).toBe(3);
    expect(svc.getWriteStats()).toMatchObject({
      persistFailures: 1,
      failedPoints: 0,
      pendingErrorLogs: 0,
      droppedErrorLogs: 1,
    });
  });
});
