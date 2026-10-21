import {
  CreateDiagnosisResponseSchema,
  DiagnosisLookupResponseSchema,
  type CreateDiagnosisBody,
  type CreateDiagnosisResponse,
  type DiagnosisLookupResponse,
} from "@flow-gatekeeper/contracts";

/**
 * 診斷觸發 REST helper（contracts/diagnose-rest、research R2）。
 *
 * 以瀏覽器原生 `fetch` 打**同源** `POST /diagnoses`（dev 由 vite proxy 轉 :3000）。
 * `jobId` 由呼叫端先產生並放進 body 當 idempotency key：store 在送出前就以它建立 pending
 * 狀態，後續 `job/status`／`ai/*` 即使早於 HTTP 回應抵達也對得上。同一 jobId 重送，只有在
 * 後端綁定仍在時才回同一個 job；綁定已結束（或 jobId 曾用於別台）則回 409，需以新 jobId 重發。
 * body／回應型別都取自契約，避免前後端各自維護一份而漂移。
 */

/** POST 往返上限：沒有上限時請求可能永遠懸著，store 的 in-flight 旗標也跟著卡住、Retry 按不下去。 */
export const DIAGNOSE_REQUEST_TIMEOUT_MS = 15_000;

/** 網路層失敗（fetch reject：離線、DNS、連線被拒）時給使用者的固定句。 */
export const NETWORK_ERROR_MESSAGE = "無法連線診斷服務，請檢查網路後重試";

/** 409 且即時通道已知未授權（收到 `system/unauthorized`）時改用的句子：重連也無濟於事，要換 token。 */
export const UNAUTHORIZED_DIAGNOSE_MESSAGE = "即時通道未授權（WS token 無效），無法發起診斷";

/** 已轉成可讀中文訊息的請求失敗；store 可直接把 `message` 呈現給使用者。 */
export class DiagnoseRequestError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "DiagnoseRequestError";
  }
}

/** 狀態碼 → 使用者看得懂的句子（不把「HTTP 503」這種字樣丟給使用者）。 */
export function messageForStatus(status: number): string {
  // 404：api 對名冊外的 machineId 回 404。
  if (status === 404) return "此機台不在名冊中";
  // 429：nginx 對 `/diagnoses` 限流（limit_req）；回應是 nginx 錯誤頁，不會有中文 message。
  if (status === 429) return "診斷請求過於頻繁，請稍後再試";
  // 409：jobId 綁定已結束／曾用於別台，或 socketId 對應的 WebSocket 已不存在／未授權。
  // 兩者的處置相同（等連線恢復後以新 jobId 重發）；後端有中文 message 時優先顯示後端原句。
  if (status === 409) return "連線已中斷或未授權，請等待重連後再試";
  if (status === 503) return "診斷佇列暫時無法使用，請稍後再試";
  if (status === 400 || status === 415) return "請求格式不被接受（前端版本可能過舊）";
  if (status >= 500) return "診斷服務暫時發生錯誤，請稍後再試";
  return "診斷請求失敗，請重試";
}

/**
 * 取後端 JSON body 的 `message`（api 以中文撰寫）。只接受含中文的短字串：Nest 預設的英文
 * reason phrase（如 "Unsupported Media Type"）或驗證錯誤陣列不適合直接給使用者看，交給狀態碼對映。
 */
async function readServerMessage(res: Response): Promise<string | null> {
  try {
    const body: unknown = await res.json();
    const msg = typeof body === "object" && body !== null ? (body as { message?: unknown }).message : undefined;
    if (typeof msg === "string" && msg.length > 0 && msg.length < 120 && /[一-鿿]/.test(msg)) return msg;
  } catch {
    // body 不是 JSON（例如 proxy 錯誤頁）→ 退回狀態碼對映
  }
  return null;
}

function timeoutSignal(): AbortSignal | undefined {
  return typeof AbortSignal.timeout === "function"
    ? AbortSignal.timeout(DIAGNOSE_REQUEST_TIMEOUT_MS)
    : undefined;
}

export async function postDiagnose(
  jobId: string,
  machineId: string,
  socketId: string,
  requestedBy?: string,
): Promise<CreateDiagnosisResponse> {
  const body = {
    jobId,
    machineId,
    socketId,
    ...(requestedBy ? { requestedBy } : {}),
  } satisfies CreateDiagnosisBody;

  let res: Response;
  try {
    res = await fetch("/diagnoses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: timeoutSignal(),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      throw new DiagnoseRequestError("診斷請求逾時，請重試");
    }
    throw new DiagnoseRequestError(NETWORK_ERROR_MESSAGE);
  }

  if (!res.ok) {
    const serverMessage = await readServerMessage(res);
    throw new DiagnoseRequestError(serverMessage ?? messageForStatus(res.status), res.status);
  }

  // 回應同樣是外部輸入：不合契約（例如 proxy 回了 HTML 錯誤頁）就當失敗處理，而不是帶著 undefined 繼續。
  const parsed = CreateDiagnosisResponseSchema.safeParse(await res.json().catch(() => null));
  if (!parsed.success) {
    throw new DiagnoseRequestError("診斷請求回應格式不符");
  }
  if (parsed.data.jobId !== jobId) {
    // 後端應回傳我們送出的同一個 jobId；不一致代表 idempotency 失效，後續事件會對不上。
    throw new DiagnoseRequestError("診斷請求回應的 jobId 與送出不一致");
  }
  return parsed.data;
}

