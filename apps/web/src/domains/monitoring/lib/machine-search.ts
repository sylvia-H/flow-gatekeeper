import { machineLabel } from "./machine-labels.js";

/**
 * US4 search 純函式（research R8、FR-015）。query 去頭尾空白、小寫後，對每台**同時比對**
 * `machineId` 與 `machineLabel(id)`（顯示名稱），任一 `includes` 命中即保留；空 query 回全部。
 * sidebar 清單與主區卡片讀同一結果，確保兩處過濾一致。
 *
 * 比對 id 時容忍 1.1.0 的英文顯示名寫法（合併門第 1 輪 low）：查詢的空白正規化成 `-`（`Press 02` → `press-02`），
 * 並同時以去掉 `-` 與空白的形式比對去掉 `-` 的 id（`press02`）。顯示名稱仍以原查詢比對（`壓製機 02` 含空白）。
 */
export function filterMachineIds(roster: readonly string[], query: string): string[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [...roster];
  const idQuery = q.replace(/\s+/g, "-");
  const compactQuery = q.replace(/[\s-]+/g, "");
  return roster.filter((id) => {
    const lowerId = id.toLowerCase();
    return (
      lowerId.includes(idQuery) ||
      (compactQuery !== "" && lowerId.replace(/-/g, "").includes(compactQuery)) ||
      machineLabel(id).toLowerCase().includes(q)
    );
  });
}
