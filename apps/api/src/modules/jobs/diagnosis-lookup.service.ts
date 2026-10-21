import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { createHash } from "node:crypto";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import {
  DIAGNOSIS_QUEUE,
  DiagnosisJobReturnValueSchema,
  DiagnosisResultSchema,
  isKnownMachineId,
} from "@flow-gatekeeper/contracts";
import type {
  DiagnosisJobPayload,
  DiagnosisLookupQuery,
  DiagnosisLookupResponse,
} from "@flow-gatekeeper/contracts";
import { ERROR_LOG_THROTTLE_MS, LogThrottle } from "@flow-gatekeeper/shared/logging";
import { DIAGNOSIS_READ_MAX_TIME_MS, HistoryService } from "../history/history.service.js";
import { MonitoringGateway } from "../websocket/monitoring.gateway.js";
import { JobRoutingRegistry } from "../websocket/job-routing-registry.js";
import type { LookupClaim } from "../websocket/job-routing-registry.js";
import { progressStatus, summarizeIssues } from "../websocket/job-status-payload.js";
import { throttledFields } from "../../lib/throttled-log.js";
import { getAppLogger } from "../../logging/app-logger.js";
import { ENQUEUE_TIMEOUT_MS, SOCKET_UNAVAILABLE_MESSAGE } from "./jobs.service.js";
import { withTimeout } from "./with-timeout.js";

/** Mongo 後援查詢的用戶端上限，與伺服器端 `maxTimeMS` 同值（contracts/diagnosis-lookup §5）。 */
export const MONGO_LOOKUP_TIMEOUT_MS = DIAGNOSIS_READ_MAX_TIME_MS;
export const LOOKUP_NOT_FOUND_MESSAGE = "查無此診斷（可能已過期）";
export const JOB_BOUND_ELSEWHERE_MESSAGE = "此診斷仍綁定在另一條連線";
export const LOOKUP_UNAVAILABLE_MESSAGE = "診斷狀態暫時無法查詢，請稍後再試";

/** 仍在進行中的 BullMQ state：回 200 waiting／active（或 409 `job_bound_elsewhere`）。 */
const IN_FLIGHT_STATES: ReadonlySet<string> = new Set([
  "waiting",
  "delayed",
  "prioritized",
  "waiting-children",
  "active",
]);
/** 終態：第一次讀到就直接回應，不補 machineId、不重讀。 */
const TERMINAL_STATES: ReadonlySet<string> = new Set(["completed", "failed"]);

/**
 * 日誌裡的 WS clientId 一律記 sha256 前 12 碼：clientId 是連線的存取憑證（知道它就能以它發 POST／GET），
 * 原值不進日誌；12 碼足以在同一段日誌裡對上同一條連線。
 */
function clientRef(clientId: string): string {
  return createHash("sha256").update(clientId).digest("hex").slice(0, 12);
}

/** lookup 只需要的依賴切面（測試可注入 fake）。 */
export type LookupJobSource = Pick<Queue<DiagnosisJobPayload>, "getJobState" | "getJob">;
export type LookupRegistry = Pick<
  JobRoutingRegistry,
  "claimForLookup" | "resolveClaim" | "revertClaim" | "owner" | "get" | "touch" | "markTerminal"
>;
export type LookupPresence = Pick<MonitoringGateway, "isAuthorized" | "isOnline">;
export type DiagnosisReader = Pick<HistoryService, "findDiagnosisResult">;

export type DiagnosisLookupInput = { jobId: string } & DiagnosisLookupQuery;

/** BullMQ job 的唯讀快照（只取本服務用到的欄位）。 */
type JobSnapshot = {
  state: string;
  machineId: unknown;
  returnvalue: unknown;
  failedReason: unknown;
  progress: unknown;
  attemptsMade: unknown;
  attemptsStarted: unknown;
};

/** 已決定的回應與 claim 是否保留（data-model §2.4：只有「進行中 × created／rebound」保留）。 */
type Outcome = { response: DiagnosisLookupResponse; keepClaim: boolean };
type InFlightResponse = Extract<DiagnosisLookupResponse, { status: "waiting" | "active" }>;