/** GET 的 409 body 帶的機器可讀 `code`（contracts/diagnosis-lookup §5、research P2）；只有這兩種值會被採信。 */
export type DiagnoseLookupConflictCode = "socket_unauthorized" | "job_bound_elsewhere";

/**
 * `getDiagnosis` 失敗的種類：
 * - `http`：非 2xx（`status` 必有；409 時 `code` 為 body 的機器可讀碼，讀不到則 undefined）；
 * - `network`：fetch reject（離線、DNS、連線被拒）；
 * - `timeout`：超過 `DIAGNOSE_REQUEST_TIMEOUT_MS`；
 * - `invalid`：2xx 但回應不合 `DiagnosisLookupResponseSchema`，或 `jobId` 與查詢的不一致（research P3）。
 */
export type DiagnoseLookupErrorKind = "http" | "network" | "timeout" | "invalid";

/**
 * `GET /diagnoses/:jobId` 的失敗（contracts/diagnosis-lookup §8）。只帶分類，不帶使用者文案：
 * 同一個失敗在續接、2 s 未送達、45 s watchdog 三種用途下顯示不同句子，由 store 依用途對映（contracts/ui-copy §3）。
 * `message` 只供除錯，不呈現給使用者。
 */
export class DiagnoseLookupError extends Error {
  constructor(
    readonly kind: DiagnoseLookupErrorKind,
    readonly status?: number,
    readonly code?: DiagnoseLookupConflictCode,
  ) {
    super(`diagnosis lookup failed: ${kind}${status !== undefined ? ` ${status}` : ""}${code ? ` (${code})` : ""}`);
    this.name = "DiagnoseLookupError";
  }
}

/** 讀 GET 409 body 的 `code`；body 不是 JSON 或值不在已知集合內時回 undefined（交給呼叫端當「其他失敗」）。 */
async function readConflictCode(res: Response): Promise<DiagnoseLookupConflictCode | undefined> {
  try {
    const body: unknown = await res.json();
    const code = typeof body === "object" && body !== null ? (body as { code?: unknown }).code : undefined;
    if (code === "socket_unauthorized" || code === "job_bound_elsewhere") return code;
  } catch {
    // 非 JSON（proxy 錯誤頁）→ 無 code
  }
  return undefined;
}

/**
 * 讀回某個診斷的目前狀態並（進行中時）把後續事件改綁到本連線（012 FR-007～FR-017、contracts/diagnosis-lookup）。
 *
 * 同源 `GET /diagnoses/<jobId>?socketId=…[&previousSocketId=…]`，逾時沿用 POST 的 15 s。200 回應同樣是外部輸入：
 * 以 `DiagnosisLookupResponseSchema.safeParse` 驗證（四分支：completed／failed／waiting／active），`jobId` 不符視為格式錯誤——
 * 與 `postDiagnose` 的 jobId 比對是同一道防線（proxy 錯路由時不會把別人的結果當成這筆）。
 * 任何失敗都拋 `DiagnoseLookupError`（見其 `kind`）；狀態碼對使用者文案的對映由 store 依用途決定。
 */
export async function getDiagnosis(
  jobId: string,
  socketId: string,
  previousSocketId?: string,
): Promise<DiagnosisLookupResponse> {
  const query = new URLSearchParams({ socketId });
  if (previousSocketId) query.set("previousSocketId", previousSocketId);

  let res: Response;
  try {
    res = await fetch(`/diagnoses/${encodeURIComponent(jobId)}?${query.toString()}`, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: timeoutSignal(),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    throw new DiagnoseLookupError(name === "TimeoutError" || name === "AbortError" ? "timeout" : "network");
  }

  if (!res.ok) {
    const code = res.status === 409 ? await readConflictCode(res) : undefined;
    throw new DiagnoseLookupError("http", res.status, code);
  }

  const parsed = DiagnosisLookupResponseSchema.safeParse(await res.json().catch(() => null));
  if (!parsed.success || parsed.data.jobId !== jobId) {
    throw new DiagnoseLookupError("invalid");
  }
  return parsed.data;
}
