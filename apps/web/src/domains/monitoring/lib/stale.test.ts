import { describe, expect, it } from "vitest";
import { isStale, staleClock } from "./stale.js";

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

describe("staleClock — Pause 期間凍結 stale 時鐘", () => {
  it("未暫停 → 照走 now", () => {
    expect(staleClock(50_000, null, true)).toBe(50_000);
  });

  it("暫停且連線中 → 凍結在 pausedAt，暫停再久也不判 stale", () => {
    const pausedAt = 1_000;
    const clock = staleClock(1_000 + 60_000, pausedAt, true);
    expect(clock).toBe(pausedAt);
    expect(isStale(900, clock)).toBe(false);
  });

  it("暫停但已斷線 → 不凍結（資料真的停了，應標 stale）", () => {
    expect(staleClock(61_000, 1_000, false)).toBe(61_000);
    expect(isStale(900, staleClock(61_000, 1_000, false))).toBe(true);
  });
});
