import { describe, expect, it } from "vitest";
import { hitRate } from "./hit-rate.js";

describe("hitRate", () => {
  it("分母為 0 時回 null（不是 0）", () => {
    expect(hitRate(0, 0)).toBeNull();
  });

  it("全部命中回 1", () => {
    expect(hitRate(4, 0)).toBe(1);
  });

  it("全部落空回 0（與 null 語意不同）", () => {
    expect(hitRate(0, 4)).toBe(0);
  });

  it("比值正確", () => {
    expect(hitRate(3, 1)).toBe(0.75);
  });

  it("窗內計數不受累計污染：歸零後的新窗獨立計算", () => {
    // 上一窗 3/1 = 0.75；歸零後新窗只有 1 次未命中 → 0，不是被歷史稀釋的中間值。
    expect(hitRate(3, 1)).toBe(0.75);
    expect(hitRate(0, 1)).toBe(0);
  });
});
