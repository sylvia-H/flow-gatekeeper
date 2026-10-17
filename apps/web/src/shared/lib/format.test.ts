import { describe, expect, it } from "vitest";
import { formatClock, formatDuration, formatRelative } from "./format.js";

describe("formatClock（本地 24h HH:mm:ss）", () => {
  it("補零且為 24 小時制", () => {
    expect(formatClock(new Date(2026, 9, 15, 9, 5, 7).getTime())).toBe("09:05:07");
    expect(formatClock(new Date(2026, 9, 15, 23, 59, 59, 999).getTime())).toBe("23:59:59");
    expect(formatClock(new Date(2026, 9, 15, 0, 0, 0).getTime())).toBe("00:00:00");
  });
});

describe("formatRelative", () => {
  const now = 1_000_000_000;
  it("≤ 2000 ms（閉區間）為「剛剛」", () => {
    expect(formatRelative(now, now)).toBe("剛剛");
    expect(formatRelative(now - 2_000, now)).toBe("剛剛");
  });
  it("2001 ms 起為「N 秒前」", () => {
    expect(formatRelative(now - 2_001, now)).toBe("2 秒前");
    expect(formatRelative(now - 12_000, now)).toBe("12 秒前");
    expect(formatRelative(now - 59_999, now)).toBe("59 秒前");
  });
  it("≥ 60 秒為「N 分鐘前」", () => {
    expect(formatRelative(now - 60_000, now)).toBe("1 分鐘前");
    expect(formatRelative(now - 125_000, now)).toBe("2 分鐘前");
    expect(formatRelative(now - 3 * 60 * 60_000, now)).toBe("180 分鐘前");
  });
  it("未來時間夾為「剛剛」", () => {
    expect(formatRelative(now + 5_000, now)).toBe("剛剛");
  });
});

describe("formatDuration", () => {
  it("先四捨五入到整數 ms：999.4 → 999 ms、999.6 → 1.0 s", () => {
    expect(formatDuration(999.4)).toBe("999 ms");
    expect(formatDuration(999.6)).toBe("1.0 s");
  });
  it("< 1000 ms 顯示整數 ms", () => {
    expect(formatDuration(0)).toBe("0 ms");
    expect(formatDuration(12.5)).toBe("13 ms");
    expect(formatDuration(999)).toBe("999 ms");
  });
  it("≥ 1000 ms 顯示四捨五入到一位小數的秒", () => {
    expect(formatDuration(1_000)).toBe("1.0 s");
    expect(formatDuration(1_049)).toBe("1.0 s");
    expect(formatDuration(1_050)).toBe("1.1 s");
    expect(formatDuration(2_345.6)).toBe("2.3 s");
    expect(formatDuration(61_000)).toBe("61.0 s");
  });
});
