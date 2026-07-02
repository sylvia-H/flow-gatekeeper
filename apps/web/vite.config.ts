import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

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
    },
  },
});
