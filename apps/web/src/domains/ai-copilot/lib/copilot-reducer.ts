import type {
  AiDone,
  AiError,
  AiToken,
  DiagnosisLookupResponse,
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
      /**
       * 目前呈現的是第幾次嘗試（BullMQ 重試時 jobId 不變、seq 又從 0 起）。
       * 用來在換輪時清空 streamText，並丟棄舊輪遲到的 token。
       */
      attempt: number;
      /**
       * 本次執行最後接上的 token `seq`（尚未收到任何 token 為 -1）。同一輪內收到 `seq <= lastSeq`
       * 即代表後端從頭重播了一次新的執行（stalled 重派）；只比 `seq === 0` 的話，新執行的第一個
       * token 若在 at-most-once 的 Pub/Sub 上遺失，就會把兩次執行的文字接在一起（AR-S8）。
       */
      lastSeq: number;
      /**
       * 目前呈現的執行序號（`job/status.execution`＝BullMQ `attemptsStarted`，起始 1）。重試、stalled 重派、限流延後都會遞增；
       * 收到更大的值即清串流（FR-006），`seq <= lastSeq` 判斷保留為備援。遞增本身不代表後端中斷，不顯示說明（D13）。
       */
      execution: number;
      /**
       * 收到 `reason: "stalled"`（後端處理程序失去 lock、任務重新排入佇列）時設起，面板顯示 `STALLED_NOTICE(execution)`。
       * `stalled` 事件本身不帶 execution，先估 `目前 execution + 1`（`confirmed` 未設），由下一則帶 execution 且不小於估計值的
       * 事件校正並確認；確認後 execution 再遞增而沒有新的 stalled（重試、限流延後）即移除（research P15）。
       */
      stalledNotice?: { execution: number; confirmed?: true };
      progress: number | null;
      streamText: string;
      /**
       * 重連後、續接 GET 回應前（FR-016）：面板步驟列下顯示 `RESUMING_NOTICE`。`lookup/result` 抵達即清除；
       * 重連後授權失敗時不會發出續接 GET，維持這個狀態交給 45 s watchdog（spec Edge Cases、代理裁決第 47 條）。
       */
      resume?: "pending";
      /**
       * 執行期間經歷過 WS 重連（FR-016）；任務結束前不清除。收尾時轉成 `streamIncomplete: true`，
       * 斷線期間的 token 已遺失，即使以 `ai/done` 收尾也標「原始串流（不完整）」（FR-038、代理裁決第 20 條）。
       */
      reconnected?: true;
    }
  | {
      status: "completed";
      machineId: string;
      jobId: string;
      cached: boolean;
      streamText: string;
      result: DiagnosisResult;
      /**
       * 收尾來源（012 FR-004、data-model §6.1）：三個完成來源先到者為準，之後到的同 jobId 結果一律忽略。
       * `"ai/done"`：Pub/Sub 的盡力送達通知；`"status"`：帶 `result` 的 `job/status: completed`（權威完成）；
       * `"lookup"`：`GET /diagnoses/:jobId` 回 completed（重連續接或 2 s／45 s 退路）。
       */
      source: CompletionSource;
      /**
       * 原始串流是否可能不完整（FR-038）：以 `job/status`／GET 收尾，或執行期間經歷過 WS 重連時為 true，
       * 串流標題改用 `STREAM_LABEL_INCOMPLETE`。判斷只看收尾來源與重連旗標，不比對 `seq` 或結果（寧可多標不漏標）。
       */
      streamIncomplete: boolean;
      /**
       * 執行期間經歷過 WS 重連（由 active／未送達失敗態傳下來）。完成 meta 的「重新連線後取回」只在以 GET 收尾**且**重連過時顯示
       * （代理裁決第 53 條）；重連過的收尾耗時也不作對比基準（第 52 條）。
       */
      reconnected?: true;
    }
  | {
      status: "failed";
      machineId: string;
      jobId?: string;
      streamText: string;
      error: string;
      /**
       * 未能分類的錯誤原文（`fix/20261022-ui-humanize-error-zh`；只由 `humanizeFailure` 設起）：`error` 改顯通用句時，
       * 短原文（< 120 字、單行、不含漢字（`\p{Script=Han}`））收在失敗態預設收合的「技術細節」裡供排錯，不再當主訊息照顯英文。
       */
      errorDetail?: string;
      /**
       * 失敗原因標記（web 內部呈現狀態，不是通訊契約）。`"undelivered"`：後端已回報
       * `job/status: completed`，但寬限期內等不到同 jobId 的結果（store `checkStalls` 判定）。
       * 只有這一種失敗允許同 jobId 遲到的結果（`ai/done`、帶 `result` 的 `job/status: completed`）把狀態
       * 改回 completed（FR-005、代理裁決第 15 條）；其他失敗（`ai/error`、`failed`、watchdog）一律忽略遲到事件。
       */
      reason?: "undelivered";
      /**
       * 轉成「結果未送達」失敗當下的輪次（只有該失敗會帶）。救回時與結果來源帶的 `attempt`（`ai/done.attempt`、
       * `job/status.attempt`；未帶時視為同輪）比對：
       * 結果來自更新一輪時，`streamText` 屬於舊輪、要清空（同 active 終態的 `streamTextFor`）。
       */
      attempt?: number;
      /**
       * 「結果未送達」失敗由重連過的 active 轉來時帶上（store `checkStalls`／undelivered GET 照抄 active 的旗標），
       * 救回時才能照樣標「原始串流（不完整）」（FR-038）。
       */
      reconnected?: true;
    };

