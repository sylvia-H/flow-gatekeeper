import { configDefaults, defineConfig } from "vitest/config";

// vitest 4 起預設 exclude 只剩 node_modules／.git（不再排除 dist）：tsc build 會把 *.test.ts 編進 dist，
// 不排除就會把舊 dist 的測試也跑一遍（重複計數、且測的是過期產物）。補回 dist 排除以維持 vitest 2 的語意。
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "**/dist/**"],
  },
});
