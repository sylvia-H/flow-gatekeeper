import { describe, expect, it, vi } from "vitest";
import { readWorkerSnapshots, WORKER_METRICS_PATTERN } from "./worker-snapshots.js";
import type { WorkerSnapshotRedis } from "./worker-snapshots.js";

/** 以固定的 SCAN 分頁序列模擬 Redis。 */
function fakeRedis(pages: [string, string[]][], values: Record<string, string>): WorkerSnapshotRedis & {
  scan: ReturnType<typeof vi.fn>;
  mget: ReturnType<typeof vi.fn>;
} {
  let i = 0;
  const scan = vi.fn((_cursor: string) => {
    const page = pages[i++];
    if (!page) throw new Error("SCAN 被呼叫超過預期次數");
    return Promise.resolve(page);
  });
  const mget = vi.fn((...keys: string[]) => Promise.resolve(keys.map((k) => values[k] ?? null)));
  return { scan, mget } as unknown as WorkerSnapshotRedis & {
    scan: ReturnType<typeof vi.fn>;
    mget: ReturnType<typeof vi.fn>;
  };
}

describe("readWorkerSnapshots", () => {
  it("以 SCAN MATCH metrics:worker:* 分頁直到游標回 0，再一次 MGET", async () => {
    const redis = fakeRedis(
      [
        ["17", ["metrics:worker:a"]],
        ["0", ["metrics:worker:b"]],
      ],
      { "metrics:worker:a": "A", "metrics:worker:b": "B" },
    );
    await expect(readWorkerSnapshots(redis)).resolves.toEqual(["A", "B"]);
    expect(redis.scan).toHaveBeenNthCalledWith(1, "0", "MATCH", WORKER_METRICS_PATTERN, "COUNT", 100);
    expect(redis.scan).toHaveBeenNthCalledWith(2, "17", "MATCH", WORKER_METRICS_PATTERN, "COUNT", 100);
    expect(redis.mget).toHaveBeenCalledTimes(1);
  });

  it("SCAN 重複回傳同一 key 時去重，避免同一實例被計入兩次", async () => {
    const redis = fakeRedis(
      [
        ["5", ["metrics:worker:a"]],
        ["0", ["metrics:worker:a"]],
      ],
      { "metrics:worker:a": "A" },
    );
    await expect(readWorkerSnapshots(redis)).resolves.toEqual(["A"]);
    expect(redis.mget).toHaveBeenCalledWith("metrics:worker:a");
  });

  it("中間頁可為空批次；沒有任何實例時不呼叫 MGET、回空陣列", async () => {
    const redis = fakeRedis(
      [
        ["9", []],
        ["0", []],
      ],
      {},
    );
    await expect(readWorkerSnapshots(redis)).resolves.toEqual([]);
    expect(redis.mget).not.toHaveBeenCalled();
  });

  it("SCAN 與 MGET 之間過期的 key 以 null 回傳（交由合併端略過）", async () => {
    const redis = fakeRedis([["0", ["metrics:worker:a", "metrics:worker:gone"]]], { "metrics:worker:a": "A" });
    await expect(readWorkerSnapshots(redis)).resolves.toEqual(["A", null]);
  });
});
