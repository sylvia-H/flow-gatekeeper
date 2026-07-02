/**
 * 5 台示範機台名冊的**單一來源**（沿用 002）——供「訂閱清單」「topology placeholder
 * 渲染名冊」「label 對照」三處共用，避免名冊漂移（data-model §2、FR-024）。
 */
export const KNOWN_MACHINE_IDS = [
  "mixer-01",
  "press-02",
  "pack-03",
  "oven-04",
  "sorter-05",
] as const;

export type KnownMachineId = (typeof KNOWN_MACHINE_IDS)[number];

/** machineId → 顯示名稱靜態對照。 */
const LABELS: Record<string, string> = {
  "mixer-01": "Mixer 01",
  "press-02": "Press 02",
  "pack-03": "Pack 03",
  "oven-04": "Oven 04",
  "sorter-05": "Sorter 05",
};

/**
 * 靜態對照顯示名稱；缺項時 fallback 回 machineId 本身（FR-006a、Clarify 決議）。
 */
export function machineLabel(machineId: string): string {
  return LABELS[machineId] ?? machineId;
}
