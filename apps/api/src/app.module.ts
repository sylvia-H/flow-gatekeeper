import { Module } from "@nestjs/common";
import { ConfigModule } from "./modules/config/config.module.js";
import { MockTelemetryService } from "./modules/telemetry/mock-telemetry.service.js";
import { MonitoringGateway } from "./modules/websocket/monitoring.gateway.js";

/**
 * 根模組。Config + Gateway + MockTelemetryService（US1）；
 * HistoryService（US2）於該相加入 providers。
 */
@Module({
  imports: [ConfigModule],
  providers: [MonitoringGateway, MockTelemetryService],
})
export class AppModule {}
