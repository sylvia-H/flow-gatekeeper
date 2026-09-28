import { defineStore } from "pinia";
import { ref } from "vue";
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

  // ── Getters ────────────────────────────────────────────────────────
  /** 取某台狀態（無則 idle）；drawer 依 selectedMachineId 呼叫。 */
  function stateFor(machineId: string): CopilotJobState {
    return jobs.value.get(machineId) ?? { status: "idle", machineId };
  }

  /** 送出前置條件（FR-008/FR-014）：有選台、有連線、該台非 active 且沒有送出中的請求（去重）。 */
  function canDiagnose(machineId: string | null, hasClient: boolean): boolean {
    if (!machineId || !hasClient) return false;
    if (inFlight.value.has(machineId)) return false;
    return stateFor(machineId).status !== "active";
  }

  // ── Internal ───────────────────────────────────────────────────────
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
    const next = copilotReducer(stateFor(machineId), event);
    jobs.value.set(machineId, next);
    // watchdog 計時：只有「屬於當前 job 且仍 active」的事件才算有進展並重置逾時；
    // 離開 active（completed/failed）即清掉該台計時。
    if (next.status === "active" && event.jobId === next.jobId) touch(machineId);
    else if (next.status !== "active") lastActivityAt.value.delete(machineId);
  }

  /**
   * 中止／放棄該台目前診斷（問題修正）：把狀態切回 idle，Diagnose 立即可再按。
   * 被放棄任務的遲到事件由 reducer 以 `isStaleJobEvent`／非 active 保護忽略，不會復活畫面。
   */
  function cancel(machineId: string): void {
    jobs.value.set(machineId, { status: "idle", machineId });
    lastActivityAt.value.delete(machineId);
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
      }
    }
  }

  return {
    jobs,
    lastClientId,
    stateFor,
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
