import { Injectable } from "@nestjs/common";
import type { OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { getAppLogger } from "../../logging/app-logger.js";

/** 終態種類：`completed` 與 `failed` 共用同一段寬限程式（ADR-003 D12）。 */
export type TerminalKind = "completed" | "failed";

/**
 * jobId → 目前接收此 job 事件的 WS 連線（記憶體，api 重啟即失效；外置見 ADR-003 §5）。
 *
 * - `machineId`：`job/status` 需要它路由到畫面；GET 在 api 重啟後暫定建立綁定時為 `null`，`Job.fromId`
 *   後補上（012 P1）。
 * - `boundAt`：建立或最近一次 rebind 的時刻；孤兒回收以此起算（P23）。
 * - `terminal`：job 已 `completed`／`failed`、綁定只是在寬限期內保留給跨連線晚到的 `ai/*`（AR-5、D12）時才有值。
 *   `JobsService` 據此把同 jobId 的重送判為「已使用過」回 409，而不是當成進行中的冪等重送回 200 waiting。
 * - `attempt`／`execution`：最近一次 progress 物件帶來的值，`completed` 時沿用（P7）。
 * - `deferred`：`machineId` 為 null 期間 relay 有 `job/status` 被擱置（P1）。
 *
 * 見 specs/012-stream-resilience/data-model.md §2.1。
 */
export type JobBinding = {
  clientId: string;
  machineId: string | null;
  boundAt: number;
  terminal?: { kind: TerminalKind; at: number };
  attempt?: number;
  execution?: number;
  deferred?: boolean;
};

/**
 * 終態後綁定再保留多久才刪（AR-5、D12）。worker 先 publish `ai/done`／`ai/error` 才讓 BullMQ 標終態，
 * 但兩者在 api 端分走 subscriber 與 QueueEvents 兩條連線，到達先後沒有保證；立刻刪綁定，晚到的
 * `ai/*` 會查無對象被丟掉（`failed` 時就是 worker 送的具體錯誤碼如 `persist_failed` 被吞掉，畫面只剩
 * api 補送的籠統 `worker_failed`）。10 s 遠大於同機 Redis 的跨連線時間差，又短到不讓綁定 Map 因大量
 * 結束的 job 明顯累積。
 */
export const TERMINAL_BINDING_GRACE_MS = 10_000;
/** 孤兒綁定回收安全期（QueueEvents 異常時避免 Map 洩漏，FR-002）；自 `boundAt` 起算。 */
export const ORPHAN_TTL_MS = 10 * 60_000;
/** 孤兒回收的掃描間隔。 */
export const ORPHAN_SWEEP_INTERVAL_MS = 60_000;

/** `claimForLookup` 的輸入（GET `/diagnoses/:jobId`，FR-009）。 */
export type LookupClaimInput = {
  jobId: string;
  /** 本次請求的連線（呼叫端已確認在線且已授權）。 */
  socketId: string;
  /** web 記得的上一條連線（重連前的 clientId）；與在線的原綁定相同時也允許改綁（P22）。 */
  previousSocketId?: string | undefined;
  /** 連線是否在線——由呼叫端以 `gateway.isOnline` 提供，registry 不依賴 Gateway。 */
  isOnline: (clientId: string) => boolean;
};

/**
 * `claimForLookup` 的結果（data-model §2.3）。`binding` 是本次請求建立或改綁出來的那一份物件參照，
 * `revertClaim` 以它判斷「目前綁定仍是自己的那份」。
 *
 * - `created`：原本無綁定，已以 `machineId: null` 暫定建立（P1）。
 * - `terminal`：綁定已標終態（寬限中），不動。
 * - `unchanged`：綁定本來就是本 socket，不動（GET 仍回 `rebound: true`，P22）。
 * - `rebound`：已改綁到本 socket；`previous` 是被取代的原綁定，`viaPreviousSocketId` 表示原連線仍在線、
 *   因等於 `previousSocketId` 而改綁（不主動終止舊連線）。
 * - `conflict`：原連線在線、不是本 socket、也不等於 `previousSocketId`，不動。
 */
export type LookupClaim =
  | { kind: "created"; jobId: string; socketId: string; binding: Readonly<JobBinding> }
  | { kind: "terminal"; jobId: string; socketId: string }
  | { kind: "unchanged"; jobId: string; socketId: string }
  | {
      kind: "rebound";
      jobId: string;
      socketId: string;
      binding: Readonly<JobBinding>;
      previous: Readonly<JobBinding>;
      viaPreviousSocketId: boolean;
    }
  | { kind: "conflict"; jobId: string; socketId: string; ownerClientId: string };

/**
 * 綁定的單一持有者（FR-014；research R3）：POST（`JobsService`）、GET、兩支 relay 都經它讀寫，
 * 不再由 `AiStreamRelayService` 持有一個三方共用的 Map。
 *
 * **不變量**（data-model §2.1）：每個 jobId 至多一份綁定；只有本類別能改寫；寬限期滿只刪「當初那一份
 * 物件」（以參照比對），不誤刪之後以同一 jobId 新建的綁定。`get` 回傳唯讀視圖，呼叫端不得改寫。
 *
 * 不依賴 Gateway（在線查詢由呼叫端以參數傳入），避免 Nest provider 循環、也方便純單元測試。
 * 狀態是一般 `Map`（非 reactive）。
 *
 * **換物件 vs 就地改寫**：會改變「這是哪一份綁定」語意的操作（`bind`、`rebind`、`markTerminal`）換新物件；
 * 只補充資訊的操作（`noteProgress`、`markDeferred`、`resolveClaim` 補 machineId）MUST 就地改寫——寬限計時器與
 * `revertClaim` 都以參照比對，換物件會讓它們認不得這份綁定。
 *
 * **GET `/diagnoses/:jobId` 的用法（T034，contracts/diagnosis-lookup §3）**：
 * 1. 授權檢查通過後、**任何 await 之前**呼叫 `claimForLookup`（同步，FR-009）——之後抵達的 `job/status`／`ai/*`
 *    才會送到本次 socket（先綁定後查詢）。
 * 2. `Job.fromId` 取得 job 後呼叫 `resolveClaim(claim, job.data.machineId)` 補上暫定綁定的 machineId；回傳
 *    `deferred: true` 表示補上之前 relay 有 `job/status` 被擱置（不會補送），呼叫端 MUST 再查一次 state，以最新
 *    state 回應（P1）。
 * 3. 依 data-model §2.4：保留的只有「進行中 × created／rebound」；其餘回應前一律 `revertClaim(claim)`
 *    （unchanged／terminal／conflict 為 no-op，可無條件呼叫）。進行中 × `conflict` 回 409 `job_bound_elsewhere`。
 * 4. rebind 的 info 日誌取 `claim.previous.clientId` → `claim.socketId` 與 `claim.viaPreviousSocketId`。
 */
@Injectable()
export class JobRoutingRegistry implements OnModuleInit, OnModuleDestroy {
  // jobId 為 SC-002 跨行程串接的關聯鍵，MUST 為獨立結構化欄位（FR-002）。
  private readonly plog = getAppLogger().child({ context: JobRoutingRegistry.name });
  private readonly bindings = new Map<string, JobBinding>();
  /** 終態後等待寬限期滿才刪綁定的 job → 其計時器（見 `TERMINAL_BINDING_GRACE_MS`）。 */
  private readonly graceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private sweepTimer?: ReturnType<typeof setInterval>;

  onModuleInit(): void {
    this.sweepTimer = setInterval(() => this.sweepOrphans(Date.now()), ORPHAN_SWEEP_INTERVAL_MS);
  }

  /**
   * 停孤兒回收與所有寬限計時器。寬限中的綁定不再等期滿：行程即將結束，綁定隨記憶體一起消失。
   */
  onModuleDestroy(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
    for (const timer of this.graceTimers.values()) clearTimeout(timer);
    this.graceTimers.clear();
  }

  /** 建立（或覆蓋）綁定：`clientId` 即 WS `clientId`（data-model §4）。 */
  bind(jobId: string, clientId: string, machineId: string | null, now: number = Date.now()): void {
    this.clearGraceTimer(jobId);
    this.bindings.set(jobId, { clientId, machineId, boundAt: now });
  }

  /**
   * 把既有綁定改送到 `clientId`，並把 `boundAt` 更新為 `now`（孤兒回收自改綁起算，P23）。以新物件
   * 取代舊綁定，回傳被取代的那一份（供呼叫端撤回時還原）；無綁定、或綁定已標終態時不動、回 undefined
   * （終態綁定只等寬限期滿刪除，不可改綁——與 data-model §2.3 第 2 列「terminal → 不動」一致）。
   * 還原見 `revertClaim`（以 `{ ...current, clientId, boundAt }` 寫回，不直接放回 `previous` 物件）。
   */
  rebind(jobId: string, clientId: string, now: number = Date.now()): JobBinding | undefined {
    const previous = this.bindings.get(jobId);
    if (!previous || previous.terminal !== undefined) return undefined;
    this.bindings.set(jobId, { ...previous, clientId, boundAt: now });
    return previous;
  }

  get(jobId: string): Readonly<JobBinding> | undefined {
    return this.bindings.get(jobId);
  }

  /** 目前接收此 job 事件的連線 clientId；無綁定回 undefined。 */
  owner(jobId: string): string | undefined {
    return this.bindings.get(jobId)?.clientId;
  }

  isBound(jobId: string): boolean {
    return this.bindings.has(jobId);
  }

  /**
   * 記下 progress 物件帶來的 `attempt`／`execution`（P7），各自取目前看過的最大值（單調遞增）。就地更新、不換物件：
   * 寬限計時器與撤回都以參照比對，換物件會讓它們認不得這份綁定。
   */
  noteProgress(jobId: string, attempt: number | undefined, execution: number | undefined): void {
    const binding = this.bindings.get(jobId);
    if (!binding) return;
    // 單調遞增：Redis 停頓造成雙重執行時，舊的那次（exec1）恢復後仍可能送出較小的值；不得讓它覆寫較新的值。
    if (attempt !== undefined) binding.attempt = Math.max(binding.attempt ?? 0, attempt);
    if (execution !== undefined) binding.execution = Math.max(binding.execution ?? 0, execution);
  }

  /**
   * 標記綁定所屬的 job 已達終態（job-status relay 送出 `completed`／`failed` 時呼叫，AR-5、D12）：綁定仍保留、
   * 照常轉發寬限內晚到的 `ai/*`，只是不再接受同 jobId 的冪等重送；`TERMINAL_BINDING_GRACE_MS` 後刪除。
   *
   * 以新物件取代舊綁定：期滿時只刪「標記當下那一份」——期間若被孤兒回收或其他路徑刪掉後又以同一 jobId
   * 重新綁定，新綁定不屬於這次終態，不得誤刪；換物件也讓之後的撤回（以參照比對）認出綁定已被標終態。
   * 計時器 `unref()`：不應為了等寬限而延後行程結束。無綁定時不動（純後端 smoke 或已清理）。
   */
  markTerminal(jobId: string, kind: TerminalKind, now: number = Date.now()): void {
    const binding = this.bindings.get(jobId);
    if (!binding) return;
    const terminal: JobBinding = { ...binding, terminal: { kind, at: now } };
    this.bindings.set(jobId, terminal);
    this.clearGraceTimer(jobId);
    const timer = setTimeout(() => {
      this.graceTimers.delete(jobId);
      if (this.bindings.get(jobId) === terminal) this.bindings.delete(jobId);
    }, TERMINAL_BINDING_GRACE_MS);
    timer.unref();
    this.graceTimers.set(jobId, timer);
  }

  /**
   * relay 因綁定尚無 machineId 而擱置了一則 `job/status`（P1）：就地記 `deferred: true`，由 `resolveClaim` 回報給 GET。
   */
  markDeferred(jobId: string): void {
    const binding = this.bindings.get(jobId);
    if (binding) binding.deferred = true;
  }

  /**
   * GET 的同步暫定綁定（data-model §2.3，依序第一個成立者決定 kind）：
   *
   * | # | 現有綁定 | 條件 | kind | 動作 |
   * | 1 | 無 | — | created | `bind(jobId, socketId, null)` |
   * | 2 | 有 | `terminal` 已設 | terminal | 不動 |
   * | 3 | 有 | `clientId === socketId` | unchanged | 不動 |
   * | 4 | 有 | `!isOnline(clientId)` | rebound | 改綁到 socketId |
   * | 5 | 有 | `clientId === previousSocketId`（仍在線） | rebound（viaPreviousSocketId） | 改綁；不終止舊連線 |
   * | 6 | 有 | 其他 | conflict | 不動 |
   *
   * MUST 在任何 await 之前呼叫（FR-009）；本方法本身完全同步。
   */
  claimForLookup(input: LookupClaimInput, now: number = Date.now()): LookupClaim {
    const { jobId, socketId, previousSocketId, isOnline } = input;
    const existing = this.bindings.get(jobId);
    if (!existing) {
      this.bind(jobId, socketId, null, now);
      return { kind: "created", jobId, socketId, binding: this.mustGet(jobId) };
    }
    if (existing.terminal !== undefined) return { kind: "terminal", jobId, socketId };
    if (existing.clientId === socketId) return { kind: "unchanged", jobId, socketId };
    const offline = !isOnline(existing.clientId);
    if (offline || existing.clientId === previousSocketId) {
      this.rebind(jobId, socketId, now);
      return {
        kind: "rebound",
        jobId,
        socketId,
        binding: this.mustGet(jobId),
        previous: existing,
        viaPreviousSocketId: !offline,
      };
    }
    return { kind: "conflict", jobId, socketId, ownerClientId: existing.clientId };
  }

  /**
   * 為本次 claim 的暫定綁定補上 machineId（P1），並回報期間是否有 `job/status` 被擱置。
   *
   * 作用對象是「目前仍送往 `claim.socketId` 且 machineId 為 null」的綁定——包含 claim 建立的那份、以及期間被
   * `markTerminal` 換成的終態副本（副本仍是本 socket 的、只是已標終態）。就地改寫、清掉 `deferred`。
   * 綁定已不存在、已改送別的連線或已有 machineId 時不動、回 `{ deferred: false }`。
   */
  resolveClaim(claim: LookupClaim, machineId: string): { deferred: boolean } {
    const current = this.bindings.get(claim.jobId);
    if (!current || current.clientId !== claim.socketId || current.machineId !== null) return { deferred: false };
    current.machineId = machineId;
    const deferred = current.deferred === true;
    delete current.deferred;
    return { deferred };
  }

  /**
   * 撤回本次 claim 自己的動作（FR-010；data-model §2.4「撤回」）。以參照比對，只撤回自己的那一份：
   * - `created`：目前綁定仍是 claim 建立的那份才刪；期間已被標終態（換成副本，交給寬限刪）、被刪或被他人改綁皆不動。
   * - `rebound`：目前綁定仍是 claim 改綁出的那份、且未標終態，才以 `{ ...current, clientId: previous.clientId,
   *   boundAt: previous.boundAt }` 還原——保留改綁期間記下的 `attempt`／`execution`／machineId；已標終態就不還原。
   * - `unchanged`／`terminal`／`conflict`：no-op。
   */
  revertClaim(claim: LookupClaim): void {
    const current = this.bindings.get(claim.jobId);
    if (claim.kind === "created") {
      if (current === claim.binding) this.delete(claim.jobId);
      return;
    }
    if (claim.kind === "rebound") {
      if (current !== claim.binding || current.terminal !== undefined) return;
      this.bindings.set(claim.jobId, {
        ...current,
        clientId: claim.previous.clientId,
        boundAt: claim.previous.boundAt,
      });
    }
  }

  /** 立即刪除綁定（例如入列失敗時解除自己剛建立的綁定）。 */
  delete(jobId: string): void {
    this.clearGraceTimer(jobId);
    this.bindings.delete(jobId);
  }

  /**
   * 回收自 `boundAt` 起超過 `ORPHAN_TTL_MS` 的綁定（恰等於不回收），每筆記一則 warn；回傳被回收的 jobId。
   */
  sweepOrphans(now: number = Date.now()): string[] {
    const swept: string[] = [];
    for (const [jobId, binding] of this.bindings) {
      if (now - binding.boundAt > ORPHAN_TTL_MS) {
        this.delete(jobId);
        swept.push(jobId);
        this.plog.warn({ jobId }, "swept orphan job binding");
      }
    }
    return swept;
  }

  private mustGet(jobId: string): JobBinding {
    const binding = this.bindings.get(jobId);
    if (!binding) throw new Error(`binding for ${jobId} missing right after it was written`);
    return binding;
  }

  private clearGraceTimer(jobId: string): void {
    const timer = this.graceTimers.get(jobId);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.graceTimers.delete(jobId);
  }
}
