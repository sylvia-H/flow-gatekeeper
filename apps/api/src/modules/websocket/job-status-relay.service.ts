import { Injectable, Logger } from "@nestjs/common";
import type { OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Job, Queue, QueueEvents } from "bullmq";
import { DIAGNOSIS_QUEUE } from "@flow-gatekeeper/contracts";
import type { AiError, DiagnosisJobPayload, JobStatus } from "@flow-gatekeeper/contracts";
import { AppConfigService } from "../config/config.service.js";
import { MonitoringGateway } from "./monitoring.gateway.js";
import { JobRoutingRegistry } from "./job-routing-registry.js";
import type { JobBinding } from "./job-routing-registry.js";
import { completedStatus, progressStatus } from "./job-status-payload.js";
import type { ProgressFields } from "./job-status-payload.js";
import { getAppLogger } from "../../logging/app-logger.js";
import { attachThrottledErrorLog, bullmqConnection } from "../../lib/connection-error-throttle.js";
import { closeWithDeadline } from "./relay-close.js";

/**
 * delayed 期間補送 `job/status: waiting` 的間隔。必須明顯短於前端 45 秒的無進展 watchdog：
 * LLM 限流會把 job 延後到下一個分鐘窗（最長約 62 秒），重試退避也會 delayed，期間沒有任何事件，
 * 不補送的話前端會把仍在排隊的 job 判成逾時失敗。
 */
export const DELAYED_KEEPALIVE_MS = 15_000;
/**
 * 到期後仍未收到 waiting/active 的寬限：promote 由 worker 的延遲計時觸發，略晚於到期時間屬正常。
 * 刻意只補到這裡：promote 需要 worker 有空 slot，slot 全忙或 worker 已死時到期後仍無事件——
 * 這種情況交回前端 watchdog 判定，而不是無限補送把死掉的 worker 掩蓋成「排隊中」。
 */
const DELAYED_GRACE_MS = 5_000;
/**
 * Job 生命週期轉發（通道 B，憲章 IV）：以**獨立 blocking 連線**建 `QueueEvents`，把
 * waiting/active/completed/failed/progress/stalled 組成 `job/status` → `gateway.send`；`delayed` 以 `waiting`
 * 轉發，並在延後期間定期補送（見 `DELAYED_KEEPALIVE_MS`）。`completed` 的 `returnvalue` 與 `progress` 的 `data`
 * 來自 Redis、視為不受信任，經 `job-status-payload.ts` 的純函式驗證後才轉發（contracts/job-lifecycle §2）。
 *
 * **終態標記單一 owner**：僅在 `completed`/`failed`（最終終態）送出終態 `job/status` 之後才以
 * `registry.markTerminal` 標記綁定，確保終態 `job/status` 一定送得出去（F1）；兩種終態都保留
 * `TERMINAL_BINDING_GRACE_MS` 寬限才刪，讓跨連線晚到的 `ai/*` 仍轉發得到（AR-5、D12）。綁定本身與孤兒回收
 * 由 `JobRoutingRegistry` 持有。
 *
 * **最終失敗的 `ai/error(worker_failed)` 是安全網**：worker 在最終嘗試或不可重試的錯誤時，會在
 * throw 之前先 publish 帶具體 code 的 `ai/error`（例如 `schema_invalid`），那則通常先到、前端以
 * 先到者為準。但 stalled 用盡、processor 之外的例外等情況 worker 沒有機會 publish；若改由 worker
 * 在自己的 `failed` handler 補送，BullMQ 寫入 `failed` 事件早於那次 PUBLISH，那則到達 relay 時可能已過寬限、
 * 查無對象。故由 api 在送 `failed` 前補送這一則，順序由單一行程保證。
 */
