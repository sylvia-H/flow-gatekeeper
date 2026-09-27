import { MongoServerError } from "mongodb";
import type { Db } from "mongodb";
import { describe, expect, it, vi } from "vitest";
import { ensureDiagnosisIndexes, TRIGGER_TTL_SECONDS } from "./diagnosis-repository.js";

type IndexCall = { coll: string; keys: Record<string, number>; opts?: Record<string, unknown> };
type ExistingIndex = { name: string; key: Record<string, number>; unique?: boolean };

function fakeDb(
  // `existing` 可就地改動：競態案例用它模擬「另一副本在兩次呼叫之間動了索引」。
  failWhen: (c: IndexCall, existing: ExistingIndex[]) => Error | undefined,
  initial: ExistingIndex[] = [],
  opts: { duplicates?: boolean; onDrop?: (existing: ExistingIndex[]) => void } = {},
) {
  const calls: IndexCall[] = [];
  const dropped: string[] = [];
  const aggregates: unknown[] = [];
  const existing = [...initial];
  const db = {
    collection: (coll: string) => ({
      createIndex: async (keys: Record<string, number>, o?: Record<string, unknown>) => {
        const call = { coll, keys, opts: o };
        calls.push(call);
        const err = failWhen(call, existing);
        if (err) throw err;
        return "ok";
      },
      indexes: async () => (coll === "diagnoses" ? existing.map((ix) => ({ ...ix })) : []),
      dropIndex: async (name: string) => {
        dropped.push(name);
        opts.onDrop?.(existing);
        const i = existing.findIndex((ix) => ix.name === name);
        // 與真 Mongo 一致：索引不存在時拋 IndexNotFound（27）。
        if (i < 0) throw conflict(27);
        existing.splice(i, 1);
      },
      aggregate: (pipeline: unknown) => {
        aggregates.push(pipeline);
        return { toArray: async () => (opts.duplicates ? [{ _id: "job-1", n: 2 }] : []) };
      },
    }),
  } as unknown as Db;
  return { db, calls, dropped, aggregates };
}

const conflict = (code: number) => new MongoServerError({ message: `E${code}`, code });
const fallbackIndex: ExistingIndex = { name: "jobId_1", key: { jobId: 1 } };
const uniqueIndex: ExistingIndex = { name: "jobId_1", key: { jobId: 1 }, unique: true };
const nonUniqueJobIdCalls = (calls: IndexCall[]) =>
  calls.filter((c) => c.coll === "diagnoses" && c.keys.jobId === 1 && !c.opts?.unique);

