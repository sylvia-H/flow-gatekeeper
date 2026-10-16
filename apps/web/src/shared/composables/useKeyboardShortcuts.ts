import {
  getCurrentInstance,
  getCurrentScope,
  nextTick,
  onMounted,
  onScopeDispose,
  onUnmounted,
  toValue,
  type MaybeRefOrGetter,
} from "vue";
import { nextIndex, type FocusDirection, type GridRect } from "../lib/focus-grid.js";
import {
  ESCAPE_LAYERS,
  isImeComposing,
  isTypingTarget,
  SHORTCUTS,
  type EscapeLayerId,
  type ShortcutId,
} from "../lib/shortcuts.js";

/**
 * App 層鍵盤快捷鍵（T054；spec FR-034a～FR-034d、data-model §11、research R9）。
 *
 * - 只收注入的 callbacks：本檔位於 `shared/`，不得匯入 domains 層或任何 store
 *   （`shared/layering.test.ts` 把關）；需要 store 的行為由 `App.vue` 接線時注入。
 * - 純事件處理，不寫任何 reactive 狀態。
 * - 按鍵比對以 `SHORTCUTS[].eventKeys` 為準，與說明層共用同一份清單。
 *
 * 守門順序：
 * 1. `defaultPrevented`（已被上層元件處理，例如說明層或手機 sheet 自己的 Escape）→ 不處理。
 * 2. IME 組字中 → 不處理（含搜尋框內的 Enter：組字中的 Enter 是確認選字）。
 * 3. 搜尋框內的 Enter 且結果恰一台 → 選取並把焦點移到該台卡片（唯一放行的輸入情境按鍵）。
 * 4. 其餘輸入情境（`isTypingTarget`）→ 一律不處理，Escape 也不處理（覆蓋式搜尋自己收回）。
 * 5. 帶 Ctrl／Meta／Alt 的組合鍵 → 不處理（不搶瀏覽器與系統快捷鍵，例如 Ctrl+D）。
 */

export interface EscapeLayer {
  isOpen(): boolean;
  close(): void;
}

export interface KeyboardShortcutHandlers {
  /** `/`：聚焦搜尋。 */
  focusSearch(): void;
  /** Enter：選取機台（搜尋唯一結果，或非原生按鈕的聚焦卡片）。 */
  selectMachine(machineId: string): void;
  /** 取消選取（Escape 最後一層的語意；`layers.selection.close` 應等同此函式）。 */
  clearSelection(): void;
  /** `d`：診斷選取機台；由 `useDiagnoseTrigger` 提供，內含「可診斷」前置條件與去重。 */
  diagnose(): void;
  /** `x`：清除（確認）該台的異常標記。 */
  clearLatch(machineId: string): void;
  /** `?`：開關快捷鍵說明層。 */
  toggleHelp(): void;
  /** `d` 守門：無選取時不呼叫 `diagnose`。 */
  getSelectedId(): string | null;
  /** 搜尋框 Enter：恰一台才選取。 */
  getSearchResultIds(): readonly string[];
  /** `x` 守門：該台標記可見才清除。 */
  isLatchVisible(machineId: string): boolean;
  /**
   * Escape 各層，依 `ESCAPE_LAYERS` 順序關第一個開著的層。
   * `copilot-panel.close` 是「只關當次」的 dismiss（不寫手動收合偏好）；`selection.close` 即取消選取。
   */
  layers: Record<EscapeLayerId, EscapeLayer>;
}

export interface UseKeyboardShortcutsOptions {
  handlers: KeyboardShortcutHandlers;
  /** 搜尋框元素（判斷「搜尋框內的 Enter」）；可為 ref、getter 或元素本身。 */
  searchInput: MaybeRefOrGetter<HTMLInputElement | null | undefined>;
  /** 卡片清單；預設 `document.querySelectorAll('.machine-card')`，測試可注入。 */
  getCards?: () => HTMLElement[];
  /** 監聽 `keydown` 的對象；預設 `window`。 */
  target?: () => Window | Document;
}

const CARD_SELECTOR = ".machine-card";

function eventKeysOf(id: ShortcutId): readonly string[] {
  return SHORTCUTS.find((s) => s.id === id)?.eventKeys ?? [];
}

const KEYS = {
  focusSearch: eventKeysOf("focus-search"),
  toggleHelp: eventKeysOf("toggle-help"),
  escape: eventKeysOf("escape"),
  searchSelect: eventKeysOf("search-select"),
  cardSelect: eventKeysOf("card-select"),
  diagnose: eventKeysOf("diagnose"),
  clearLatch: eventKeysOf("clear-latch"),
} as const;

const ARROW_DIRECTIONS: Readonly<Record<string, FocusDirection>> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
};

/** 方向鍵的 `eventKeys` 以清單為準，方向對應見 `ARROW_DIRECTIONS`。 */
const CARD_MOVE_KEYS = eventKeysOf("card-move");

function defaultCards(): HTMLElement[] {
  if (typeof document === "undefined") return [];
  return Array.from(document.querySelectorAll<HTMLElement>(CARD_SELECTOR));
}

function hasSize(rect: GridRect): boolean {
  return rect.right - rect.left > 0 || rect.bottom - rect.top > 0;
}

/**
 * 不依賴元件生命週期的掛載：立即在 `target` 上註冊 `keydown`，回傳拆除函式。
 * `useKeyboardShortcuts` 在元件內以 `onMounted`／`onUnmounted` 包裝它。
 */
