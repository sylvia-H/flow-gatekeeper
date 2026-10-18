/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
// 檔頂 import（TQ-14）：冷載入整個 Vue app graph（App.vue → 全部元件／store）移到 collection 階段，
// 不再算進單支測試的 timeout——原本在 `it` 內 `await import()`，`pnpm check` 多套件並行或多 agent 同跑時
// Windows 冷 transform 實測 15–27 s，常超過 timeout。import 拋錯時整個檔案仍會失敗，斷言強度不變。
import * as entry from "./main.js";
import App from "./App.vue";

/**
 * FR-014 / research R8：entry-module smoke 測試。
 *
 * T011 把 entry 由 001 的 `createGatekeeperApp` 骨架改為實際掛載，
 * 舊斷言（匯出 factory）已不成立。改為斷言：node 環境（無 document）下
 * import entry 不觸發掛載、不丟錯，且 App 元件可乾淨 import。
 */
describe("apps/web entry", () => {
  it("entry module 於 node 環境可乾淨 import（不觸發掛載、不丟錯）", () => {
    expect(entry).toBeTruthy();
  });

  it("App 根元件可 import", () => {
    expect(App).toBeTruthy();
  });
});

/**
 * WEB-13：zod `jitless` 必須在任何 schema 建構之前生效（zod 4.6.5 在 `z.object()` 建構時就探測 eval，
 * 含 contracts 模組載入時頂層求值的 schema），所以 `zod-config.js` MUST 是 main.ts 的第一個 import
 * （ES module 依 import 順序執行；排在後面就晚於 App 元件圖與 contracts 載入）。
 */
describe("zod 全域設定（WEB-13）", () => {
  it("載入 entry 後 zod 的 jitless 已開啟（不再以 new Function 探測 eval，CSP 不記違規）", () => {
    expect(z.config().jitless).toBe(true);
  });

  it("main.ts 的第一個 import 是 ./zod-config.js", () => {
    const source = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
    const firstImport = /^\s*import\s[^;]*?["']([^"']+)["']/m.exec(source)?.[1];
    expect(firstImport).toBe("./zod-config.js");
  });
});
