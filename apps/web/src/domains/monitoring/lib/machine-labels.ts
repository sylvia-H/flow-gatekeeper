import { MACHINE_IDS, isKnownMachineId } from "@flow-gatekeeper/contracts";
import type { MachineId } from "@flow-gatekeeper/contracts";

/**
 * 5 台示範機台名冊——供「訂閱清單」「topology placeholder 渲染名冊」「label 對照」三處共用
 * （data-model §2、FR-024）。名冊本身的跨端單一來源是 `@flow-gatekeeper/contracts` 的
 * `MACHINE_IDS`（api 以同一份檢查訂閱與 `POST /diagnoses`），此處只是 web 端沿用的別名。
 */
export const KNOWN_MACHINE_IDS = MACHINE_IDS;

export type KnownMachineId = MachineId;

/** machineId → 顯示名稱靜態對照（以 MachineId 為 key：名冊增減時漏補對照會編譯失敗）。 */
const LABELS: Readonly<Record<MachineId, string>> = {
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
  return isKnownMachineId(machineId) ? LABELS[machineId] : machineId;
}
