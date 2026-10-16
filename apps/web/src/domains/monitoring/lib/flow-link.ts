import type { MachineLive } from "../stores/monitoring.store.js";
import { isStale } from "./stale.js";

/**
 * stage 之間的流動連線（data-model §4、FR-003）。
 * 連線粗細與流動速度反映**下游 stage** 的產出量（各機台最新 throughput 總和，單位 u/min）。
 * 純函式：由 `machines` 的 computed 衍生，每幀至多一次；`speed` 為離散等級，避免連續值重啟 CSS 動畫。
 *
 * 門檻依 mock 實況設定（`apps/api` 的 mock：每台約 120 u/min，warning 約 −18、critical 約 −45，雜訊 ±6）：
 * 下游 stage 皆為 2 台：兩台健康時總和約 228–252；一台 warning 時約 210–234（例如成型烘烤欄的 oven-04
 * 警告期間）；一台 critical 約 183–207；一台 stale 約 114–126；全 stale 為 0。
 * 門檻**無法**完全避開常見值：225 正好落在「健康」與「一台警告」的重疊區，該區間的雜訊仍可能讓等級在
 * 6.5／8px、mid／fast 之間切換。抑制抖動靠的是「等級化」（只有跨檔才改 class、不重啟連續值動畫），
 * 不是門檻避讓。
 */
export type FlowSpeed = "none" | "slow" | "mid" | "fast";

/** throughputSum 只需要的欄位（避免 lib 依賴 store 執行期；此處僅 `import type`）。 */
export type FlowMachine = Pick<MachineLive, "telemetry" | "lastUpdated">;

/**
 * 下游 stage 機台最新 throughput 總和。
 * `stageMachines` MUST 傳該 stage 的**完整分組**成員（`MACHINE_GROUPS[i].machineIds`），不是搜尋過濾後的
 * `Stage.machineIds`：搜尋只影響卡片顯示，即使清空某欄，連線粗細與速度仍反映實際產出（research R5）。
 * stale（`isStale(lastUpdated, now)`，門檻 10 s）或尚無資料的機台計 0；
 * 非有限值或負值亦計 0（防禦，契約 guard 已擋非有限值）。`now` 傳 store 的凍結時鐘 `staleNow`。
 */
export function throughputSum(
  stageMachines: readonly string[],
  machines: ReadonlyMap<string, FlowMachine>,
  now: number,
): number {
  let sum = 0;
  for (const id of stageMachines) {
    const machine = machines.get(id);
    if (machine === undefined || isStale(machine.lastUpdated, now)) continue;
    const value = machine.telemetry.throughput;
    if (Number.isFinite(value) && value > 0) sum += value;
  }
  return sum;
}

/**
 * 五段粗細（px，等距 1.5）：sum ≤ 0 → 2；(0, 90) → 3.5；[90, 170) → 5；[170, 225) → 6.5；≥ 225 → 8。
 */
export function widthFor(sum: number): number {
  if (!(sum > 0)) return 2;
  if (sum < 90) return 3.5;
  if (sum < 170) return 5;
  if (sum < 225) return 6.5;
  return 8;
}

/**
 * 速度三檔：sum ≤ 0 → none；(0, 150) → slow；[150, 225) → mid；≥ 225 → fast。
 * reduced-motion 或手機垂直排列（< 768px）時恆為 `"none"`（不流動），粗細照常由 `widthFor` 決定。
 */
export function speedFor(sum: number, reducedMotion: boolean, vertical: boolean): FlowSpeed {
  if (reducedMotion || vertical || !(sum > 0)) return "none";
  if (sum < 150) return "slow";
  if (sum < 225) return "mid";
  return "fast";
}
