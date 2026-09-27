import { MongoServerError } from "mongodb";
import type { Db } from "mongodb";
import { describe, expect, it, vi } from "vitest";
import { ensureDiagnosisIndexes, TRIGGER_TTL_SECONDS } from "./diagnosis-repository.js";

type IndexCall = { coll: string; keys: Record<string, number>; opts?: Record<string, unknown> };
type ExistingIndex = { name: string; key: Record<string, number>; unique?: boolean };

function fakeDb(
  failWhen: (c: IndexCall, existing: readonly ExistingIndex[]) => Error | undefined,
  initial: ExistingIndex[] = [],
) {
  const calls: IndexCall[] = [];
  const dropped: string[] = [];
  const existing = [...initial];
  const db = {
    collection: (coll: string) => ({
      createIndex: async (keys: Record<string, number>, opts?: Record<string, unknown>) => {
        const call = { coll, keys, opts };
        calls.push(call);
        const err = failWhen(call, existing);
        if (err) throw err;
        return "ok";
      },
      indexes: async () => (coll === "diagnoses" ? existing.map((ix) => ({ ...ix })) : []),
      dropIndex: async (name: string) => {
        dropped.push(name);
        const i = existing.findIndex((ix) => ix.name === name);
        if (i >= 0) existing.splice(i, 1);
      },
    }),
  } as unknown as Db;
  return { db, calls, dropped };
}

const conflict = (code: number) => new MongoServerError({ message: `E${code}`, code });
const fallbackIndex: ExistingIndex = { name: "jobId_1", key: { jobId: 1 } };

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
    const { db, calls, dropped } = fakeDb(
      (c, existing) => (c.opts?.unique && existing.some((ix) => ix.name === "jobId_1") ? conflict(85) : undefined),
      [fallbackIndex],
    );
    const log = { error: vi.fn() };
    await ensureDiagnosisIndexes(db, log);
    expect(dropped).toEqual(["jobId_1"]);
    expect(calls.filter((c) => c.coll === "diagnoses" && c.keys.jobId === 1 && !c.opts?.unique)).toEqual([]);
    expect(log.error).not.toHaveBeenCalled();
  });

  it("移除後仍有重複資料（11000）：再退回非 unique 並記 error", async () => {
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

  it("非索引衝突的錯誤照樣拋出（例如連線失敗）", async () => {
    const { db } = fakeDb((c) => (c.opts?.unique ? new Error("network") : undefined));
    await expect(ensureDiagnosisIndexes(db, { error: vi.fn() })).rejects.toThrow("network");
  });
});
