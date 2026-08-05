import { Injectable, Logger } from "@nestjs/common";
import type { OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import IORedis from "ioredis";
import type { Redis } from "ioredis";
import type { AiStreamEvent } from "@flow-gatekeeper/contracts";
import { AppConfigService } from "../config/config.service.js";
import { MonitoringGateway } from "./monitoring.gateway.js";
import { getAppLogger } from "../../logging/app-logger.js";

/** jobId → 發起連線綁定（記憶體，重連失效——已知限制，spec Assumptions）。 */
export type JobBinding = { clientId: string; machineId: string; boundAt: number };

/**
 * AI 串流轉發（通道 A，憲章 IV）：專用 subscriber `psubscribe('ai-stream:*')`，把 worker
 * publish 的 `ai/token`／`ai/done`／`ai/error` 依 `jobId` 綁定查 `clientId` → `gateway.send`。
 *
 * **只轉發、不刪綁定**：worker 先 publish `ai/done`、才由 BullMQ 標 `completed`；若此處在
 * `ai/done` 就刪綁定，通道 B（T020）的終態 `job/status:completed` 會查不到對象（F1）。綁定的
 * 建立由 `JobsService` 呼叫 `bindJobToClient`，清理由 job-status relay 單一負責。
 * subscriber 連線 MUST NOT 跑一般 command（憲章 IV）。
 */
@Injectable()
export class AiStreamRelayService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AiStreamRelayService.name);
  // jobId 為 SC-002 跨行程串接的關聯鍵，MUST 為獨立結構化欄位（FR-002）。
  private readonly plog = getAppLogger().child({ context: AiStreamRelayService.name });
  private subscriber?: Redis;
  private readonly jobRooms = new Map<string, JobBinding>();

  constructor(
    private readonly config: AppConfigService,
    private readonly gateway: MonitoringGateway,
  ) {}

  onModuleInit(): void {
    // 韌性：subscribe 初始化以 try/catch 包覆（T027），Redis/worker 異常時 api 仍能啟動。
    try {
      this.subscriber = new IORedis({
        host: this.config.redisHost,
        port: this.config.redisPort,
        maxRetriesPerRequest: null,
      });
      void this.subscriber.psubscribe("ai-stream:*");
      this.subscriber.on("pmessage", (_pattern, channel, message) =>
        this.handleMessage(channel, message),
      );
      this.subscriber.on("error", (err) => this.logger.warn(`subscriber error: ${err.message}`));
      this.logger.log("ai-stream relay subscribed to 'ai-stream:*'");
    } catch (err) {
      this.logger.error(`ai-stream relay init failed: ${(err as Error).message}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.subscriber?.quit().catch(() => undefined);
  }

  /** 建 job 時綁定發起連線（`socketId` 即 WS `clientId`，data-model §4）。 */
  bindJobToClient(jobId: string, clientId: string, machineId: string): void {
    this.jobRooms.set(jobId, { clientId, machineId, boundAt: Date.now() });
  }

  getBinding(jobId: string): JobBinding | undefined {
    return this.jobRooms.get(jobId);
  }

  /** 綁定清理——僅由 job-status relay 於終態呼叫（單一 owner，F1）。 */
  deleteBinding(jobId: string): void {
    this.jobRooms.delete(jobId);
  }

  /** 供 job-status relay 掃描孤兒綁定（唯讀）。 */
  get bindings(): ReadonlyMap<string, JobBinding> {
    return this.jobRooms;
  }

  private handleMessage(channel: string, message: string): void {
    const jobId = channel.slice("ai-stream:".length);
    const binding = this.jobRooms.get(jobId);
    if (!binding) return; // 純後端 smoke 或已重連：略過推送，job 仍完成
    let event: AiStreamEvent;
    try {
      event = JSON.parse(message) as AiStreamEvent;
    } catch {
      this.plog.warn({ jobId, channel }, "unparsable ai-stream message");
      return;
    }
    this.gateway.send(binding.clientId, event); // 只轉發、不刪綁定（F1）
  }
}
