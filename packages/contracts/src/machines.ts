/**
 * 5 台示範機台名冊的**跨端單一來源**：api 以此產生 mock telemetry、過濾 client 訂閱、
 * 檢查 `POST /diagnoses` 的 machineId（不在名冊回 404）；web 以此渲染 topology、Fleet
 * Health 與搜尋。兩端各寫一份時，新增或改名機台只改到一邊就會出現「web 看得到、api 回 404」
 * 或「api 有產資料、web 不渲染」的漂移。
 */
export const MACHINE_IDS = ["mixer-01", "press-02", "pack-03", "oven-04", "sorter-05"] as const;

export type MachineId = (typeof MACHINE_IDS)[number];

/** 該字串是否為名冊內的機台（type guard）。 */
export function isKnownMachineId(machineId: string): machineId is MachineId {
  return (MACHINE_IDS as readonly string[]).includes(machineId);
}
