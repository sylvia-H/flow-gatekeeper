import { z } from "zod";
import { DiagnosisResultSchema } from "./schemas.js";

/**
 * AI 串流事件（worker → Redis `ai-stream:<jobId>` → Gateway → web）。Gateway 轉發時，有設 `WS_AUTH_SECRET` 時只送已授權（通過 `machine/subscribe` token 檢查）的連線。
 *
 * 以 Zod 定義是因為 relay 從 Redis 讀回的是任何能 PUBLISH 的一方都寫得進去的字串，
 * 必須 `safeParse` 後才轉發；`ai/done.result` 也因此直接沿用 `DiagnosisResultSchema`。
 *
 * `attempt` 為 BullMQ 的第幾次嘗試（`job.attemptsMade + 1`，從 1 起）。重試時 jobId 不變、
 * `seq` 又從 0 起，前端需要據此在換輪時清空已累積的 streamText，而不是把兩輪 token 接在一起。
 * worker 崩潰後的 stalled 重派不遞增 `attemptsMade`，因此 `attempt` 不變但 `seq` 同樣從 0 重播；
 * 消費端在同一 `attempt` 內再收到 `seq` 0 也要視為新的一次執行並清空。
 */
const attempt = z.number().int().min(1);

/** ai/token：串流 AI token 區塊（有設 `WS_AUTH_SECRET` 時只送已授權（通過 `machine/subscribe` token 檢查）的連線）。 */
export const AiTokenSchema = z.object({
  type: z.literal("ai/token"),
  jobId: z.string(),
  attempt,
  seq: z.number().int(),
  text: z.string(),
});

/** ai/done：最終 AI 診斷結果（已通過 schema 驗證；有設 `WS_AUTH_SECRET` 時只送已授權（通過 `machine/subscribe` token 檢查）的連線）。 */
export const AiDoneSchema = z.object({
  type: z.literal("ai/done"),
  jobId: z.string(),
  attempt,
  cached: z.boolean(),
  result: DiagnosisResultSchema,
});

/** ai/error：AI 供應商或 worker 錯誤（有設 `WS_AUTH_SECRET` 時只送已授權（通過 `machine/subscribe` token 檢查）的連線）。 */
export const AiErrorSchema = z.object({
  type: z.literal("ai/error"),
  jobId: z.string(),
  attempt,
  code: z.string(),
  message: z.string(),
});

export const AiStreamEventSchema = z.discriminatedUnion("type", [
  AiTokenSchema,
  AiDoneSchema,
  AiErrorSchema,
]);

export type AiToken = z.infer<typeof AiTokenSchema>;
export type AiDone = z.infer<typeof AiDoneSchema>;
export type AiError = z.infer<typeof AiErrorSchema>;
export type AiStreamEvent = z.infer<typeof AiStreamEventSchema>;
