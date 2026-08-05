import { describe, expect, it } from "vitest";

/**
 * FR-014：entry-module smoke 測試——斷言 api entry 能乾淨 import，
 * 攔截「build 過卻啟動炸」的工具鏈破壞。
 */
describe("apps/api entry", () => {
  // timeout 30s：此測試冷載入整個 NestJS AppModule graph，在 `pnpm check` 的多套件並行負載下，
  // Windows 冷 transform 常超過 vitest 預設 5s（暖快取實際 ~2s）。放寬 timeout 只是給足冷載入時間，
  // 不弱化「乾淨 import 且匯出 bootstrap」的斷言。
  it("entry module 能乾淨 import 且匯出 bootstrap", async () => {
    const mod = await import("./main.js");
    expect(typeof mod.bootstrap).toBe("function");
  }, 30_000);
});