/** 完成狀態的收尾來源（web 內部呈現狀態，非通訊契約）。 */
export type CompletionSource = "ai/done" | "status" | "lookup";

/**
 * `GET /diagnoses/:jobId` 的 200 回應包成的 web 內部事件（data-model §6.1；不是通訊契約）。store `lookup()` 收到回應後
 * 經 `applyEvent` 丟給 reducer，讓三個完成來源的「先到者為準」規則全部落在同一個純函式（research R9）。
 */
export interface LookupResultEvent {
  type: "lookup/result";
  jobId: string;
  response: DiagnosisLookupResponse;
}

/** 消費的診斷事件聯集：契約事件（皆自契約 import；MUST NOT 另寫平行定義）＋ web 內部的 `lookup/result`。 */
export type CopilotEvent = JobStatus | AiToken | AiDone | AiError | LookupResultEvent;

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

/** 診斷結果寫入資料庫失敗（FR-027、ui-copy §1）；MongoDB 原始錯誤只進後端日誌。 */
export const PERSIST_FAILED_ERROR = "診斷結果無法寫入資料庫，請稍後重試";

/** 後端處理程序多次中斷、BullMQ 放棄任務（`job stalled more than allowable limit`；FR-035、D13）。 */
export const STALLED_LIMIT_ERROR = "後端處理程序多次中斷，診斷已停止，請重試";

/**
 * 進行中說明行：任務因後端處理程序中斷而重新排入佇列（FR-035；只由 `reason: "stalled"` 設起）。
 * 畫面用語避開「worker」「stalled」「停滯」（FR-036）。
 */
export function STALLED_NOTICE(n: number): string {
  return `後端處理程序中斷，任務已重新排入佇列（第 ${n} 次執行）`;
}

/** 未能分類的錯誤一律顯示的通用句（FR-007）。 */
export const GENERIC_DIAGNOSIS_ERROR = "診斷失敗，請重試。";

/** 原文含漢字即視為已是中文訊息（如 api 回的中文 message），可直接給使用者看。 */
const HAN_RE = /\p{Script=Han}/u;

/** 短（< 120 字）且單行的原文：不是長堆疊或多行 JSON，才有給人看的價值。 */
function isShortSingleLine(msg: string): boolean {
  return msg.length > 0 && msg.length < 120 && !msg.includes("\n");
}