/**
 * `GET /diagnoses/:jobId?socketId=[&previousSocketId=]`（012 US2，FR-007～FR-013；contracts/diagnosis-lookup §3）。
 *
 * 處理順序：
 * 1. `socketId` 非在線且已授權 → 409 `socket_unauthorized`（warn 走 30 s 全域節流，同 POST）。
 * 2. **任何 await 之前** `registry.claimForLookup`：之後抵達的 `job/status`／`ai/*` 已會送到本次 socket（先綁定後查詢）。
 * 3. BullMQ `getJobState` → `getJob`（producer command 連線，全程上限 `ENQUEUE_TIMEOUT_MS`）；有 job 時 `resolveClaim`
 *    補上暫定綁定的 machineId，回 `deferred` 就重讀一次 job（P1）。
 * 4. 依 state × claim 回應（data-model §2.4），job 不存在／未知 state／`returnvalue` 不合法 → Mongo（上限 3 s）→ 200 或 404。
 * 5. 回應前（含拋錯），非保留的 claim 一律 `revertClaim`（只撤回本次請求自己的動作）。
 *
 * Redis／Mongo 錯誤或逾時 → 503（warn 以 30 s 節流）。日誌中的 clientId 一律為短雜湊（見 `clientRef`）。
 */
@Injectable()
export class DiagnosisLookupService {
  // jobId 為 SC-002 跨行程串接的關聯鍵，MUST 為獨立結構化欄位（FR-002）。
  private readonly plog = getAppLogger().child({ context: DiagnosisLookupService.name });
  /**
   * 對外可觸發的 warn 共用一個 30 s 全域節流（依 key 分開計）：409 socket 未授權（同 `JobsService`，任何人以亂數
   * socketId 就能反覆觸發）、Redis／Mongo 不可用（故障期間每個 GET 都會撞到）。
   */
  private readonly rejectLogThrottle = new LogThrottle(ERROR_LOG_THROTTLE_MS);

  constructor(
    @InjectQueue(DIAGNOSIS_QUEUE) private readonly queue: LookupJobSource,
    @Inject(JobRoutingRegistry) private readonly registry: LookupRegistry,
    @Inject(MonitoringGateway) private readonly presence: LookupPresence,
    @Inject(HistoryService) private readonly reader: DiagnosisReader,
  ) {}

  async lookup(input: DiagnosisLookupInput): Promise<DiagnosisLookupResponse> {
    const { jobId, socketId, previousSocketId } = input;
    if (!this.presence.isAuthorized(socketId)) {
      const fields = throttledFields(this.rejectLogThrottle, "socket-unauthorized", { jobId });
      if (fields) this.plog.warn(fields, "diagnosis lookup rejected: socket offline or unauthorized");
      throw new ConflictException({
        statusCode: 409,
        error: "Conflict",
        code: "socket_unauthorized",
        message: SOCKET_UNAVAILABLE_MESSAGE,
      });
    }

    // MUST 在任何 await 之前（FR-009）。
    const claim = this.registry.claimForLookup({
      jobId,
      socketId,
      previousSocketId,
      isOnline: (clientId) => this.presence.isOnline(clientId),
    });

    let keepClaim = false;
    try {
      const outcome = await this.decide(claim);
      keepClaim = outcome.keepClaim;
      return outcome.response;
    } finally {
      if (!keepClaim) this.registry.revertClaim(claim);
    }
  }

  private async decide(claim: LookupClaim): Promise<Outcome> {
    const { jobId } = claim;
    const snapshot = await this.readFromQueue(claim);
    if (snapshot !== undefined && (snapshot.state === "completed" || snapshot.state === "failed")) {
      this.markTerminalIfUnchanged(claim, snapshot.state);
    }

    if (snapshot?.state === "completed") {
      const parsed = DiagnosisJobReturnValueSchema.safeParse(snapshot.returnvalue);
      if (parsed.success) {
        return {
          response: { status: "completed", jobId, result: parsed.data.result, cached: parsed.data.cached },
          keepClaim: false,
        };
      }
      // 代理裁決第 16 條：returnvalue 不合法不直接 404，退到 Mongo（LLM 路徑的結果在那裡也有一份）。
      this.plog.warn(
        { jobId, issues: summarizeIssues(parsed.error) },
        "diagnosis lookup: invalid returnvalue, falling back to mongo",
      );
      return this.fromMongo(jobId);
    }

    if (snapshot?.state === "failed") {
      const error = typeof snapshot.failedReason === "string" ? snapshot.failedReason : "";
      return { response: { status: "failed", jobId, error }, keepClaim: false };
    }

    if (snapshot !== undefined && IN_FLIGHT_STATES.has(snapshot.state)) {
      return this.inFlight(claim, snapshot);
    }

    // 查無 job，或 state 不在列舉內（例如 unknown）：視同查無 job。
    return this.fromMongo(jobId);
  }

