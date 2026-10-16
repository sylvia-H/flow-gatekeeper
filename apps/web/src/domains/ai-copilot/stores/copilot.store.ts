import { defineStore } from "pinia";
import { computed, ref, shallowRef, triggerRef } from "vue";
import { AiDoneSchema } from "@flow-gatekeeper/contracts";
import {
  copilotReducer,
  startActiveState,
  type CopilotEvent,
  type CopilotJobState,
} from "../lib/copilot-reducer.js";
import {
  DiagnoseRequestError,
  NETWORK_ERROR_MESSAGE,
  UNAUTHORIZED_DIAGNOSE_MESSAGE,
  postDiagnose,
} from "../lib/diagnose-api.js";
import {
  cancelTiming,
  settleTiming,
  startTiming,
  type DiagnosisTiming,
} from "../lib/diagnosis-timing.js";

import {
  NO_DIAGNOSIS_BADGE,
  diagnosisBadgeOf,
  sameDiagnosisBadge,
  type DiagnosisBadge,
} from "../lib/diagnosis-badge.js";

/** `diagnose`／`retry` 的選用參數。 */
export interface DiagnoseOptions {
  requestedBy?: string;
  /**
   * 失敗當下讀取即時通道的授權錯誤（monitoring store `authError`）。409 且有值時改顯示
   * 「未授權」句，而不是「請等待重連」——未授權時重連不會自己好。以 getter 傳入，store 之間不互相匯入。
   */
  authError?: () => string | null;
}

/** 把 POST 失敗轉成使用者看得懂的句子。 */
function failureMessage(err: unknown, options: DiagnoseOptions | undefined): string {
  if (!(err instanceof DiagnoseRequestError)) return NETWORK_ERROR_MESSAGE;
  if (err.status === 409 && options?.authError?.()) return UNAUTHORIZED_DIAGNOSE_MESSAGE;
  return err.message;
}

/**
 * ai-copilot store（contracts/copilot-store）——薄殼負責副作用（fetch、事件路由、重連收尾），
 * 狀態轉移邏輯委派純函式 `copilotReducer`（research R9）。
 *
 * 容器為 `Map<machineId, CopilotJobState>`：每台各自狀態機、多台可並存 active（FR-010）。
 * drawer 依 `selectedMachineId` 呼叫 `stateFor` 取當前那一份呈現。
 */
/**
 * 產生 jobId（UUID v4）。`crypto.randomUUID` 只在 secure context（HTTPS／localhost）存在，
 * 以 http + 區網 IP 開 demo 時會是 undefined；此時退回 `getRandomValues`（不受此限）自行組 v4。
 */
