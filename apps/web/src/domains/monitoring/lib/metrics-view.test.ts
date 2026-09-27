import { describe, expect, it } from "vitest";
import type { SystemMetrics } from "@flow-gatekeeper/contracts";
import { persistView } from "./metrics-view.js";

const BASE: SystemMetrics = {
  type: "system/metrics",
  windowMs: 60_000,
  collectedAt: "2026-09-27T00:00:00.000Z",
  queue: { waiting: 0, active: 0, failed: 0 },
  wsConnections: 1,
  worker: null,
};

describe("persistView — 遙測落地累計", () => {
  it("尚無快照或舊版 api 不帶 persist → 兩格皆「—」（不是 0）", () => {
    expect(persistView(null)).toEqual({ dropped: "—", failed: "—" });
    expect(persistView(BASE)).toEqual({ dropped: "—", failed: "—" });
  });

  it("帶 persist → 以千分位顯示，0 照實顯示 0", () => {
    expect(persistView({ ...BASE, persist: { dropped: 12_345, failed: 0 } })).toEqual({
      dropped: "12,345",
      failed: "0",
    });
  });
});
