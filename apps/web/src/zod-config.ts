import { z } from "zod";

/**
 * zod 全域設定（WEB-13）——MUST 是 `main.ts` 的第一個 import，在任何 schema **建構**之前生效
 * （含 contracts 模組載入時頂層求值的 `z.object()`），不只是 parse 之前。
 *
 * 為什麼要 `jitless`：zod 4.6.5 在建構 object schema 時（`$ZodObject` 初始化，`v4/core/schemas.js`
 * 讀 `util.allowsEval.value`）就以 `new Function("")` 探測環境能否 eval，能的話 parse 改走 JIT 編出的
 * 快速路徑；探測結果快取，只做一次。demo 的 nginx CSP 是 `script-src 'self'`（不含 `'unsafe-eval'`），
 * 探測雖然被 zod 自己 try/catch 吞掉，瀏覽器仍會每次載入記一筆 CSP 違規（console 與 `securitypolicyviolation`
 * 報告）。`jitless: true` 直接跳過探測與 JIT，走一般解析路徑。效能上沒有損失：CSP 下探測本來就失敗、
 * production 從來沒走過 JIT；只有開發模式（Vite 無 CSP）原本會走 JIT，現在與 production 一致。
 *
 * 設定存在 `globalThis` 上，contracts 套件的 schema 與本檔共用同一份（同一個 zod 4.6.5）。
 * 以 side-effect 模組實作而非寫在 `main.ts` 本體：ES module 會先執行完所有 import 才跑本體，
 * 寫在本體就晚於 App 元件圖與 contracts 的 schema 定義（皆在 import 時期求值）。
 */
z.config({ jitless: true });
