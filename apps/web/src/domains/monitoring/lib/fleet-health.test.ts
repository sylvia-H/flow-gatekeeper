import { describe, expect, it } from "vitest";
import type { MachineState } from "@flow-gatekeeper/contracts";
import type { MachineLive } from "../stores/monitoring.store.js";
import { fleetHealthOf } from "./fleet-health.js";

const ROSTER = ["mixer-01", "press-02", "pack-03", "oven-04", "sorter-05"] as const;
const NOW = 1_000_000_000;

function live(machineId: string, state: MachineState, ageMs = 0): MachineLive {
  return {
    machineId,
    state,
    telemetry: { temperature: 20, vibration: 0.2, throughput: 100, errorRate: 0 },
    lastUpdated: NOW - ageMs,
  };
}

function mapOf(...ms: MachineLive[]): Map<string, MachineLive> {
  return new Map(ms.map((m) => [m.machineId, m]));
}

describe("fleetHealthOf（FR-006/007/008、SC-003）", () => {
  it("四類之和恆等於 roster 長度（含 stale）", () => {
    const s = fleetHealthOf(mapOf(live("mixer-01", "healthy")), NOW, ROSTER);
    expect(s.total).toBe(5);
    expect(s.healthy + s.warning + s.critical + s.stale).toBe(5);
  });

  it("never-reported（無快照）併入 stale", () => {
    const s = fleetHealthOf(new Map(), NOW, ROSTER);
    expect(s.stale).toBe(5);
    expect(s.healthy).toBe(0);
  });

  it("isStale(>10s) 併入 stale 而非其 state", () => {
    const s = fleetHealthOf(mapOf(live("mixer-01", "critical", 11_000)), NOW, ROSTER);
    expect(s.critical).toBe(0);
    expect(s.stale).toBe(5); // 1 stale + 4 never-reported
  });

  it("依快照 state 計數且與 total 一致", () => {
    const s = fleetHealthOf(
      mapOf(
        live("mixer-01", "healthy"),
        live("press-02", "warning"),
        live("pack-03", "critical"),
        live("oven-04", "healthy"),
        live("sorter-05", "warning"),
      ),
      NOW,
      ROSTER,
    );
    expect(s).toEqual({ healthy: 2, warning: 2, critical: 1, stale: 0, total: 5 });
  });
});
