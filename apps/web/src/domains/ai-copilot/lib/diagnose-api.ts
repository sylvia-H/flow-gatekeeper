/**
 * 診斷觸發 REST helper（contracts/diagnose-rest、research R2）。
 *
 * 以瀏覽器原生 `fetch` 打**同源** `POST /diagnoses`（dev 由 vite proxy 轉 :3000），
 * body `{ machineId, socketId, requestedBy? }`（`socketId` = 004 對外最新 `clientId`）。
 * 回傳後端指派的 `jobId`；後續 `job/status`／`ai/*`（帶同一 jobId）經 004 WebSocket 回送。
 */

/** `POST /diagnoses` 回應（200，初始狀態）。 */
export interface CreateDiagnosisResponse {
  jobId: string;
  machineId: string;
  status: "waiting";
}

/**
 * 觸發診斷。前置條件（有 `socketId`＝已連線）由呼叫端把關；此處僅負責送出與解析回應。
 * 非 2xx 或缺 `jobId` → throw，交由 store 轉該台 failed（附可讀訊息）。
 */
export async function postDiagnose(
  machineId: string,
  socketId: string,
  requestedBy?: string,
): Promise<CreateDiagnosisResponse> {
  const res = await fetch("/diagnoses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ machineId, socketId, ...(requestedBy ? { requestedBy } : {}) }),
  });

  if (!res.ok) {
    throw new Error(`診斷請求失敗（HTTP ${res.status}）`);
  }

  const data = (await res.json()) as Partial<CreateDiagnosisResponse>;
  if (typeof data.jobId !== "string" || data.jobId.length === 0) {
    throw new Error("診斷請求回應缺少 jobId");
  }
  return { jobId: data.jobId, machineId, status: "waiting" };
}
