import { describe, expect, it } from "vitest";

/**
 * FR-014：entry-module smoke 測試——斷言 web entry 能乾淨 import
 * （node 環境無 document，不觸發掛載）。
 */
describe("apps/web entry", () => {
  it("entry module 能乾淨 import 且匯出 createGatekeeperApp", async () => {
    const mod = await import("./main.js");
    expect(typeof mod.createGatekeeperApp).toBe("function");
  });
});
