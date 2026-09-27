import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { randomUUID } from "node:crypto";
import { DIAGNOSIS_QUEUE, MACHINE_IDS } from "@flow-gatekeeper/contracts";
import type {
  CreateDiagnosisBody,
  CreateDiagnosisResponse,
  DiagnosisJobPayload,
} from "@flow-gatekeeper/contracts";
import { AiStreamRelayService } from "../websocket/ai-stream-relay.service.js";
import { MonitoringGateway } from "../websocket/monitoring.gateway.js";
import { ERROR_LOG_THROTTLE_MS, LogThrottle } from "@flow-gatekeeper/shared/logging";
import { throttledFields } from "../../lib/throttled-log.js";
import { getAppLogger } from "../../logging/app-logger.js";

/**
 * 入列（含重複檢查）的逾時上限。producer 連線雖已設為斷線即 reject，但 BullMQ Queue 在首次
 * 連線尚未 ready 時會等待連線建立——Redis 啟動前就收到的請求若不設上限，會掛到 Redis 恢復。
 */
export const ENQUEUE_TIMEOUT_MS = 5_000;

/** 綁定查詢／建立／清理——JobsService 只需要 relay 的這三個能力（測試可注入 fake）。 */
export type JobBindingStore = Pick<AiStreamRelayService, "bindJobToClient" | "getBinding" | "deleteBinding">;

/** 發起連線的在線／授權查詢——JobsService 只需要 Gateway 的這個能力（測試可注入 fake）。 */
export type ClientPresence = Pick<MonitoringGateway, "isAuthorized">;

/**
 * 機台名冊（與 Gateway 過濾訂閱、web 渲染共用 `@flow-gatekeeper/contracts` 的 `MACHINE_IDS` 單一來源）。
 * 不在名冊的 machineId 不入列：否則每個亂數 id 必然 cache miss、真的打一次 LLM，且沒有任何
 * telemetry／errorlog／維修紀錄可供診斷。
 */
const KNOWN_MACHINE_IDS: ReadonlySet<string> = new Set(MACHINE_IDS);

class EnqueueTimeoutError extends Error {
  constructor() {
    super(`enqueue timed out after ${ENQUEUE_TIMEOUT_MS}ms`);
  }
}

/**
 * 建立診斷 job（API 只入列與綁定，不跑 long-running，憲章 IV）。
 * jobId 綁定發起連線 → 組完整 payload → enqueue（attempts/backoff/removeOn*，FR-003）。
 *
 * **冪等（jobId 為前端產生的 idempotency key）**：同一 jobId 重送時，回同一個
 * `{ jobId, machineId, status: "waiting" }`，**保留第一次的綁定、不改綁到新的 socketId**。
 * 理由：綁定決定 AI 串流送給哪條連線；若後到者能覆蓋，任何知道 jobId 的一方都能把別人的
 * 診斷結果改送到自己的連線。前端重連後拿到新 clientId 的情況，應以新 jobId 重新發起。
 * - 同 jobId、不同 machineId → 409（同一把 key 不能代表兩個請求）。
 * - 綁定已不在、但 job 仍留在 Redis（已完成／失敗、或綁定被回收）→ 409：不會重跑，
 *   也不會再有任何事件，靜默回 200 只會讓前端等到 watchdog 逾時。
 *
 * machineId 不在機台名冊 → 404，在任何綁定與入列之前擋下（見 `KNOWN_MACHINE_IDS`）。
 *
 * socketId 不是「在線且已授權」的 WS 連線 → 409（API-4）：AI 串流與 `job/status` 只送已授權
 * 連線，綁到未授權或已斷線的 clientId 只會讓診斷結果無處可送；不擋的話 `POST /diagnoses` 也會
 * 成為繞過 `WS_AUTH_SECRET` 的入口。冪等重送同樣檢查（檢查的是本次請求帶的 socketId）。
 */
@Injectable()
export class JobsService {
  // jobId 為 SC-002 跨行程串接的關聯鍵，MUST 為獨立結構化欄位（FR-002）。
  private readonly plog = getAppLogger().child({ context: JobsService.name });
  /**
   * 409（socket 未授權／離線）warn 的全域節流：每 30 秒至多一則並附 `suppressed`。此路徑可由
   * 任何人以亂數 socketId 反覆觸發，逐則記錄等於讓外部請求直接放大日誌量。
   */
  private readonly rejectLogThrottle = new LogThrottle(ERROR_LOG_THROTTLE_MS);
  /**
   * 進行中的入列（jobId → 結果）。併發重送命中既有綁定時要等首發的入列結果：首發之後可能逾時或
   * 409 而刪掉綁定並回錯誤，此時重送方若已先回 200，拿到的就是一個不存在的 job。
   */
  private readonly enqueuing = new Map<string, Promise<void>>();

