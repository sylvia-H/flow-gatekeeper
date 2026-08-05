import { machineLabel } from "./machine-labels.js";

/**
 * US4 search 純函式（research R8、FR-015）。query 去頭尾空白、小寫後，對每台**同時比對**
 * `machineId` 與 `machineLabel(id)`（顯示名稱），任一 `includes` 命中即保留；空 query 回全部。
 * sidebar 清單與主區卡片讀同一結果，確保兩處過濾一致。
 */
export function filterMachineIds(roster: readonly string[], query: string): string[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [...roster];
  return roster.filter(
    (id) => id.toLowerCase().includes(q) || machineLabel(id).toLowerCase().includes(q),
  );
}