/**
 * 把 provider／worker 原始錯誤對應成簡潔的使用者訊息（FR-007「非原始堆疊之可讀訊息」）。
 * 命中已知簽章 → 對應友善句；未知錯誤只在原文已是中文（含漢字）且短（< 120 字、單行）時照顯，
 * 其餘（英文原文、過長、多行堆疊）→ 通用句（`fix/20261022-ui-humanize-error-zh`：畫面文案一律繁中；
 * 英文短原文改由 `humanizeFailure` 放進「技術細節」）。純函式，決定性、便於單元測試。
 */
export function humanizeError(raw: string | undefined, code?: string): string {
  const msg = (raw ?? "").trim();
  const hay = `${code ?? ""} ${msg}`.toLowerCase();

  // 012 新增的兩條排在既有關鍵字之前（contracts/ui-copy §1）：固定句日後改字時，才不會誤落到下方其他分類。
  // persist_failed：`ai/error.code`，或 `failed`／GET failed 只帶的 `failedReason` 固定句（含 `persist_failed` 字樣，P14）。
  if (code === "persist_failed" || hay.includes("persist_failed")) return PERSIST_FAILED_ERROR;
  // BullMQ `maxStalledCount` 用盡時的英文 `failedReason`；不照顯英文原文（D12、D13）。
  if (hay.includes("job stalled more than allowable limit")) return STALLED_LIMIT_ERROR;
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

  // 未知錯誤：已是中文的短句照顯；英文原文、長堆疊／JSON 一律通用句（畫面文案一律繁中）。
  if (isShortSingleLine(msg) && HAN_RE.test(msg)) return msg;
  return GENERIC_DIAGNOSIS_ERROR;
}

/**
 * 失敗態的錯誤欄位：`error` 同 `humanizeError`；未知錯誤改顯通用句、而原文是短的單行非中文訊息時，
 * 另帶 `errorDetail`＝原文，由 drawer 收在預設收合的「技術細節」裡供排錯（本分支以前這段原文直接當主訊息顯示）。
 * 長堆疊／多行 JSON 維持不上畫面（FR-007），只留後端日誌。
 */
export function humanizeFailure(
  raw: string | undefined,
  code?: string,
): { error: string; errorDetail?: string } {
  const error = humanizeError(raw, code);
  const msg = (raw ?? "").trim();
  if (error === GENERIC_DIAGNOSIS_ERROR && isShortSingleLine(msg) && !HAN_RE.test(msg)) {
    return { error, errorDetail: msg };
  }
  return { error };
}

/**
 * 起始 active 狀態（`diagnose`/`retry` 共用）：新 jobId、progress 未定（indeterminate）、
 * streamText 清空（FR-004/FR-007）。store 在 POST 送出**之前**就建立它（pending），
 * 讓早於 HTTP 回應抵達的事件也能被消費。純函式，便於單元測試與 store 重用。
 */
export function startActiveState(machineId: string, jobId: string): CopilotJobState {
  return { status: "active", machineId, jobId, attempt: 1, lastSeq: -1, execution: 1, progress: null, streamText: "" };
}

/**
 * 「結果未送達」失敗（AR-6）：後端已完成，但結果沒有在寬限期內抵達畫面；012 起 2 s 寬限到期先 GET 一次，
 * GET 回 completed／failed 以外的結果才轉這句（contracts/ui-copy §3 `undelivered` 列）。
 */
export const UNDELIVERED_ERROR = "診斷已在後端完成，但結果未送達畫面，請重試";

/** 重連後、續接 GET 回應前的說明行（FR-035；active 且 `resume === "pending"`）。 */
export const RESUMING_NOTICE = "已重新連線，正在取回診斷狀態…";

