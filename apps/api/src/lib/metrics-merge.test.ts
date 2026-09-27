import { describe, expect, it } from "vitest";
import type { WorkerMetrics } from "@flow-gatekeeper/contracts";
import { dropStaleSnapshots, mergeMetrics, mergeWorkerSnapshots, parseWorkerSnapshot } from "./metrics-merge.js";
import type { ApiMetricsPart } from "./metrics-merge.js";

const apiPart: ApiMetricsPart = {
  windowMs: 60_000,
  collectedAt: "2026-07-20T09:14:22.481Z",
  queue: { waiting: 0, active: 1, failed: 2 },
  wsConnections: 3,
};

const workerSnapshot: WorkerMetrics = {
  snapshotAt: "2026-07-20T09:14:20.004Z",
  llmLatency: { count: 4, avgMs: 2184, p95Ms: 3902, maxMs: 4011 },
  cache: { hits: 3, misses: 1, hitRate: 0.75 },
};

/** api 側四項中的兩項在任何降級情境下都 MUST 完整保留（data-model E3 不變量）。 */
function expectApiPartIntact(result: ReturnType<typeof mergeMetrics>): void {
  expect(result.type).toBe("system/metrics");
  expect(result.windowMs).toBe(60_000);
  expect(result.collectedAt).toBe("2026-07-20T09:14:22.481Z");
  expect(result.queue).toEqual({ waiting: 0, active: 1, failed: 2 });
  expect(result.wsConnections).toBe(3);
}

describe("mergeMetrics", () => {
  it("worker 快照合法時原樣併入", () => {
    const result = mergeMetrics(apiPart, [JSON.stringify(workerSnapshot)]);
    expectApiPartIntact(result);
    expect(result.worker).toEqual(workerSnapshot);
  });

  it("worker 快照缺席／過期（掃不到任何 key，或 MGET 前剛過期）時 worker 為 null，api 兩項不受影響", () => {
    expect(mergeMetrics(apiPart, []).worker).toBeNull();
    const result = mergeMetrics(apiPart, [null]);
    expectApiPartIntact(result);
    expect(result.worker).toBeNull();
  });

  it("畸形 JSON 降級為 null 而不拋錯", () => {
    const result = mergeMetrics(apiPart, ["{not json"]);
    expectApiPartIntact(result);
    expect(result.worker).toBeNull();
  });

  it("JSON 合法但非物件（如 null／字串／陣列）降級為 null", () => {
    for (const raw of ["null", '"worker"', "[]", "42"]) {
      const result = mergeMetrics(apiPart, [raw]);
      expectApiPartIntact(result);
      expect(result.worker).toBeNull();
    }
  });

  it("欄位缺漏降級為 null", () => {
    const missingCache = { snapshotAt: workerSnapshot.snapshotAt, llmLatency: workerSnapshot.llmLatency };
    expect(mergeMetrics(apiPart, [JSON.stringify(missingCache)]).worker).toBeNull();

    const missingSnapshotAt = { llmLatency: workerSnapshot.llmLatency, cache: workerSnapshot.cache };
    expect(mergeMetrics(apiPart, [JSON.stringify(missingSnapshotAt)]).worker).toBeNull();

    const missingCount = {
      ...workerSnapshot,
      llmLatency: { avgMs: 1, p95Ms: 1, maxMs: 1 },
    };
    expect(mergeMetrics(apiPart, [JSON.stringify(missingCount)]).worker).toBeNull();
  });

  it("欄位型別不符降級為 null", () => {
    const badSnapshotAt = { ...workerSnapshot, snapshotAt: 1784286860004 };
    expect(mergeMetrics(apiPart, [JSON.stringify(badSnapshotAt)]).worker).toBeNull();

    const badCount = { ...workerSnapshot, llmLatency: { ...workerSnapshot.llmLatency, count: "4" } };
    expect(mergeMetrics(apiPart, [JSON.stringify(badCount)]).worker).toBeNull();

    const badHitRate = { ...workerSnapshot, cache: { ...workerSnapshot.cache, hitRate: "0.75" } };
    expect(mergeMetrics(apiPart, [JSON.stringify(badHitRate)]).worker).toBeNull();
  });

  it("計數違反契約（負數、非整數）降級為 null", () => {
    const negativeHits = { ...workerSnapshot, cache: { ...workerSnapshot.cache, hits: -1 } };
    expect(mergeMetrics(apiPart, [JSON.stringify(negativeHits)]).worker).toBeNull();

    const fractionalCount = { ...workerSnapshot, llmLatency: { ...workerSnapshot.llmLatency, count: 1.5 } };
    expect(mergeMetrics(apiPart, [JSON.stringify(fractionalCount)]).worker).toBeNull();
  });

  it("契約以外的多餘欄位不外洩到廣播 payload", () => {
    const extra = { ...workerSnapshot, injected: "<script>" };
    expect(mergeMetrics(apiPart, [JSON.stringify(extra)]).worker).toEqual(workerSnapshot);
  });

  it("空樣本的合法快照（統計值為 null）不被誤判為畸形", () => {
    const idle: WorkerMetrics = {
      snapshotAt: "2026-07-20T09:15:20.004Z",
      llmLatency: { count: 0, avgMs: null, p95Ms: null, maxMs: null },
      cache: { hits: 0, misses: 0, hitRate: null },
    };
    expect(mergeMetrics(apiPart, [JSON.stringify(idle)]).worker).toEqual(idle);
  });

  it("任何降級情境都不拋錯", () => {
    for (const raw of [null, "", "{", "undefined", '{"snapshotAt":{}}']) {
      expect(() => mergeMetrics(apiPart, [raw])).not.toThrow();
    }
  });
});

