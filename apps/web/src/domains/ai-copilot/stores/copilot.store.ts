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
    jobs.value.set(machineId, copilotReducer(stateFor(machineId), event));
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
    applyEvent,
    onReconnect,
  };
});