  constructor(
    @InjectQueue(DIAGNOSIS_QUEUE) private readonly queue: Queue<DiagnosisJobPayload>,
    @Inject(AiStreamRelayService) private readonly relay: JobBindingStore,
    @Inject(MonitoringGateway) private readonly presence: ClientPresence,
  ) {}

  async createDiagnosis(body: CreateDiagnosisBody): Promise<CreateDiagnosisResponse> {
    const jobId = body.jobId ?? randomUUID();
    const { machineId } = body;

    // 名冊檢查先於冪等檢查：未知機台不可能有既有綁定，也不該因重送而得到 409 這類誤導的回應。
    if (!KNOWN_MACHINE_IDS.has(machineId)) {
      throw new NotFoundException({
        statusCode: 404,
        error: "Not Found",
        message: "此機台不在名冊中",
      });
    }

    // 在線／授權檢查先於冪等檢查：重送帶的 socketId 若已斷線或未授權，同樣不該拿到 200。
    // 限制：檢查的是「本次請求」的 socketId；冪等命中時仍保留第一次綁定的舊 clientId（不改綁），
    // 故 409 檢查不保證既有綁定仍有效（原連線可能已斷）。web 每次發起都用新 jobId，實務上不觸發。
    if (!this.presence.isAuthorized(body.socketId)) {
      const fields = throttledFields(this.rejectLogThrottle, "socket-unauthorized", { jobId, machineId });
      if (fields) this.plog.warn(fields, "diagnosis rejected: socket offline or unauthorized");
      throw new ConflictException({
        statusCode: 409,
        error: "Conflict",
        message: "WebSocket 連線不存在或未授權，請重新連線後再發起診斷",
      });
    }

    const existing = this.relay.getBinding(jobId);
    if (existing) {
      if (existing.machineId !== machineId) {
        throw new ConflictException("jobId 已用於另一台機台的診斷");
      }
      this.plog.info({ jobId, machineId }, "duplicate diagnosis request, keeping original binding");
      // 首發仍在入列：共用它的結果（失敗時拋出同一個錯誤）。
      await this.enqueuing.get(jobId);
      return { jobId, machineId, status: "waiting" };
    }

    // 綁定必須在任何 await 之前建立：早到的 job/status／ai/* 要能找到對象，同一 jobId 的
    // 併發重送也會在上面的檢查命中，而不是各自入列。
    this.relay.bindJobToClient(jobId, body.socketId, machineId);

    const payload: DiagnosisJobPayload = {
      jobId,
      machineId,
      requestedBy: body.requestedBy ?? "demo-user",
      requestedAt: new Date().toISOString(),
      windowMinutes: 5,
    };

    const work = this.enqueueOrUnbind(payload);
    this.enqueuing.set(jobId, work);
    try {
      await work;
    } finally {
      this.enqueuing.delete(jobId);
    }

    this.plog.info({ jobId, machineId, requestedBy: payload.requestedBy }, "diagnosis job created");
    return { jobId, machineId, status: "waiting" };
  }

  /** 有時限地入列；失敗時解除綁定並轉成對外的 409／503。 */
  private async enqueueOrUnbind(payload: DiagnosisJobPayload): Promise<void> {
    const { jobId, machineId } = payload;
    try {
      await withTimeout(this.enqueueOnce(payload), ENQUEUE_TIMEOUT_MS);
    } catch (err) {
      this.relay.deleteBinding(jobId);
      if (err instanceof ConflictException) throw err;
      this.plog.warn({ jobId, machineId, err }, "diagnosis enqueue failed, redis unavailable");
      // 逾時後底層的 add 仍可能在 Redis 恢復時完成（無法撤回），此時 job 會在無綁定下跑完；
      // 前端以同一 jobId 重送會得到 409 而非第二個 job，不會重複打 LLM。
      throw new ServiceUnavailableException("診斷佇列暫時無法使用，請稍後再試");
    }
  }

  /**
   * 先確認 jobId 未曾入列再 add。BullMQ 對重複 jobId 的 add 本身冪等（不建第二個 job），
   * 但它不告訴呼叫端「這是重複的」；先查一次才能對已結束的 job 明確回 409。
   */
  private async enqueueOnce(payload: DiagnosisJobPayload): Promise<void> {
    if (await this.queue.getJob(payload.jobId)) {
      throw new ConflictException("jobId 已使用過，請以新的 jobId 重新發起診斷");
    }
    await this.queue.add("diagnose-machine", payload, {
      jobId: payload.jobId,
      attempts: 3,
      backoff: { type: "exponential", delay: 5000 },
      removeOnComplete: { age: 3600, count: 1000 },
      removeOnFail: { age: 86400, count: 5000 },
    });
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

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new EnqueueTimeoutError()), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