/**
 * 重連後以 GET 取回的完成態，完成 meta 的中性小字（FR-035；completed、`source === "lookup"` 且 `reconnected`——
 * 沒有重連過的 2 s／45 s 退路不顯示，代理裁決第 53 條）。
 */
export const RECOVERED_META = "重新連線後取回";

/**
 * 45 s 無進展 → GET 回 404、409、503、429、網路錯誤或格式不符（FR-022、D11）。取代 2.1.0 的「診斷逾時或無回應，請重試」：
 * watchdog 觸發只代表畫面這麼久沒收到進展，後端可能其實已完成，所以是「結果未知」而不是「逾時」。
 */
export const WATCHDOG_UNKNOWN_ERROR = "超過 45 秒沒有收到進度，結果未知，請重試";

/** 續接 GET 回 404（job 已清且 Mongo 查無，例如快取命中的結果 1 h 後）。 */
export const LOOKUP_EXPIRED_ERROR = "連線中斷期間的診斷結果已無法取回，請重試";

/** 續接 GET 回 409 `job_bound_elsewhere`（任務仍綁在另一條在線連線，例如另一個分頁）。 */
export const LOOKUP_ELSEWHERE_ERROR = "這個診斷正由另一個視窗接收，請在該視窗查看或重試";

/** 續接 GET 的其他失敗：網路錯誤、逾時、429、503、409 `socket_unauthorized`、回應格式不符。 */
export const LOOKUP_DISCONNECTED_ERROR = "連線中斷，請重試";

/**
 * 完成態原始串流的標題（FR-038、contracts/ui-copy §2）：以 `job/status`／GET 收尾，或執行期間經歷過重連時使用；
 * 其餘完成態沿用「原始串流」。
 */
export const STREAM_LABEL_INCOMPLETE = "原始串流（不完整）";

/** 是否為可被遲到結果救回的「結果未送達」失敗。 */
export function isUndeliveredFailure(
  state: CopilotJobState,
): state is Extract<CopilotJobState, { status: "failed" }> & { reason: "undelivered" } {
  return state.status === "failed" && state.reason === "undelivered";
}

/**
 * 終態事件（ai/done／ai/error）要保留的串流文字：來自更新一輪時，手上的文字屬於已放棄的舊輪
 * （新一輪可能沒吐 token 就直接結束，例如 cache 命中），留著會讓「推理過程」和結果對不上。
 */
function streamTextFor(state: Extract<CopilotJobState, { status: "active" }>, attempt: number): string {
  return attempt > state.attempt ? "" : state.streamText;
}

/** 一則「帶結果」的完成事件抽出的共同欄位（`ai/done`、帶 `result` 的 `job/status: completed`、`lookup/result` completed）。 */
interface CompletionPayload {
  result: DiagnosisResult;
  cached: boolean;
  /** 產出結果的那一輪；`job/status` 未帶 `attempt`、或來自 GET（回應不帶輪次）時為 undefined（視為同輪，保留串流文字）。 */
  attempt: number | undefined;
  /** 產出結果的那次執行（`job/status.execution`）；其他來源不帶。 */
  execution?: number;
  source: CompletionSource;
}

/**
 * 把一則完成事件抽成 `CompletionPayload`；不是帶結果的完成事件則回 null。
 * `job/status: completed` 不帶 `result`（舊版 api、returnvalue 驗證失敗）時不算完成，由 store 的 2 s 寬限接手；
 * 帶 `result` 卻缺 `cached` 時當 false（research P8：最多少顯示一個「快取」字樣）。
 */
function completionOf(event: CopilotEvent): CompletionPayload | null {
  if (event.type === "ai/done") {
    return { result: event.result, cached: event.cached, attempt: event.attempt, source: "ai/done" };
  }
  if (event.type === "job/status" && event.status === "completed" && event.result !== undefined) {
    return {
      result: event.result,
      cached: event.cached ?? false,
      attempt: event.attempt,
      execution: event.execution,
      source: "status",
    };
  }
  if (event.type === "lookup/result" && event.response.status === "completed") {
    const { result, cached } = event.response;
    return { result, cached, attempt: undefined, source: "lookup" };
  }
  return null;
}