export function attachKeyboardShortcuts(options: UseKeyboardShortcutsOptions): () => void {
  const { handlers } = options;
  const getCards = options.getCards ?? defaultCards;
  const eventTarget: Window | Document = options.target ? options.target() : window;

  /** 焦點所在的卡片（焦點在卡片本身或其內部元素）；不在卡片上時為 null。 */
  function focusedCard(cards: readonly HTMLElement[]): HTMLElement | null {
    const active = typeof document !== "undefined" ? document.activeElement : null;
    if (!active) return null;
    return cards.find((card) => card === active || card.contains(active)) ?? null;
  }

  function focusCard(machineId: string): void {
    const card = getCards().find((c) => c.dataset.machine === machineId);
    card?.focus();
  }

  /** 搜尋框 Enter：選取唯一結果，DOM 更新後把焦點移到該台卡片，後續 `d` 才不被輸入欄守門擋下。 */
  function selectFromSearch(event: KeyboardEvent): void {
    const ids = handlers.getSearchResultIds();
    if (ids.length !== 1) return;
    const id = ids[0];
    if (id === undefined) return;
    event.preventDefault();
    handlers.selectMachine(id);
    // selectMachine 可能收回手機覆蓋式搜尋或重繪卡片；等 Vue 套用後再移焦。
    void nextTick(() => focusCard(id));
  }

  function moveFocus(event: KeyboardEvent, direction: FocusDirection): void {
    const cards = getCards();
    const current = focusedCard(cards);
    if (!current) return;
    // 隱藏（無尺寸）的卡片不參與移焦，避免焦點跳到看不見的位置；目前卡片一律保留。
    const visible = cards.filter((card) => card === current || hasSize(card.getBoundingClientRect()));
    const from = visible.indexOf(current);
    const rects = visible.map((card) => card.getBoundingClientRect());
    const to = nextIndex(rects, from, direction);
    // 焦點已在卡片上時，方向鍵一律吃掉，避免邊界停留時捲動頁面。
    event.preventDefault();
    if (to !== from) visible[to]?.focus();
  }

  function closeTopLayer(event: KeyboardEvent): void {
    for (const { id } of ESCAPE_LAYERS) {
      const layer = handlers.layers[id];
      if (layer.isOpen()) {
        event.preventDefault();
        layer.close();
        return;
      }
    }
  }

  function onKeydown(raw: Event): void {
    if (!(raw instanceof KeyboardEvent)) return;
    const event = raw;
    if (event.defaultPrevented || isImeComposing(event)) return;

    const key = event.key;
    // 說明層（aria-modal）開著時只處理 `?` 與 Escape：`/` 會把焦點移出對話框、`d` 會在底下觸發診斷。
    if (handlers.layers.help.isOpen() && !KEYS.toggleHelp.includes(key) && !KEYS.escape.includes(key)) {
      return;
    }
    const searchInput = toValue(options.searchInput) ?? null;
    if (searchInput !== null && event.target === searchInput) {
      if (KEYS.searchSelect.includes(key) && !event.repeat) selectFromSearch(event);
      return;
    }
    if (isTypingTarget(event)) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;

    const direction = ARROW_DIRECTIONS[key];
    if (direction !== undefined && CARD_MOVE_KEYS.includes(key)) {
      if (!event.shiftKey) moveFocus(event, direction);
      return;
    }

    // 以下為一次性動作：長按的重複事件不再觸發（Escape 每按一次只關一層、`d` 不連發）。
    if (event.repeat) return;

    if (KEYS.escape.includes(key)) {
      closeTopLayer(event);
      return;
    }
    if (KEYS.focusSearch.includes(key)) {
      event.preventDefault();
      handlers.focusSearch();
      return;
    }
    if (KEYS.toggleHelp.includes(key)) {
      event.preventDefault();
      handlers.toggleHelp();
      return;
    }
    if (KEYS.diagnose.includes(key)) {
      // 一律作用於選取機台；僅聚焦、未選取的卡片不觸發。
      if (handlers.getSelectedId() === null) return;
      event.preventDefault();
      handlers.diagnose();
      return;
    }
    if (KEYS.clearLatch.includes(key)) {
      const id = focusedCard(getCards())?.dataset.machine;
      if (id === undefined || !handlers.isLatchVisible(id)) return;
      event.preventDefault();
      handlers.clearLatch(id);
      return;
    }
    if (KEYS.cardSelect.includes(key)) {
      // 原生 <button> 的 Enter 會觸發 click → 選取，這裡不重複處理也不攔截；
      // 只有卡片不是原生按鈕（例如改成 tabindex=0 的容器）時才代為選取。
      const active = typeof document !== "undefined" ? document.activeElement : null;
      const card = getCards().find((c) => c === active);
      if (!card || card instanceof HTMLButtonElement) return;
      const id = card.dataset.machine;
      if (id === undefined) return;
      event.preventDefault();
      handlers.selectMachine(id);
    }
  }

  eventTarget.addEventListener("keydown", onKeydown);
  return () => eventTarget.removeEventListener("keydown", onKeydown);
}

/**
 * 元件內呼叫：`onMounted` 掛、`onUnmounted` 拆；在 effectScope 內（非元件）呼叫時立即掛、
 * scope 結束時拆。也回傳 `dispose` 供提前拆除與測試使用（重複呼叫無副作用；在 mount 前呼叫
 * 也會擋住之後的掛載）。
 */
export function useKeyboardShortcuts(options: UseKeyboardShortcutsOptions): { dispose(): void } {
  let detach: (() => void) | null = null;
  let disposed = false;

  function attach(): void {
    if (disposed || detach !== null) return;
    detach = attachKeyboardShortcuts(options);
  }

  function dispose(): void {
    disposed = true;
    detach?.();
    detach = null;
  }

  if (getCurrentInstance()) {
    onMounted(attach);
    onUnmounted(dispose);
  } else {
    attach();
    if (getCurrentScope()) onScopeDispose(dispose);
  }

  return { dispose };
}
