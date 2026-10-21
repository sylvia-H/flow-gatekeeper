import { defineConfig } from "vitest/config";

// 跨 process e2e（review02 §6 Batch D）：真的起 compose 全棧，故與單元／整合測試分開、只由 `test:e2e` 觸發。
//
// gating 只看 mode：`vitest run --mode e2e`（即 `pnpm test:e2e`）才設 E2E=1、收 `src/*.e2e.test.ts`、掛 globalSetup
// 起容器；其他方式（`pnpm --filter @flow-gatekeeper/e2e test`、本目錄 `vitest run`、root `pnpm test` 經 `pnpm -r`）
// 只收 `src/harness/**/*.test.ts` 的純函式單元測試、不掛 globalSetup——shell 殘留 `E2E=1` 也不會起容器。
// 場景檔另有 `describe.skipIf(!process.env.E2E)` 作第二道防線。
// 在設定檔（主行程）直接寫 process.env：globalSetup 跑在主行程、看不到 `test.env`，worker 則繼承主行程 env。
//
// 與各套件同一道防線：NODE_ENV=production 會讓 Vite 改選 production condition、吃 contracts 的 dist。
if (process.env.NODE_ENV === "production") {
  process.env.NODE_ENV = "test";
}

export default defineConfig(({ mode }) => {
  const e2e = mode === "e2e";
  if (e2e) process.env.E2E = "1";
  return {
    test: {
      // harness 單元測試不進 root 的 coverage projects（門檻只量五個套件）。
      include: e2e ? ["src/**/*.e2e.test.ts"] : ["src/harness/**/*.test.ts"],
      // verbose：逐場景列出耗時；silent:false：印出場景內的 [e2e] 計時訊息（build／up／各場景耗時）。
      reporters: ["verbose"],
      silent: false,
      globalSetup: e2e ? ["src/harness/global-setup.ts"] : [],
      // 所有場景共用同一組容器，且 kill worker 會影響其他場景 → 檔案與測試一律循序。
      fileParallelism: false,
      sequence: { concurrent: false },
      testTimeout: 60_000,
      // 冷啟動含三個映像 build，交給 globalSetup 自己的逾時控制；這裡只管單一 hook。
      // 大於 afterAll 裡 startWorker 的 60 s 上限（合併門第 2 輪調整），逾時時先看到 compose 的具名訊息。
      hookTimeout: 90_000,
    },
  };
});
