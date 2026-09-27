import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// root 聚合設定：只給 `pnpm test:coverage`（`vitest run --coverage`）用，把五個套件當 projects 一次跑、
// 產出一份合併的覆蓋率報告。日常 `pnpm test`（`pnpm -r test`）仍逐套件各跑各的，不經過這個檔。
//
// 每個 project 直接指向該套件既有的設定檔，行為（dist 排除、NODE_ENV 壓制、web 的 Vue plugin
// 與各測試檔自帶的 environment 註記）完全沿用套件本身設定；project root 即設定檔所在目錄，因此相對路徑與 workspace 套件的
// "development" condition（→ packages/*/src）解析與單跑時一致。
// tests/e2e 刻意不納入：它需要實際起 infra，由 `pnpm test:e2e` 另跑。
// 注意：vitest 會從 cwd 逐層往上找設定檔；子目錄若沒有自己的 vitest／vite 設定就會撿到本檔。projects 路徑因此
// 一律以「本檔所在目錄」為基準轉成絕對路徑（相對路徑會依 cwd 解析而報 non-existing file）；但撿到本檔就等於
// 跑全部單元測試，所以每個會跑 vitest 的子套件（含 tests/e2e）仍 MUST 有自己的設定檔。
const fromRoot = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

// 與各套件設定同一道防線：NODE_ENV=production 會讓 Vite 改選 production condition、吃 packages 的 dist，
// 在 root 先壓回 test，避免 coverage 量到過期產物（或乾淨 clone 下根本沒有 dist 而失敗）。
if (process.env.NODE_ENV === "production") {
  process.env.NODE_ENV = "test";
}

export default defineConfig({
  // 根目錄固定為本檔所在處：coverage include／reportsDirectory 等相對路徑都不隨 cwd 漂移。
  root: fromRoot("."),
  test: {
    projects: [
      fromRoot("./packages/shared/vitest.config.ts"),
      fromRoot("./packages/contracts/vitest.config.ts"),
      fromRoot("./apps/worker/vitest.config.ts"),
      fromRoot("./apps/api/vitest.config.ts"),
      fromRoot("./apps/web/vite.config.ts"),
    ],
    coverage: {
      provider: "v8",
      // 只量 production 原始碼：五個套件的 src。
      include: [
        "packages/shared/src/**/*.ts",
        "packages/contracts/src/**/*.ts",
        "apps/worker/src/**/*.ts",
        "apps/api/src/**/*.ts",
        "apps/web/src/**/*.{ts,vue}",
      ],
      exclude: [
        "**/*.test.ts",
        "**/test-support/**",
        "**/dist/**",
        "**/*.d.ts",
        // 手動執行的開發 CLI，不是執行期程式碼：seed 維修紀錄（需真 MongoDB）、Gemini 連通性 smoke（需真 API key）。
        "apps/api/src/scripts/**",
        "apps/worker/src/ai/smoke-*.ts",
      ],
      reporter: ["text-summary", "lcov"],
      reportsDirectory: fromRoot("./coverage"),
      // 測試失敗時仍產出報告：CI 失敗 run 也能上傳 lcov 供比對（vitest 預設失敗即不出報告）。
      reportOnFailure: true,
      // 「不退步門檻」（第二輪審查報告 §6 Batch D）：守住「不往下掉」而非追求數字。
      // 落地時實測 lines ≈ 67%、branches ≈ 65%，已高於報告要求，照報告值設定；
      // 其後 Batch D 補測試升到 lines ≈ 81%、branches ≈ 76%（2026-09-28 實測 81.37／76.44），門檻仍維持報告值（不追數字、只防退步）。
      // main.ts 入口刻意納入，以免覆蓋率虛高：main.test.ts 只測入口的守衛與 side-effect，
      // bootstrap 本體由 e2e（`pnpm test:e2e`）覆蓋，不計入本報告。
      thresholds: {
        lines: 60,
        branches: 50,
      },
    },
  },
});
