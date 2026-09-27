import { z } from "zod";

/**
 * `POST /diagnoses` 的 HTTP 契約（api 驗證、web 送出共用同一份）。
 *
 * body 會一路進 BullMQ payload、Mongo 查詢條件與 LLM prompt，所以每個欄位都必須是
 * 受限的純字串：型別不對（例如 urlencoded 解析出的 `{ $ne: "x" }` 物件）或長度失控，
 * 在入口就擋掉，而不是讓下游各自防禦。
 */
export const CreateDiagnosisBodySchema = z.object({
  /**
   * idempotency key：由前端 `crypto.randomUUID()` 產生並在送出前就建立 pending 狀態，
   * 讓早於 HTTP 回應抵達的 `job/status`／`ai/*` 能對上；缺省時由 api 產生。
   */
  jobId: z.string().uuid().optional(),
  /** 機台識別；格式受限是為了不讓任意長字串進 prompt（prompt injection 與 token 成本）。 */
  machineId: z.string().regex(/^[a-z0-9-]{1,32}$/),
  /** 發起連線的 WS clientId（Gateway 以 `randomUUID()` 派發，見 `system/connected`）。 */
  socketId: z.string().uuid(),
  /** 發起者；會寫進日誌與 `diagnosisTriggers`，故限制長度。缺省時 api 以 'demo-user' 代入。 */
  requestedBy: z.string().min(1).max(64).optional(),
});

/** `POST /diagnoses` 回應（初始狀態）；後續狀態經 WS `job/status`／`ai/*` 回送。 */
export const CreateDiagnosisResponseSchema = z.object({
  jobId: z.string().uuid(),
  machineId: z.string(),
  status: z.literal("waiting"),
});

export type CreateDiagnosisBody = z.infer<typeof CreateDiagnosisBodySchema>;
export type CreateDiagnosisResponse = z.infer<typeof CreateDiagnosisResponseSchema>;
