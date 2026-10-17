/**
 * US6 機台分組——前端**靜態**「機台 → 群組」對照（data-model §4、research R10、FR-017）。
 * 比照 `machine-labels.ts` 靜態對照做法（同目錄、同風格），純前端資料、不動契約。
 * 截圖的 Stamping/Fluids 等群組為視覺示意，與實際 5 台 roster 不符，故以下列三組落地。
 *
 * 013 起同一份定義也是 stage 拓樸（`stage-layout.ts`）的來源：
 * - `name`：英文穩定 key（`stage-layout.ts` 的 `Stage.name` 沿用）；不在任何分組的 id 由 `assignToStages` 歸入最後一欄，
 *   不另設 fallback 群組（原 `machineGroup()` 與 `"Ungrouped"` 已於合併門第 2 輪隨死碼刪除）；
 * - `key`：`data-stage` 屬性值（ui-contract §3：`prep`／`forming`／`fulfilment`），供 StageColumn 與 e2e 選擇器；
 * - `label`：stage 繁中顯示名（不附英文副標）。
 */
export type MachineGroupName = "Prep" | "Forming & Baking" | "Fulfilment";

/** stage 的 `data-stage` 值（ui-contract §3）。 */
export type StageKey = "prep" | "forming" | "fulfilment";

export interface MachineGroup {
  name: MachineGroupName;
  key: StageKey;
  /** stage 繁中顯示名。 */
  label: string;
  machineIds: readonly string[];
}

/** 有序群組（stage 欄依此順序渲染：前處理 → 成型烘烤 → 包裝分揀）。 */
export const MACHINE_GROUPS: readonly MachineGroup[] = [
  { name: "Prep", key: "prep", label: "前處理", machineIds: ["mixer-01"] },
  { name: "Forming & Baking", key: "forming", label: "成型烘烤", machineIds: ["press-02", "oven-04"] },
  { name: "Fulfilment", key: "fulfilment", label: "包裝分揀", machineIds: ["pack-03", "sorter-05"] },
];
