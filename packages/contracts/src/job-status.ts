import { z } from "zod";
import { DiagnosisResultSchema } from "./schemas.js";

/**
 * job/status：伺服器推送的診斷任務狀態。有設 `WS_AUTH_SECRET` 時只送已授權（通過 `machine/subscribe` token 檢查）的連線。
 *
 * 以 Zod 定義是為了讓 web 入口能 `safeParse`：這則訊息可能帶完整 `result`，畸形內容若
 * 直接進 store，會在診斷結果畫面 render 時才炸開，比在入口丟棄更難追。
 *
 * `status: "completed"` 且帶 `result` 是**權威完成**訊號（asyncapi 1.4.0、ADR-003 D3）；`ai/done`
 * 只是盡力送達的通知，可能重複、可能遺失。
 */
export const JobStatusSchema = z.object({
  type: z.literal("job/status"),
  jobId: z.string(),
  machineId: z.string(),
  status: z.enum(["waiting", "active", "completed", "failed"]),
  progress: z.number().min(0).max(100).optional(),
  result: DiagnosisResultSchema.optional(),
  error: z.string().optional(),
  // 以下四欄 1.4.0 新增，全部 optional：舊 client 照常運作、舊 api 不送也合法。
  /** `attemptsMade + 1`，與 `ai/*` 的 `attempt` 同義；`active`（progress 物件）與已知時的 `completed` 帶上。 */
  attempt: z.number().int().min(1).optional(),
  /** `attemptsStarted`：重試、stalled 重派、限流延後都會遞增；遞增時消費端清串流，但**不等於** worker 中斷。 */
  execution: z.number().int().min(1).optional(),
  /**
   * 狀態變化的原因，開放字串。已知值：
   * - `"stalled"`：worker 失去 lock 後 BullMQ 重新排入佇列（隨 `status: "waiting"` 送出）。
   *
   * 刻意不用 enum：web 以 Zod 驗整則 `job/status`，封閉 enum 時 api 日後加一個新值，舊 web 會把整則
   * （含 `completed`＋`result`）丟掉（ADR-003 D7）。消費端遇到未知值 MUST 忽略。
   */
  reason: z.string().optional(),
  /**
   * 結果是否來自 cache；`status: "completed"` 且帶 `result` 時 api 一律帶上，缺值時消費端當 `false`。
   * 不以 refine 綁「帶 result 必帶 cached」：那會讓舊 api 的 completed 整則被丟掉。
   */
  cached: z.boolean().optional(),
});

export type JobStatus = z.infer<typeof JobStatusSchema>;
