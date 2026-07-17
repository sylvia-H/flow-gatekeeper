import type {
  AiDone,
  AiError,
  AiToken,
  DiagnosisResult,
  JobStatus,
} from "@flow-gatekeeper/contracts";

/**
 * 前端診斷任務呈現狀態機（每台一份，記憶體、非持久化）。型別以 `@flow-gatekeeper/contracts`
 * 的事件／結果為單一來源（憲章 III），本檔僅描述**衍生的呈現狀態**，不新增通訊契約。
 *
 * discriminated union（見 data-model）：`idle` 無 result/error；`completed` 必有 result；
 * `active`/`completed` 由 `jobId` 標識當前任務，過期片段以此比對忽略（FR-011）。
 */
export type CopilotJobState =
  | { status: "idle"; machineId: string }
  | {
      status: "active";
      machineId: string;
      jobId: string;
      progress: number | null;
      streamText: string;
    }
  | {
      status: "completed";
      machineId: string;
      jobId: string;
      cached: boolean;
      streamText: string;
      result: DiagnosisResult;
    }
  | {
      status: "failed";
      machineId: string;
      jobId?: string;
      streamText: string;
      error: string;
    };

/** 005 消費的診斷事件聯集（皆自契約 import；MUST NOT 另寫平行定義）。 */
export type CopilotEvent = JobStatus | AiToken | AiDone | AiError;

/** 該台目前任務 id（`idle` 無、`failed` 可能無）。 */
function currentJobId(state: CopilotJobState): string | undefined {
  return "jobId" in state ? state.jobId : undefined;
}

/**
 * 過期／被取代片段判定（FR-011）：事件 `jobId` 不等於該台目前 `jobId` 即為過期，MUST 忽略。
 * `idle`（無 jobId）收到任何診斷事件皆視為過期。
 */
export function isStaleJobEvent(
  state: CopilotJobState,
  event: CopilotEvent,
): boolean {
  const jobId = currentJobId(state);
  return jobId === undefined || event.jobId !== jobId;
}

/** 進度呈現（FR-004 無障礙）：`null`→indeterminate 描述；否則 `N%`。 */
export function progressLabel(progress: number | null): string {
  return progress === null ? "處理中…" : `${progress}%`;
}

/**
 * 把 provider／worker 原始錯誤對應成簡潔的使用者訊息（FR-007「非原始堆疊之可讀訊息」）。
 * 命中已知簽章 → 對應友善句；否則短原文（<120 字、非多行堆疊）沿用，過長／堆疊 → 通用句。
 * 純函式，決定性、便於單元測試。
 */
export function humanizeError(raw: string | undefined, code?: string): string {
  const msg = (raw ?? "").trim();
  const hay = `${code ?? ""} ${msg}`.toLowerCase();

  if (code === "schema_invalid" || hay.includes("schema")) return "AI 回傳格式不符，請重試。";
  // "unregistered"：空金鑰時 Gemini 回 "Method doesn't allow unregistered callers…"（403），
  // 該句不含下列其他關鍵字，且含 "fetching" 會誤命中下方網路分支——實測補齊（008 T016b、research D11）。
  if (hay.includes("api_key_invalid") || hay.includes("api key not valid") || hay.includes("unauthorized") || hay.includes("permission") || hay.includes("unregistered"))
    return "AI 服務金鑰無效或未授權——請確認 apps/worker/.env 的 GEMINI_API_KEY 已填入有效金鑰（範本見 apps/worker/.env.example）。";
  if (hay.includes("429") || hay.includes("quota") || hay.includes("rate limit") || hay.includes("resource_exhausted"))
    return "AI 服務暫時繁忙（速率限制），請稍後重試。";
  if (hay.includes("timeout") || hay.includes("timed out") || hay.includes("etimedout"))
    return "AI 診斷逾時，請重試。";
  if (hay.includes("econn") || hay.includes("network") || hay.includes("fetch") || hay.includes("socket") || hay.includes("enotfound"))
    return "無法連線 AI 服務，請稍後重試。";

  // 未知錯誤：短且非多行堆疊 → 沿用原文；否則通用句（避免把長堆疊/JSON 丟給使用者）。
  if (msg.length > 0 && msg.length < 120 && !msg.includes("\n")) return msg;
  return "診斷失敗，請重試。";
}

/**
 * 起始 active 狀態（`diagnose`/`retry` 共用）：新 jobId、progress 未定（indeterminate）、
 * streamText 清空（FR-004/FR-007）。純函式，便於單元測試與 store 重用。
 */
export function startActiveState(machineId: string, jobId: string): CopilotJobState {
  return { status: "active", machineId, jobId, progress: null, streamText: "" };
}

/**
 * 決定性狀態轉移（見 data-model 轉移表）。僅在該台 `active` 且 `jobId` 相符時消費事件；
 * 過期片段、或非 active 狀態（idle/completed/failed 由 store 動作而非事件推進）一律回傳原狀態。
 */
export function copilotReducer(
  state: CopilotJobState,
  event: CopilotEvent,
): CopilotJobState {
  if (isStaleJobEvent(state, event)) return state;
  if (state.status !== "active") return state; // 只有 active 消費 WS 事件

  switch (event.type) {
    case "job/status":
      if (event.status === "failed") {
        return {
          status: "failed",
          machineId: state.machineId,
          jobId: state.jobId,
          streamText: state.streamText,
          error: humanizeError(event.error),
        };
      }
      // waiting/active/completed：維持 active，僅更新進度（未帶則維持既值＝indeterminate）。
      return { ...state, progress: event.progress ?? state.progress };

    case "ai/token":
      // 單一有序 WebSocket 依 seq 遞送，直接 append 即保序（research R6）。
      return { ...state, streamText: state.streamText + event.text };

    case "ai/done":
      return {
        status: "completed",
        machineId: state.machineId,
        jobId: state.jobId,
        cached: event.cached,
        streamText: state.streamText,
        result: event.result,
      };

    case "ai/error":
      return {
        status: "failed",
        machineId: state.machineId,
        jobId: state.jobId,
        streamText: state.streamText,
        error: humanizeError(event.message, event.code),
      };
  }
}
