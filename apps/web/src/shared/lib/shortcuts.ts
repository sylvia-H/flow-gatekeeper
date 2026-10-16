/**
 * 鍵盤快捷鍵對照表（data-model §11、ui-contract §4、research R9）。
 *
 * `SHORTCUTS` 是唯一一份清單：說明層（`ShortcutHelp.vue`）直接渲染它，`useKeyboardShortcuts`
 * 以每項的 `eventKeys` 比對 `KeyboardEvent.key`，避免兩份清單漂移。`keys`／`action`／`scope`
 * 是說明層可見的繁體中文文案，用操作者看得懂的說法（術語依 research R13：UI 寫「AI 診斷」）。
 *
 * `isTypingTarget` 判斷這次按鍵是否發生在輸入情境（輸入欄或輸入法組字中）；是的話，字母與符號
 * 快捷鍵（`/`、`d`、`x`、`?`）一律不觸發（說明層以 `SHORTCUT_FOOTNOTE` 告知）。
 */

/** 說明層標題。 */
export const SHORTCUT_HELP_TITLE = "鍵盤快捷鍵";

/** 說明層註腳：字母與符號快捷鍵在輸入情境不觸發。 */
export const SHORTCUT_FOOTNOTE = "在輸入欄或輸入法組字中時，字母與符號快捷鍵不會觸發。";

/**
 * Escape 每次只關閉最上層的一項，依此順序由上而下判斷（data-model §11）。
 * 實作語意（不寫進 UI 文案）：`copilot-panel`（手機即 bottom-sheet）只設當次 `open = false`，
 * 不寫入手動收合偏好；`selection` 是取消目前的機台選取。
 */
export const ESCAPE_LAYERS = [
  { id: "help", label: "快捷鍵說明" },
  { id: "search-overlay", label: "搜尋" },
  { id: "anomaly-overlay", label: "異常清單（手機）" },
  { id: "copilot-panel", label: "AI 診斷面板" },
  { id: "selection", label: "選取" },
] as const;

export type EscapeLayerId = (typeof ESCAPE_LAYERS)[number]["id"];

export type ShortcutGroup = "全域" | "搜尋" | "機台卡片" | "版面";

export interface ShortcutEntry {
  /** 穩定識別，供說明層 `v-for` 的 key 與測試使用。 */
  readonly id: string;
  /** 顯示用按鍵（方向鍵以箭頭符號表示）；多個鍵代表同一列的不同按法。 */
  readonly keys: readonly string[];
  /** 比對用的 `KeyboardEvent.key` 值，與 `keys` 一一對應。 */
  readonly eventKeys: readonly string[];
  /** 動作說明。 */
  readonly action: string;
  /** 觸發條件。 */
  readonly scope: string;
  /** 說明層分組。 */
  readonly group: ShortcutGroup;
}

/** 前幾層是「關閉」，最後一層（選取）是「取消」。 */
const ESCAPE_ACTION = `依序關閉最上層：${ESCAPE_LAYERS.map((l) => (l.id === "selection" ? `取消${l.label}` : l.label)).join(" → ")}`;

const NOT_IN_INPUT = "焦點不在輸入欄";

export const SHORTCUTS = [
  {
    id: "focus-search",
    keys: ["/"],
    eventKeys: ["/"],
    action: "聚焦搜尋",
    scope: NOT_IN_INPUT,
    group: "全域",
  },
  {
    id: "toggle-help",
    keys: ["?"],
    eventKeys: ["?"],
    action: "開關鍵盤快捷鍵說明",
    scope: NOT_IN_INPUT,
    group: "全域",
  },
  {
    id: "escape",
    keys: ["Escape"],
    eventKeys: ["Escape"],
    action: ESCAPE_ACTION,
    scope: "每次只關一層",
    group: "全域",
  },
  {
    id: "search-select",
    keys: ["Enter"],
    eventKeys: ["Enter"],
    action: "選取唯一結果，並把焦點移到該台卡片（手機覆蓋式搜尋同時收回）",
    scope: "焦點在搜尋框、結果恰 1 台且不在輸入法組字中",
    group: "搜尋",
  },
  {
    id: "card-move",
    keys: ["↑", "↓", "←", "→"],
    eventKeys: ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"],
    action: "依畫面位置移到相鄰的機台卡片",
    scope: "焦點在機台卡片",
    group: "機台卡片",
  },
  {
    id: "card-select",
    keys: ["Enter"],
    eventKeys: ["Enter"],
    action: "選取聚焦的機台",
    scope: "焦點在機台卡片",
    group: "機台卡片",
  },
  {
    id: "diagnose",
    keys: ["d"],
    eventKeys: ["d"],
    action: "診斷選取的機台（不作用於僅聚焦、未選取的卡片）",
    scope: NOT_IN_INPUT,
    group: "機台卡片",
  },
  {
    id: "clear-latch",
    keys: ["x"],
    eventKeys: ["x"],
    action: "清除（確認）聚焦卡片的異常標記",
    scope: NOT_IN_INPUT,
    group: "機台卡片",
  },
  {
    id: "resize-sidebar",
    keys: ["→", "←"],
    eventKeys: ["ArrowRight", "ArrowLeft"],
    action: "側欄加寬／縮窄 16px（200–420px）",
    scope: "焦點在側欄把手",
    group: "版面",
  },
  {
    id: "resize-events",
    keys: ["↑", "↓"],
    eventKeys: ["ArrowUp", "ArrowDown"],
    action: "事件流增高／降低 16px（100–360px）",
    scope: "焦點在事件流把手",
    group: "版面",
  },
] as const satisfies readonly ShortcutEntry[];

export type ShortcutId = (typeof SHORTCUTS)[number]["id"];

/** IME 組字中，部分瀏覽器（Safari、舊版 Chrome）不設 `isComposing`，改以 keyCode 229 表示。 */
const IME_PROCESS_KEY_CODE = 229;

/** 按鍵是否發生在輸入法組字中。 */
export function isImeComposing(event: KeyboardEvent): boolean {
  // keyCode 已標為 deprecated，但它是辨識 IME 處理中按鍵的唯一跨瀏覽器訊號。
  return event.isComposing || event.keyCode === IME_PROCESS_KEY_CODE;
}

/**
 * 按鍵是否發生在輸入情境：輸入法組字中，或焦點在 input／textarea／select／可編輯內容裡。
 * `target` 為 null 或不是 Element（例如 window、document）時回 false。
 */
export function isTypingTarget(event: KeyboardEvent): boolean {
  if (isImeComposing(event)) return true;

  const target = event.target;
  if (typeof Element === "undefined" || !(target instanceof Element)) return false;

  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  ) {
    return true;
  }
  if (target instanceof HTMLElement && target.isContentEditable) return true;

  // 最近一個帶 contenteditable 屬性的祖先（含自己）決定可否編輯；明確寫 "false" 者不可編輯。
  const editableHost = target.closest("[contenteditable]");
  return editableHost !== null && editableHost.getAttribute("contenteditable")?.toLowerCase() !== "false";
}
