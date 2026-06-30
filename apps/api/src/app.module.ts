import { Module } from "@nestjs/common";
import { ConfigModule } from "./modules/config/config.module.js";
import { MonitoringGateway } from "./modules/websocket/monitoring.gateway.js";

/**
 * 根模組。Foundational 先掛 Config 與 Gateway；
 * MockTelemetryService（US1）與 HistoryService（US2）於各相加入 providers。
 */
@Module({
  imports: [ConfigModule],
  providers: [MonitoringGateway],
})
export class AppModule {}
