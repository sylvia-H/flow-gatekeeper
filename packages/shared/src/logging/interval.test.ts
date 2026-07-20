import { describe, expect, it } from "vitest";
import { resolveMetricsInterval } from "./interval.js";

describe("resolveMetricsInterval", () => {
  it("未設定回預設 60000", () => {
    expect(resolveMetricsInterval({})).toEqual({
      intervalMs: 60_000,
      fellBackToDefault: false,
      rawValue: undefined,
    });
  });

  it("4999（低於下限）回退預設 60000", () => {
    expect(resolveMetricsInterval({ METRICS_INTERVAL_MS: "4999" })).toEqual({
      intervalMs: 60_000,
      fellBackToDefault: true,
      rawValue: "4999",
    });
  });

  it("5000（下限邊界）原樣通過，不回退", () => {
    expect(resolveMetricsInterval({ METRICS_INTERVAL_MS: "5000" })).toEqual({
      intervalMs: 5_000,
      fellBackToDefault: false,
      rawValue: "5000",
    });
  });

  it("非數值回退預設", () => {
    expect(resolveMetricsInterval({ METRICS_INTERVAL_MS: "loud" })).toEqual({
      intervalMs: 60_000,
      fellBackToDefault: true,
      rawValue: "loud",
    });
  });

  it("負數回退預設", () => {
    expect(resolveMetricsInterval({ METRICS_INTERVAL_MS: "-1000" })).toEqual({
      intervalMs: 60_000,
      fellBackToDefault: true,
      rawValue: "-1000",
    });
  });

  it("合法值（大於下限）原樣通過", () => {
    expect(resolveMetricsInterval({ METRICS_INTERVAL_MS: "120000" })).toEqual({
      intervalMs: 120_000,
      fellBackToDefault: false,
      rawValue: "120000",
    });
  });
});
