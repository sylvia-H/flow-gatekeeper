import { describe, expect, it } from "vitest";
import { resolveLogLevel, resolveMetricsLogLevel, resolvePretty } from "./level.js";

describe("resolveLogLevel", () => {
  it("未設定時回預設 info", () => {
    expect(resolveLogLevel({})).toEqual({ level: "info", invalidValue: null });
  });

  it("合法值原樣通過", () => {
    expect(resolveLogLevel({ LOG_LEVEL: "warn" })).toEqual({
      level: "warn",
      invalidValue: null,
    });
  });

  it("無法辨識的值回退 info 並回報原始值", () => {
    expect(resolveLogLevel({ LOG_LEVEL: "loud" })).toEqual({
      level: "info",
      invalidValue: "loud",
    });
  });

  it("空字串視為未設定，不回報為非法值", () => {
    expect(resolveLogLevel({ LOG_LEVEL: "" })).toEqual({ level: "info", invalidValue: null });
  });
});

describe("resolvePretty", () => {
  it("NODE_ENV=production 時預設非 pretty", () => {
    expect(resolvePretty({ NODE_ENV: "production" })).toBe(false);
    expect(resolvePretty({ NODE_ENV: "Production " })).toBe(false); // 與 isProductionEnv 同一判準（正規化）
  });

  it("非 production（含未設定）時預設 pretty", () => {
    expect(resolvePretty({ NODE_ENV: "development" })).toBe(true);
    expect(resolvePretty({})).toBe(true);
  });

  it("LOG_PRETTY 可顯式覆寫 NODE_ENV 推導值", () => {
    expect(resolvePretty({ NODE_ENV: "production", LOG_PRETTY: "true" })).toBe(true);
    expect(resolvePretty({ NODE_ENV: "development", LOG_PRETTY: "false" })).toBe(false);
  });
});

describe("resolveMetricsLogLevel", () => {
  it("未設定時回預設 info", () => {
    expect(resolveMetricsLogLevel({})).toBe("info");
  });

  it("合法值原樣通過，且獨立於 LOG_LEVEL", () => {
    expect(resolveMetricsLogLevel({ METRICS_LOG_LEVEL: "debug", LOG_LEVEL: "error" })).toBe(
      "debug",
    );
  });

  it("無法辨識的值靜默回退 info", () => {
    expect(resolveMetricsLogLevel({ METRICS_LOG_LEVEL: "loud" })).toBe("info");
  });
});
