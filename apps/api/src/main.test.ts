import { describe, expect, it } from "vitest";

/**
 * FR-014：entry-module smoke 測試——斷言 api entry 能乾淨 import，
 * 攔截「build 過卻啟動炸」的工具鏈破壞。
 */
describe("apps/api entry", () => {
  it("entry module 能乾淨 import 且匯出 bootstrap", async () => {
    const mod = await import("./main.js");
    expect(typeof mod.bootstrap).toBe("function");
  });
});
