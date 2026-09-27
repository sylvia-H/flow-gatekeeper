import { defineConfig } from "vitest/config";

// 跨 process e2e（review02 §6 Batch D）：真的起 compose 全棧，故與單元／整合測試分開、只由 `test:e2e` 觸發。
//
// gating：`vitest run --mode e2e`（即 `pnpm test:e2e`）才設 E2E=1；其他方式在本目錄跑 vitest 時，
// 測試檔以 `describe.skipIf(!process.env.E2E)` 略過、globalSetup 也不起容器。
// 在設定檔（主行程）直接寫 process.env：globalSetup 跑在主行程、看不到 `test.env`，worker 則繼承主行程 env。
//
// 與各套件同一道防線：NODE_ENV=production 會讓 Vite 改選 production condition、吃 contracts 的 dist。
if (process.env.NODE_ENV === "production") {
  process.env.NODE_ENV = "test";
}

export default defineConfig(({ mode }) => {
  if (mode === "e2e") process.env.E2E = "1";
  return {
    test: {
      include: ["src/**/*.e2e.test.ts"],
      // verbose：逐場景列出耗時；silent:false：印出場景內的 [e2e] 計時訊息（build／up／各場景耗時）。
      reporters: ["verbose"],
      silent: false,
      globalSetup: ["src/harness/global-setup.ts"],
      // 所有場景共用同一組容器，且 kill worker 會影響其他場景 → 檔案與測試一律循序。
      fileParallelism: false,
      sequence: { concurrent: false },
      testTimeout: 60_000,
      // 冷啟動含三個映像 build，交給 globalSetup 自己的逾時控制；這裡只管單一 hook。
      hookTimeout: 60_000,
    },
  };
});
