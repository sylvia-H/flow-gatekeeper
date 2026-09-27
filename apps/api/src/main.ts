import "reflect-metadata";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";
import { getAppLogger } from "./logging/app-logger.js";
import { PinoLoggerService } from "./logging/pino-logger.service.js";
import { fatalExit, installFatalHandlers } from "./logging/fatal.js";
import { HistoryService } from "./modules/history/history.service.js";
import { MonitoringGateway } from "./modules/websocket/monitoring.gateway.js";
import { AppConfigService } from "./modules/config/config.service.js";
import { JobsService } from "./modules/jobs/jobs.service.js";
import { MetricsService } from "./modules/metrics/metrics.service.js";

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
  //
  // abortOnError: false——Nest 預設在建構／初始化失敗時呼叫 process.abort()（exit 134、無結構化
  // 錯誤），設定錯誤（例如環境變數驗證失敗）因此不會以 rejection 回到這裡。關掉後錯誤照常拋出，
  // 由 entry 的 catch 走 fatalExit：印出可讀的 fatal JSON、以 exit 1 交給監督者。
  const app = await NestFactory.create(AppModule, {
    logger: new PinoLoggerService(getAppLogger()),
    abortOnError: false,
  });
  // 經 AppConfigService 取 port：直接讀 process.env 會繞過其啟動時的設定驗證。
  const port = app.get(AppConfigService).apiPort;
  await app.listen(port);
  const gateway = app.get(MonitoringGateway);
  gateway.attach(app.getHttpServer());

  // 009 US3：於組合根把指標來源與出口接給 MetricsService 並啟動週期結算——`JobsService`
  // 與 `MonitoringGateway` 是 AppModule 層的 provider，對 MetricsModule 不可見，故沿用本檔
  // 既有的組合根接線慣例（同上一行的 gateway.attach）。純觀測接線，不改任何既有控制流。
  const jobs = app.get(JobsService);
  app.get(MetricsService).bind({
    queueCounts: () => jobs.getQueueCounts(),
    wsConnections: () => gateway.connectionCount,
    broadcast: (payload) => gateway.broadcastMetrics(payload),
  });

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
  // 寫入語意：關閉路徑會先停 producer 並（有時限地）flush telemetry buffer，正常關閉不再丟資料；
  // ADR-002 §6.4 接受的有損寫入現在只剩「崩潰」與「flush 逾時」兩種情形。
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return; // 重入防護：第二個訊號不再另起一輪 close
    shuttingDown = true;
    logger.log(`received ${signal}, shutting down api...`);
    try {
      // 關閉順序：先停 producer（不再產生新點）→ flush telemetry buffer → app.close()。
      // app.close() 依模組距離呼叫 onModuleDestroy、不保證 Gateway 先於 HistoryModule，
      // 若直接 close，Mongo 可能先關而 producer 仍在跑，最後一批會撞上已關閉的連線。
      // flush 設上限（由 HistoryService 內部計時）：Mongo 不可達或寫入卡住時也不讓它吃光
      // stop_grace_period 而被 SIGKILL——非零退出會被 on-failure 誤判為崩潰。
      gateway.stopProducer();
      await app.get(HistoryService).flush({ deadlineMs: SHUTDOWN_FLUSH_DEADLINE_MS });
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

/** 關閉時 flush telemetry buffer 的時間上限。 */
const SHUTDOWN_FLUSH_DEADLINE_MS = 5_000;

// 僅在被直接執行時才啟動；被 import（含 entry smoke 測試）時不產生副作用。
// 用 fileURLToPath + resolve 比對，正確處理含空白/特殊字元的路徑（避免 file:// 的 %20 不相等）。
// 去掉 .js/.mjs/.cjs 副檔名再比對：`nest start` 以 `node dist/main`（無副檔名）啟動，
// 若不 normalize 會與 import.meta.url 的 `dist/main.js` 不相等而永不 bootstrap（start:dev 不服務）。
const stripJs = (p: string): string => p.replace(/\.[cm]?js$/, "");
const invokedPath = process.argv[1] ? stripJs(resolve(process.argv[1])) : "";
if (invokedPath && stripJs(resolve(fileURLToPath(import.meta.url))) === invokedPath) {
  // 致命 handler 只在真的啟動時才掛（被 import 時不產生副作用）。bootstrap 的 rejection
  // （設定驗證失敗、Mongo 連不上、port 被占用…）顯式接到同一條致命路徑，退出碼 1。
  installFatalHandlers();
  bootstrap().catch((err: unknown) => fatalExit("bootstrap", err));
}
