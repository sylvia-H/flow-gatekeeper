import { describe, expect, it } from "vitest";
import { SystemMetricsSchema, TelemetryPointSchema } from "./events.js";
import { WorkerMetricsSchema } from "./metrics.js";

/**
 * 契約中的時間戳欄位對齊 asyncapi 的 `format: date-time`（RFC 3339 §5.6）：
 * 須含秒、可帶小數秒、時區為 `Z` 或 `±hh:mm`。Zod 4 的 `z.iso.datetime()` 預設只收 `Z` 結尾，
 * 比 RFC 3339 嚴；契約以 `{ offset: true }` 放寬到與文件一致，這裡鎖定正反例。
 */
const worker = {
  snapshotAt: "2026-09-27T00:00:00.000Z",
  llmLatency: { count: 0, avgMs: null, p95Ms: null, maxMs: null },
  cache: { hits: 0, misses: 0, hitRate: null },
};
const metrics = {
  type: "system/metrics",
  windowMs: 5000,
  collectedAt: "2026-09-27T00:00:00.000Z",
  queue: { waiting: 0, active: 0, failed: 0 },
  wsConnections: 1,
  worker,
};
const point = {
  type: "machine/data",
  machineId: "press-01",
  timestamp: "2026-09-27T00:00:00.000Z",
  telemetry: { temperature: 1, vibration: 1, throughput: 1, errorRate: 0 },
  state: "healthy",
};

const cases: [string, (v: string) => boolean][] = [
  ["WorkerMetrics.snapshotAt", (v) => WorkerMetricsSchema.safeParse({ ...worker, snapshotAt: v }).success],
  ["SystemMetrics.collectedAt", (v) => SystemMetricsSchema.safeParse({ ...metrics, collectedAt: v }).success],
  ["TelemetryPoint.timestamp", (v) => TelemetryPointSchema.safeParse({ ...point, timestamp: v }).success],
];

describe.each(cases)("%s 依 RFC 3339 驗證", (_name, accepts) => {
  it.each([
    "2026-01-01T00:00:00Z",
    "2026-01-01T00:00:00.123Z",
    "2026-01-01T00:00:00+08:00",
    "2026-01-01T00:00:00.5-05:30",
  ])("接受 %s", (v) => {
    expect(accepts(v)).toBe(true);
  });

  it.each([
    "2026-01-01T00:00Z", // RFC 3339 的 partial-time 必含秒
    "2026-01-01T00:00:00", // 缺時區
    "2026-01-01",
    "2026-02-30T00:00:00Z",
    "not-a-date",
  ])("拒絕 %s", (v) => {
    expect(accepts(v)).toBe(false);
  });
});
