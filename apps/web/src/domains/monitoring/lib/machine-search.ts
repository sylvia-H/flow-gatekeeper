import { machineLabel } from "./machine-labels.js";

/**
 * US4 search 純函式（research R8、FR-015）。query 去頭尾空白、小寫後，對每台**同時比對**
 * `machineId` 與 `machineLabel(id)`（顯示名稱），任一 `includes` 命中即保留；空 query 回全部。
 * 唯一呼叫端是 store 的 `visibleMachineIds`：stage 拓樸（`StageTopology`）與搜尋框 Enter（`TopBar`）讀同一結果，
 * 確保兩處過濾一致。
 *
 * 比對 id 時容忍 1.1.0 的英文顯示名寫法（合併門第 1 輪 low）：查詢的空白正規化成 `-`（`Press 02` → `press-02`），
 * 並同時以去掉 `-` 與空白的形式比對去掉 `-` 的 id（`press02`）。
 * 顯示名稱以原查詢比對（`壓製機 02` 含空白），也以去掉 `-` 與空白的形式比對去掉空白的顯示名
 * （合併門第 2 輪 low：少打或多打空白的 `壓製機02`、`壓製機  02` 也命中）。
 */
export function filterMachineIds(roster: readonly string[], query: string): string[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [...roster];
  const idQuery = q.replace(/\s+/g, "-");
  const compactQuery = q.replace(/[\s-]+/g, "");
  const compact = (s: string): string => s.replace(/[\s-]+/g, "");
  return roster.filter((id) => {
    const lowerId = id.toLowerCase();
    const label = machineLabel(id).toLowerCase();
    return (
      lowerId.includes(idQuery) ||
      label.includes(q) ||
      (compactQuery !== "" && (compact(lowerId).includes(compactQuery) || compact(label).includes(compactQuery)))
    );
  });
}
