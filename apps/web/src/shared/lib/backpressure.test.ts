import { describe, expect, it } from "vitest";
import { backpressureRatio } from "./backpressure.js";

describe("backpressureRatio（received / rendered 累計比值）", () => {
  it("received / rendered，不取整（顯示端統一一位小數）", () => {
    expect(backpressureRatio(21, 3)).toBe(7);
    expect(backpressureRatio(10, 4)).toBe(2.5);
    expect(backpressureRatio(7, 5)).toBeCloseTo(1.4);
  });

  it("renderedBatches === 0 → 0（避免除以零）", () => {
    expect(backpressureRatio(0, 0)).toBe(0);
    expect(backpressureRatio(50, 0)).toBe(0);
  });
});
