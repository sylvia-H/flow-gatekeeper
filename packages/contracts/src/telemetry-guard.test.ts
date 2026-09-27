import { describe, expect, it } from "vitest";
import { isTelemetryBatch, isTelemetryPoint, TelemetryPointSchema } from "./events.js";

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

  const malformed: [string, unknown][] = [
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
  ];

  it.each(malformed)("拒絕畸形資料：%s", (_label, value) => {
    expect(isTelemetryPoint(value)).toBe(false);
  });

  // 高頻路徑只用手寫守衛、不逐筆 safeParse（硬規則 1）；schema 只供漂移測試與低頻用途。
  // 兩者對同一組正反例必須判定一致，守衛才稱得上是 schema 的等價快速版。
  it.each<[string, unknown]>([
    ["合法資料點", valid],
    ["帶額外欄位（兩者皆接受）", { ...valid, extra: 1 }],
    ...malformed,
  ])("isTelemetryPoint 與 TelemetryPointSchema.safeParse 判定一致：%s", (_label, value) => {
    expect(isTelemetryPoint(value)).toBe(TelemetryPointSchema.safeParse(value).success);
  });

  it("唯一刻意的差異：守衛不驗 timestamp 的 ISO-8601 格式，schema 會驗", () => {
    const loose = { ...valid, timestamp: "not-a-date" };
    expect(isTelemetryPoint(loose)).toBe(true);
    expect(TelemetryPointSchema.safeParse(loose).success).toBe(false);
  });

  it("isTelemetryBatch 要求陣列且每筆皆合法", () => {
    expect(isTelemetryBatch([valid, { ...valid, machineId: "press-02" }])).toBe(true);
    expect(isTelemetryBatch([])).toBe(true);
    expect(isTelemetryBatch(valid)).toBe(false);
    expect(isTelemetryBatch([valid, null])).toBe(false);
    expect(isTelemetryBatch("[]")).toBe(false);
  });
});
