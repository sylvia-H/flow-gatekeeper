import { afterEach, describe, expect, it, vi } from "vitest";
import { fatal, formatFatal } from "./fatal.js";

const writeSyncMock = vi.hoisted(() => vi.fn());
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  writeSync: writeSyncMock,
}));

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

  it("所有 kind 皆以一致格式呈現", () => {
    for (const kind of ["uncaughtException", "unhandledRejection", "invalidConfig", "bootstrap"] as const) {
      expect(formatFatal(kind, "x")).toBe(`${kind}（致命，worker 將結束交由監督者重啟）：x`);
    }
  });
});

describe("fatal", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    writeSyncMock.mockReset();
  });

  it("bootstrap 失敗：先以 writeSync 同步寫 stderr，再 exit(1)", () => {
    const order: string[] = [];
    writeSyncMock.mockImplementation(() => order.push("write"));
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      order.push("exit");
      throw new Error("exit called");
    });

    expect(() => fatal("bootstrap", new Error("mongo down"))).toThrow("exit called");
    expect(order).toEqual(["write", "exit"]);
    expect(writeSyncMock).toHaveBeenCalledWith(2, expect.stringMatching(/^\[worker\] bootstrap（致命.*mongo down/s));
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("writeSync 丟錯（stderr 不可寫）：仍 exit(1)，不讓錯誤從致命處理器拋出", () => {
    writeSyncMock.mockImplementation(() => {
      throw Object.assign(new Error("EPIPE: broken pipe, write"), { code: "EPIPE" });
    });
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit called");
    });

    expect(() => fatal("uncaughtException", new Error("boom"))).toThrow("exit called");
    expect(writeSyncMock).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });
});
