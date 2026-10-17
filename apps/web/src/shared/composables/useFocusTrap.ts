import { nextTick, onBeforeUnmount, watch, type Ref } from "vue";

/**
 * 覆蓋層的焦點陷阱（T075：原本 `ShortcutHelp.vue` 與 `AnomalyOverlay.vue` 各有一份相同實作）。
 *
 * - 啟用（`active()` 轉為 true，含掛載當下即為 true）：記下目前焦點，DOM 更新後把焦點移進容器（容器需 `tabindex="-1"`）。
 * - `onKeydown`：只處理 Tab／Shift+Tab——在容器內循環；焦點在容器本身（或不在清單內）時拉回邊界；
 *   沒有可聚焦元素時留在容器。Escape 等其他鍵由呼叫端處理。
 * - 停用（轉為 false，或啟用中卸載）：還焦點。只在焦點仍在容器內、或已掉到 body／null 時才還；
 *   使用者若已點了容器外的元素（例如工具列），不搶走他的焦點。
 * - 還原後備（`fallback`）：先前焦點已不在 DOM、或啟用當下焦點就在 body（iOS Safari 點按鈕不給焦點，
 *   activeElement 停在 body）時，改聚焦 `fallback()` 回傳的元素（同樣須仍在 DOM）；未提供時維持原狀不動。
 *
 * 行動版 bottom sheet 的焦點邏輯（`domains/ai-copilot/composables/useModalSheet`）另有非 modal／`engage` 語意，
 * 只共用這裡的 `FOCUSABLE_SELECTOR` 與 `nextTrapTarget`。
 */

/** 可 Tab 到的元素。 */
export const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/**
 * 計算 Tab／Shift+Tab 在容器內循環時下一個要聚焦的元素；回傳 null 表示交給瀏覽器預設行為。
 */
export function nextTrapTarget<T>(items: readonly T[], active: T | null, backwards: boolean): T | null {
  if (items.length === 0) return null;
  const first = items[0] as T;
  const last = items[items.length - 1] as T;
  const idx = active === null ? -1 : items.indexOf(active);
  if (idx === -1) return backwards ? last : first; // 焦點不在清單內（例如容器本身）→ 拉回邊界
  if (backwards && idx === 0) return last;
  if (!backwards && idx === items.length - 1) return first;
  return null;
}

/** 容器內目前可聚焦的元素：排除 `hidden`、`aria-hidden="true"` 與不可見（`checkVisibility`，環境支援時）者。 */
export function focusablesIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) =>
      !el.hidden &&
      el.getAttribute("aria-hidden") !== "true" &&
      (typeof el.checkVisibility === "function" ? el.checkVisibility() : true),
  );
}

export interface FocusTrapOptions {
  /** 還原後備：先前焦點不可用（不在 DOM，或啟用時焦點在 body）時改聚焦它；回 null 則不動。 */
  fallback?: () => HTMLElement | null;
}

function connected(el: HTMLElement | null | undefined): HTMLElement | null {
  return el && el.isConnected ? el : null;
}

/** MUST 在元件 setup 內呼叫（依賴 watch 與 onBeforeUnmount）。 */
export function useFocusTrap(
  container: Readonly<Ref<HTMLElement | null>>,
  active: () => boolean,
  options: FocusTrapOptions = {},
): { onKeydown: (event: KeyboardEvent) => void } {
  let restoreTo: HTMLElement | null = null;

  function restoreFocus(): void {
    const saved = restoreTo;
    restoreTo = null;
    const target = connected(saved) ?? connected(options.fallback?.());
    if (!target) return;
    const focused = document.activeElement;
    const root = container.value;
    const focusInside = root !== null && focused !== null && root.contains(focused);
    if (focused === null || focused === document.body || focusInside) target.focus();
  }

  watch(
    active,
    (on) => {
      if (on) {
        const focused = typeof document !== "undefined" ? document.activeElement : null;
        restoreTo = focused instanceof HTMLElement && focused !== document.body ? focused : null;
        void nextTick(() => container.value?.focus());
      } else {
        restoreFocus();
      }
    },
    { immediate: true },
  );

  onBeforeUnmount(() => {
    if (active()) restoreFocus();
  });

  function onKeydown(event: KeyboardEvent): void {
    if (event.key !== "Tab") return;
    const root = container.value;
    if (!root) return;
    const items = focusablesIn(root);
    if (items.length === 0) {
      event.preventDefault();
      root.focus();
      return;
    }
    const target = nextTrapTarget(items, document.activeElement as HTMLElement | null, event.shiftKey);
    if (target) {
      event.preventDefault();
      target.focus();
    }
  }

  return { onKeydown };
}
