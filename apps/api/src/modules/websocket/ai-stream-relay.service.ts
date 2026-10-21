import { Injectable, Logger } from "@nestjs/common";
import type { OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import IORedis from "ioredis";
import type { Redis } from "ioredis";
import { AiStreamEventSchema } from "@flow-gatekeeper/contracts";
import { AppConfigService } from "../config/config.service.js";
import { MonitoringGateway } from "./monitoring.gateway.js";
import { JobRoutingRegistry } from "./job-routing-registry.js";
import { getAppLogger } from "../../logging/app-logger.js";
import { attachThrottledErrorLog } from "../../lib/connection-error-throttle.js";
import { closeWithDeadline } from "./relay-close.js";

/**
 * AI 串流轉發（通道 A，憲章 IV）：專用 subscriber `psubscribe('ai-stream:*')`，把 worker
 * publish 的 `ai/token`／`ai/done`／`ai/error` 依 `jobId` 向 `JobRoutingRegistry` 查目前接收連線 → `gateway.send`。
 *
 * **只轉發、不刪綁定**：worker 先 publish `ai/done`、才由 BullMQ 標 `completed`；若此處在
 * `ai/done` 就刪綁定，通道 B（T020）的終態 `job/status:completed` 會查不到對象（F1）。綁定的
 * 建立由 `JobsService`（與 GET 的 claim）經 registry 進行，終態標記由 job-status relay 負責。反過來也不成立：
 * 兩個訊號分走不同 Redis 連線（本服務的 subscriber 與 QueueEvents 的 XREAD），api 端收到的先後沒有
 * 保證，`ai/done`／`ai/error` 可能晚於 `completed`／`failed` 才到——故 job-status relay 在終態後以
 * `registry.markTerminal` 把綁定保留 `TERMINAL_BINDING_GRACE_MS` 才刪（AR-5、D12），本服務查的就是同一份綁定，
 * 寬限內遲到的 `ai/*` 照常轉發。
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
  /** 已進入關閉流程：之後 subscriber 的 close／reconnecting 屬預期，不記成斷線。 */
  private closing = false;

  constructor(
    private readonly config: AppConfigService,
    private readonly gateway: MonitoringGateway,
    private readonly registry: JobRoutingRegistry,
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
      const throttle = attachThrottledErrorLog(this.subscriber, {
        error: (err, suppressed) =>
          this.logger.warn(
            `subscriber error: ${err.message}` +
              (suppressed > 0 ? `（期間另有 ${suppressed} 則同類錯誤未記）` : ""),
          ),
        recovered: (suppressed) =>
          this.logger.log(`subscriber connection recovered（故障期間共壓掉 ${suppressed} 則錯誤／斷線事件）`),
      });
      // AR-6：對端關閉連線（Redis 重啟、`CLIENT KILL TYPE pubsub`、閒置逾時）時 ioredis 只發
      // `close`／`reconnecting`、不發 error——不聽這兩個事件，斷線期間 worker publish 的 `ai/*` 會無聲
      // 遺失（Pub/Sub 不補送），前端只看到收了 `completed` 卻等不到 `ai/done`。兩者併入同一個轉態節流器：
      // 與 error 共用「故障中」狀態，整段故障只記第一則 warn，恢復由上面既有的 ready 記錄（含壓掉的則數）。
      const onConnectionLost = (event: "close" | "reconnecting"): void => {
        if (this.closing) return; // 優雅關閉時 quit()／disconnect() 本來就會發 close，不是故障
        const decision = throttle.onError(Date.now());
        if (decision.log) {
          this.logger.warn(
            `subscriber connection lost (${event})：斷線期間的 ai/* 事件會遺失，ioredis 自動重連並重新訂閱` +
              (decision.suppressed > 0 ? `（期間另有 ${decision.suppressed} 則同類事件未記）` : ""),
          );
        }
      };
      this.subscriber.on("close", () => onConnectionLost("close"));
      this.subscriber.on("reconnecting", () => onConnectionLost("reconnecting"));
      this.logger.log("ai-stream relay subscribed to 'ai-stream:*'");
    } catch (err) {
      this.logger.error(`ai-stream relay init failed: ${(err as Error).message}`);
    }
  }

  /**
   * 關閉 subscriber（API-12）：`quit()` 在 Redis 不可達時排在 offline queue、永不 resolve，故以
   * `RELAY_CLOSE_DEADLINE_MS` 為限，逾時改 `disconnect()` 強制斷線（同時清掉 offline queue）。
   */
  async onModuleDestroy(): Promise<void> {
    const subscriber = this.subscriber;
    if (!subscriber) return;
    this.closing = true;
    await closeWithDeadline(
      () => subscriber.quit(),
      () => subscriber.disconnect(),
      (ms) => this.logger.warn(`subscriber quit() 逾 ${ms} ms 未完成，改以 disconnect() 強制斷線`),
    );
  }

  private handleMessage(channel: string, message: string): void {
    const jobId = channel.slice("ai-stream:".length);
    const clientId = this.registry.owner(jobId);
    if (clientId === undefined) return; // 純後端 smoke 或已重連：略過推送，job 仍完成
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
    this.gateway.send(clientId, parsed.data); // 只轉發、不刪綁定（F1）
  }
}
