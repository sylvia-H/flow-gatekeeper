import { configDefaults, defineConfig } from "vitest/config";

// 真 Redis／Mongo 整合測試專用設定（第二輪審查報告 §6 Batch D）。只由
// `pnpm --filter @flow-gatekeeper/api test:integration` 使用，不進 `pnpm -r test`。
// 前置：repo 根目錄 `docker compose up -d`（只起 redis＋mongo；api 整合測試只用 mongo）。連不上時測試明確失敗並提示，不靜默 skip。
//
// 同 vitest.config.ts：不讓 NODE_ENV=production 滲入，否則 workspace 套件會解析到 dist。
if (process.env.NODE_ENV === "production") {
  process.env.NODE_ENV = "test";
}

export default defineConfig({
  test: {
    include: ["src/integration/**/*.int.test.ts"],
    exclude: [...configDefaults.exclude, "**/dist/**"],
    // 整合測試檔以此旗標判斷「是由整合設定啟動」；被單元設定誤收時整組 skip（見各檔 describe.runIf）。
    env: { FG_INTEGRATION: "1" },
    // 共用同一組容器：檔案間序列執行，避免彼此的並發測試互相干擾時序（例如鎖換手的實等 TTL）。
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 30_000,
  },
});
