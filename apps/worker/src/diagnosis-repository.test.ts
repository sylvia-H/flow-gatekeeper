import { MongoServerError } from "mongodb";
import type { Db } from "mongodb";
import { describe, expect, it, vi } from "vitest";
import { ensureDiagnosisIndexes, TRIGGER_TTL_SECONDS } from "./diagnosis-repository.js";

type IndexCall = { coll: string; keys: Record<string, number>; opts?: Record<string, unknown> };

function fakeDb(failWhen: (c: IndexCall) => unknown | undefined) {
  const calls: IndexCall[] = [];
  const db = {
    collection: (coll: string) => ({
      createIndex: async (keys: Record<string, number>, opts?: Record<string, unknown>) => {
        const call = { coll, keys, opts };
        calls.push(call);
        const err = failWhen(call);
        if (err) throw err;
        return "ok";
      },
    }),
  } as unknown as Db;
  return { db, calls };
}

const conflict = (code: number) => new MongoServerError({ message: `E${code}`, code });

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

  it("非索引衝突的錯誤照樣拋出（例如連線失敗）", async () => {
    const { db } = fakeDb((c) => (c.opts?.unique ? new Error("network") : undefined));
    await expect(ensureDiagnosisIndexes(db, { error: vi.fn() })).rejects.toThrow("network");
  });
});
