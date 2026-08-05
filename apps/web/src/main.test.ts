import { describe, expect, it } from "vitest";

/**
 * FR-014 / research R8：entry-module smoke 測試。
 *
 * T011 把 entry 由 001 的 `createGatekeeperApp` 骨架改為實際掛載，
 * 舊斷言（匯出 factory）已不成立。改為斷言：node 環境（無 document）下
 * import entry 不觸發掛載、不丟錯，且 App 元件可乾淨 import。
 */
describe("apps/web entry", () => {
  // timeout 30s：此測試冷載入整個 Vue app graph（App.vue → 全部元件／store），在 `pnpm check`
  // 的多套件並行負載下，Windows 冷 transform 常超過 vitest 預設 5s（暖快取實際 ~1-2s）。放寬
  // timeout 只是給足冷載入時間，不弱化「乾淨 import 不丟錯」的斷言。
  it("entry module 於 node 環境可乾淨 import（不觸發掛載、不丟錯）", async () => {
    await expect(import("./main.js")).resolves.toBeTruthy();
  }, 30_000);

  it("App 根元件可 import", async () => {
    const mod = await import("./App.vue");
    expect(mod.default).toBeTruthy();
  });
});