/**
 * active 或可救回的「結果未送達」失敗 → completed。三個來源共用這一份，確保先到者不論是誰，
 * 收斂出的 `result`／`cached`／`jobId` 都相同（SC-006）。
 *
 * - `streamText`：結果來自更新一輪時（例如重試那輪命中快取、沒吐 token 就直接結束），手上的文字屬於
 *   已放棄的舊輪，丟掉；同輪（或來源沒帶輪次）才保留。
 * - `streamIncomplete`：`ai/done` 以外的來源一律標不完整；`ai/done` 收尾時看「執行期間是否經歷過重連」
 *   （`reconnected`，未送達失敗態照抄 active 的旗標）——斷線期間的 token 已遺失（FR-038）。
 */
function toCompleted(
  state: Extract<CopilotJobState, { status: "active" | "failed" }>,
  jobId: string,
  payload: CompletionPayload,
): CopilotJobState {
  const baseAttempt = state.attempt;
  const newerAttempt = payload.attempt !== undefined && baseAttempt !== undefined && payload.attempt > baseAttempt;
  // 同理，結果來自更新的一次執行（例如 stalled 重派那次走冪等短路、沒吐 token 就完成）時，手上的文字屬於中斷的那次。
  const newerExecution =
    state.status === "active" && payload.execution !== undefined && payload.execution > state.execution;
  return {
    status: "completed",
    machineId: state.machineId,
    jobId,
    cached: payload.cached,
    streamText: newerAttempt || newerExecution ? "" : state.streamText,
    result: payload.result,
    source: payload.source,
    streamIncomplete: payload.source !== "ai/done" || state.reconnected === true,
    ...(state.reconnected ? { reconnected: true as const } : {}),
  };
}

/** GET 回應是否為「仍在進行」（waiting／active）；reducer 與 store 共用同一判斷（合併門第 2 輪 L6）。 */
export function isLookupInProgress(
  response: DiagnosisLookupResponse,
): response is Extract<DiagnosisLookupResponse, { status: "waiting" | "active" }> {
  return response.status === "waiting" || response.status === "active";
}

/**
 * GET（waiting／active）帶的進度只往前採用（合併門第 2 輪 L3）：GET 讀的是發出當下的快照，往返期間 WS 可能已送來更新的
 * 進度，回應較小時不可把畫面拉回去。唯一例外是這則回應讓任務換到新一輪或新一次執行（`advanceRound` 換了物件且輪次變了），
 * 新的執行從頭計進度，照回應採用。未帶進度時維持既值。
 */
function lookupProgress(
  before: Extract<CopilotJobState, { status: "active" }>,
  advanced: Extract<CopilotJobState, { status: "active" }>,
  progress: number | undefined,
): number | null {
  if (progress === undefined) return before.progress;
  const newRound = advanced.attempt !== before.attempt || advanced.execution !== before.execution;
  if (newRound || before.progress === null || progress > before.progress) return progress;
  return before.progress;
}

/** `job/status`／`lookup/result` 帶的輪次資訊。 */
interface RoundInfo {
  attempt?: number;
  execution?: number;
  reason?: string;
}

/**
 * 把 `job/status`／`lookup/result` 帶的輪次資訊套到 active（data-model §6.2；T058、T065、research P15）：
 *
 * - `attempt` 更大 → 換輪：清 `streamText`、`lastSeq = -1`、更新 `attempt`（重試那輪沒吐 token 也立即推進「嘗試 N / 3」）；
 * - `execution` 更大 → 清 `streamText`、`lastSeq = -1`、更新 `execution`（重試、stalled 重派、限流延後皆然）；
 * - `reason === "stalled"` → 設 `stalledNotice`，N 先估 `max(目前 execution, 既有說明的 N) + 1`；
 * - 其他帶 `execution` 的事件：說明未確認且 execution ≥ 估計值 → 以它校正並確認（小於估計值的是中斷那次遲到的事件，忽略）；
 *   已確認且 execution 再遞增 → 移除說明（遞增來自重試或限流延後，不是新的中斷）。
 *
 * 未知的 `reason` 一律忽略（契約為開放字串，D7）。沒有任何變化時回傳原物件。
 */
