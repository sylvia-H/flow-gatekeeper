import { configDefaults, defineConfig } from "vitest/config";

// vitest 必須永遠對 workspace 套件的原始碼測試（packages/* exports 的 "development" condition → src），
// 避免拿舊 dist（或乾淨 clone 根本沒有 dist）而假綠。
// Vite 依 NODE_ENV 自動選 development／production condition（Vite 5 會過濾使用者給的 development／production；
// Vite 6 起預設值以 `development|production` 佔位、依 NODE_ENV 展開，使用者提供的 resolve.conditions
// 會整組取代預設值）——寫 resolve.conditions 不是正解；因此改成不讓 NODE_ENV=production 滲進測試。
if (process.env.NODE_ENV === "production") {
  process.env.NODE_ENV = "test";
}

// vitest 4 起預設 exclude 只剩 node_modules／.git（不再排除 dist）：tsc build 會把 *.test.ts 編進 dist，
// 不排除就會把舊 dist 的測試也跑一遍（重複計數、且測的是過期產物）。補回 dist 排除以維持 vitest 2 的語意。
export default defineConfig({
  test: {
    // 整合測試（src/integration/**/*.int.test.ts）需要真 Redis／Mongo，由 vitest.integration.config.ts 另跑（pnpm test:integration）。
    exclude: [...configDefaults.exclude, "**/dist/**", "**/integration/**"],
  },
});
