import { describe, expect, it } from "vitest";

/**
 * FR-014：entry-module smoke 測試——斷言 worker entry 能乾淨 import。
 */
describe("apps/worker entry", () => {
  it("entry module 能乾淨 import 且匯出 bootstrap", async () => {
    const mod = await import("./main.js");
    expect(typeof mod.bootstrap).toBe("function");
  });
});
