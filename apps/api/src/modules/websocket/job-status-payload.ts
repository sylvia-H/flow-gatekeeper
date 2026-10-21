import { DiagnosisJobProgressSchema, DiagnosisJobReturnValueSchema } from "@flow-gatekeeper/contracts";
import type { JobStatus } from "@flow-gatekeeper/contracts";
import type { z } from "zod";
import type { JobBinding } from "./job-routing-registry.js";

/**
 * `job/status` 的組裝純函式（research R2；contracts/job-lifecycle §2）。QueueEvents 帶來的 `returnvalue`／`data`
 * 來自 Redis，任何能寫 Redis 的一方都寫得進去，一律視為不受信任：只轉發 `safeParse` 之後的資料，MUST NOT
 * 原樣轉發（憲章 III、V）。
 */

/** 驗證失敗的摘要：只有路徑與代碼，不含原始內容（畸形資料可能夾帶任意大小或敏感的 payload）。 */
export type PayloadIssue = { path: string; code: string };

/** 日誌最多記幾則 issue。 */
const MAX_ISSUES = 5;

/**
 * Zod 驗證失敗 → 日誌用的 issue 摘要（最多 5 則，`{ path, code }`）。api 各處記「驗證失敗、已丟棄／降級」的 warn
 * 共用這個形狀：job-status relay、ai-stream relay、GET 查詢（T034）。
 */
export function summarizeIssues(error: z.ZodError): PayloadIssue[] {
  return error.issues.slice(0, MAX_ISSUES).map((issue) => ({
    path: issue.path.map(String).join(".") || "(root)",
    code: issue.code,
  }));
}

/**
 * `completed` 的 `job/status`（D1、P7、P8）。
 *
 * - `returnvalue` 通過 `DiagnosisJobReturnValueSchema` → 帶 `result` 與 `cached`（**帶 result 必帶 cached**，
 *   由本函式保證；schema 層刻意不 refine），以及綁定上最近一次 progress 記下的 `attempt`／`execution`（已知才帶）。
 * - 不通過、`null`（舊版 worker 不回傳）或缺值 → 只送不帶 `result` 的 `completed`，並回 `issues` 供呼叫端記 warn。
 *   此時也不帶 `attempt`／`execution`：契約對映表的這一列只定義「不帶 result 的 completed」。
 */
export function completedStatus(input: {
  jobId: string;
  machineId: string;
  returnvalue: unknown;
  binding?: Pick<Readonly<JobBinding>, "attempt" | "execution">;
}): { status: JobStatus; issues?: PayloadIssue[] } {
  const { jobId, machineId, returnvalue, binding } = input;
  const base: JobStatus = { type: "job/status", jobId, machineId, status: "completed" };
  const parsed = DiagnosisJobReturnValueSchema.safeParse(returnvalue);
  if (!parsed.success) return { status: base, issues: summarizeIssues(parsed.error) };

  const status: JobStatus = { ...base, result: parsed.data.result, cached: parsed.data.cached };
  if (binding?.attempt !== undefined) status.attempt = binding.attempt;
  if (binding?.execution !== undefined) status.execution = binding.execution;
  return { status };
}

/** `progress` 事件 `data` 拆出的 `job/status: active` 欄位。 */
export type ProgressFields = Pick<JobStatus, "progress" | "attempt" | "execution">;

/**
 * `progress` 事件的 `data`（D7）：
 * - 通過 `DiagnosisJobProgressSchema`（012 worker）→ `{ progress: value, attempt, execution }`；
 * - 有限數字且在 0～100（舊 worker）→ `{ progress }`；超出範圍或 NaN 省略，免得送出 `JobStatusSchema` 不收的值；
 * - 其他 → `{}`（送不帶 progress 的 `active`，沿用既有行為）。
 */
export function progressStatus(data: unknown): ProgressFields {
  const parsed = DiagnosisJobProgressSchema.safeParse(data);
  if (parsed.success) {
    return { progress: parsed.data.value, attempt: parsed.data.attempt, execution: parsed.data.execution };
  }
  if (typeof data === "number" && Number.isFinite(data) && data >= 0 && data <= 100) return { progress: data };
  return {};
}
