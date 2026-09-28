/**
 * 背壓比值（design-spec §7.2.1）：`renderedBatches > 0 ? round(received / rendered) : 0`。
 * 唯一實作處——BackpressureBadge 讀它，store 不再另留一份 getter，避免兩處定義漂移。
 */
export function backpressureRatio(receivedMessages: number, renderedBatches: number): number {
  return renderedBatches > 0 ? Math.round(receivedMessages / renderedBatches) : 0;
}
