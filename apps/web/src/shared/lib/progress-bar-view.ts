/**
 * ProgressBar 呈現推導（design-spec §7.5、FR-004）。抽成純函式使進度條的顯示不變量
 * 可單元測試（同 copilot-reducer／classifyWsMessage 的做法）：
 * - `indeterminate` **僅** waiting/active 且無數值時為真；completed/failed 皆為收尾態，
 *   絕不走 indeterminate 動畫（避免對已結束任務誤顯「處理中」）。
 * - `barClass` 依狀態上色（completed→ok、failed→crit、其餘→accent）。
 * - `widthPct` completed 視為 100，其餘取數值（無則 0）。
 */
export type ProgressStatus = "waiting" | "active" | "completed" | "failed";

export interface ProgressBarView {
  indeterminate: boolean;
  barClass: string;
  widthPct: number;
  ariaLabel: string;
}

export function progressBarView(status: ProgressStatus, value?: number | null): ProgressBarView {
  const numeric = typeof value === "number" ? value : null;
  const indeterminate = numeric === null && status !== "completed" && status !== "failed";

  const barClass = status === "completed" ? "bg-ok" : status === "failed" ? "bg-crit" : "bg-accent";
  const widthPct = status === "completed" ? 100 : (numeric ?? 0);
  const ariaLabel = indeterminate ? "診斷進度：處理中…" : `診斷進度：${widthPct}%`;

  return { indeterminate, barClass, widthPct, ariaLabel };
}
