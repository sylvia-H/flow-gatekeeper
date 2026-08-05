import { describe, expect, it } from "vitest";
import {
  DEFAULT_HEALTH_PROBE_TIMEOUT_MS,
  resolveHealthProbeTimeout,
} from "./health-probe-timeout.js";

describe("resolveHealthProbeTimeout", () => {
  it("未設定 → 預設 2000ms，不回報回退", () => {
    expect(resolveHealthProbeTimeout({})).toEqual({
      timeoutMs: DEFAULT_HEALTH_PROBE_TIMEOUT_MS,
      fellBackToDefault: false,
      rawValue: undefined,
    });
  });

  it("留空（HEALTH_PROBE_TIMEOUT_MS=）視同未設定，MUST NOT 變成 0", () => {
    const resolved = resolveHealthProbeTimeout({ HEALTH_PROBE_TIMEOUT_MS: "" });
    expect(resolved.timeoutMs).toBe(DEFAULT_HEALTH_PROBE_TIMEOUT_MS);
    expect(resolved.fellBackToDefault).toBe(false);
  });

  it("合法正數照用", () => {
    expect(resolveHealthProbeTimeout({ HEALTH_PROBE_TIMEOUT_MS: "500" })).toEqual({
      timeoutMs: 500,
      fellBackToDefault: false,
      rawValue: "500",
    });
  });

  it.each(["abc", "NaN", "0", "-1", "Infinity"])(
    "不合法值 %s → 回退預設並回報 fellBackToDefault",
    (raw) => {
      const resolved = resolveHealthProbeTimeout({ HEALTH_PROBE_TIMEOUT_MS: raw });
      expect(resolved.timeoutMs).toBe(DEFAULT_HEALTH_PROBE_TIMEOUT_MS);
      expect(resolved.fellBackToDefault).toBe(true);
      expect(resolved.rawValue).toBe(raw);
    },
  );
});
