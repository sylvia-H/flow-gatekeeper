import { describe, expect, it } from "vitest";
import {
  EVENT_STRIP_CHROME_PX,
  EVENT_STRIP_MAX,
  EVENT_STRIP_MIN,
  EVENT_STRIP_ROW_PX,
  eventStripHeightForRows,
  eventStripInitialHeight,
} from "./event-strip-size.js";

describe("event-strip-size：事件流面板預設高度對齊整列", () => {
  it("面板高 = 外框 2 + 標題列 34 + 每列 32", () => {
    expect(EVENT_STRIP_CHROME_PX).toBe(36);
    expect(EVENT_STRIP_ROW_PX).toBe(32);
    expect(eventStripHeightForRows(3)).toBe(132);
    expect(eventStripHeightForRows(4)).toBe(164);
  });

  it("夾在上下限 100–360（下限正好是標題＋2 列）", () => {
    expect(EVENT_STRIP_MIN).toBe(100);
    expect(eventStripHeightForRows(2)).toBe(EVENT_STRIP_MIN);
    expect(eventStripHeightForRows(1)).toBe(EVENT_STRIP_MIN);
    expect(eventStripHeightForRows(20)).toBe(EVENT_STRIP_MAX);
  });

  it("視窗高 ≤ 800 → 標題＋2 列（100）；> 800 → 4 列（164）", () => {
    expect(eventStripInitialHeight(768)).toBe(100);
    expect(eventStripInitialHeight(800)).toBe(100);
    expect(eventStripInitialHeight(801)).toBe(164);
    expect(eventStripInitialHeight(900)).toBe(164);
    expect(eventStripInitialHeight(Infinity)).toBe(164);
  });
});
