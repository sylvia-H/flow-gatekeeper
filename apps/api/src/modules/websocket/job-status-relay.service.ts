import { Injectable, Logger } from "@nestjs/common";
import type { OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Job, Queue, QueueEvents } from "bullmq";
import { DIAGNOSIS_QUEUE } from "@flow-gatekeeper/contracts";
import type { AiError, DiagnosisJobPayload, JobStatus } from "@flow-gatekeeper/contracts";
import { AppConfigService } from "../config/config.service.js";
import { MonitoringGateway } from "./monitoring.gateway.js";
import { AiStreamRelayService } from "./ai-stream-relay.service.js";
import { getAppLogger } from "../../logging/app-logger.js";

/** 孤兒綁定回收安全期（QueueEvents 異常時避免 Map 洩漏，FR-002）。 */
const ORPHAN_TTL_MS = 10 * 60_000;

/**
 * Job 生命週期轉發（通道 B，憲章 IV）：以**獨立 blocking 連線**建 `QueueEvents`，把
 * waiting/active/completed/failed/progress 組成 `job/status` → `gateway.send`。
 *
 * **綁定清理單一 owner**：僅在 `completed`/`failed`（最終終態，晚於 `ai/done`）刪綁定，確保
 * 終態 `job/status` 一定送得出去（F1）；另以 `boundAt` 定期回收孤兒綁定。
 *
 * **最終失敗的 `ai/error(worker_failed)` 是安全網**：worker 在最終嘗試或不可重試的錯誤時，會在
 * throw 之前先 publish 帶具體 code 的 `ai/error`（例如 `schema_invalid`），那則通常先到、前端以
 * 先到者為準。但 stalled 用盡、processor 之外的例外等情況 worker 沒有機會 publish；若改由 worker
 * 在自己的 `failed` handler 補送，BullMQ 寫入 `failed` 事件早於那次 PUBLISH，本服務收到 `failed`
 * 就刪綁定，那則到達 relay 時已查無對象。故由 api 在刪綁定前補送這一則，順序由單一行程保證。
 */
@Injectable()
export class JobStatusRelayService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(JobStatusRelayService.name);
  // jobId 為 SC-002 跨行程串接的關聯鍵，MUST 為獨立結構化欄位（FR-002）。
  private readonly plog = getAppLogger().child({ context: JobStatusRelayService.name });
  private queueEvents?: QueueEvents;
  private sweepTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly config: AppConfigService,
    private readonly gateway: MonitoringGateway,
    private readonly relay: AiStreamRelayService,
    // producer 那條 command 連線的 Queue，只用來在最終失敗時查一次 attemptsMade。
    @InjectQueue(DIAGNOSIS_QUEUE) private readonly queue: Queue<DiagnosisJobPayload>,
  ) {}

  onModuleInit(): void {
    // 韌性（T027）：QueueEvents 初始化以 try/catch 包覆，Redis/worker 異常時 api 仍能啟動、
    // POST /diagnoses 照回 jobId（SC-005/SC-006）。
    try {
      this.queueEvents = new QueueEvents(DIAGNOSIS_QUEUE, {
        connection: this.config.redisOptions("blocking"),
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
      // `failed` 只在「不會再重試」時才發：依 bullmq 5.79 原始碼，`Job.moveToFailed` 先以
      // `shouldRetryJob` 判斷（`attemptsMade + 1 < attempts` 且非 `UnrecoverableError`），需重試者走
      // `moveToDelayed`／`retryJob`，事件流只寫 `delayed`／`waiting`；唯有最終失敗才走
      // `moveToFinished`，在該 Lua 腳本內 `XADD ... "event", "failed"`。stalled 超過上限也是先標記
      // deferred failure、再由 worker 經同一條 `moveToFinished` 路徑失敗。因此這裡收到的一律是終態，
      // 可以安心送 `ai/error` 並清綁定；中途重試不會誤觸發。
      this.queueEvents.on("failed", ({ jobId, failedReason }) => {
        void this.handleFailed(jobId, failedReason);
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

  /**
   * 最終失敗：先送 `ai/error(worker_failed)`、再送 `job/status:failed`、最後刪綁定。
   *
   * 這則 `worker_failed` 是安全網：worker 在最終嘗試／不可重試時已先 publish 帶具體 code 的
   * `ai/error`，一般情況下前端早已收到並轉為失敗，這則會被當成過期事件忽略（前端以先到者為準）；
   * 真正生效的是 stalled 用盡、processor 外例外這類 worker 來不及 publish 的情況。
   * `ai/error` 排在 `job/status` 前面，是因為前端收到終態後就不再消費該 job 的事件，順序反過來
   * 會讓可讀的失敗原因被丟掉。MUST NOT 拋錯（由 QueueEvents 以 fire-and-forget 呼叫）。
   */
  private async handleFailed(jobId: string, failedReason: string): Promise<void> {
    const binding = this.relay.getBinding(jobId);
    if (binding) {
      const aiError: AiError = {
        type: "ai/error",
        jobId,
        attempt: await this.resolveAttempt(jobId),
        code: "worker_failed",
        message: failedReason,
      };
      this.gateway.send(binding.clientId, aiError);
    }
    this.emit(jobId, "failed", undefined, failedReason);
    this.relay.deleteBinding(jobId);
  }

  /**
   * `failed` 事件本身不帶嘗試次數，查一次 job 取 `attemptsMade`。`moveToFinished` 在寫入 `failed`
   * 事件前已 `HINCRBY atm`，所以此時的 `attemptsMade` 就是最後那一輪的編號（從 1 起）。
   * 查不到（已被 removeOnFail 清掉、Redis 不通）就填 1：這則訊息的價值在於「告知失敗」，
   * 輪次只是輔助資訊，不值得為它延後或放棄通知。
   */
  private async resolveAttempt(jobId: string): Promise<number> {
    try {
      const job = await Job.fromId<DiagnosisJobPayload>(this.queue, jobId);
      return Math.max(1, job?.attemptsMade ?? 1);
    } catch (err) {
      this.plog.warn({ jobId, err }, "查詢失敗 job 的 attemptsMade 失敗，attempt 以 1 代入");
      return 1;
    }
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
        this.plog.warn({ jobId }, "swept orphan job binding");
      }
    }
  }
}
