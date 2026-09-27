import {
  CreateDiagnosisResponseSchema,
  type CreateDiagnosisBody,
  type CreateDiagnosisResponse,
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
  if (status === 409) return "此診斷請求已失效，請重新發起";
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
