import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

// Vite 依 NODE_ENV 自動選 development／production condition：dev 與 vitest（mode=test）吃 packages src、build 吃 dist。
// vitest 必須永遠對 packages src 測試（與 apps/api、apps/worker 的 vitest.config 一致）：若 shell 帶著
// NODE_ENV=production 跑測試，Vite 會改吃可能過時或不存在的 dist 而假綠／假紅，故僅在 vitest 下把它壓回 test。
if (process.env.VITEST && process.env.NODE_ENV === "production") {
  process.env.NODE_ENV = "test";
}

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      // 前端連同源 `/ws`，由 Vite 轉發到 Gateway（:3000）——免 CORS、不把後端位址塞進 bundle（research R2）。
      "/ws": {
        target: "http://localhost:3000",
        ws: true,
        changeOrigin: true,
      },
      // 診斷觸發 `POST /diagnoses` 同理走同源 proxy（005 research R2、contracts/diagnose-rest）。
      "/diagnoses": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
});