describe("ensureDiagnosisIndexes", () => {
  it("正常：jobId unique + diagnosisTriggers createdAt TTL 30 天", async () => {
    const { db, calls } = fakeDb(() => undefined);
    const log = { error: vi.fn() };
    await ensureDiagnosisIndexes(db, log);
    expect(calls).toContainEqual({ coll: "diagnoses", keys: { jobId: 1 }, opts: { unique: true } });
    expect(calls).toContainEqual({
      coll: "diagnosisTriggers",
      keys: { createdAt: 1 },
      opts: { expireAfterSeconds: TRIGGER_TTL_SECONDS },
    });
    expect(log.error).not.toHaveBeenCalled();
  });

  it.each([11000, 85, 86])("unique 建立遇 %i：記 error 並退回非 unique，不讓 bootstrap 失敗", async (code) => {
    const { db, calls } = fakeDb((c) => (c.opts?.unique ? conflict(code) : undefined));
    const log = { error: vi.fn() };
    await expect(ensureDiagnosisIndexes(db, log)).resolves.toBeUndefined();
    expect(calls).toContainEqual({ coll: "diagnoses", keys: { jobId: 1 }, opts: undefined });
    expect(log.error).toHaveBeenCalledTimes(1);
  });

  it("前次退回留下的非 unique jobId_1 擋住 unique：移除後重建，恢復 unique", async () => {
    // 同鍵非 unique 索引還在時建 unique 會撞 85；移除後即成功（重複資料已清掉）。
    const { db, calls, dropped, aggregates } = fakeDb(
      (c, existing) => (c.opts?.unique && existing.some((ix) => ix.name === "jobId_1") ? conflict(85) : undefined),
      [fallbackIndex],
    );
    const log = { error: vi.fn() };
    await ensureDiagnosisIndexes(db, log);
    expect(aggregates).toHaveLength(1); // drop 前先探測重複
    expect(dropped).toEqual(["jobId_1"]);
    expect(nonUniqueJobIdCalls(calls)).toEqual([]);
    expect(log.error).not.toHaveBeenCalled();
  });

  it("重複資料尚未清理：不移除既有的非 unique 索引、不重建，只記 error", async () => {
    // 明知會撞 11000 還 drop → 重建 → 再退回，每次重啟都白做兩次索引重建，還讓 jobId 短暫沒有索引。
    const { db, calls, dropped } = fakeDb(
      (c, existing) => (c.opts?.unique && existing.length > 0 ? conflict(85) : undefined),
      [fallbackIndex],
      { duplicates: true },
    );
    const log = { error: vi.fn() };
    await expect(ensureDiagnosisIndexes(db, log)).resolves.toBeUndefined();
    expect(dropped).toEqual([]);
    expect(nonUniqueJobIdCalls(calls)).toEqual([]);
    expect(log.error).toHaveBeenCalledTimes(1);
  });

  it("探測未發現重複、移除後重建仍撞 11000（探測與重建之間寫入了重複）：退回非 unique 並記 error", async () => {
    const { db, calls, dropped } = fakeDb(
      (c, existing) =>
        c.opts?.unique ? (existing.length > 0 ? conflict(85) : conflict(11000)) : undefined,
      [fallbackIndex],
    );
    const log = { error: vi.fn() };
    await expect(ensureDiagnosisIndexes(db, log)).resolves.toBeUndefined();
    expect(dropped).toEqual(["jobId_1"]);
    expect(calls).toContainEqual({ coll: "diagnoses", keys: { jobId: 1 }, opts: undefined });
    expect(log.error).toHaveBeenCalledTimes(1);
  });

  it("多副本競態：另一副本先移除了擋路索引（drop 撞 27）→ 重建 unique 成功、不記 error", async () => {
    const { db, calls, dropped } = fakeDb(
      (c, existing) => (c.opts?.unique && existing.some((ix) => ix.unique !== true) ? conflict(85) : undefined),
      [fallbackIndex],
      // 在本副本 drop 之前，另一副本已把它移除。
      { onDrop: (existing) => existing.splice(0) },
    );
    const log = { error: vi.fn() };
    await ensureDiagnosisIndexes(db, log);
    expect(dropped).toEqual(["jobId_1"]);
    expect(calls.filter((c) => c.opts?.unique)).toHaveLength(2);
    expect(nonUniqueJobIdCalls(calls)).toEqual([]);
    expect(log.error).not.toHaveBeenCalled();
  });

  it("多副本競態：另一副本已先建好 unique（重建撞 85 但 unique 已存在）→ 視為成功、不退回", async () => {
    let uniqueAttempts = 0;
    const { db, calls } = fakeDb(
      (c, existing) => {
        if (!c.opts?.unique) return undefined;
        uniqueAttempts += 1;
        // 第一次：被非 unique 擋住；第二次：另一副本搶先建好 unique，本副本再撞 85。
        if (uniqueAttempts === 2) existing.splice(0, existing.length, uniqueIndex);
        return conflict(85);
      },
      [fallbackIndex],
    );
    const log = { error: vi.fn() };
    await ensureDiagnosisIndexes(db, log);
    expect(nonUniqueJobIdCalls(calls)).toEqual([]);
    expect(log.error).not.toHaveBeenCalled();
  });

  it("已存在不同名的 unique jobId 索引（85）：目的已達成，不退回也不記 error", async () => {
    const { db, calls, dropped } = fakeDb(
      (c) => (c.opts?.unique ? conflict(85) : undefined),
      [{ name: "uniq_jobId", key: { jobId: 1 }, unique: true }],
    );
    const log = { error: vi.fn() };
    await ensureDiagnosisIndexes(db, log);
    expect(dropped).toEqual([]);
    expect(nonUniqueJobIdCalls(calls)).toEqual([]);
    expect(log.error).not.toHaveBeenCalled();
  });

  it("非索引衝突的錯誤照樣拋出（例如連線失敗）", async () => {
    const { db } = fakeDb((c) => (c.opts?.unique ? new Error("network") : undefined));
    await expect(ensureDiagnosisIndexes(db, { error: vi.fn() })).rejects.toThrow("network");
  });
});
