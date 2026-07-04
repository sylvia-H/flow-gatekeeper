/**
 * US6 機台分組——前端**靜態**「機台 → 群組」對照（data-model §4、research R10、FR-017）。
 * 比照 `machine-labels.ts` 靜態對照做法（同目錄、同風格），純前端資料、不動契約。
 * 截圖的 Stamping/Fluids 等群組為視覺示意，與實際 5 台 roster 不符，故以下列三組落地。
 */
export type MachineGroupName = "Prep" | "Forming & Baking" | "Fulfilment" | "Ungrouped";

export interface MachineGroup {
  name: MachineGroupName;
  machineIds: readonly string[];
}

/** 有序群組（sidebar 依此順序渲染）。 */
export const MACHINE_GROUPS: readonly MachineGroup[] = [
  { name: "Prep", machineIds: ["mixer-01"] },
  { name: "Forming & Baking", machineIds: ["press-02", "oven-04"] },
  { name: "Fulfilment", machineIds: ["pack-03", "sorter-05"] },
];

/** 缺項（對照表中找不到）→ fallback 群組 `"Ungrouped"`（不漏顯示）。 */
export function machineGroup(machineId: string): MachineGroupName {
  for (const group of MACHINE_GROUPS) {
    if (group.machineIds.includes(machineId)) return group.name;
  }
  return "Ungrouped";
}
