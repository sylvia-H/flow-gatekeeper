import { z } from "zod";
import { DiagnosisResultSchema } from "./schemas.js";

/**
 * 診斷 job 契約（003 擴充，contract-first：先入契約再於 api/worker 實作）。
 *
 * `DiagnosisJobPayload` 屬 api↔worker 的 BullMQ job 內部傳輸型別（非 WS 訊息，不進
 * asyncapi）。依憲章 III「型別來源分層」，純傳輸型別 MAY 以 TS 定義，仍以本套件為單一
 * 來源，MUST NOT 在 api/worker 各寫平行定義。
 *
 * 刻意不含 prompt 版本：prompt 內容住在 worker，版本也由 worker 的 prompt 模組自行匯出
 * 版本常數放進 cache signature——版本與內容放在同一處，改 prompt 才不會忘記升版、讓舊
 * cache 繼續服務到 TTL。
 */

/** BullMQ 佇列名稱——api（產 job）與 worker（消化）MUST 一致。 */
export const DIAGNOSIS_QUEUE = "diagnosis";

/** 一次診斷請求的 job payload。 */
export type DiagnosisJobPayload = {
  /** UUID，同時作為 BullMQ jobId 與 ai-stream channel 尾綴（可由前端帶入作 idempotency key）。 */
  jobId: string;
  /** 目標機台（沿用 002 的 5 台示範機台識別）。 */
  machineId: string;
  /** 發起者（預設 'demo-user'）。 */
  requestedBy: string;
  /** 發起時間，ISO 8601。 */
  requestedAt: string;
  /** context 讀取窗口（分鐘，預設 5）。 */
  windowMinutes: number;
};

/**
 * BullMQ job 的 `returnvalue`（worker processor 的回傳值，012 起）。
 *
 * worker 回傳後由 BullMQ 寫進 Redis，api 從 QueueEvents `completed` 與 `Job.fromId` 讀回；
 * 任何能寫 Redis 的一方都寫得進去，所以 api 讀回時 MUST `safeParse`，不合法就當「沒有結果」
 * （relay 送不帶 result 的 completed、GET 退到 Mongo）。這份 `result` 是權威完成的來源：
 * `job/status` 的 `completed`＋`result`＋`cached` 由它而來，`ai/done` 只是盡力送達的通知。
 *
 * 屬 api↔worker 內部傳輸型別，不進 asyncapi；以 Zod 定義是因為讀回端必須做 runtime 驗證。
 */
export const DiagnosisJobReturnValueSchema = z.object({
  result: DiagnosisResultSchema,
  /** 是否由 Redis cache 命中（未呼叫 LLM）。 */
  cached: z.boolean(),
});

/**
 * `job.updateProgress()` 的參數（012 起由數字改為物件）。
 *
 * api 的 relay 與 GET 讀 `job.progress` 時 `safeParse`；舊 worker 送的純數字仍照舊接受
 * （只帶 progress、不帶 attempt／execution），兩者都不符時不帶 progress。
 */
export const DiagnosisJobProgressSchema = z.object({
  /** 進度百分比。 */
  value: z.number().int().min(0).max(100),
  /** `attemptsMade + 1`，與 `ai/*` 的 `attempt` 同義。 */
  attempt: z.number().int().min(1),
  /** `attemptsStarted`：重試、stalled 重派、限流延後都會遞增；遞增不等於 worker 中斷。 */
  execution: z.number().int().min(1),
});

export type DiagnosisJobReturnValue = z.infer<typeof DiagnosisJobReturnValueSchema>;
export type DiagnosisJobProgress = z.infer<typeof DiagnosisJobProgressSchema>;
