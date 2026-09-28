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

/**
 * stale 判斷用的「有效時鐘」：Pause 且連線正常時凍結在按下 Pause 的時刻，其餘情況照走。
 *
 * 為什麼凍結：Pause 期間資料其實持續抵達（進 buffer 續存），只是畫面不提交；若時鐘照走，
 * 10 秒後所有卡片都會被標 Stale、Fleet Health 全數算 stale——那違反 design-spec §8.3
 * 「資料停止抵達」的語意。凍結後畫面就是按下 Pause 那一刻的完整快照（含相對時間）。
 *
 * 為什麼斷線時不凍結：斷線代表資料真的停了，這時標 Stale 才正確（§8.2 disconnected
 * 「保留最後資料但標示 stale」），不能被 Pause 蓋掉。
 */
export function staleClock(
  now: number,
  pausedAt: number | null,
  connected: boolean,
): number {
  return pausedAt !== null && connected ? pausedAt : now;
}
