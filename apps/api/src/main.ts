import "reflect-metadata";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module.js";
import { HTTP_APP_OPTIONS, configureHttpApp } from "./http/http-exception.filter.js";
import { loadApiDotenv } from "./lib/env-file.js";
import { createShutdownHandler } from "./lib/graceful-shutdown.js";
import { getAppLogger } from "./logging/app-logger.js";
import { PinoLoggerService } from "./logging/pino-logger.service.js";
import { fatalExit, installFatalHandlers } from "./logging/fatal.js";
import { HistoryService, toPersistStats } from "./modules/history/history.service.js";
import { MonitoringGateway } from "./modules/websocket/monitoring.gateway.js";
import { AppConfigService } from "./modules/config/config.service.js";
import { JobsService } from "./modules/jobs/jobs.service.js";
import { MetricsService } from "./modules/metrics/metrics.service.js";

// 明確載入本套件的 .env（apps/api/.env），不依賴 cwd——避免從別處啟動時 WS_AUTH_SECRET
// 等設定靜默落空（例如授權被意外停用）。healthcheck／seed 共用同一個載入函式。
loadApiDotenv();

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
  //
  // HTTP_APP_OPTIONS 關掉 Nest 自動掛的 body parser，改由 configureHttpApp 以 16 kb 上限自行掛，
  // 並在其後接上 body-parser 錯誤正規化、全域 ExceptionFilter 與 `disable("x-powered-by")`
  // （API-7／API-17，見 http/http-exception.filter.ts）。
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    ...HTTP_APP_OPTIONS,
    logger: new PinoLoggerService(getAppLogger()),
    abortOnError: false,
  });
  configureHttpApp(app);
  // 經 AppConfigService 取 port：直接讀 process.env 會繞過其啟動時的設定驗證。
  const config = app.get(AppConfigService);
  const port = config.apiPort;
  await app.listen(port);
  const gateway = app.get(MonitoringGateway);
  // Origin 白名單、背壓高水位、連線數上限與授權期限一樣走 AppConfigService（單一設定來源），
  // Gateway 內不再各自讀 process.env。
  // 以 NestExpressApplication 建立，getHttpServer() 的型別即 node:http Server。
  gateway.attach(app.getHttpServer(), {
    allowedOrigins: config.wsAllowedOrigins,
    sendHighWaterBytes: config.wsSendHighWaterBytes,
    maxConnections: config.maxWsConnections,
    authGraceMs: config.wsAuthGraceMs,
  });

  // 009 US3：於組合根把指標來源與出口接給 MetricsService 並啟動週期結算——`JobsService`
  // 與 `MonitoringGateway` 是 AppModule 層的 provider，對 MetricsModule 不可見，故沿用本檔
  // 既有的組合根接線慣例（同上一行的 gateway.attach）。純觀測接線，不改任何既有控制流。
  const jobs = app.get(JobsService);
  const history = app.get(HistoryService);
  app.get(MetricsService).bind({
    queueCounts: () => jobs.getQueueCounts(),
    wsConnections: () => gateway.connectionCount,
    persistStats: () => toPersistStats(history.getWriteStats()),
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
  //
  // 總時限與第二次訊號（API-12，裁決 5）：flush＋app.close() 合計至多 12 秒，逾時記 warn 後仍
  // exit(0)——Redis 不可達時 relay 的 close 可能卡住，不設總時限會吃光 compose 的 15 秒 grace 而被
  // SIGKILL（137，非零退出會被 on-failure 誤判為崩潰）。關閉中再收到訊號則立即 exit(0)。
  // 收尾失敗也不是崩潰：記 log 後仍以 0 退出（contracts §3）。見 lib/graceful-shutdown.ts。
  const shutdown = createShutdownHandler({
    close: async () => {
      // 關閉順序：先停 producer（不再產生新點）→ flush telemetry buffer → app.close()。
      // app.close() 依模組距離呼叫 onModuleDestroy、不保證 Gateway 先於 HistoryModule，
      // 若直接 close，Mongo 可能先關而 producer 仍在跑，最後一批會撞上已關閉的連線。
      // flush 另有自己的上限（由 HistoryService 內部計時），不讓它單獨吃掉總時限。
      gateway.stopProducer();
      await app.get(HistoryService).flush({ deadlineMs: SHUTDOWN_FLUSH_DEADLINE_MS });
      await app.close();
    },
    exit: (code) => process.exit(code),
    log: {
      info: (message) => logger.log(message),
      warn: (message) => logger.warn(message),
      error: (message) => logger.error(message),
    },
  });
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
