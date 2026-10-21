import { z } from "zod";
import { DiagnosisResultSchema } from "./schemas.js";

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
   *
   * `z.uuid()`（Zod 4）依 RFC 9562 檢查版本位元（1–8）與 variant 位元，比 Zod 3 的
   * `.uuid()`（只看 8-4-4-4-12 hex）嚴格；`crypto.randomUUID()` 產生的 v4 必然通過。
   */
  jobId: z.uuid().optional(),
  /** 機台識別；格式受限是為了不讓任意長字串進 prompt（prompt injection 與 token 成本）。 */
  machineId: z.string().regex(/^[a-z0-9-]{1,32}$/),
  /**
   * 發起連線的 WS clientId（Gateway 以 `randomUUID()` 派發，見 `system/connected`）。
   * 該連線必須**仍在線且已授權**（未設 `WS_AUTH_SECRET` 時連上即授權；有設時須已通過
   * `machine/subscribe` 的 token 檢查），否則 api 回 409——AI 串流與 `job/status` 只送已授權連線。
   */
  socketId: z.uuid(),
  /** 發起者；會寫進日誌與 `diagnosisTriggers`，故限制長度。缺省時 api 以 'demo-user' 代入。 */
  requestedBy: z.string().min(1).max(64).optional(),
});

/** `POST /diagnoses` 回應（初始狀態）；後續狀態經 WS `job/status`／`ai/*` 回送。 */
export const CreateDiagnosisResponseSchema = z.object({
  jobId: z.uuid(),
  machineId: z.string(),
  status: z.literal("waiting"),
});

export type CreateDiagnosisBody = z.infer<typeof CreateDiagnosisBodySchema>;
export type CreateDiagnosisResponse = z.infer<typeof CreateDiagnosisResponseSchema>;

/**
 * `GET /diagnoses/:jobId` 的 path params（012 起；ADR-003 D8）。
 *
 * jobId（UUID v4）即 bearer capability：持有一條在線、已授權的 WS 連線且知道 jobId，就能讀該 job。
 */
export const DiagnosisLookupParamsSchema = z.object({ jobId: z.uuid() });

/**
 * `GET /diagnoses/:jobId` 的 query。重複的 key（`?socketId=a&socketId=b`）會被 express 解析成陣列而 400；
 * 未列出的 key 忽略（z.object 預設 strip）。
 */
export const DiagnosisLookupQuerySchema = z.object({
  /** 發起查詢的 WS clientId；必須在線且已授權（與 POST 同一道閘門），否則 409 `socket_unauthorized`。 */
  socketId: z.uuid(),
  /**
   * 呼叫端分頁上一次成功綁定此任務的 socketId；只用於改綁判斷：原綁定仍在線但等於它時，比照「原綁定已離線」
   * 改綁到本次 socketId（處理半開連線）。
   */
  previousSocketId: z.uuid().optional(),
});

/**
 * 進行中（waiting／active）分支的共同欄位。
 *
 * `rebound` 恆為 `true`：表示之後的 `job/status`／`ai/*` 會送到本次 `socketId`（綁定原本就是本連線時也回 true，
 * 讓 web 只有一條規則）。綁在別條在線連線時不回 200，而是 409 `job_bound_elsewhere`。
 */
const DiagnosisLookupInFlightShape = {
  jobId: z.uuid(),
  /** `job.progress` 為 `DiagnosisJobProgress` 時取 `value`、為數字時直接用，否則省略。 */
  progress: z.number().min(0).max(100).optional(),
  /** `attemptsMade + 1`。 */
  attempt: z.number().int().min(1).optional(),
  /** `attemptsStarted`（≥ 1 才帶）。 */
  execution: z.number().int().min(1).optional(),
  rebound: z.literal(true),
};

/**
 * `GET /diagnoses/:jobId` 的 200 回應，以 `status` 區分。四個分支都帶 `jobId`，web 比對不符視為格式錯誤。
 *
 * - `completed`：BullMQ `returnvalue` 合法，或 job 已清、由 Mongo `diagnoses` 取回（此時 `cached: false`）。
 *   `result` 不論來源皆已通過 `DiagnosisResultSchema`。
 * - `failed`：`error` 為 BullMQ `failedReason` 原文。
 * - `waiting`：涵蓋 BullMQ 的 waiting／delayed／prioritized／waiting-children。
 * - `active`：BullMQ active。
 *
 * 錯誤回應（400／404／409 兩種 `code`／429／503）依憲章 III 例外 (b) 不另定 schema，語意記於 `asyncapi.yaml`
 * 的 `info.description`。
 */
export const DiagnosisLookupResponseSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("completed"),
    jobId: z.uuid(),
    result: DiagnosisResultSchema,
    cached: z.boolean(),
  }),
  z.object({
    status: z.literal("failed"),
    jobId: z.uuid(),
    error: z.string(),
  }),
  z.object({ status: z.literal("waiting"), ...DiagnosisLookupInFlightShape }),
  z.object({ status: z.literal("active"), ...DiagnosisLookupInFlightShape }),
]);

export type DiagnosisLookupParams = z.infer<typeof DiagnosisLookupParamsSchema>;
export type DiagnosisLookupQuery = z.infer<typeof DiagnosisLookupQuerySchema>;
export type DiagnosisLookupResponse = z.infer<typeof DiagnosisLookupResponseSchema>;