const idleSnapshot: WorkerMetrics = {
  snapshotAt: "2026-07-20T09:14:21.000Z",
  llmLatency: { count: 0, avgMs: null, p95Ms: null, maxMs: null },
  cache: { hits: 0, misses: 0, hitRate: null },
};

describe("parseWorkerSnapshot", () => {
  it("合法字串 → 快照；null／畸形 → null", () => {
    expect(parseWorkerSnapshot(JSON.stringify(workerSnapshot))).toEqual(workerSnapshot);
    expect(parseWorkerSnapshot(null)).toBeNull();
    expect(parseWorkerSnapshot("{")).toBeNull();
    expect(parseWorkerSnapshot("{}")).toBeNull();
  });
});

describe("mergeWorkerSnapshots（多實例合併）", () => {
  it("零筆 → null（維持 worker 全數缺席時整塊降級）", () => {
    expect(mergeWorkerSnapshots([])).toBeNull();
  });

  it("單筆 → 原樣回傳", () => {
    expect(mergeWorkerSnapshots([workerSnapshot])).toEqual(workerSnapshot);
  });

  it("多筆：count／hits／misses 加總、avg 以 count 加權、p95／max 取最大、hitRate 重算、snapshotAt 取最新", () => {
    const b: WorkerMetrics = {
      snapshotAt: "2026-07-20T09:14:25.000Z",
      llmLatency: { count: 1, avgMs: 1000, p95Ms: 1000, maxMs: 1000 },
      cache: { hits: 0, misses: 3, hitRate: 0 },
    };
    const merged = mergeWorkerSnapshots([workerSnapshot, b]);
    expect(merged).toEqual({
      snapshotAt: "2026-07-20T09:14:25.000Z",
      llmLatency: {
        count: 5,
        // (2184×4 + 1000×1) / 5 = 1947.2 → 1947
        avgMs: 1947,
        p95Ms: 3902,
        maxMs: 4011,
      },
      // 3 / (3 + 4)：以加總重算，而非兩實例比值（0.75、0）的平均 0.375
      cache: { hits: 3, misses: 4, hitRate: 3 / 7 },
    });
  });

  it("閒置實例（count=0、統計為 null）不稀釋加權平均，也不把 null 當 0 參與最大值", () => {
    const merged = mergeWorkerSnapshots([idleSnapshot, workerSnapshot, idleSnapshot]);
    expect(merged?.llmLatency).toEqual(workerSnapshot.llmLatency);
    expect(merged?.cache).toEqual(workerSnapshot.cache);
    expect(merged?.snapshotAt).toBe(idleSnapshot.snapshotAt);
  });

  it("全部閒置 → 統計值與 hitRate 皆為 null（不是 0）", () => {
    const later = { ...idleSnapshot, snapshotAt: "2026-07-20T09:15:00.000Z" };
    expect(mergeWorkerSnapshots([idleSnapshot, later])).toEqual({
      snapshotAt: "2026-07-20T09:15:00.000Z",
      llmLatency: { count: 0, avgMs: null, p95Ms: null, maxMs: null },
      cache: { hits: 0, misses: 0, hitRate: null },
    });
  });

  it("自相矛盾的快照（count=0 卻帶數值）不讓合併結果違反 count=0 ⟹ null 的不變量", () => {
    const odd: WorkerMetrics = {
      ...idleSnapshot,
      llmLatency: { count: 0, avgMs: 5, p95Ms: 5, maxMs: 5 },
    };
    expect(mergeWorkerSnapshots([odd, idleSnapshot])?.llmLatency).toEqual({
      count: 0,
      avgMs: null,
      p95Ms: null,
      maxMs: null,
    });
  });

  it("無法解析的 snapshotAt 不會蓋掉其他實例的新鮮時間", () => {
    const bad = { ...idleSnapshot, snapshotAt: "not-a-date" };
    expect(mergeWorkerSnapshots([bad, workerSnapshot])?.snapshotAt).toBe(workerSnapshot.snapshotAt);
  });
});

