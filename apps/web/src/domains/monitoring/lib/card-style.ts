import type { MachineState } from "@flow-gatekeeper/contracts";

/**
 * `MachineNodeCard` 狀態 → 卡片外觀語意 token（013 ui-contract §1）。
 *
 * - healthy／placeholder（冷啟動／首批未到）：磨砂玻璃 `bg-surface/72` + `border-edge`；
 *   hover 時玻璃轉為不透明、邊框換蝕刻色。
 * - warning：玻璃 + 1px `border-warn` 全邊框（013 FR-030；只換 border 顏色、不改寬度，
 *   盒模型不變、不位移）。hover 保留警告邊框，只把玻璃轉為不透明——狀態不因 hover 消失。
 * - critical：`border-crit` + 半透明 crit-bg（80%，疊在玻璃位置上仍透出桌面格線）+
 *   `animate-critical-pulse`（動畫只動 background-color 與 border-color：半週期把 80% 的 crit-bg 斟滿成
 *   不透明、邊框 crit → crit-fg；不動尺寸、不用光暈）。hover 時 crit-bg 轉為不透明，只剩邊框換色；
 *   選取時由選取規則停用脈動。
 *
 * hover 不用位移（translate）：FR-031 要求 hover 不造成版面跳動。
 *
 * **選取態不在這裡**：選取以 `.machine-card[data-selected="true"]` 規則呈現（見 `styles/tailwind.css`），
 * 放在所有 utilities 之後、特異性 (0,2,0)，才能同時勝過這裡的狀態 class 與 `hover:*`；
 * 選取框用 outline（不是 ring／box-shadow）。
 * 若把選取改回一般 utility class，會重現「選取與未選取看起來一樣」的缺陷
 * （回歸測試：`MachineNodeCard.css.test.ts`）。
 */
export const CARD_PLACEHOLDER_CLASS = "border-edge bg-surface/72 hover:border-etch hover:bg-surface-strong";

export const CARD_STATE_CLASS: Record<MachineState, string> = {
  healthy: "border-edge bg-surface/72 hover:border-etch hover:bg-surface-strong",
  warning: "border-warn bg-surface/72 hover:bg-surface-strong",
  critical: "border-crit bg-crit-bg/80 hover:bg-crit-bg animate-critical-pulse",
};

/**
 * stale（停滯，>10s 未更新）：邊框改虛線，與狀態 class 疊加——邊框與底色仍是最後已知狀態的色。
 * 「停滯」文字徽章（含 `bg-stale` 色點）由元件渲染，與 FleetHealth 的停滯計數同用 `stale` token（FR-004）。
 * - 不用降透明：整卡 opacity 會把卡內文字一起淡化，ink-3 小字對比跌破 4.5:1（FR-005）。
 * - 不另加 `border-stale`：它與狀態邊框色同為 (0,1,0)，勝負取決於 Tailwind 產出 CSS 的順序
 *   （實測不是色票定義順序，warning 會蓋掉 stale），這種靠輸出順序的疊加不可靠。
 *   只換 `border-style` 不與任何顏色 class 競爭。
 */
export const CARD_STALE_CLASS = "border-dashed";

/** 卡片根元素的固定 class（選取規則以它為錨點）。 */
export const CARD_ROOT_CLASS = "machine-card";

export function cardStateClass(state: MachineState | null): string {
  return state ? CARD_STATE_CLASS[state] : CARD_PLACEHOLDER_CLASS;
}