function advanceRound(
  state: Extract<CopilotJobState, { status: "active" }>,
  info: RoundInfo,
): Extract<CopilotJobState, { status: "active" }> {
  // 已知的潛在競態（不加機制）：`job/status` 走 QueueEvents、`ai/token` 走 Pub/Sub，跨通道先後不保證。新一次執行的 token
  // 若早於同次執行第一則帶 execution 的 status 抵達，會在這裡被當成舊執行的文字清掉。processor 在呼叫 LLM 前先 await
  // `report()`（帶 execution 的 progress），首 token 必在其後送出，實務上難發生；萬一發生，只少顯示開頭幾個 token。
  let next = state;
  const newerAttempt = info.attempt !== undefined && info.attempt > state.attempt;
  const newerExecution = info.execution !== undefined && info.execution > state.execution;
  if (newerAttempt || newerExecution) {
    next = {
      ...next,
      attempt: newerAttempt ? (info.attempt as number) : state.attempt,
      execution: newerExecution ? (info.execution as number) : state.execution,
      lastSeq: -1,
      streamText: "",
    };
  }
  const notice = next.stalledNotice;
  if (info.reason === "stalled") {
    next = { ...next, stalledNotice: { execution: Math.max(next.execution, notice?.execution ?? 0) + 1 } };
  } else if (notice !== undefined && info.execution !== undefined) {
    if (notice.confirmed !== true) {
      if (info.execution >= notice.execution) next = { ...next, stalledNotice: { execution: info.execution, confirmed: true } };
    } else if (info.execution > notice.execution) {
      const { stalledNotice: _notice, ...rest } = next;
      next = rest;
    }
  }
  return next;
}

/**
 * 決定性狀態轉移（見 data-model 轉移表）。僅在該台 `active` 且 `jobId` 相符時消費事件；
 * 過期片段、或非 active 狀態（idle/completed/failed 由 store 動作而非事件推進）一律回傳原狀態。
 *
 * 完成以三個來源中最先到者為準（FR-004）：`ai/done`、帶 `result` 的 `job/status: completed`、
 * GET 回 completed（`lookup/result`）。先到者讓狀態離開 active，之後到的同 jobId 結果因「非 active」原樣忽略——`ai/done` 重複亦同。
 * 唯一例外是「結果未送達」失敗：結果其實已產出、只是晚到，任一來源的結果抵達都改回 completed（FR-005）；
 * 其他失敗態（`ai/error`、`job/status: failed`、watchdog）不被覆蓋。
 */
export function copilotReducer(
  state: CopilotJobState,
  event: CopilotEvent,
): CopilotJobState {
  if (isStaleJobEvent(state, event)) return state;
  if (isUndeliveredFailure(state)) {
    const payload = completionOf(event);
    return payload ? toCompleted(state, event.jobId, payload) : state;
  }
  if (state.status !== "active") return state; // 只有 active 消費 WS 事件
  // 同 jobId 的 ai/token／job/status 抵達：這條連線已在收這個任務的事件，「正在取回」說明不再成立（合併門第 2 輪 L2）。
  // 續接 GET 之後若失敗，store 也不再以 resume 文案轉失敗、改交給 watchdog（`onLookupFailure`）。
  if ((event.type === "ai/token" || event.type === "job/status") && state.resume !== undefined) {
    const { resume: _resume, ...rest } = state;
    return reduceActive(rest, event);
  }
  return reduceActive(state, event);
}

