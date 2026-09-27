import { isKnownMachineId } from "@flow-gatekeeper/contracts";
import type { MachineId } from "@flow-gatekeeper/contracts";

/**
 * 機台顯示名稱對照。名冊本身（5 台示範機台）的跨端單一來源是 `@flow-gatekeeper/contracts` 的
 * `MACHINE_IDS`／`MachineId`（api 以同一份檢查訂閱與 `POST /diagnoses`；web 的訂閱清單、topology
 * placeholder 與搜尋直接匯入契約，不再另設別名）。
 */
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
