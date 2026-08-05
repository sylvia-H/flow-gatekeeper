import { describe, expect, it } from "vitest";
import { formatFatal } from "./fatal.js";

/** formatFatal 格式化決定性（憲章測試門檻；contracts/supervision-runtime.md §5）。 */
describe("formatFatal", () => {
  it("Error 有 stack 時取 stack", () => {
    const err = new Error("boom");
    const msg = formatFatal("uncaughtException", err);
    expect(msg).toBe(`uncaughtException（致命，worker 將結束交由監督者重啟）：${err.stack}`);
    expect(msg).toContain("boom");
  });

  it("Error 無 stack 時退回 message", () => {
    const err = new Error("no-stack");
    err.stack = undefined;
    expect(formatFatal("unhandledRejection", err)).toBe(
      "unhandledRejection（致命，worker 將結束交由監督者重啟）：no-stack",
    );
  });

  it("非 Error 值一律 String()：字串", () => {
    expect(formatFatal("unhandledRejection", "raw reason")).toBe(
      "unhandledRejection（致命，worker 將結束交由監督者重啟）：raw reason",
    );
  });

  it("非 Error 值一律 String()：數字與 undefined/null", () => {
    expect(formatFatal("uncaughtException", 42)).toContain("：42");
    expect(formatFatal("unhandledRejection", undefined)).toContain("：undefined");
    expect(formatFatal("unhandledRejection", null)).toContain("：null");
  });

  it("兩種 kind 皆以一致格式呈現", () => {
    for (const kind of ["uncaughtException", "unhandledRejection"] as const) {
      expect(formatFatal(kind, "x")).toBe(`${kind}（致命，worker 將結束交由監督者重啟）：x`);
    }
  });
});
