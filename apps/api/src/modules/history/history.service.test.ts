import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Logger } from "@nestjs/common";
import type { MachineState, TelemetryPoint } from "@flow-gatekeeper/contracts";

/**
 * TQ-7：`HistoryService` 寫入路徑的計數協調。以假 Mongo（記錄 `insertMany` 呼叫、可注入失敗
 * 或懸住）驅動真正的 `onModuleInit`（每秒 flush 計時器）、`enqueue`、`flush` 與 `getWriteStats`。
 */

type InsertCall = { collection: string; docs: unknown[]; opts: unknown };
type InsertImpl = (collection: string, docs: unknown[]) => Promise<unknown>;

const inserts: InsertCall[] = [];
let insertImpl: InsertImpl = () => Promise.resolve({ acknowledged: true });

function fakeCollection(name: string) {
  return {
    insertMany: vi.fn((docs: unknown[], opts: unknown) => {
      inserts.push({ collection: name, docs, opts });
      return insertImpl(name, docs);
    }),
    createIndex: vi.fn(() => Promise.resolve("ok")),
  };
}

const fakeDb = {
  createCollection: vi.fn(() => Promise.resolve({})),
  collection: vi.fn((name: string) => fakeCollection(name)),
  command: vi.fn(() => Promise.resolve({ ok: 1 })),
  listCollections: vi.fn(() => ({ toArray: () => Promise.resolve([]) })),
};

// 被測程式以 `new MongoClient()` 建構：vitest 4 起箭頭函式實作的 vi.fn 不能被 `new`，須用 function 實作。
vi.mock("mongodb", async (importOriginal) => {
  const actual = await importOriginal<typeof import("mongodb")>();
  return {
    ...actual,
    MongoClient: vi.fn(function () {
      return {
        connect: () => Promise.resolve(),
        db: () => fakeDb,
        close: () => Promise.resolve(),
      };
    }),
  };
});

const { HistoryService, toPersistStats } = await import("./history.service.js");

const TELEMETRY_CAPACITY = 5_000;
const FLUSH_INTERVAL_MS = 1_000;

function point(i: number, state: MachineState = "healthy", machineId = "cnc-01"): TelemetryPoint {
  return {
    type: "machine/data",
    machineId,
    timestamp: new Date(Date.UTC(2026, 8, 27, 0, 0, 0, i)).toISOString(),
    telemetry: { temperature: 60, vibration: 1.2, throughput: i, errorRate: 0.01 },
    state,
  };
}

function points(from: number, count: number): TelemetryPoint[] {
  return Array.from({ length: count }, (_, k) => point(from + k));
}

