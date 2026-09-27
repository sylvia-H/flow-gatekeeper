import { describe, expect, it } from "vitest";
import { isTelemetryBatch, isTelemetryPoint } from "./events.js";

describe("isTelemetryPoint", () => {
  const valid = {
    type: "machine/data",
    machineId: "press-01",
    timestamp: "2026-09-27T00:00:00.000Z",
    telemetry: { temperature: 72.5, vibration: 0.4, throughput: 118, errorRate: 0.01 },
    state: "healthy",
  };

  it("接受合法資料點", () => {
    expect(isTelemetryPoint(valid)).toBe(true);
  });

  it.each([
    ["null", null],
    ["數字", 42],
    ["陣列", [valid]],
    ["type 不符", { ...valid, type: "job/status" }],
    ["machineId 非字串", { ...valid, machineId: 1 }],
    ["timestamp 缺漏", { ...valid, timestamp: undefined }],
    ["state 非三值之一", { ...valid, state: "ok" }],
    ["telemetry 為 null", { ...valid, telemetry: null }],
    ["數值為字串", { ...valid, telemetry: { ...valid.telemetry, temperature: "72" } }],
    ["數值為 NaN", { ...valid, telemetry: { ...valid.telemetry, vibration: Number.NaN } }],
    [
      "數值為 Infinity",
      { ...valid, telemetry: { ...valid.telemetry, throughput: Number.POSITIVE_INFINITY } },
    ],
    ["缺數值欄位", { ...valid, telemetry: { temperature: 1, vibration: 1, throughput: 1 } }],
  ])("拒絕畸形資料：%s", (_label, value) => {
    expect(isTelemetryPoint(value)).toBe(false);
  });

  it("isTelemetryBatch 要求陣列且每筆皆合法", () => {
    expect(isTelemetryBatch([valid, { ...valid, machineId: "press-02" }])).toBe(true);
    expect(isTelemetryBatch([])).toBe(true);
    expect(isTelemetryBatch(valid)).toBe(false);
    expect(isTelemetryBatch([valid, null])).toBe(false);
    expect(isTelemetryBatch("[]")).toBe(false);
  });
});