/** active 狀態收到同 jobId 事件的轉移（`copilotReducer` 已過濾過期片段與非 active）。 */
function reduceActive(state: Extract<CopilotJobState, { status: "active" }>, event: CopilotEvent): CopilotJobState {
  switch (event.type) {
    case "job/status":
      if (event.status === "failed") {
        return {
          status: "failed",
          machineId: state.machineId,
          jobId: state.jobId,
          streamText: state.streamText,
          ...humanizeFailure(event.error),
        };
      }
      // 帶 result 的 completed 是權威完成（ADR-003 D3）：Pub/Sub 斷線、ai/done 遺失時畫面照樣收尾。
      {
        const payload = completionOf(event);
        if (payload) return toCompleted(state, state.jobId, payload);
      }
      // waiting/active/不帶 result 的 completed：維持 active，推進輪次（attempt／execution／stalled 說明）並更新進度
      // （未帶則維持既值＝indeterminate）。
      {
        const advanced = advanceRound(state, event);
        return { ...advanced, progress: event.progress ?? advanced.progress };
      }

    case "ai/token":
      // 舊輪遲到的 token：新一輪已開始重播，接上去只會把兩輪文字混在一起。
      if (event.attempt < state.attempt) return state;
      // 換輪（重試）：後端從頭重播，先清掉上一輪的半截文字再接，否則會變成「半截 + 完整」。
      if (event.attempt > state.attempt) {
        return { ...state, attempt: event.attempt, lastSeq: event.seq, streamText: event.text };
      }
      // 同一輪卻收到不比上一個大的 seq：worker 崩潰後 BullMQ 以 stalled 重派同一個 job 時只遞增
      // stalled 計數、不遞增 attemptsMade，attempt 因此不變但串流從頭重播。單一有序 WebSocket 上
      // 同一次執行的 seq 嚴格遞增，所以 seq 回頭必然代表「新的一次執行」，要丟掉前一次的半截文字。
      // 以 `<= lastSeq` 而非 `=== 0` 判定：新執行的 seq 0 遺失時（Pub/Sub at-most-once）也認得出來。
      if (event.seq <= state.lastSeq) return { ...state, lastSeq: event.seq, streamText: event.text };
      // 同一輪：單一有序 WebSocket 依 seq 遞送，直接 append 即保序（research R6）。
      return { ...state, lastSeq: event.seq, streamText: state.streamText + event.text };

    case "ai/done":
      return toCompleted(state, state.jobId, {
        result: event.result,
        cached: event.cached,
        attempt: event.attempt,
        source: "ai/done",
      });

    case "ai/error":
      // 後端只在最終嘗試失敗時才送 ai/error，收到即為終態。
      return {
        status: "failed",
        machineId: state.machineId,
        jobId: state.jobId,
        streamText: streamTextFor(state, event.attempt),
        ...humanizeFailure(event.message, event.code),
      };

    case "lookup/result": {
      const { response } = event;
      switch (response.status) {
        case "completed":
          return toCompleted(state, state.jobId, {
            result: response.result,
            cached: response.cached,
            attempt: undefined,
            source: "lookup",
          });
        case "failed":
          // GET 的 failed 只帶 BullMQ `failedReason` 原文，與 `job/status: failed` 同一套對映（FR-005、FR-022）。
          return {
            status: "failed",
            machineId: state.machineId,
            jobId: state.jobId,
            streamText: state.streamText,
            ...humanizeFailure(response.error),
          };
        case "waiting":
        case "active": {
          // 任務仍在後端進行，續接完成——清掉「正在取回」說明、推進輪次、更新進度。`reconnected` 保留到任務結束（FR-016）。
          const advanced = advanceRound(state, response);
          const { resume: _resume, ...rest } = advanced;
          return { ...rest, progress: lookupProgress(state, advanced, response.progress) };
        }
        default: {
          const unreachable: never = response;
          return unreachable;
        }
      }
    }
  }
}
