import { Module } from "@nestjs/common";
import { ConfigModule } from "./modules/config/config.module.js";
import { HistoryModule } from "./modules/history/history.module.js";
import { HealthModule } from "./modules/health/health.module.js";
import { MetricsModule } from "./modules/metrics/metrics.module.js";
import { JobsModule } from "./modules/jobs/jobs.module.js";
import { JobsController } from "./modules/jobs/jobs.controller.js";
import { JobsService } from "./modules/jobs/jobs.service.js";
import { DiagnosisLookupService } from "./modules/jobs/diagnosis-lookup.service.js";
import { MockTelemetryService } from "./modules/telemetry/mock-telemetry.service.js";
import { MonitoringGateway } from "./modules/websocket/monitoring.gateway.js";
import { AiStreamRelayService } from "./modules/websocket/ai-stream-relay.service.js";
import { JobStatusRelayService } from "./modules/websocket/job-status-relay.service.js";
import { JobRoutingRegistry } from "./modules/websocket/job-routing-registry.js";

/**
 * 根模組：Config + Gateway + Telemetry（US1）+ History（US2）+ 003 診斷佇列與雙通道 relay
 * + 009 Health（US2 `/healthz`）+ 009 Metrics（US3 週期指標摘要與廣播）。
 *
 * JobsModule 負責 BullMQ 佈線（forRoot + registerQueue，re-export BullModule）；JobsService／
 * 兩個 relay 與 MonitoringGateway 同層提供，使 relay 能注入 gateway、JobsService 能 @InjectQueue
 * 並注入 JobRoutingRegistry（jobId → 連線綁定的單一持有者，012 FR-014；兩個 relay 也經它查綁定）。
 * HistoryService 改由 HistoryModule 提供並 export，使 HealthModule 可複用同一個實體（同一條 Mongo 連線），不需另開連線。
 */
@Module({
  imports: [ConfigModule, JobsModule, HistoryModule, HealthModule, MetricsModule],
  controllers: [JobsController],
  providers: [
    MonitoringGateway,
    MockTelemetryService,
    JobRoutingRegistry,
    AiStreamRelayService,
    JobStatusRelayService,
    JobsService,
    DiagnosisLookupService,
  ],
})
export class AppModule {}
