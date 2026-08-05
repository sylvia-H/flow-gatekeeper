/**
 * 診斷 job 契約（003 擴充，contract-first：先入契約再於 api/worker 實作）。
 *
 * `DiagnosisJobPayload` 屬 api↔worker 的 BullMQ job 內部傳輸型別（非 WS 訊息，不進
 * asyncapi）。依憲章 III「型別來源分層」，純傳輸型別 MAY 以 TS 定義，仍以本套件為單一
 * 來源，MUST NOT 在 api/worker 各寫平行定義。
 */

/** BullMQ 佇列名稱——api（產 job）與 worker（消化）MUST 一致。 */
export const DIAGNOSIS_QUEUE = "diagnosis";

/** 一次診斷請求的 job payload。 */
export type DiagnosisJobPayload = {
  /** randomUUID，同時作為 BullMQ jobId 與 ai-stream channel 尾綴。 */
  jobId: string;
  /** 目標機台（沿用 002 的 5 台示範機台識別）。 */
  machineId: string;
  /** 發起者（預設 'demo-user'）。 */
  requestedBy: string;
  /** 發起時間，ISO 8601。 */
  requestedAt: string;
  /** context 讀取窗口（分鐘，預設 5）。 */
  windowMinutes: number;
  /** 進 cache 簽章的 prompt 版本（預設 'diagnosis-v1'）。 */
  promptVersion: string;
};
