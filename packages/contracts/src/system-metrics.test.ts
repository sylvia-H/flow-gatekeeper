import { describe, expect, it } from "vitest";
import { SystemMetricsSchema } from "./events.js";

const base = {
  type: "system/metrics",
  windowMs: 60_000,
  collectedAt: "2026-09-27T00:00:00.000Z",
  queue: { waiting: 0, active: 0, failed: 0 },
  wsConnections: 1,
  worker: null,
};

describe("SystemMetricsSchema.persist", () => {
  it("缺席時仍合法（舊版 api 相容）", () => {
    expect(SystemMetricsSchema.safeParse(base).success).toBe(true);
  });

  it("帶非負整數的 dropped／failed 合法", () => {
    const parsed = SystemMetricsSchema.parse({ ...base, persist: { dropped: 12, failed: 3 } });
    expect(parsed.persist).toEqual({ dropped: 12, failed: 3 });
  });

  it.each([
    { dropped: -1, failed: 0 },
    { dropped: 0, failed: 1.5 },
    { dropped: 0 },
    null,
  ])("不合法的 persist %j 被拒", (persist) => {
    expect(SystemMetricsSchema.safeParse({ ...base, persist }).success).toBe(false);
  });
});
