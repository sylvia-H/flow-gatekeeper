import { Module } from "@nestjs/common";
import { ConfigModule } from "./modules/config/config.module.js";
import { HistoryService } from "./modules/history/history.service.js";
import { MockTelemetryService } from "./modules/telemetry/mock-telemetry.service.js";
import { MonitoringGateway } from "./modules/websocket/monitoring.gateway.js";

/** 根模組：Config + Gateway + MockTelemetryService（US1）+ HistoryService（US2）。 */
@Module({
  imports: [ConfigModule],
  providers: [MonitoringGateway, MockTelemetryService, HistoryService],
})
export class AppModule {}
