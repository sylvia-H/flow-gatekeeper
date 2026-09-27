import { describe, expect, it } from "vitest";
import { backpressureRatio } from "./backpressure.js";

describe("backpressureRatio（design-spec §7.2.1）", () => {
  it("received / rendered 四捨五入", () => {
    expect(backpressureRatio(21, 3)).toBe(7);
    expect(backpressureRatio(10, 4)).toBe(3);
  });

  it("renderedBatches === 0 → 0（避免除以零）", () => {
    expect(backpressureRatio(0, 0)).toBe(0);
    expect(backpressureRatio(50, 0)).toBe(0);
  });
});
