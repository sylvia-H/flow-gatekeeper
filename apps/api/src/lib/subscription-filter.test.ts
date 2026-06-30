import { describe, expect, it } from "vitest";
import type { TelemetryPoint } from "@flow-gatekeeper/contracts";
import { filterPointsForSubscription } from "./subscription-filter.js";

function point(machineId: string): TelemetryPoint {
  return {
    type: "machine/data",
    machineId,
    timestamp: new Date(0).toISOString(),
    telemetry: { temperature: 70, vibration: 0.3, throughput: 120, errorRate: 0.01 },
    state: "healthy",
  };
}

const batch = [point("mixer-01"), point("press-02"), point("oven-04")];

describe("filterPointsForSubscription", () => {
  it("只回傳訂閱集合內的機台", () => {
    const out = filterPointsForSubscription(batch, new Set(["press-02"]));
    expect(out.map((p) => p.machineId)).toEqual(["press-02"]);
  });

  it("空訂閱集合回傳空陣列（未訂閱者不收遙測）", () => {
    expect(filterPointsForSubscription(batch, new Set())).toEqual([]);
  });

  it("不相交訂閱集合互不外洩（SC-001）", () => {
    const a = filterPointsForSubscription(batch, new Set(["press-02"]));
    const b = filterPointsForSubscription(batch, new Set(["oven-04"]));
    expect(a.some((p) => p.machineId === "oven-04")).toBe(false);
    expect(b.some((p) => p.machineId === "press-02")).toBe(false);
  });

  it("訂閱不存在的機台不報錯且回傳空", () => {
    expect(filterPointsForSubscription(batch, new Set(["ghost-99"]))).toEqual([]);
  });
});
