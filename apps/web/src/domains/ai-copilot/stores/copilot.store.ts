import { defineStore } from "pinia";
import { ref } from "vue";
import {
  copilotReducer,
  startActiveState,
  type CopilotEvent,
  type CopilotJobState,
} from "../lib/copilot-reducer.js";
import { postDiagnose } from "../lib/diagnose-api.js";

/**
 * ai-copilot store（contracts/copilot-store）——薄殼負責副作用（fetch、事件路由、重連收尾），
 * 狀態轉移邏輯委派純函式 `copilotReducer`（research R9）。
 *
 * 容器為 `Map<machineId, CopilotJobState>`：每台各自狀態機、多台可並存 active（FR-010）。
 * drawer 依 `selectedMachineId` 呼叫 `stateFor` 取當前那一份呈現。
 */
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

  // ── Getters ────────────────────────────────────────────────────────
  /** 取某台狀態（無則 idle）；drawer 依 selectedMachineId 呼叫。 */
  function stateFor(machineId: string): CopilotJobState {
    return jobs.value.get(machineId) ?? { status: "idle", machineId };
  }

  /** 送出前置條件（FR-008/FR-014）：有選台、有連線、且該台非 active（去重）。 */
  function canDiagnose(machineId: string | null, hasClient: boolean): boolean {
    if (!machineId || !hasClient) return false;
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

  // ── Actions ────────────────────────────────────────────────────────
  /**
   * 觸發診斷：前置檢查（去重／有連線）→ POST /diagnoses → 以回傳 jobId 立即建該台 active
   * （SC-001，不等 WS 事件）。失敗（400／網路）→ 該台 failed 附可讀訊息。
   */
  async function diagnose(
    machineId: string,
    socketId: string | null,
    requestedBy?: string,
  ): Promise<void> {
    if (!canDiagnose(machineId, socketId !== null && socketId !== "")) return;
    try {
      const { jobId } = await postDiagnose(machineId, socketId as string, requestedBy);
      jobs.value.set(machineId, startActiveState(machineId, jobId));
      touch(machineId);
    } catch (err) {
      jobs.value.set(machineId, {
        status: "failed",
        machineId,
        streamText: "",
        error: err instanceof Error ? err.message : "診斷請求失敗，請重試",
      });
    }
  }

  /**
   * Retry：等同對同機台重新 diagnose（新 jobId、重置 progress/streamText，FR-007）。
   * 僅在該台非 active 時有效（failed/completed），active 期間由 canDiagnose 去重擋下。
   * 命中後端快取時照常顯示 Cached、不繞過快取（Clarifications CHK038）。
   */
  async function retry(machineId: string, socketId: string | null): Promise<void> {
    await diagnose(machineId, socketId);
  }

  /**
   * 套用一則診斷事件：依 machineId（job/status）或 jobId 反查（ai/*）找對應台，
   * 委派 reducer 轉移；過期片段由 reducer 忽略（FR-011）。
   */
  function applyEvent(event: CopilotEvent): void {
    const machineId =
      event.type === "job/status" ? event.machineId : findMachineByJobId(event.jobId);
    if (machineId === undefined) return;
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
    onReconnect,
  };
});