function newJobId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export const useCopilotStore = defineStore("copilot", () => {
  // ── State ──────────────────────────────────────────────────────────
  /** 每台診斷任務呈現狀態；key 為 machineId，無則視為 idle。 */
  const jobs = ref<Map<string, CopilotJobState>>(new Map());
  /** 最近一次連線的 clientId；用於偵測重連（新 clientId）以收尾中斷任務（FR-012）。 */
  const lastClientId = ref<string | null>(null);
  /**
   * 每台 active 任務「最後一次有進展」的時刻（進度/串流 token 抵達即更新）。
   * 供 `checkStalls` 的前端逾時 watchdog 判定：後端事件久久不來時自動收尾為 failed，
   * 避免 drawer 永遠卡在 active 又無從脫身（純呈現層，不新增通訊契約）。
   */
  const lastActivityAt = ref<Map<string, number>>(new Map());
  /** 記某台目前有進展（開始診斷、或收到屬於當前 job 的事件時呼叫）。 */
  function touch(machineId: string): void {
    lastActivityAt.value.set(machineId, Date.now());
  }
  /**
   * POST /diagnoses 往返中的機台。TopBar、卡片 icon、drawer 三個入口共用 `canDiagnose`，
   * 往返期間即使使用者先按了中止（狀態回 idle），也不該再送出第二筆，否則同台會有兩個 job。
   */
  const inFlight = ref<Set<string>>(new Set());
  /**
   * 每台診斷耗時量測（data-model §8、research R7；session 內記憶）。轉移邏輯在純函式
   * `diagnosis-timing.ts`，這裡只負責在 POST 前 start、任務收尾時 settle／cancel。
   * 每次診斷才動一兩次（低頻），用 shallowRef 整份換 Map 內容後 `triggerRef` 一次即可。
   */
  const timings = shallowRef<Map<string, DiagnosisTiming>>(new Map());
  /** 每台最近一次「active → 已完成」的時刻（epoch ms，`ai/done` 經 reducer 轉完成當下記錄），供完成 meta 的 `HH:mm:ss`。 */
  const completedAt = shallowRef<Map<string, number>>(new Map());

  // ── Getters ────────────────────────────────────────────────────────
  /** 取某台狀態（無則 idle）；drawer 依 selectedMachineId 呼叫。 */
  function stateFor(machineId: string): CopilotJobState {
    return jobs.value.get(machineId) ?? { status: "idle", machineId };
  }

  /** 取某台耗時量測（從未診斷過則 undefined）。 */
  function timingFor(machineId: string): DiagnosisTiming | undefined {
    return timings.value.get(machineId);
  }

  /** 取某台最近一次完成的時刻（epoch ms；從未完成過則 undefined）。 */
  function completedAtFor(machineId: string): number | undefined {
    return completedAt.value.get(machineId);
  }

  /**
   * 每台診斷狀態 chip（data-model §7、FR-028），由 `jobs` 衍生。
   *
   * 串流期間每個 `ai/token` 都會寫一次 `jobs`，但 chip 只看 kind／progress／severity／cached：
   * 以上一輪結果（computed 的 oldValue）比對，內容未變的台沿用舊物件；整份都沒變時回傳舊 Map，
   * 依賴 chip 的元件（拓樸卡片）就不會因 token 而重算或重繪。
   */
  const badges = computed<ReadonlyMap<string, DiagnosisBadge>>((prev) => {
    const next = new Map<string, DiagnosisBadge>();
    let changed = prev === undefined || prev.size !== jobs.value.size;
    for (const [machineId, state] of jobs.value) {
      const fresh = diagnosisBadgeOf(state);
      const old = prev?.get(machineId);
      if (old !== undefined && sameDiagnosisBadge(old, fresh)) {
        next.set(machineId, old);
      } else {
        next.set(machineId, fresh);
        changed = true;
      }
    }
    return changed || prev === undefined ? next : prev;
  });

  /** 取某台診斷狀態 chip（從未診斷或 idle 為 `{ kind: "none" }`）。 */
  function badgeFor(machineId: string): DiagnosisBadge {
    return badges.value.get(machineId) ?? NO_DIAGNOSIS_BADGE;
  }

  /** 送出前置條件（FR-008/FR-014）：有選台、有連線、該台非 active 且沒有送出中的請求（去重）。 */
  function canDiagnose(machineId: string | null, hasClient: boolean): boolean {
    if (!machineId || !hasClient) return false;
    if (inFlight.value.has(machineId)) return false;
    return stateFor(machineId).status !== "active";
  }

  // ── Internal ───────────────────────────────────────────────────────
  /** 寫回某台耗時量測；與原值相同（純函式原樣回傳）時不觸發更新。 */
  function putTiming(machineId: string, next: DiagnosisTiming): void {
    if (timings.value.get(machineId) === next) return;
    timings.value.set(machineId, next);
    triggerRef(timings);
  }

  /** 任務離開 active 但未完成（失敗／中止）：清掉進行中的量測，保留歷史耗時。 */
  function dropPendingTiming(machineId: string): void {
    const timing = timings.value.get(machineId);
    if (timing) putTiming(machineId, cancelTiming(timing));
  }

  /** ai/* 事件無 machineId：以 jobId 反查該台（O(台數)，5 台可忽略成本）。 */
  function findMachineByJobId(jobId: string): string | undefined {
    for (const [machineId, state] of jobs.value) {
      if ("jobId" in state && state.jobId === jobId) return machineId;
    }
    return undefined;
  }

  /**
   * `ai/done` 的第二道防線：WS 入口已 safeParse，但 result 直接交給 DiagnosisResultView
   * 渲染，缺 `suggestedActions`／`evidence` 就會在 render 時炸掉整個 drawer。
   * 在 store 入口再驗一次，畸形結果轉成 schema_invalid 錯誤走既有 failed 路徑，
   * 元件因此可以繼續信任契約型別，不必每個欄位各自防禦。
   */
  function guardDone(event: CopilotEvent): CopilotEvent {
    if (event.type !== "ai/done" || AiDoneSchema.safeParse(event).success) return event;
    const attempt: unknown = (event as { attempt?: unknown }).attempt;
    return {
      type: "ai/error",
      jobId: event.jobId,
      attempt: typeof attempt === "number" ? attempt : 1,
      code: "schema_invalid",
      message: "ai/done result schema invalid",
    };
  }

  // ── Actions ────────────────────────────────────────────────────────
  /**
   * 觸發診斷：前置檢查（去重／有連線）→ 前端產生 jobId 並**先**建該台 active（pending）→
   * POST /diagnoses。
   *
   * 為什麼先建狀態再送：後端先綁定 jobId 再入列才回 HTTP，cache 命中時 `job/status`／`ai/done`
   * 經 WS 可能比 HTTP 回應更早到；若等回應才建 active，這些事件會因對不上 jobId 被丟，
   * 畫面卡到 watchdog 逾時。jobId 同時是 idempotency key，重送不會多建 job。
   *
   * POST 失敗（400／409 失效／503 佇列不可用／逾時／網路）→ 仍是這筆任務才回滾為 failed，
   * 訊息由 `postDiagnose` 轉成可讀中文；若期間已被中止或事件已把它推進到 completed，
   * 就不覆寫使用者當下看到的狀態。
   */
  async function diagnose(
    machineId: string,
    socketId: string | null,
    options?: DiagnoseOptions,
  ): Promise<void> {
    if (!canDiagnose(machineId, socketId !== null && socketId !== "")) return;
    const jobId = newJobId();
    jobs.value.set(machineId, startActiveState(machineId, jobId));
    touch(machineId);
    inFlight.value.add(machineId);
    // 耗時自「送出請求」起算（FR-023）：jobId 由前端先產生，所以能在 POST 前就開始量測，
    // 早於 HTTP 回應抵達的 cache 命中 `ai/done` 也對得上。
    putTiming(machineId, startTiming(timings.value.get(machineId), jobId, performance.now()));
    try {
      await postDiagnose(jobId, machineId, socketId as string, options?.requestedBy);
    } catch (err) {
      const current = stateFor(machineId);
      if (current.status === "active" && current.jobId === jobId) {
        jobs.value.set(machineId, {
          status: "failed",
          machineId,
          jobId,
          streamText: current.streamText,
          // 已知失敗帶可讀中文；其他未預期例外（理論上只剩網路層）給固定句，不露出英文原文。
          error: failureMessage(err, options),
        });
        lastActivityAt.value.delete(machineId);
        dropPendingTiming(machineId);
      }
    } finally {
      inFlight.value.delete(machineId);
    }
  }

  /**
   * Retry：等同對同機台重新 diagnose（新 jobId、重置 progress/streamText，FR-007）。
   * 僅在該台非 active 且沒有送出中的 POST 時有效（failed/completed）；active 或 inFlight 期間
   * 由 canDiagnose 去重擋下。
   * 命中後端快取時照常顯示 Cached、不繞過快取（Clarifications CHK038）。
   */
  async function retry(
    machineId: string,
    socketId: string | null,
    options?: DiagnoseOptions,
  ): Promise<void> {
    await diagnose(machineId, socketId, options);
  }

  /**
   * 套用一則診斷事件：依 machineId（job/status）或 jobId 反查（ai/*）找對應台，
   * 委派 reducer 轉移；過期片段由 reducer 忽略（FR-011）。
   */
  function applyEvent(incoming: CopilotEvent): void {
    const machineId =
      incoming.type === "job/status" ? incoming.machineId : findMachineByJobId(incoming.jobId);
    if (machineId === undefined) return;
    const event = guardDone(incoming);
    const prev = stateFor(machineId);
    const next = copilotReducer(prev, event);
    jobs.value.set(machineId, next);
    // watchdog 計時：只有「屬於當前 job 且仍 active」的事件才算有進展並重置逾時；
    // 離開 active（completed/failed）即清掉該台計時。
    if (next.status === "active" && event.jobId === next.jobId) touch(machineId);
    else if (next.status !== "active") lastActivityAt.value.delete(machineId);
    // 耗時量測：只在這一則事件讓任務「離開 active」時收尾（reducer 對非 active 一律原樣回傳）。
    if (prev.status !== "active") return;
    if (next.status === "completed") {
      const timing = timings.value.get(machineId);
      if (timing) putTiming(machineId, settleTiming(timing, next.jobId, next.cached, performance.now()));
      completedAt.value.set(machineId, Date.now());
      triggerRef(completedAt);
    } else if (next.status === "failed") {
      dropPendingTiming(machineId);
    }
  }

  /**
   * 中止／放棄該台目前診斷（問題修正）：把狀態切回 idle，Diagnose 立即可再按。
   * 被放棄任務的遲到事件由 reducer 以 `isStaleJobEvent`／非 active 保護忽略，不會復活畫面。
   */
  function cancel(machineId: string): void {
    jobs.value.set(machineId, { status: "idle", machineId });
    lastActivityAt.value.delete(machineId);
    dropPendingTiming(machineId);
  }

  /**
   * 前端逾時 watchdog（問題修正）：掃描仍 active 的台，若距最後一次進展超過 `thresholdMs`
   * 未有任何進度/串流更新，判定卡住並收尾為 failed（可讀訊息 + 沿用現成 Retry）。
   * 由 App 每隔數秒帶當前時間呼叫；純呈現層自癒，不依賴後端補送事件。
   */
  function checkStalls(nowMs: number, thresholdMs: number): void {
    for (const [machineId, state] of jobs.value) {
      if (state.status !== "active") continue;
      const last = lastActivityAt.value.get(machineId) ?? nowMs;
      if (nowMs - last > thresholdMs) {
        jobs.value.set(machineId, {
          status: "failed",
          machineId,
          jobId: state.jobId,
          streamText: state.streamText,
          error: "診斷逾時或無回應，請重試",
        });
        lastActivityAt.value.delete(machineId);
        dropPendingTiming(machineId);
      }
    }
  }

  /**
   * 重連收尾（FR-012／R7）：由 004 `onConnected` 呼叫。首次連線僅記 clientId；
   * 之後若 clientId 變更（重連派新連線），把所有仍 active 的台標 failed（中斷）＋可 Retry。
   */
  function onReconnect(newClientId: string): void {
    const prev = lastClientId.value;
    lastClientId.value = newClientId;
    if (prev === null || prev === newClientId) return;
    for (const [machineId, state] of jobs.value) {
      if (state.status === "active") {
        jobs.value.set(machineId, {
          status: "failed",
          machineId,
          jobId: state.jobId,
          streamText: state.streamText,
          error: "連線中斷，請重試",
        });
        lastActivityAt.value.delete(machineId);
        dropPendingTiming(machineId);
      }
    }
  }

  return {
    jobs,
    timings,
    completedAt,
    lastClientId,
    stateFor,
    timingFor,
    completedAtFor,
    badgeFor,
    canDiagnose,
    diagnose,
    retry,
    cancel,
    checkStalls,
    applyEvent,
    inFlight,
    onReconnect,
  };
});
