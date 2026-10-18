import { URL, fileURLToPath } from "node:url";

// tailwind 設定以本檔位置解析成絕對路徑（TQ-23）：`tailwindcss: {}` 會依 cwd 找 tailwind.config，
// 從 repo 根目錄跑（root vitest coverage、`vite build apps/web`）時找不到，tailwind 便以空設定編 CSS
// 並警告「content option missing」。content glob 本身另以 `content.relative` 對齊設定檔位置。
export default {
  plugins: {
    tailwindcss: { config: fileURLToPath(new URL("./tailwind.config.ts", import.meta.url)) },
    autoprefixer: {},
  },
};
