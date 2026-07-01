import { Injectable, Logger } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { randomUUID } from "node:crypto";
import { DIAGNOSIS_QUEUE } from "@flow-gatekeeper/contracts";
import type { DiagnosisJobPayload } from "@flow-gatekeeper/contracts";
import { AiStreamRelayService } from "../websocket/ai-stream-relay.service.js";

/** POST /diagnoses 的回應（初始狀態）。 */
export type CreateDiagnosisResult = { jobId: string; machineId: string; status: "waiting" };

/**
 * 建立診斷 job（API 只入列與綁定，不跑 long-running，憲章 IV）。
 * jobId 綁定發起連線 → 組完整 payload → enqueue（attempts/backoff/removeOn*，FR-003）。
 */
@Injectable()
export class JobsService {
  private readonly logger = new Logger(JobsService.name);

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

    this.logger.log(`diagnosis job created: ${jobId} machine=${machineId} by=${payload.requestedBy}`);
    return { jobId, machineId, status: "waiting" };
  }
}
