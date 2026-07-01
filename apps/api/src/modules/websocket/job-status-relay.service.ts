import { Injectable, Logger } from "@nestjs/common";
import type { OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { QueueEvents } from "bullmq";
import { DIAGNOSIS_QUEUE } from "@flow-gatekeeper/contracts";
import type { JobStatus } from "@flow-gatekeeper/contracts";
import { AppConfigService } from "../config/config.service.js";
import { MonitoringGateway } from "./monitoring.gateway.js";
import { AiStreamRelayService } from "./ai-stream-relay.service.js";

/** 孤兒綁定回收安全期（QueueEvents 異常時避免 Map 洩漏，FR-002）。 */
const ORPHAN_TTL_MS = 10 * 60_000;

/**
 * Job 生命週期轉發（通道 B，憲章 IV）：以**獨立 blocking 連線**建 `QueueEvents`，把
 * waiting/active/completed/failed/progress 組成 `job/status` → `gateway.send`。
 *
 * **綁定清理單一 owner**：僅在 `completed`/`failed`（最終終態，晚於 `ai/done`）刪綁定，確保
 * 終態 `job/status` 一定送得出去（F1）；另以 `boundAt` 定期回收孤兒綁定。
 */
@Injectable()
export class JobStatusRelayService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(JobStatusRelayService.name);
  private queueEvents?: QueueEvents;
  private sweepTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly config: AppConfigService,
    private readonly gateway: MonitoringGateway,
    private readonly relay: AiStreamRelayService,
  ) {}

  onModuleInit(): void {
    // 韌性（T027）：QueueEvents 初始化以 try/catch 包覆，Redis/worker 異常時 api 仍能啟動、
    // POST /diagnoses 照回 jobId（SC-005/SC-006）。
    try {
      this.queueEvents = new QueueEvents(DIAGNOSIS_QUEUE, {
        connection: {
          host: this.config.redisHost,
          port: this.config.redisPort,
          maxRetriesPerRequest: null,
        },
      });
      this.queueEvents.on("waiting", ({ jobId }) => this.emit(jobId, "waiting"));
      this.queueEvents.on("active", ({ jobId }) => this.emit(jobId, "active"));
      this.queueEvents.on("progress", ({ jobId, data }) =>
        this.emit(jobId, "active", typeof data === "number" ? data : undefined),
      );
      this.queueEvents.on("completed", ({ jobId }) => {
        this.emit(jobId, "completed");
        this.relay.deleteBinding(jobId);
      });
      this.queueEvents.on("failed", ({ jobId, failedReason }) => {
        this.emit(jobId, "failed", undefined, failedReason);
        this.relay.deleteBinding(jobId);
      });
      this.queueEvents.on("error", (err) => this.logger.warn(`QueueEvents error: ${err.message}`));
      this.sweepTimer = setInterval(() => this.sweepOrphans(), 60_000);
      this.logger.log(`job-status relay listening QueueEvents('${DIAGNOSIS_QUEUE}')`);
    } catch (err) {
      this.logger.error(`job-status relay init failed: ${(err as Error).message}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    await this.queueEvents?.close().catch(() => undefined);
  }

  private emit(jobId: string, status: JobStatus["status"], progress?: number, error?: string): void {
    const binding = this.relay.getBinding(jobId);
    if (!binding) return; // 純後端 smoke 或已終態清理：略過
    const jobStatus: JobStatus = { type: "job/status", jobId, machineId: binding.machineId, status };
    if (progress !== undefined) jobStatus.progress = progress;
    if (error !== undefined) jobStatus.error = error;
    this.gateway.send(binding.clientId, jobStatus);
  }

  private sweepOrphans(): void {
    const now = Date.now();
    for (const [jobId, binding] of this.relay.bindings) {
      if (now - binding.boundAt > ORPHAN_TTL_MS) {
        this.relay.deleteBinding(jobId);
        this.logger.warn(`swept orphan job binding: ${jobId}`);
      }
    }
  }
}
