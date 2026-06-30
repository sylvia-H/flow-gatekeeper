import { z } from "zod";

/**
 * DiagnosisResultSchema — AI 診斷結果的單一真實來源（憲章 Principle III）。
 *
 * 型別由 `z.infer` 推導，MUST NOT 手寫平行型別。worker 取得 LLM 回傳後 MUST 以
 * `DiagnosisResultSchema.parse()` 驗證，失敗走 `ai/error`（憲章 Principle V）。
 */
export const DiagnosisResultSchema = z.object({
  summary: z.string(),
  severity: z.enum(["ok", "warning", "critical"]),
  likelyCauses: z.array(z.string()),
  suggestedActions: z.array(
    z.object({
      label: z.string(),
      priority: z.enum(["low", "medium", "high"]),
      command: z.string().optional(),
    }),
  ),
  evidence: z.array(
    z.object({
      source: z.enum(["telemetry", "errorlog", "maintenance"]),
      id: z.string().optional(),
      excerpt: z.string(),
    }),
  ),
});

export type DiagnosisResult = z.infer<typeof DiagnosisResultSchema>;
