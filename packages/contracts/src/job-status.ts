import { z } from "zod";
import { DiagnosisResultSchema } from "./schemas.js";

/**
 * job/status：伺服器推送的診斷任務狀態。有設 `WS_AUTH_SECRET` 時只送已授權（通過 `machine/subscribe` token 檢查）的連線。
 *
 * 以 Zod 定義是為了讓 web 入口能 `safeParse`：這則訊息可能帶完整 `result`，畸形內容若
 * 直接進 store，會在診斷結果畫面 render 時才炸開，比在入口丟棄更難追。
 */
export const JobStatusSchema = z.object({
  type: z.literal("job/status"),
  jobId: z.string(),
  machineId: z.string(),
  status: z.enum(["waiting", "active", "completed", "failed"]),
  progress: z.number().min(0).max(100).optional(),
  result: DiagnosisResultSchema.optional(),
  error: z.string().optional(),
});

export type JobStatus = z.infer<typeof JobStatusSchema>;
