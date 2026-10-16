/**
 * 背壓比值（定義源自 013 前的 design-spec §7.2.1，已退役）：`renderedBatches > 0 ? round(received / rendered) : 0`。
 * 唯一實作處——013 起是「自載入起的累計比值」，monitoring store 每秒取樣一次給背壓 strip 的 tooltip；
 * strip 的主顯示改為 60 秒視窗比值（`domains/monitoring/lib/rate-series.ts`）。
 */
export function backpressureRatio(receivedMessages: number, renderedBatches: number): number {
  return renderedBatches > 0 ? Math.round(receivedMessages / renderedBatches) : 0;
}
