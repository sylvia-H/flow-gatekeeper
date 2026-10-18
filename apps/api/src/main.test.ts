import { describe, expect, it } from "vitest";
import * as mod from "./main.js";

/**
 * FR-014：entry-module smoke 測試——斷言 api entry 能乾淨 import，
 * 攔截「build 過卻啟動炸」的工具鏈破壞。
 *
 * 檔頂靜態 import（TQ-14）：entry 載入失敗時整個檔案在收集階段就失敗，而不是藏在 `it` 內的動態
 * import；冷載入整個 NestJS AppModule graph 的時間也不再受單一測試的 timeout 限制。
 */
describe("apps/api entry", () => {
  it("entry module 能乾淨 import 且匯出 bootstrap", () => {
    expect(typeof mod.bootstrap).toBe("function");
  });
});
