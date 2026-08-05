import { describe, expect, it } from "vitest";
import { isStale } from "./stale.js";

describe("isStale（FR-017 / SC-005）", () => {
  it("超過門檻 → stale", () => {
    expect(isStale(0, 10_001)).toBe(true);
  });

  it("恰好等於門檻 → 非 stale（嚴格大於）", () => {
    expect(isStale(0, 10_000)).toBe(false);
  });

  it("小於門檻 → 非 stale", () => {
    expect(isStale(0, 9_999)).toBe(false);
    expect(isStale(5_000, 5_000)).toBe(false);
  });

  it("可自訂門檻", () => {
    expect(isStale(0, 3_001, 3_000)).toBe(true);
    expect(isStale(0, 3_000, 3_000)).toBe(false);
  });
});