describe("mergeMetrics（多實例）", () => {
  it("畸形與過期（null）的快照逐筆略過，只合併有效者", () => {
    const b: WorkerMetrics = {
      snapshotAt: "2026-07-20T09:14:19.000Z",
      llmLatency: { count: 4, avgMs: 1000, p95Ms: 5000, maxMs: 6000 },
      cache: { hits: 1, misses: 3, hitRate: 0.25 },
    };
    const result = mergeMetrics(apiPart, [JSON.stringify(workerSnapshot), null, "{bad", JSON.stringify(b)]);
    expectApiPartIntact(result);
    expect(result.worker).toEqual({
      snapshotAt: workerSnapshot.snapshotAt,
      llmLatency: { count: 8, avgMs: 1592, p95Ms: 5000, maxMs: 6000 },
      cache: { hits: 4, misses: 4, hitRate: 0.5 },
    });
  });

  it("全部畸形 → worker: null", () => {
    expect(mergeMetrics(apiPart, ["{", "[]", null]).worker).toBeNull();
  });
});

describe("過期快照（已消失實例的殘留）", () => {
  // apiPart.collectedAt = 09:14:22.481、windowMs = 60s → 容忍 90s，界線為 09:12:52.481
  const stale: WorkerMetrics = {
    snapshotAt: "2026-07-20T09:12:52.480Z",
    llmLatency: { count: 100, avgMs: 9000, p95Ms: 9999, maxMs: 9999 },
    cache: { hits: 50, misses: 50, hitRate: 0.5 },
  };

  it("過期快照不計入合併，數字不被舊實例墊高", () => {
    const result = mergeMetrics(apiPart, [JSON.stringify(workerSnapshot), JSON.stringify(stale)]);
    expectApiPartIntact(result);
    expect(result.worker).toEqual(workerSnapshot);
  });

  it("全部過期 → worker: null", () => {
    expect(mergeMetrics(apiPart, [JSON.stringify(stale), JSON.stringify(stale)]).worker).toBeNull();
  });

  it("恰在 1.5 × windowMs 界線上仍算新鮮；晚於 collectedAt（時鐘偏差）也算新鮮", () => {
    const edge = { ...stale, snapshotAt: "2026-07-20T09:12:52.481Z" };
    const future = { ...workerSnapshot, snapshotAt: "2026-07-20T09:14:30.000Z" };
    expect(dropStaleSnapshots([edge, future, stale], apiPart.collectedAt, apiPart.windowMs)).toEqual([edge, future]);
  });

  it("snapshotAt 無法解析視為過期；collectedAt 無法解析時不過濾", () => {
    const bad = { ...workerSnapshot, snapshotAt: "not-a-date" };
    expect(dropStaleSnapshots([bad], apiPart.collectedAt, apiPart.windowMs)).toEqual([]);
    expect(dropStaleSnapshots([stale], "garbage", apiPart.windowMs)).toEqual([stale]);
  });
});
