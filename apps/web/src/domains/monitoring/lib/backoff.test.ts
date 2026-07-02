import { describe, expect, it } from "vitest";
import { nextBackoffDelay } from "./backoff.js";

describe("nextBackoffDelay（FR-013 / SC-003）", () => {
  it("rng=0 → 等於 base（1000·2^attempt，cap maxMs）", () => {
    expect(nextBackoffDelay(0, 30_000, () => 0)).toBe(1000);
    expect(nextBackoffDelay(1, 30_000, () => 0)).toBe(2000);
    expect(nextBackoffDelay(2, 30_000, () => 0)).toBe(4000);
    expect(nextBackoffDelay(3, 30_000, () => 0)).toBe(8000);
  });

  it("上界：rng=1 → base 的 1.3 倍", () => {
    expect(nextBackoffDelay(0, 30_000, () => 1)).toBe(1300);
    expect(nextBackoffDelay(2, 30_000, () => 1)).toBe(5200);
  });

  it("cap 於 maxMs：大 attempt 的 base 不超過 maxMs", () => {
    // 2^20 * 1000 遠大於 30000 → base 應 cap 為 30000
    expect(nextBackoffDelay(20, 30_000, () => 0)).toBe(30_000);
    expect(nextBackoffDelay(20, 30_000, () => 1)).toBe(39_000); // cap 後再加抖動
  });

  it("到 cap 前，base（rng=0）單調不減", () => {
    let prev = -1;
    for (let attempt = 0; attempt <= 6; attempt++) {
      const delay = nextBackoffDelay(attempt, 30_000, () => 0);
      expect(delay).toBeGreaterThanOrEqual(prev);
      prev = delay;
    }
  });

  it("抖動落在 [base, base*1.3] 區間", () => {
    const base = 4000; // attempt=2
    for (const r of [0, 0.25, 0.5, 0.75, 0.99]) {
      const delay = nextBackoffDelay(2, 30_000, () => r);
      expect(delay).toBeGreaterThanOrEqual(base);
      expect(delay).toBeLessThanOrEqual(Math.round(base * 1.3));
    }
  });
});
