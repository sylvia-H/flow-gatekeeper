import { randomBytes } from "node:crypto";
import { silenceNestLogger } from "../test-support/nest-logger.js";
import { MongoClient } from "mongodb";
import type { Db } from "mongodb";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { loadApiDotenv } from "../lib/env-file.js";
import { AppConfigService } from "../modules/config/config.service.js";
import { HistoryService } from "../modules/history/history.service.js";

/**
 * 真 Mongo 整合測試：`HistoryService.ensureCollections` 的 TTL 維護（第二輪審查報告 §6 Batch D：collMod）。
 * 單元測試只測得到 `planTimeSeriesTtl` 純函式；這裡驗證 time-series 建立、既存 collection 以 `collMod`
 * 更新 `expireAfterSeconds`、errorlogs TTL 索引 85 → collMod 的退回，都真的在 Mongo 7 上生效。
 *
 * 隔離：每個測試一個 `flow-gatekeeper-int-<本輪隨機>-<序號>` 資料庫（以 `MONGO_DB` 指給 HistoryService），
 * afterAll 全數 dropDatabase；絕不碰正式 `flow-gatekeeper`。連線位址取 `apps/api/.env` 的 `MONGO_URL`。
 */

loadApiDotenv();
const MONGO_URL = process.env.MONGO_URL?.trim() || "mongodb://127.0.0.1:27017";
const RUN_ID = randomBytes(4).toString("hex");
const ERRORLOG_TTL_SECONDS = 30 * 24 * 60 * 60;
const UNREACHABLE_HINT =
  "無法連線 MongoDB（MONGO_URL）。請先在 repo 根目錄執行 `docker compose up -d`，" +
  "並以 `docker compose ps` 確認 mongo 為 healthy。";

type CollectionInfo = {
  type?: string;
  options?: { expireAfterSeconds?: unknown; timeseries?: Record<string, unknown> };
};
type IndexInfo = { name?: string; key: Record<string, unknown>; expireAfterSeconds?: number };

describe.runIf(process.env.FG_INTEGRATION === "1")("HistoryService TTL 維護 × 真 Mongo（整合）", () => {
  let client: MongoClient;
  let restoreLogger: () => void = () => undefined;
  const dbNames: string[] = [];

  function freshDbName(): string {
    const name = `flow-gatekeeper-int-${RUN_ID}-${dbNames.length}`;
    dbNames.push(name);
    return name;
  }

  /** 以指定 TTL 跑一次 HistoryService 啟動（ensureCollections）後立即關閉，模擬一次 api 重啟。 */
  async function bootOnce(dbName: string, telemetryTtlSeconds: number): Promise<void> {
    vi.stubEnv("MONGO_URL", MONGO_URL);
    vi.stubEnv("MONGO_DB", dbName);
    vi.stubEnv("TELEMETRY_TTL_SECONDS", String(telemetryTtlSeconds));
    const svc = new HistoryService(new AppConfigService());
    try {
      await svc.onModuleInit();
    } finally {
      await svc.onModuleDestroy();
    }
  }

  async function telemetryInfo(db: Db): Promise<CollectionInfo | undefined> {
    const [info] = await db.listCollections({ name: "telemetry" }).toArray();
    return info;
  }

  async function errorlogTtl(db: Db): Promise<IndexInfo | undefined> {
    const all = (await db.collection("errorlogs").indexes()) as IndexInfo[];
    return all.find((i) => JSON.stringify(i.key) === JSON.stringify({ timestamp: 1 }));
  }

  beforeAll(async () => {
    // Nest Logger 的 log／warn 在此只是雜訊；斷言一律讀回 Mongo 實際狀態。
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
      for (const name of dbNames) await client.db(name).dropDatabase();
    } finally {
      await client?.close();
      restoreLogger();
    }
  });

  it("全新資料庫：建立 time-series telemetry（TTL＝TELEMETRY_TTL_SECONDS）與 errorlogs／maintenanceRecords 索引", async () => {
    const name = freshDbName();
    await bootOnce(name, 3600);
    const db = client.db(name);

    const info = await telemetryInfo(db);
    expect(info?.type).toBe("timeseries");
    expect(info?.options?.expireAfterSeconds).toBe(3600);
    expect(info?.options?.timeseries).toMatchObject({
      timeField: "timestamp",
      metaField: "metadata",
      granularity: "seconds",
    });
    expect(await errorlogTtl(db)).toMatchObject({ name: "timestamp_ttl", expireAfterSeconds: ERRORLOG_TTL_SECONDS });
    const errIdx = (await db.collection("errorlogs").indexes()) as IndexInfo[];
    expect(errIdx.some((i) => JSON.stringify(i.key) === JSON.stringify({ machineId: 1, timestamp: -1 }))).toBe(true);
    const mrIdx = (await db.collection("maintenanceRecords").indexes()) as IndexInfo[];
    expect(mrIdx.some((i) => JSON.stringify(i.key) === JSON.stringify({ machineId: 1, performedAt: -1 }))).toBe(true);
  });

  it("既存 telemetry：改 TELEMETRY_TTL_SECONDS 後重啟，以 collMod 更新 expireAfterSeconds；同值再重啟維持不變", async () => {
    const name = freshDbName();
    const db = client.db(name);
    await bootOnce(name, 3600);
    expect((await telemetryInfo(db))?.options?.expireAfterSeconds).toBe(3600);

    // 重啟帶新值：createCollection 撞 48 NamespaceExists → planTimeSeriesTtl → collMod。
    await bootOnce(name, 7200);
    const updated = await telemetryInfo(db);
    expect(updated?.type).toBe("timeseries");
    expect(updated?.options?.expireAfterSeconds).toBe(7200);

    // 同值：plan 為 none，不報錯也不改動。
    await bootOnce(name, 7200);
    expect((await telemetryInfo(db))?.options?.expireAfterSeconds).toBe(7200);
  });

  it("errorlogs TTL 索引秒數漂移：createIndex 撞 85，改以 collMod 拉回 30 天", async () => {
    const name = freshDbName();
    const db = client.db(name);
    await bootOnce(name, 3600);
    // 人為把既有 TTL 索引改成 100 秒（模擬舊版本留下的不同設定）。
    await db.command({ collMod: "errorlogs", index: { keyPattern: { timestamp: 1 }, expireAfterSeconds: 100 } });
    expect((await errorlogTtl(db))?.expireAfterSeconds).toBe(100);
    // 先確認真 Mongo 對「同名同鍵、TTL 不同」回的是 85。
    await expect(
      db.collection("errorlogs").createIndex({ timestamp: 1 }, { expireAfterSeconds: ERRORLOG_TTL_SECONDS, name: "timestamp_ttl" }),
    ).rejects.toMatchObject({ code: 85 });

    await bootOnce(name, 3600);

    expect((await errorlogTtl(db))?.expireAfterSeconds).toBe(ERRORLOG_TTL_SECONDS);
  });

  it("telemetry 已是一般 collection（非 time-series）：啟動不失敗、不嘗試轉換，collection 原樣保留", async () => {
    const name = freshDbName();
    const db = client.db(name);
    await db.createCollection("telemetry");

    await expect(bootOnce(name, 3600)).resolves.toBeUndefined();

    const info = await telemetryInfo(db);
    expect(info?.type).toBe("collection");
    expect(info?.options?.expireAfterSeconds).toBeUndefined();
  });
});
