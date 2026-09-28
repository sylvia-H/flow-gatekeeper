import type { MachineState } from "@flow-gatekeeper/contracts";

/**
 * `MachineNodeCard` 狀態 → 卡片外觀 token（design-spec §7.3）。
 *
 * - warning：`bg-surface` + `warn-bg` subtle inset（`ring-1 ring-inset ring-warn-bg` 內嵌環；
 *   非盒模型、不位移，FR-002/005）。
 * - critical：crit-bg tint + `animate-critical-pulse`（動畫只動 box-shadow）。
 * - placeholder（冷啟動／首批未到）：中性面。
 *
 * **選取態不在這裡**：選取以 `.machine-card[data-selected="true"]` 規則呈現（見 `styles/tailwind.css`），
 * 放在所有 utilities 之後、特異性 (0,2,0)，才能同時勝過這裡的狀態 class 與 `hover:*`；
 * 選取框用 outline（不是 ring／box-shadow），critical 的 pulse 動畫就不會把它蓋掉。
 * 若把選取改回一般 utility class，會重現「選取與未選取看起來一樣」的缺陷
 * （回歸測試：`MachineNodeCard.css.test.ts`）。
 */
export const CARD_PLACEHOLDER_CLASS = "border-subtle bg-surface";

export const CARD_STATE_CLASS: Record<MachineState, string> = {
  healthy: "border-subtle bg-surface",
  warning: "border-subtle bg-surface ring-1 ring-inset ring-warn-bg",
  critical: "border-crit-border bg-crit-bg animate-critical-pulse",
};

/** stale：降透明（design-spec §7.3），與狀態 class 疊加。 */
export const CARD_STALE_CLASS = "opacity-[0.55]";

/** 卡片根元素的固定 class（選取規則以它為錨點）。 */
export const CARD_ROOT_CLASS = "machine-card";

export function cardStateClass(state: MachineState | null): string {
  return state ? CARD_STATE_CLASS[state] : CARD_PLACEHOLDER_CLASS;
}
