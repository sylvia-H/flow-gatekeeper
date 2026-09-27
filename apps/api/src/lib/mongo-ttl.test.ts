import { describe, expect, it } from "vitest";
import { MongoBulkWriteError, MongoNetworkError, MongoServerError } from "mongodb";
import {
  classifyInsertFailure,
  isIndexConflict,
  isOnlyDuplicateKeyError,
  planTimeSeriesTtl,
} from "./mongo-ttl.js";

describe("planTimeSeriesTtl", () => {
  it("TTL 相同不動作", () => {
    expect(
      planTimeSeriesTtl({ type: "timeseries", options: { expireAfterSeconds: 86400 } }, 86400),
    ).toEqual({ action: "none" });
  });

  it("TTL 不同或未設 → collMod", () => {
    expect(
      planTimeSeriesTtl({ type: "timeseries", options: { expireAfterSeconds: 604800 } }, 86400),
    ).toEqual({ action: "collMod", from: 604800, to: 86400 });
    expect(planTimeSeriesTtl({ type: "timeseries", options: {} }, 3600)).toEqual({
      action: "collMod",
      from: undefined,
      to: 3600,
    });
  });

  it("不是 time-series（或查不到）→ 回報，無法 collMod", () => {
    expect(planTimeSeriesTtl({ type: "collection" }, 3600)).toEqual({
      action: "not-timeseries",
      type: "collection",
    });
    expect(planTimeSeriesTtl(undefined, 3600)).toEqual({
      action: "not-timeseries",
      type: undefined,
    });
  });
});

describe("isIndexConflict", () => {
  it("只認 85/86", () => {
    expect(isIndexConflict({ code: 85 })).toBe(true);
    expect(isIndexConflict({ code: 86 })).toBe(true);
    expect(isIndexConflict({ code: 48 })).toBe(false);
    expect(isIndexConflict(new Error("x"))).toBe(false);
    expect(isIndexConflict(null)).toBe(false);
  });
});

describe("isOnlyDuplicateKeyError", () => {
  it("writeErrors 全為 11000 視為成功", () => {
    expect(isOnlyDuplicateKeyError({ code: 11000, writeErrors: [{ code: 11000 }] })).toBe(true);
    expect(isOnlyDuplicateKeyError({ writeErrors: { code: 11000 } })).toBe(true);
  });

  it("混有其他錯誤或非寫入錯誤則不是", () => {
    expect(isOnlyDuplicateKeyError({ writeErrors: [{ code: 11000 }, { code: 121 }] })).toBe(false);
    expect(isOnlyDuplicateKeyError({ writeErrors: [] })).toBe(false);
    expect(isOnlyDuplicateKeyError(new Error("server selection timed out"))).toBe(false);
    expect(isOnlyDuplicateKeyError(undefined)).toBe(false);
  });
});

describe("classifyInsertFailure", () => {
  it("網路／選址類錯誤（無 writeErrors）→ transient，可重試", () => {
    for (const name of [
      "MongoNetworkError",
      "MongoNetworkTimeoutError",
      "MongoServerSelectionError",
      "MongoTopologyClosedError",
      "MongoNotConnectedError",
    ]) {
      expect(classifyInsertFailure(Object.assign(new Error("x"), { name }), 3)).toEqual({
        kind: "transient",
      });
    }
    expect(
      classifyInsertFailure({ name: "MongoServerError", errorLabels: ["RetryableWriteError"] }, 3),
    ).toEqual({ kind: "transient" });
  });

  it("帶 writeErrors → terminal，只計被拒（非 11000）的筆數", () => {
    expect(
      classifyInsertFailure({ writeErrors: [{ code: 121 }, { code: 11000 }, { code: 121 }] }, 5),
    ).toEqual({ kind: "terminal", rejected: 2 });
    expect(classifyInsertFailure({ writeErrors: { code: 121 } }, 5)).toEqual({
      kind: "terminal",
      rejected: 1,
    });
  });

  it("server 直接拒絕整個指令（如 10334 文件過大）或未知錯誤 → 整批 terminal", () => {
    expect(classifyInsertFailure({ name: "MongoServerError", code: 10334 }, 4)).toEqual({
      kind: "terminal",
      rejected: 4,
    });
    expect(classifyInsertFailure(new Error("weird"), 2)).toEqual({ kind: "terminal", rejected: 2 });
  });

  // 用 driver 真實的包裝行為重現：insertMany 走 bulkWrite，連線失敗會變成 writeErrors 為空的 MongoBulkWriteError。
  it("driver 包裝過的網路錯誤（MongoBulkWriteError、writeErrors 為空）→ transient", () => {
    const wrapped = new MongoBulkWriteError(new MongoNetworkError("connection reset"), {} as never);
    expect(wrapped.name).toBe("MongoBulkWriteError");
    expect(wrapped.writeErrors).toEqual([]);
    expect(classifyInsertFailure(wrapped, 3)).toEqual({ kind: "transient" });
    expect(isOnlyDuplicateKeyError(wrapped)).toBe(false);
  });

  it("driver 包裝過的整批拒絕（非暫時性 server 錯誤）→ 整批 terminal", () => {
    const inner = new MongoServerError({ message: "document too large", code: 10334 });
    const wrapped = new MongoBulkWriteError(inner, {} as never);
    expect(classifyInsertFailure(wrapped, 4)).toEqual({ kind: "terminal", rejected: 4 });
  });
});
