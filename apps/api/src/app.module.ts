import { Module } from "@nestjs/common";
import { ConfigModule } from "./modules/config/config.module.js";
import { HistoryService } from "./modules/history/history.service.js";
import { JobsModule } from "./modules/jobs/jobs.module.js";
import { JobsController } from "./modules/jobs/jobs.controller.js";
import { JobsService } from "./modules/jobs/jobs.service.js";
import { MockTelemetryService } from "./modules/telemetry/mock-telemetry.service.js";
import { MonitoringGateway } from "./modules/websocket/monitoring.gateway.js";
import { AiStreamRelayService } from "./modules/websocket/ai-stream-relay.service.js";
import { JobStatusRelayService } from "./modules/websocket/job-status-relay.service.js";

/**
 * 根模組：Config + Gateway + Telemetry（US1）+ History（US2）+ 003 診斷佇列與雙通道 relay。
 *
 * JobsModule 負責 BullMQ 佈線（forRoot + registerQueue，re-export BullModule）；JobsService／
 * 兩個 relay 與 MonitoringGateway 同層提供，使 relay 能注入 gateway、JobsService 能 @InjectQueue
 * 並注入 AiStreamRelayService（綁定 Map 的持有者）。
 */
@Module({
  imports: [ConfigModule, JobsModule],
  controllers: [JobsController],
  providers: [
    MonitoringGateway,
    MockTelemetryService,
    HistoryService,
    AiStreamRelayService,
    JobStatusRelayService,
    JobsService,
  ],
})
export class AppModule {}