@Injectable()
export class JobStatusRelayService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(JobStatusRelayService.name);
  // jobId 為 SC-002 跨行程串接的關聯鍵，MUST 為獨立結構化欄位（FR-002）。
  private readonly plog = getAppLogger().child({ context: JobStatusRelayService.name });
  private queueEvents?: QueueEvents;
  private keepaliveTimer?: ReturnType<typeof setInterval>;
  /** 目前處於 delayed 的 job → 預計恢復排隊的時間戳（ms）。 */
  private readonly delayedUntil = new Map<string, number>();

  constructor(
    private readonly config: AppConfigService,
    private readonly gateway: MonitoringGateway,
    private readonly registry: JobRoutingRegistry,
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
      this.queueEvents.on("waiting", ({ jobId }) => {
        // delayed 到期被 promote 回 wait 也走這裡：離開 delayed，停止補送。
        this.delayedUntil.delete(jobId);
        this.emit(jobId, "waiting");
      });
      this.queueEvents.on("active", ({ jobId }) => this.emit(jobId, "active"));
      this.queueEvents.on("stalled", ({ jobId }) => this.handleStalled(jobId));
      this.queueEvents.on("progress", ({ jobId, data }) => this.handleProgress(jobId, data));
      this.queueEvents.on("delayed", ({ jobId, delay }) => this.handleDelayed(jobId, Number(delay)));
      // bullmq 的 QueueEvents 已 JSON.parse 過 returnvalue（型別宣告寫 string，實際是解析後的值）。
      this.queueEvents.on("completed", ({ jobId, returnvalue }) => this.handleCompleted(jobId, returnvalue as unknown));
      // `failed` 只在「不會再重試」時才發：依 bullmq 5.79 原始碼，`Job.moveToFailed` 先以
      // `shouldRetryJob` 判斷（`attemptsMade + 1 < attempts` 且非 `UnrecoverableError`），需重試者走
      // `moveToDelayed`／`retryJob`，事件流只寫 `delayed`／`waiting`；唯有最終失敗才走
      // `moveToFinished`，在該 Lua 腳本內 `XADD ... "event", "failed"`。stalled 超過上限也是先標記
      // deferred failure、再由 worker 經同一條 `moveToFinished` 路徑失敗。因此這裡收到的一律是終態，
      // 可以安心送 `ai/error` 並標記終態（寬限後才刪）；中途重試不會誤觸發。
      this.queueEvents.on("failed", ({ jobId, failedReason }) => {
        void this.handleFailed(jobId, failedReason);
      });
      // 轉態節流：Redis 斷線時 QueueEvents 隨底層連線重連反覆發 error，逐則記錄會洗版。
      attachThrottledErrorLog(bullmqConnection(this.queueEvents), {
        error: (err, suppressed) =>
          this.logger.warn(
            `QueueEvents error: ${err.message}` +
              (suppressed > 0 ? `（期間另有 ${suppressed} 則同類錯誤未記）` : ""),
          ),
        recovered: (suppressed) =>
          this.logger.log(`QueueEvents connection recovered（故障期間共壓掉 ${suppressed} 則錯誤）`),
      });
      this.keepaliveTimer = setInterval(() => this.keepDelayedAlive(Date.now()), DELAYED_KEEPALIVE_MS);
      this.logger.log(`job-status relay listening QueueEvents('${DIAGNOSIS_QUEUE}')`);
    } catch (err) {
      this.logger.error(`job-status relay init failed: ${(err as Error).message}`);
    }
  }

  /**
   * 停 keepalive 計時器並關閉 QueueEvents（API-12）：`close()` 會先等底層 blocking 連線 ready，Redis 不可達或
   * 密碼錯時永不 resolve，故以 `RELAY_CLOSE_DEADLINE_MS` 為限，逾時改 `disconnect()` 強制斷線。
   * 寬限計時器與孤兒回收屬 `JobRoutingRegistry`，由它自己的 `onModuleDestroy` 停止。
   */
  async onModuleDestroy(): Promise<void> {
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    const queueEvents = this.queueEvents;
    if (!queueEvents) return;
    await closeWithDeadline(
      () => queueEvents.close(),
      () => queueEvents.disconnect(),
      (ms) => this.logger.warn(`QueueEvents close() 逾 ${ms} ms 未完成，改以 disconnect() 強制斷線`),
    );
  }

  /**
   * stalled（FR-021、D7）：worker 失去 lock，BullMQ 把 job 搬回 wait 重新派送。`moveStalledJobsToWait` 先寫 `waiting`
   * 再寫 `stalled`，所以畫面會依序收到兩則 `waiting`，第二則帶 `reason: "stalled"`（web 據此顯示「重新派送」說明）。
   * 之後新 worker 撿起時照常 `active`／progress（`execution` 遞增）。
   *
   * 每次都記 warn（FR-047；不論是否有綁定，stalled 本身就是值得注意的事件）。綁定已標終態（寬限中）時不送：
   * job 已結束，晚到的 stalled 不該把畫面拉回「排隊中」。
   */
  private handleStalled(jobId: string): void {
    this.plog.warn({ jobId, reason: "stalled" }, "job stalled, re-queued by bullmq");
    if (this.registry.get(jobId)?.terminal !== undefined) return;
    this.emit(jobId, "waiting", { reason: "stalled" });
  }

  /**
   * progress：`data` 經 `progressStatus` 拆解（D7）。012 worker 的物件形狀帶 `attempt`／`execution`，先記進綁定
   * （`completed` 時沿用，P7）再送 `active`；舊 worker 的數字照舊只帶 `progress`；其他形狀送不帶 progress 的 `active`。
   */
  private handleProgress(jobId: string, data: unknown): void {
    const fields = progressStatus(data);
    if (fields.attempt !== undefined || fields.execution !== undefined) {
      this.registry.noteProgress(jobId, fields.attempt, fields.execution);
    }
    this.emit(jobId, "active", fields);
  }

  /**
   * 完成：送 `job/status: completed`，再以 `markTerminal` 標記綁定（AR-5）：寬限
   * `TERMINAL_BINDING_GRACE_MS` 內 `ai/*` 照常轉發，`JobsService` 對同 jobId 的重送回 409「已使用過」
   * （與綁定立即刪除時的行為一致）；期滿由 registry 只刪標記當下那一份綁定。
   *
   * `returnvalue` 通過驗證才帶 `result`／`cached`（權威完成，D1）；不通過或缺值記 warn——只記 `jobId` 與 issue
   * 路徑／代碼、不記原文——並照送不帶 `result` 的 `completed`，前端仍可收尾。`null`／`undefined` 多半是 012 之前的
   * worker（processor 不回傳），訊息與「形狀不對」分開，方便從日誌區分升級落差與資料異常。
   */
  private handleCompleted(jobId: string, returnvalue: unknown): void {
    this.delayedUntil.delete(jobId);
    const target = this.routable(jobId);
    if (target) {
      const { status, issues } = completedStatus({
        jobId,
        machineId: target.machineId,
        returnvalue,
        binding: target.binding,
      });
      if (issues) {
        this.plog.warn(
          { jobId, issues },
          returnvalue == null
            ? "completed without returnvalue (legacy worker?)"
            : "invalid completed returnvalue, forwarding completed without result",
        );
      }
      this.gateway.send(target.binding.clientId, status);
    }
    this.registry.markTerminal(jobId, "completed");
  }

  /**
   * 最終失敗：先送 `ai/error(worker_failed)`、再送 `job/status:failed`、最後以 `markTerminal` 標記綁定。
   * 與 `completed` 同樣保留寬限（D12）：worker 送的具體 `ai/error`（如 `persist_failed`）走 Pub/Sub、可能晚於
   * `failed` 才到，寬限內仍轉發到原連線。
   *
   * 這則 `worker_failed` 是安全網：worker 在最終嘗試／不可重試時已先 publish 帶具體 code 的
   * `ai/error`，一般情況下前端早已收到並轉為失敗，這則會被當成過期事件忽略（前端以先到者為準）；
   * 真正生效的是 stalled 用盡、processor 外例外這類 worker 來不及 publish 的情況。
   * `ai/error` 排在 `job/status` 前面，是因為前端收到終態後就不再消費該 job 的事件，順序反過來
   * 會讓可讀的失敗原因被丟掉。MUST NOT 拋錯（由 QueueEvents 以 fire-and-forget 呼叫）。
   */
  private async handleFailed(jobId: string, failedReason: string): Promise<void> {
    if (this.registry.isBound(jobId)) {
      const attempt = await this.resolveAttempt(jobId);
      // await 之後重新查接收連線：查詢 attemptsMade 期間綁定可能已被 GET rebind（T031），
      // `ai/error` 與緊接的 `job/status:failed` 必須送到同一條（目前的）連線。
      const clientId = this.registry.owner(jobId);
      if (clientId !== undefined) {
        const aiError: AiError = { type: "ai/error", jobId, attempt, code: "worker_failed", message: failedReason };
        this.gateway.send(clientId, aiError);
      }
    }
    this.emit(jobId, "failed", { error: failedReason });
    this.registry.markTerminal(jobId, "failed");
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

  /**
   * job 進入 delayed（限流延後、重試退避、關閉中交回）：以契約既有的 `waiting` 告知前端它仍在
   * 排隊，並登記到期時間讓 keepalive 在等待期間定期補送。`delay` 是事件流帶的絕對時間戳。
   */
  private handleDelayed(jobId: string, until: number): void {
    if (!this.registry.isBound(jobId)) return;
    this.delayedUntil.set(jobId, Number.isFinite(until) ? until : Date.now());
    this.emit(jobId, "waiting");
  }

  /** 對仍在 delayed 的 job 補送 waiting；已到期逾寬限、或綁定已清掉者不再追蹤。 */
  private keepDelayedAlive(now: number): void {
    for (const [jobId, until] of this.delayedUntil) {
      if (!this.registry.isBound(jobId) || now > until + DELAYED_GRACE_MS) {
        this.delayedUntil.delete(jobId);
        continue;
      }
      this.emit(jobId, "waiting");
    }
  }

  /**
   * 送一則 `job/status`。`fields` 中值為 undefined 的欄位不放進訊息。
   */
  private emit(
    jobId: string,
    status: JobStatus["status"],
    fields: ProgressFields & Pick<JobStatus, "error" | "reason"> = {},
  ): void {
    // active/completed/failed 都代表 job 已離開 delayed，停止補送（waiting 由呼叫端各自處理）。
    if (status !== "waiting") this.delayedUntil.delete(jobId);
    const target = this.routable(jobId);
    if (!target) return;
    const jobStatus: JobStatus = { type: "job/status", jobId, machineId: target.machineId, status };
    if (fields.progress !== undefined) jobStatus.progress = fields.progress;
    if (fields.attempt !== undefined) jobStatus.attempt = fields.attempt;
    if (fields.execution !== undefined) jobStatus.execution = fields.execution;
    if (fields.error !== undefined) jobStatus.error = fields.error;
    if (fields.reason !== undefined) jobStatus.reason = fields.reason;
    this.gateway.send(target.binding.clientId, jobStatus);
  }

  /**
   * 可送 `job/status` 的綁定；無綁定或尚無 machineId 時回 undefined。
   *
   * 綁定尚無 machineId（GET 在 api 重啟後暫定建立，`resolveClaim` 之前，P1）時組不出合法的 `job/status`：這則
   * 擱置不送、也不事後補送，只在綁定記 `deferred`；GET 由 `resolveClaim` 得知後再查一次 state，以最新 state 回應。
   * 擱置窗只有一個 Redis 往返。`ai/*` 只看 `clientId`，不受影響。
   */
  private routable(jobId: string): { binding: Readonly<JobBinding>; machineId: string } | undefined {
    const binding = this.registry.get(jobId);
    if (!binding) return undefined; // 純後端 smoke 或已終態清理：略過
    if (binding.machineId === null) {
      this.registry.markDeferred(jobId);
      return undefined;
    }
    return { binding, machineId: binding.machineId };
  }
}
