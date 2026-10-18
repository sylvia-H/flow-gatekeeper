import { Injectable } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import type { Queue } from "bullmq";
import { DIAGNOSIS_QUEUE } from "@flow-gatekeeper/contracts";
import type { DiagnosisJobPayload } from "@flow-gatekeeper/contracts";
import { attachThrottledErrorLog, bullmqConnection } from "../../lib/connection-error-throttle.js";
import { getAppLogger } from "../../logging/app-logger.js";

/**
 * producer `Queue` 的 error 監聽（API-1，P1）：bullmq 的 `QueueBase.emit` 在沒有監聽者時直接
 * `console.error(err)`，Redis AUTH 失敗的 `ReplyError` 帶著 `command.args`（即 `REDIS_PASSWORD`）
 * 明文進 stderr、也不經節流。改走 pino（serializer 剝掉 `command.args`）並以轉態節流記 warn。
 *
 * **在建構子掛、不等 `onModuleInit`**：Queue 一建立就開始連線，連不上時第一則 error 約 16 ms 內就到
 * （實測 ECONNREFUSED）；`onModuleInit` 要等其他模組的 hook 跑完（`HistoryService` 會先 await
 * Mongo 連線），這段空窗裡的錯誤照樣走 `console.error`。DI 建構階段沒有任何 I/O await，依賴 Queue
 * 的 provider 緊接在它之後建構，空窗內不會有 socket 事件插進來。
 *
 * 獨立成 provider（JobsModule 註冊）而不放進 `JobsService` 建構子：`JobsService`、`JobStatusRelayService`
 * 注入的是同一個 Queue 實例，只需掛一次；放在這裡也不讓 `JobsService` 的建構多一個副作用（各單測以
 * 只有 `getJob`／`add` 的假 queue 建構它）。
 */
@Injectable()
export class DiagnosisQueueErrorLog {
  private readonly plog = getAppLogger().child({ context: DiagnosisQueueErrorLog.name });

  constructor(@InjectQueue(DIAGNOSIS_QUEUE) queue: Queue<DiagnosisJobPayload>) {
    attachThrottledErrorLog(bullmqConnection(queue), {
      error: (err, suppressed) =>
        this.plog.warn(suppressed > 0 ? { err, suppressed } : { err }, "diagnosis queue redis connection error"),
      recovered: (suppressed) => this.plog.info({ suppressed }, "diagnosis queue redis connection recovered"),
    });
  }
}
