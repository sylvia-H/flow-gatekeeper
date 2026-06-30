import "reflect-metadata";
import "dotenv/config";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";
import { MonitoringGateway } from "./modules/websocket/monitoring.gateway.js";

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
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  void bootstrap();
}
