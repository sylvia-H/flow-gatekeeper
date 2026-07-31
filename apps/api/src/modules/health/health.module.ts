import { Module } from "@nestjs/common";
import { ConfigModule } from "../config/config.module.js";
import { HistoryModule } from "../history/history.module.js";
import { HealthService } from "./health.service.js";
import { HealthController } from "./health.controller.js";

/**
 * US2：`GET /healthz`，與既有 config／history／jobs／websocket 同層同構。
 * import `HistoryModule`（而非直接 provide `HistoryService`）以複用 AppModule 已建立的
 * 同一個 HistoryService 實體（同一條 Mongo 連線），不另開連線。
 */
@Module({
  imports: [ConfigModule, HistoryModule],
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
