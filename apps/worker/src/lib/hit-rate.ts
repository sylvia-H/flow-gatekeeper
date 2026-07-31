/**
 * 窗內快取命中率（009 FR-008／data-model E3）。
 *
 * **分母為 0 時回 `null`，不是 0**——`0` 是「有請求但全部落空」的語意，
 * 與「本窗根本沒有請求」完全不同（不變量：`hitRate === null` ⟺ `hits + misses === 0`）。
 *
 * 不四捨五入：呈現層（面板／日誌讀者）自行決定精度，此處保留原始比值。
 */
export function hitRate(hits: number, misses: number): number | null {
  const total = hits + misses;
  if (total === 0) return null;
  return hits / total;
}