  /** 進行中：依 claim 回 200 `rebound: true`（保留 created／rebound）或 409 `job_bound_elsewhere`。 */
  private inFlight(claim: LookupClaim, snapshot: JobSnapshot): Outcome {
    const { jobId, socketId } = claim;
    // 等 Redis 期間綁定可能已被另一個 GET 改綁走（例如以 previousSocketId 改綁）：回 rebound: true 前確認
    // 之後的事件確實會送到本 socket，否則與 conflict 同樣回 409。
    if (claim.kind === "conflict") throw this.boundElsewhere(jobId, socketId);
    if (claim.kind === "terminal") {
      // data-model §2.4：不可達、回 503 不重判。registry 已標終態、BullMQ 卻仍是進行中（終態事件晚於 state 寫入，
      // 照理查到的 state 已是終態）；不猜測要不要改綁，回 503 讓 web 稍後重試。
      this.plog.warn({ jobId, state: snapshot.state }, "diagnosis lookup: terminal binding but job still in flight");
      throw new ServiceUnavailableException(LOOKUP_UNAVAILABLE_MESSAGE);
    }
    const owner = this.registry.owner(jobId);
    if (owner === undefined) {
      // 等 Redis 期間綁定消失（孤兒回收、終態寬限期滿）：不知道之後的事件會不會送到本 socket，回 503 讓 web 重試，
      // 下一次 GET 會重新建立綁定。
      this.plog.warn({ jobId }, "diagnosis lookup: binding vanished while reading job");
      throw new ServiceUnavailableException(LOOKUP_UNAVAILABLE_MESSAGE);
    }
    if (owner !== socketId) throw this.boundElsewhere(jobId, socketId);
    if (claim.kind === "unchanged") {
      // 使用者仍在等這個任務：孤兒回收自此重新起算（P23）。
      this.registry.touch(jobId, socketId);
    } else {
      this.plog.info(
        {
          jobId,
          claim: claim.kind,
          fromClientId: claim.kind === "rebound" ? clientRef(claim.previous.clientId) : null,
          toClientId: clientRef(socketId),
          viaPreviousSocketId: claim.kind === "rebound" && claim.viaPreviousSocketId,
        },
        "diagnosis lookup rebound job to requesting connection",
      );
    }

    const response: InFlightResponse = {
      status: snapshot.state === "active" ? "active" : "waiting",
      jobId,
      rebound: true,
    };
    const { progress } = progressStatus(snapshot.progress);
    if (progress !== undefined) response.progress = progress;
    if (isNonNegativeInt(snapshot.attemptsMade)) response.attempt = snapshot.attemptsMade + 1;
    if (isNonNegativeInt(snapshot.attemptsStarted) && snapshot.attemptsStarted >= 1) {
      response.execution = snapshot.attemptsStarted;
    }
    return { response, keepClaim: claim.kind === "created" || claim.kind === "rebound" };
  }

  /**
   * 讀 BullMQ（全程上限 `ENQUEUE_TIMEOUT_MS`）。claim 為 created／rebound 時以 `job.data.machineId` `resolveClaim`
   * （只有這兩種是本請求建立或改綁的綁定；unchanged 等不碰，避免同 socket 並發的另一個 GET 搶走 deferred）；
   * 期間 relay 有 `job/status` 被擱置（`deferred`）就重讀一次 job 與 state，以最新狀態回應（P1）。
   * 第一次讀到終態就直接回傳，不補 machineId、不重讀（claim 反正會撤回）。逾時或 Redis 錯誤 → 503。
   * `job.data.machineId` 不在機台名冊（Redis 資料不可信）→ 503（呼叫端撤回，不留 null 綁定）；例外是 rebound 且原綁定
   * 已有 machineId——不需要補，照常回應。
   */
  private async readFromQueue(claim: LookupClaim): Promise<JobSnapshot | undefined> {
    const deadline = Date.now() + ENQUEUE_TIMEOUT_MS;
    const read = () => withTimeout(this.snapshot(claim.jobId), Math.max(0, deadline - Date.now()), "job lookup");
    const owns = claim.kind === "created" || claim.kind === "rebound";
    let first: JobSnapshot | undefined;
    try {
      first = await read();
    } catch (err) {
      throw this.redisUnavailable(claim.jobId, err);
    }
    if (first === undefined || TERMINAL_STATES.has(first.state) || !owns) return first;
    if (typeof first.machineId !== "string" || !isKnownMachineId(first.machineId)) {
      // rebound 且原綁定已有 machineId：不需補，照常回應。
      if (claim.kind === "rebound" && this.registry.get(claim.jobId)?.machineId != null) return first;
      this.plog.warn(
        { jobId: claim.jobId },
        "diagnosis lookup: job data has no valid machineId, cannot route job/status",
      );
      throw new ServiceUnavailableException(LOOKUP_UNAVAILABLE_MESSAGE);
    }
    const { deferred } = this.registry.resolveClaim(claim, first.machineId);
    if (!deferred) return first;
    try {
      return await read();
    } catch (err) {
      throw this.redisUnavailable(claim.jobId, err);
    }
  }

