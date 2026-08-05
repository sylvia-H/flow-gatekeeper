/**
 * 資料新鮮度判斷（FR-017、SC-005、design-spec §8.3）。
 * `now - lastUpdated > thresholdMs` → 視為 stale（預設門檻 10s）。
 * 純函式，供卡片 stale 視覺與單測使用；不清空數值，只降透明＋badge。
 */
export function isStale(
  lastUpdated: number,
  now: number,
  thresholdMs = 10_000,
): boolean {
  return now - lastUpdated > thresholdMs;
}
