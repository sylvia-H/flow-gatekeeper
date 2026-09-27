import { describe, expect, it } from "vitest";
import type { WorkerMetrics } from "@flow-gatekeeper/contracts";
import { mergeMetrics } from "./metrics-merge.js";
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
    const result = mergeMetrics(apiPart, JSON.stringify(workerSnapshot));
    expectApiPartIntact(result);
    expect(result.worker).toEqual(workerSnapshot);
  });

  it("worker 快照缺席／過期（key 不存在）時 worker 為 null，api 兩項不受影響", () => {
    const result = mergeMetrics(apiPart, null);
    expectApiPartIntact(result);
    expect(result.worker).toBeNull();
  });

  it("畸形 JSON 降級為 null 而不拋錯", () => {
    const result = mergeMetrics(apiPart, "{not json");
    expectApiPartIntact(result);
    expect(result.worker).toBeNull();
  });

  it("JSON 合法但非物件（如 null／字串／陣列）降級為 null", () => {
    for (const raw of ["null", '"worker"', "[]", "42"]) {
      const result = mergeMetrics(apiPart, raw);
      expectApiPartIntact(result);
      expect(result.worker).toBeNull();
    }
  });

  it("欄位缺漏降級為 null", () => {
    const missingCache = { snapshotAt: workerSnapshot.snapshotAt, llmLatency: workerSnapshot.llmLatency };
    expect(mergeMetrics(apiPart, JSON.stringify(missingCache)).worker).toBeNull();

    const missingSnapshotAt = { llmLatency: workerSnapshot.llmLatency, cache: workerSnapshot.cache };
    expect(mergeMetrics(apiPart, JSON.stringify(missingSnapshotAt)).worker).toBeNull();

    const missingCount = {
      ...workerSnapshot,
      llmLatency: { avgMs: 1, p95Ms: 1, maxMs: 1 },
    };
    expect(mergeMetrics(apiPart, JSON.stringify(missingCount)).worker).toBeNull();
  });

  it("欄位型別不符降級為 null", () => {
    const badSnapshotAt = { ...workerSnapshot, snapshotAt: 1784286860004 };
    expect(mergeMetrics(apiPart, JSON.stringify(badSnapshotAt)).worker).toBeNull();

    const badCount = { ...workerSnapshot, llmLatency: { ...workerSnapshot.llmLatency, count: "4" } };
    expect(mergeMetrics(apiPart, JSON.stringify(badCount)).worker).toBeNull();

    const badHitRate = { ...workerSnapshot, cache: { ...workerSnapshot.cache, hitRate: "0.75" } };
    expect(mergeMetrics(apiPart, JSON.stringify(badHitRate)).worker).toBeNull();
  });

  it("計數違反契約（負數、非整數）降級為 null", () => {
    const negativeHits = { ...workerSnapshot, cache: { ...workerSnapshot.cache, hits: -1 } };
    expect(mergeMetrics(apiPart, JSON.stringify(negativeHits)).worker).toBeNull();

    const fractionalCount = { ...workerSnapshot, llmLatency: { ...workerSnapshot.llmLatency, count: 1.5 } };
    expect(mergeMetrics(apiPart, JSON.stringify(fractionalCount)).worker).toBeNull();
  });

  it("契約以外的多餘欄位不外洩到廣播 payload", () => {
    const extra = { ...workerSnapshot, injected: "<script>" };
    expect(mergeMetrics(apiPart, JSON.stringify(extra)).worker).toEqual(workerSnapshot);
  });

  it("空樣本的合法快照（統計值為 null）不被誤判為畸形", () => {
    const idle: WorkerMetrics = {
      snapshotAt: "2026-07-20T09:15:20.004Z",
      llmLatency: { count: 0, avgMs: null, p95Ms: null, maxMs: null },
      cache: { hits: 0, misses: 0, hitRate: null },
    };
    expect(mergeMetrics(apiPart, JSON.stringify(idle)).worker).toEqual(idle);
  });

  it("任何降級情境都不拋錯", () => {
    for (const raw of [null, "", "{", "undefined", '{"snapshotAt":{}}']) {
      expect(() => mergeMetrics(apiPart, raw)).not.toThrow();
    }
  });
});
