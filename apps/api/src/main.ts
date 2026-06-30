import "reflect-metadata";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";
import { MonitoringGateway } from "./modules/websocket/monitoring.gateway.js";

// 明確載入本套件的 .env（apps/api/.env），不依賴 cwd——避免從別處啟動時 WS_AUTH_SECRET
// 等設定靜默落空（例如授權被意外停用）。
loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../.env") });

/**
 * apps/api entry。Feature 002 起實際啟動 NestJS HTTP server，並把同一個 HTTP server
 * 交給原生 `ws` Gateway（path `/ws`，憲章 IV、ADR-001）。
 *
 * 維持 entry import 為 side-effect-free（僅在被直接執行時才啟動），使 001 的 smoke 測試
 * （斷言可乾淨 import 且匯出 bootstrap）仍通過。
 */
export async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const port = Number(process.env.API_PORT ?? 3000);
  await app.listen(port);
  app.get(MonitoringGateway).attach(app.getHttpServer());
  new Logger("api").log(`flow-gatekeeper api listening on :${port} (ws path /ws)`);
}

// 僅在被直接執行時才啟動；被 import（含 entry smoke 測試）時不產生副作用。
// 用 fileURLToPath + resolve 比對，正確處理含空白/特殊字元的路徑（避免 file:// 的 %20 不相等）。
const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && resolve(fileURLToPath(import.meta.url)) === invokedPath) {
  void bootstrap();
}
