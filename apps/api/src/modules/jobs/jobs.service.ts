import { Injectable } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { randomUUID } from "node:crypto";
import { DIAGNOSIS_QUEUE } from "@flow-gatekeeper/contracts";
import type { DiagnosisJobPayload } from "@flow-gatekeeper/contracts";
import { AiStreamRelayService } from "../websocket/ai-stream-relay.service.js";
import { getAppLogger } from "../../logging/app-logger.js";

/** POST /diagnoses 的回應（初始狀態）。 */
export type CreateDiagnosisResult = { jobId: string; machineId: string; status: "waiting" };

/**
 * 建立診斷 job（API 只入列與綁定，不跑 long-running，憲章 IV）。
 * jobId 綁定發起連線 → 組完整 payload → enqueue（attempts/backoff/removeOn*，FR-003）。
 */
@Injectable()
export class JobsService {
  // jobId 為 SC-002 跨行程串接的關聯鍵，MUST 為獨立結構化欄位（FR-002）。
  private readonly plog = getAppLogger().child({ context: JobsService.name });

  constructor(
    @InjectQueue(DIAGNOSIS_QUEUE) private readonly queue: Queue<DiagnosisJobPayload>,
    private readonly relay: AiStreamRelayService,
  ) {}

  async createDiagnosis(
    machineId: string,
    requestedBy: string | undefined,
    socketId: string,
  ): Promise<CreateDiagnosisResult> {
    const jobId = randomUUID();
    this.relay.bindJobToClient(jobId, socketId, machineId);

    const payload: DiagnosisJobPayload = {
      jobId,
      machineId,
      requestedBy: requestedBy ?? "demo-user",
      requestedAt: new Date().toISOString(),
      windowMinutes: 5,
      promptVersion: "diagnosis-v1",
    };

    await this.queue.add("diagnose-machine", payload, {
      jobId,
      attempts: 3,
      backoff: { type: "exponential", delay: 5000 },
      removeOnComplete: { age: 3600, count: 1000 },
      removeOnFail: { age: 86400, count: 5000 },
    });

    this.plog.info({ jobId, machineId, requestedBy: payload.requestedBy }, "diagnosis job created");
    return { jobId, machineId, status: "waiting" };
  }

  /**
   * 佇列深度的**瞬時值**（009 US3 指標來源，contracts/metrics-summary.md §6）——gauge，
   * 不隨週期歸零。由 MetricsService 每 `METRICS_INTERVAL_MS` 讀一次；此處只讀不改，
   * MUST NOT 影響任何入列行為（FR-012 零回歸）。
   */
  async getQueueCounts(): Promise<{ waiting: number; active: number; failed: number }> {
    const counts = await this.queue.getJobCounts("waiting", "active", "failed");
    return {
      waiting: counts.waiting ?? 0,
      active: counts.active ?? 0,
      failed: counts.failed ?? 0,
    };
  }
}