  private redisUnavailable(jobId: string, err: unknown): ServiceUnavailableException {
    const fields = throttledFields(this.rejectLogThrottle, "redis-unavailable", { jobId, err });
    if (fields) this.plog.warn(fields, "diagnosis lookup failed, redis unavailable");
    return new ServiceUnavailableException(LOOKUP_UNAVAILABLE_MESSAGE);
  }

  private boundElsewhere(jobId: string, socketId: string): ConflictException {
    this.plog.info(
      { jobId, clientId: clientRef(socketId) },
      "diagnosis lookup conflict: job bound to another live connection",
    );
    return new ConflictException({
      statusCode: 409,
      error: "Conflict",
      code: "job_bound_elsewhere",
      message: JOB_BOUND_ELSEWHERE_MESSAGE,
    });
  }

  /**
   * GET 讀到終態、綁定又是本 socket 原本那份（unchanged）且 registry 尚未標終態：代表 relay 錯過了終態事件（例如 api
   * 重啟後 QueueEvents 從 `$` 讀起），在此補標，讓綁定照寬限刪除，而不是留到孤兒回收。
   */
  private markTerminalIfUnchanged(claim: LookupClaim, kind: "completed" | "failed"): void {
    if (claim.kind !== "unchanged") return;
    const current = this.registry.get(claim.jobId);
    if (current === undefined || current.clientId !== claim.socketId || current.terminal !== undefined) return;
    this.registry.markTerminal(claim.jobId, kind);
  }

  /**
   * 先讀 state、再讀 job hash：state 永遠不比資料新。兩者是兩個獨立的 Redis 指令，完成可能落在中間；反過來（先 hash
   * 後 state）會讀到「hash 尚無 returnvalue／failedReason、state 卻已是 completed／failed」，快取命中的 job（不寫 Mongo）
   * 因此誤回 404、failed 回空的 error。依此順序，最壞情況是 state 仍為進行中而 hash 已完成——回 `rebound: true`，之後
   * WS 照常收到 `completed`／`failed`；讀到終態時 hash 必已寫好（BullMQ 以單一 Lua 腳本原子地寫 hash 並搬移 state）。
   * `unknown` 視同查無 job；兩次讀取之間 job 被 removeOn* 清掉（`getJob` 回 undefined）也一樣，交給 Mongo 後援。
   */
  private async snapshot(jobId: string): Promise<JobSnapshot | undefined> {
    const state = await this.queue.getJobState(jobId);
    if (state === "unknown") return undefined;
    let job: Awaited<ReturnType<LookupJobSource["getJob"]>>;
    try {
      job = await this.queue.getJob(jobId);
    } catch (err) {
      // job hash 解析失敗（BullMQ 對 data／opts 做 JSON.parse）不是 Redis 不可用：資料本身壞了，退到 Mongo 後援。
      if (!(err instanceof SyntaxError)) throw err;
      this.plog.warn({ jobId }, "diagnosis lookup: job hash unparsable, falling back to mongo");
      return undefined;
    }
    if (!job) return undefined;
    // 資料來自 Redis：快照欄位一律以 unknown 看待（JobSnapshot 的型別），使用前各自檢查。
    const data = job.data as unknown;
    return {
      state,
      machineId: typeof data === "object" && data !== null ? (data as { machineId?: unknown }).machineId : undefined,
      returnvalue: job.returnvalue,
      failedReason: job.failedReason,
      progress: job.progress,
      attemptsMade: job.attemptsMade,
      attemptsStarted: job.attemptsStarted,
    };
  }

  /** Mongo `diagnoses` 後援：合法結果 200 completed（`cached: false`），查無或不合法 404，錯誤或逾時 503。 */
  private async fromMongo(jobId: string): Promise<Outcome> {
    let raw: unknown;
    try {
      raw = await withTimeout(this.reader.findDiagnosisResult(jobId), MONGO_LOOKUP_TIMEOUT_MS, "diagnosis read");
    } catch (err) {
      const fields = throttledFields(this.rejectLogThrottle, "mongo-unavailable", { jobId, err });
      if (fields) this.plog.warn(fields, "diagnosis lookup failed, mongo unavailable");
      throw new ServiceUnavailableException(LOOKUP_UNAVAILABLE_MESSAGE);
    }
    if (raw === null || raw === undefined) throw new NotFoundException(LOOKUP_NOT_FOUND_MESSAGE);
    const parsed = DiagnosisResultSchema.safeParse(raw);
    if (!parsed.success) {
      this.plog.warn({ jobId, issues: summarizeIssues(parsed.error) }, "diagnosis lookup: invalid mongo result");
      throw new NotFoundException(LOOKUP_NOT_FOUND_MESSAGE);
    }
    return { response: { status: "completed", jobId, result: parsed.data, cached: false }, keepClaim: false };
  }
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
