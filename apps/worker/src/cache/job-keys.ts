/**
 * 012 新增的 worker Redis 鍵與 TTL（FR-026～FR-028、FR-043；data-model §3；research R6／R7）。
 *
 * - `ai-result:<jobId>`：LLM 成功、`parseResult` 通過後、寫 `diagnoses` 之前的 per-job 結果暫存；寫庫成功後 DEL。
 *   TTL 對齊 BullMQ `removeOnComplete`（3600 s）。
 * - `ai-metric:<jobId>`：hit／miss 以 jobId 只計一次的標記（`SET NX`，回 OK 才記）。TTL 對齊 `removeOnFail`（86400 s）。
 * - `ai-fail:<sig>`：同簽章 LLM 階段失敗的負向標記，TTL 10 s（ADR-003 D5：涵蓋持鎖者第一次退避重試的時間點）。
 *
 * 既有 `ai-cache:`／`ai-lock:`／`ai-rpm:` 仍在 processor 內組字串（集中到 contracts 屬 010-lite）；新前綴不得與之撞名
 * （單測斷言）。
 */

export const AI_RESULT_TTL_SECONDS = 3600;
export const AI_METRIC_TTL_SECONDS = 86_400;
export const AI_FAIL_TTL_SECONDS = 10;

export function aiResultKey(jobId: string): string {
  return `ai-result:${jobId}`;
}

export function aiMetricKey(jobId: string): string {
  return `ai-metric:${jobId}`;
}

export function aiFailKey(sig: string): string {
  return `ai-fail:${sig}`;
}