/** 可手動結束的 promise：模擬卡住的 insertMany。 */
function deferred() {
  let resolve!: (v: unknown) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<unknown>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const config = { mongoUrl: "mongodb://fake", mongoDb: "fg", telemetryTtlSeconds: 3600 };

async function started() {
  const svc = new HistoryService(config as never);
  await svc.onModuleInit();
  return svc;
}

const telemetryInserts = () => inserts.filter((c) => c.collection === "telemetry");
const errorlogInserts = () => inserts.filter((c) => c.collection === "errorlogs");

beforeEach(() => {
  inserts.length = 0;
  insertImpl = () => Promise.resolve({ acknowledged: true });
  vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("HistoryService 寫入路徑計數協調（TQ-7）", () => {
  it("enqueue 超過 buffer 上限：丟最舊並計入 droppedPoints，flush 寫出的是最新的那批", async () => {
    const svc = await started();
    svc.enqueue(points(0, TELEMETRY_CAPACITY));
    svc.enqueue(points(TELEMETRY_CAPACITY, 3));

    expect(svc.getWriteStats()).toMatchObject({ bufferedPoints: TELEMETRY_CAPACITY, droppedPoints: 3 });

    await svc.flush();
    const [call] = telemetryInserts();
    expect(telemetryInserts()).toHaveLength(1);
    expect(call?.docs).toHaveLength(TELEMETRY_CAPACITY);
    expect(call?.opts).toEqual({ ordered: false });
    // 最舊的 0、1、2 被丟，第一筆是 #3、最後一筆是最新的 #5002。
    const first = call?.docs[0] as { telemetry: { throughput: number } };
    const last = call?.docs.at(-1) as { telemetry: { throughput: number } };
    expect(first.telemetry.throughput).toBe(3);
    expect(last.telemetry.throughput).toBe(TELEMETRY_CAPACITY + 2);
    expect(svc.getWriteStats()).toMatchObject({ bufferedPoints: 0, droppedPoints: 3, failedPoints: 0 });
    await svc.onModuleDestroy();
  });

  it("單一 in-flight：insertMany 卡住時每秒的 flush tick 不疊第二批，完成後下一個 tick 才寫新累積的點", async () => {
    vi.useFakeTimers();
    const svc = await started();
    const hang = deferred();
    insertImpl = () => hang.promise;

    svc.enqueue(points(0, 10));
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);
    expect(telemetryInserts()).toHaveLength(1);

    // 卡住期間持續進點、tick 照跑：不得發出第二個 insertMany。
    svc.enqueue(points(10, 5));
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS * 5);
    expect(telemetryInserts()).toHaveLength(1);
    expect(svc.getWriteStats().bufferedPoints).toBe(5);

    insertImpl = () => Promise.resolve({ acknowledged: true });
    hang.resolve({ acknowledged: true });
    // 進行中那批結束後，由之後的 flush tick 寫新累積的點：逐 tick 推時間直到第二批出現（不依賴 microtask 層數）。
    await vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);
      expect(telemetryInserts()).toHaveLength(2);
    });
    expect(telemetryInserts()[1]?.docs).toHaveLength(5);
    expect(svc.getWriteStats().bufferedPoints).toBe(0);
    await svc.onModuleDestroy();
  });

  it("telemetry 寫入失敗：計 persistFailures 與 failedPoints、不放回重試，並記 error", async () => {
    const svc = await started();
    insertImpl = (name) =>
      name === "telemetry" ? Promise.reject(new Error("socket timeout")) : Promise.resolve({});

    svc.enqueue(points(0, 7));
    await svc.flush();
    expect(svc.getWriteStats()).toEqual({
      bufferedPoints: 0,
      droppedPoints: 0,
      persistFailures: 1,
      failedPoints: 7,
      pendingErrorLogs: 0,
      droppedErrorLogs: 0,
    });
    expect(Logger.prototype.error).toHaveBeenCalledWith(expect.stringContaining("7 points lost"));

    // 不重試：下一次 flush 沒有 telemetry 可寫。
    await svc.flush();
    expect(telemetryInserts()).toHaveLength(1);
    expect(toPersistStats(svc.getWriteStats())).toEqual({ dropped: 7, failed: 1 });
    await svc.onModuleDestroy();
  });

  it("errorlog 與 telemetry 獨立計數：網路錯誤放回重試、毒批次丟棄計數、重複鍵視為成功", async () => {
    const svc = await started();
    const networkError = Object.assign(new Error("connection reset"), { name: "MongoNetworkError" });
    let errorlogAttempt = 0;
    insertImpl = (name, docs) => {
      if (name !== "errorlogs") return Promise.resolve({});
      errorlogAttempt += 1;
      if (errorlogAttempt === 1) return Promise.reject(networkError);
      if (errorlogAttempt === 2) {
        // 3 筆中 1 筆被 server 以文件驗證（121）拒、1 筆重複鍵（已寫入）。
        return Promise.reject(
          Object.assign(new Error("bulk write"), { writeErrors: [{ code: 121 }, { code: 11000 }] }),
        );
      }
      expect(docs.length).toBeGreaterThan(0);
      return Promise.reject(Object.assign(new Error("dup"), { code: 11000 }));
    };

    // 三台各轉入 warning → 3 筆 errorlog。
    svc.enqueue([point(0, "warning", "a"), point(1, "warning", "b"), point(2, "critical", "c")]);
    await svc.flush();
    expect(svc.getWriteStats()).toMatchObject({ persistFailures: 1, pendingErrorLogs: 3, droppedErrorLogs: 0 });

    await svc.flush(); // 放回的 3 筆重送 → 1 筆被拒（毒批次）丟棄，不再重試
    expect(errorlogInserts()[1]?.docs).toHaveLength(3);
    expect(svc.getWriteStats()).toMatchObject({ persistFailures: 2, pendingErrorLogs: 0, droppedErrorLogs: 1 });

    svc.enqueue([point(3, "healthy", "a"), point(4, "critical", "a")]);
    await svc.flush(); // 純重複鍵：視為成功，不計失敗
    expect(svc.getWriteStats()).toMatchObject({ persistFailures: 2, pendingErrorLogs: 0, droppedErrorLogs: 1 });
    // telemetry 全部成功：failedPoints 不受 errorlog 失敗牽連。
    expect(svc.getWriteStats().failedPoints).toBe(0);
    expect(toPersistStats(svc.getWriteStats())).toEqual({ dropped: 1, failed: 2 });
    await svc.onModuleDestroy();
  });

  it("flush 有時限：進行中那批卡住時在 deadline 回 false，不無限等待", async () => {
    vi.useFakeTimers();
    const svc = await started();
    const hang = deferred();
    insertImpl = () => hang.promise;
    svc.enqueue(points(0, 3));
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS); // tick 開始寫、卡住

    svc.enqueue(points(3, 2));
    let result: boolean | undefined;
    void svc.flush({ deadlineMs: 500 }).then((r) => {
      result = r;
    });
    await vi.advanceTimersByTimeAsync(499);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toBe(false);
    // 等不到進行中那批就不寫殘量。
    expect(telemetryInserts()).toHaveLength(1);
    expect(svc.getWriteStats().bufferedPoints).toBe(2);

    hang.resolve({});
    vi.useRealTimers();
    await svc.onModuleDestroy();
  });

  it("flush 寫殘量本身逾時：回 false 並記 warn", async () => {
    vi.useFakeTimers();
    const svc = await started();
    const hang = deferred();
    insertImpl = () => hang.promise;
    svc.enqueue(points(0, 3));

    let result: boolean | undefined;
    void svc.flush({ deadlineMs: 200 }).then((r) => {
      result = r;
    });
    await vi.advanceTimersByTimeAsync(200);
    expect(telemetryInserts()).toHaveLength(1);
    expect(result).toBe(false);
    expect(Logger.prototype.warn).toHaveBeenCalledWith(expect.stringContaining("within 200ms"));

    hang.resolve({});
    vi.useRealTimers();
    await svc.onModuleDestroy();
  });

  it("flush 不給 deadline：先等進行中那批完成，再寫當下的殘量，回 true", async () => {
    vi.useFakeTimers();
    const svc = await started();
    const hang = deferred();
    insertImpl = () => hang.promise;
    svc.enqueue(points(0, 3));
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);
    svc.enqueue(points(3, 4));

    insertImpl = () => Promise.resolve({});
    const flushed = svc.flush();
    hang.resolve({});
    await expect(flushed).resolves.toBe(true);
    expect(telemetryInserts().map((c) => c.docs.length)).toEqual([3, 4]);
    expect(svc.getWriteStats().bufferedPoints).toBe(0);
    vi.useRealTimers();
    await svc.onModuleDestroy();
  });
});
