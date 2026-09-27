import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";

/**
 * 本套件的 `.env`（`apps/api/.env`）絕對路徑。以本檔位置推導（`src/lib` 與 `dist/lib` 都往上兩層），
 * 不依賴 cwd——從 repo 根目錄、`apps/api` 或容器內任一處啟動，讀到的都是同一份。
 */
export const API_DOTENV_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../../.env");

/**
 * 載入 `apps/api/.env`。main／healthcheck／seed 三個進入點共用，避免各自用 `dotenv/config`（依 cwd）
 * 而讀到不同檔案或落空。已存在於 `process.env` 的值不被覆寫（compose `env_file`／shell 優先）；
 * 檔案不存在時靜默略過（容器內通常沒有）。
 */
export function loadApiDotenv(): void {
  loadEnv({ path: API_DOTENV_PATH });
}
