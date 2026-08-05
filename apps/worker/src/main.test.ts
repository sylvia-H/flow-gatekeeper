import { describe, expect, it } from "vitest";

/**
 * FR-014：entry-module smoke 測試——斷言 worker entry 能乾淨 import。
 */
describe("apps/worker entry", () => {
  // import 會 transform 整個依賴圖（bullmq/mongodb/gemini SDK），本機基線即 4–6s，
  // 高於 vitest 預設 5s——給足額度，避免機器負載造成的邊界性 flake。
  it("entry module 能乾淨 import 且匯出 bootstrap", { timeout: 20_000 }, async () => {
    const mod = await import("./main.js");
    expect(typeof mod.bootstrap).toBe("function");
  });
});
