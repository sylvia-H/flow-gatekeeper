import "reflect-metadata";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";
import { getAppLogger } from "./logging/app-logger.js";
import { PinoLoggerService } from "./logging/pino-logger.service.js";
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
  // 於 create() 期間即傳入自訂 logger（而非事後 app.useLogger）：Nest 在 create() 一開始
  // 就呼叫 registerLoggerConfiguration() 覆寫 Logger.staticInstanceRef，早於任何框架自身的
  // 啟動訊息輸出，因此連框架內部日誌也一併轉為結構化（FR-001、research R1）。
  const app = await NestFactory.create(AppModule, {
    logger: new PinoLoggerService(getAppLogger()),
  });
  const port = Number(process.env.API_PORT ?? 3000);
  await app.listen(port);
  app.get(MonitoringGateway).attach(app.getHttpServer());
  const logger = new Logger("api");
  logger.log(`flow-gatekeeper api listening on :${port} (ws path /ws)`);

  // 優雅關閉（FR-004、008 research D5）：api 現況原無任何訊號處理——收到 SIGTERM 即刻
  // 死亡，四個 onModuleDestroy（Mongo／QueueEvents／AI relay／Gateway）從未被觸發。此顯式
  // handler 收到訊號即 app.close()，它會逐一呼叫那些 onModuleDestroy（含 Gateway 主動
  // terminate ws 連線並關閉 ws server，讓 HTTP server 的 close 能真正完成，否則活躍的 ws
  // 連線會使關閉掛住至寬限期逾時），再以顯式退出碼 0 收場——FR-003 的 on-failure:5 靠退出碼
  // 區分「崩潰」與「優雅關閉」。
  //
  // 不使用 enableShutdownHooks()：app.close() 本就會執行 onModuleDestroy，enableShutdownHooks()
  // 只會「另外」再掛一組 SIGTERM/SIGINT 監聽器，與本 handler 競態、重複觸發 app.close()。
  //
  // 範圍紀律（FR-014 的唯一例外）：關閉路徑之外一律不動；onModuleDestroy 的既有清理語意
  // （含 ADR-002 §6.4 接受的有損寫入）未變，Gateway 僅新增「釋放 ws 連線」這一收尾必要步驟。
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return; // 重入防護：第二個訊號不再另起一輪 close
    shuttingDown = true;
    logger.log(`received ${signal}, shutting down api...`);
    try {
      await app.close();
    } catch (err) {
      // 收尾失敗不是崩潰：記 log 後仍以 0 退出。若以非零退出，監督者會誤判為崩潰而重啟
      // 一個正要停止的服務（contracts §3）。
      logger.error(`shutdown error: ${err instanceof Error ? err.message : String(err)}`);
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

// 僅在被直接執行時才啟動；被 import（含 entry smoke 測試）時不產生副作用。
// 用 fileURLToPath + resolve 比對，正確處理含空白/特殊字元的路徑（避免 file:// 的 %20 不相等）。
// 去掉 .js/.mjs/.cjs 副檔名再比對：`nest start` 以 `node dist/main`（無副檔名）啟動，
// 若不 normalize 會與 import.meta.url 的 `dist/main.js` 不相等而永不 bootstrap（start:dev 不服務）。
const stripJs = (p: string): string => p.replace(/\.[cm]?js$/, "");
const invokedPath = process.argv[1] ? stripJs(resolve(process.argv[1])) : "";
if (invokedPath && stripJs(resolve(fileURLToPath(import.meta.url))) === invokedPath) {
  void bootstrap();
}
