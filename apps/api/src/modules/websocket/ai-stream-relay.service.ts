import { Injectable, Logger } from "@nestjs/common";
import type { OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import IORedis from "ioredis";
import type { Redis } from "ioredis";
import { AiStreamEventSchema } from "@flow-gatekeeper/contracts";
import { AppConfigService } from "../config/config.service.js";
import { MonitoringGateway } from "./monitoring.gateway.js";
import { getAppLogger } from "../../logging/app-logger.js";
import { attachThrottledErrorLog } from "../../lib/connection-error-throttle.js";

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
 *
 * **轉發前必驗**：channel 上的字串來自任何能對 Redis `PUBLISH` 的一方，不只是 worker；未經
 * `AiStreamEventSchema` 驗證就轉發，等於讓偽造的 `ai/done` 繞過硬規則 6 直接進前端畫面。
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
      // blocking 設定：subscriber 只收不發，斷線時交給 ioredis 自動重連並重新訂閱。
      this.subscriber = new IORedis(this.config.redisOptions("blocking"));
      // 刻意 fire-and-forget 但自帶 catch：Redis 不可達時 psubscribe 留在 offline queue，關閉或斷線清佇列
      // 會 reject；放任成浮空 rejection 會被全域致命守門當成崩潰 exit(1)，把優雅關閉誤報成崩潰。
      void this.subscriber.psubscribe("ai-stream:*").catch((err: unknown) => {
        this.logger.warn(`psubscribe failed: ${err instanceof Error ? err.message : String(err)}`);
      });
      this.subscriber.on("pmessage", (_pattern, channel, message) =>
        this.handleMessage(channel, message),
      );
      // 轉態節流：斷線時 ioredis 每 100–270 ms 重連一次、每次都發 error，逐則記錄會洗版。
      attachThrottledErrorLog(this.subscriber, {
        error: (err, suppressed) =>
          this.logger.warn(
            `subscriber error: ${err.message}` +
              (suppressed > 0 ? `（期間另有 ${suppressed} 則同類錯誤未記）` : ""),
          ),
        recovered: (suppressed) =>
          this.logger.log(`subscriber connection recovered（故障期間共壓掉 ${suppressed} 則錯誤）`),
      });
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
    let raw: unknown;
    try {
      raw = JSON.parse(message);
    } catch {
      this.plog.warn({ jobId, channel }, "unparsable ai-stream message");
      return;
    }
    const parsed = AiStreamEventSchema.safeParse(raw);
    if (!parsed.success) {
      // 只記 issue 路徑與代碼，不記原始內容：畸形訊息可能夾帶任意大小或敏感的 payload。
      const issues = parsed.error.issues
        .slice(0, 5)
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.code}`);
      this.plog.warn({ jobId, channel, issues }, "invalid ai-stream message dropped");
      return;
    }
    // channel 尾綴才是綁定依據；payload 內的 jobId 與之不符代表來源可疑，不轉發給這個 client。
    if (parsed.data.jobId !== jobId) {
      this.plog.warn({ jobId, channel, payloadJobId: parsed.data.jobId }, "ai-stream jobId mismatch dropped");
      return;
    }
    this.gateway.send(binding.clientId, parsed.data); // 只轉發、不刪綁定（F1）
  }
}
