import { nextTick, onMounted, onUnmounted, ref, type Ref } from "vue";
import {
  BELOW_DESK_QUERY,
  hasMatchMedia,
  onMediaChange,
  type MediaQueryListLike,
} from "../../../shared/composables/useMediaQuery.js";
import { FOCUSABLE_SELECTOR, nextTrapTarget } from "../../../shared/composables/useFocusTrap.js";

export { nextTrapTarget };

/**
 * 與 Tailwind 自訂 `desk` 斷點（1366px，AppLayout 的推擠式側欄門檻）對齊：低於它時 drawer 是覆蓋畫面的 bottom sheet
 * （768–1023px 的推擠式面板會把卡片欄擠到無法閱讀；1024–1365px 會把拓樸擠成單欄，013 critique 第一輪 P1、T073 使用者裁決）。
 */
export const MOBILE_QUERY = BELOW_DESK_QUERY;

/** 焦點陷阱只需要的元素能力；以最小介面描述，測試不必有真 DOM。 */
export interface FocusableLike {
  focus(): void;
  getClientRects(): { length: number };
  isConnected?: boolean;
}
export interface SheetRootLike extends FocusableLike {
  querySelectorAll(selector: string): ArrayLike<FocusableLike>;
  /** 判斷焦點是否仍在 sheet 內（`disengage` 用）；未提供時視為不在內。 */
  contains?(other: unknown): boolean;
}

/** 取容器內可 Tab 到、且目前有渲染（非 display:none）的元素。 */
export function focusableWithin(root: SheetRootLike): FocusableLike[] {
  return Array.from(root.querySelectorAll(FOCUSABLE_SELECTOR)).filter((el) => el.getClientRects().length > 0);
}

type IOCtor = new (cb: (entries: { isIntersecting: boolean }[]) => void) => {
  observe(target: never): void;
  disconnect(): void;
};

export interface ModalSheetEnv {
  matchMedia?: (query: string) => MediaQueryListLike;
  IntersectionObserver?: IOCtor;
  /** 目前焦點；焦點落在 body（例如開啟鈕隨 sheet 展開而被移除）時回 null，視同「焦點遺失」。 */
  activeElement: () => unknown;
  /** 延後到 DOM 更新後再聚焦（元件內為 Vue nextTick）。 */
  defer: (fn: () => void) => void;
}

export interface ModalSheetOptions {
  /**
   * sheet 出現時要不要把焦點搶進來（未提供＝一律搶）。回 false 時焦點留在原處（例如剛按 Enter 選台的卡片，
   * 方向鍵可繼續導航），sheet 以非 modal 對話框呈現；之後 `engage()`、或焦點自己進入 sheet（focusin）才進焦點陷阱。
   * 焦點遺失（activeElement 為 null）也只依這個選項：觸控 Safari 點按鈕不給焦點，不能把 body 當成「要搶」的訊號。
   */
  autoFocus?: () => boolean;
}

export interface KeyEventLike {
  key: string;
  shiftKey: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}

function asFocusable(el: unknown): FocusableLike | null {
  return el !== null && typeof el === "object" && typeof (el as FocusableLike).focus === "function"
    ? (el as FocusableLike)
    : null;
}

/**
 * 不依賴元件生命週期的核心：由 `useModalSheet` 在 mounted／unmounted 呼叫 attach／detach，
 * 測試則直接注入 stub 的 matchMedia／IntersectionObserver 驅動。
 */
export function createModalSheet(
  getRoot: () => SheetRootLike | null,
  onClose: () => void,
  env: ModalSheetEnv,
  options: ModalSheetOptions = {},
) {
  /** 目前是否為 bottom sheet 形態（決定要不要掛 role="dialog" 等屬性）。 */
  const isSheet = ref(false);
  /** sheet 形態且正顯示中（不論焦點在不在裡面）。 */
  const open = ref(false);
  /** sheet 顯示中且已接手焦點：焦點陷阱、Escape 攔截與 aria-modal="true" 只在這時生效。 */
  const trapActive = ref(false);

  let visible = false;
  let restoreTo: FocusableLike | null = null;
  let stopMedia: (() => void) | null = null;
  /** 程式搬移焦點期間（`disengage`）暫停 focusin 接手，否則把焦點放進 sheet 會立刻又進焦點陷阱。 */
  let quiet = false;
  let observer: InstanceType<IOCtor> | null = null;

  /**
   * 進焦點陷阱。`moveFocus`：由程式把焦點搬進 sheet，記下原焦點供關閉時歸還；
   * 否則焦點已自己進來（focusin），`from` 是它離開的元素。
   */
  function enter(moveFocus: boolean, from: FocusableLike | null): void {
    if (!open.value || trapActive.value) return;
    trapActive.value = true;
    if (moveFocus) {
      restoreTo = asFocusable(env.activeElement());
      env.defer(() => getRoot()?.focus());
    } else {
      restoreTo = from;
    }
  }

  function sync(): void {
    const next = isSheet.value && visible;
    if (next === open.value) return;
    open.value = next;
    if (next) {
      // 只看 autoFocus，不因「焦點遺失」強制接手：觸控 Safari（iPad／iPhone）點按鈕不給焦點，點卡片後
      // activeElement 是 body，若據此接手，1024–1365 平板選台的閒置 sheet 會一律轉 modal、遮罩擋住改選
      // （第三輪交叉審查 medium）。有可操作內容或空狀態時 autoFocus 本來就為真，焦點遺失的情況照樣接手。
      if (options.autoFocus?.() ?? true) enter(true, null);
      return;
    }
    // 關閉：只有曾接手焦點時才歸還；焦點一直留在外面（例如卡片）就不動它。
    const wasTrapped = trapActive.value;
    trapActive.value = false;
    if (wasTrapped && restoreTo && restoreTo.isConnected !== false) restoreTo.focus();
    restoreTo = null;
  }

  function onBreakpoint(e: { matches: boolean }): void {
    isSheet.value = e.matches;
    sync();
  }

  function attach(): void {
    const mql = env.matchMedia?.(MOBILE_QUERY) ?? null;
    isSheet.value = mql?.matches ?? false;
    stopMedia = mql ? onMediaChange(mql, onBreakpoint) : null;
    const root = getRoot();
    if (root && env.IntersectionObserver) {
      observer = new env.IntersectionObserver((entries) => {
        visible = entries[entries.length - 1]?.isIntersecting ?? false;
        sync();
      });
      observer.observe(root as never);
    }
  }

  function detach(): void {
    stopMedia?.();
    stopMedia = null;
    observer?.disconnect();
  }

  /**
   * sheet 已開、焦點仍在外面時改由程式接手（例如開始診斷後有可操作內容）；未開時無作用。
   *
   * 已接手時改為「焦點遺失才拉回」：滑鼠點閒置單列的「診斷」會先經 focusin 接手，接著該鈕隨單列切成完整標頭而被移除，
   * 焦點掉到 body——掛在根節點的 keydown 收不到 Tab，焦點會逃出 sheet（合併門第 2 輪實測追加）。DOM 更新後焦點若不在
   * sheet 內（body 或已移除的節點），就移到根節點（tabindex=-1，不進 Tab 順序、無焦點環）；焦點仍在 sheet 內則不動。
   */
  function engage(): void {
    if (!trapActive.value) {
      enter(true, null);
      return;
    }
    env.defer(() => {
      if (!trapActive.value) return;
      const root = getRoot();
      if (!root) return;
      const active = env.activeElement();
      if (active !== null && root.contains?.(active) === true) return;
      quiet = true;
      try {
        root.focus();
      } finally {
        quiet = false;
      }
    });
  }

  /**
   * 退出焦點陷阱、回到非 modal（合併門第 2 輪 #1）：modal sheet 回到「已選台、閒置」時呼叫——按「中止診斷」、
   * 或搜尋 Enter 改選一台閒置機台。不呼叫的話 sheet 縮成閒置單列卻仍 `aria-modal="true"`、遮罩還在、點其他卡只會收合，
   * 中止鈕隨單列消失後焦點掉到 body、Tab 逃出陷阱。
   *
   * 不歸還焦點到接手前的元素（那多半是很久以前的卡片，跳回去會讓使用者迷路）：`focusTarget` 有給、且延後到 DOM 更新後
   * 焦點仍在 sheet 內或已遺失（中止鈕被移除）時，改聚焦它（閒置單列的「診斷」鈕）；焦點已在外面（例如搜尋 Enter
   * 後移到卡片）就不動。搬焦點期間暫停 focusin，避免一放進 sheet 又被當成「使用者自己進來」而再度接手。
   */
  function disengage(focusTarget?: () => FocusableLike | null): void {
    if (!trapActive.value) return;
    trapActive.value = false;
    restoreTo = null;
    if (!focusTarget) return;
    env.defer(() => {
      if (!open.value || trapActive.value) return;
      const active = env.activeElement();
      if (active !== null && getRoot()?.contains?.(active) !== true) return;
      const target = focusTarget();
      if (!target) return;
      quiet = true;
      try {
        target.focus();
      } finally {
        quiet = false;
      }
    });
  }

  /**
   * 掛在 sheet 外框的 focusin：使用者自己 Tab／點進 sheet 時進焦點陷阱，關閉時把焦點還給它離開的元素。
   * 焦點在 sheet 內部移動（`fromInside`，例如 `disengage` 後從「診斷」Tab 到收合鈕）不算「進來」，不接手。
   */
  function onFocusIn(event: { relatedTarget: unknown; fromInside?: boolean }): void {
    if (quiet || event.fromInside === true) return;
    enter(false, asFocusable(event.relatedTarget));
  }

  /** 掛在 drawer 根節點的 keydown。 */
  function onKeydown(event: KeyEventLike): void {
    const root = getRoot();
    if (!trapActive.value || !root) return;
    if (event.key === "Escape") {
      // 攔下冒泡：App 層的 useKeyboardShortcuts 在 window 上也監聽 Esc（依 ESCAPE_LAYERS 關一層），避免同一次按鍵關兩次。
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const items = focusableWithin(root);
    if (items.length === 0) {
      event.preventDefault();
      root.focus();
      return;
    }
    const target = nextTrapTarget(items, env.activeElement() as FocusableLike | null, event.shiftKey);
    if (target) {
      event.preventDefault();
      target.focus();
    }
  }

  return { isSheet, open, trapActive, attach, detach, engage, disengage, onFocusIn, onKeydown };
}

/**
 * 行動版 bottom sheet 的對話框行為：Tab 在 sheet 內循環、Esc 關閉，關閉後把焦點還給接手前的元素。
 *
 * 焦點接手分兩種（013 critique 第二輪 P1／鍵盤使用者）：`autoFocus()` 為真時 sheet 一出現就把焦點搬進來
 * （有可操作內容的進行中／完成／失敗態、未選機台的空狀態）；為假時（閒置態，使用者剛在卡片上按 Enter 選台）
 * 焦點留在卡片、方向鍵可繼續導航，sheet 以 `aria-modal="false"` 的非 modal 對話框呈現，Escape 交 App 層的面板層收合；
 * 直到 `engage()`（開始診斷）或焦點自己進入 `focusScope`（Tab 進來、點把手或面板）才進焦點陷阱。
 *
 * 為什麼靠 IntersectionObserver 偵測「開啟」：sheet 的外層 `<aside>` 與開關狀態由 AppLayout／
 * App 持有，drawer 元件拿不到 `drawerOpen`；外層以 `display:none` 切換顯示，而 display:none
 * 的元素不會 intersect，觀察 drawer 根節點即可得知 sheet 何時出現／消失，不必改外層介面。
 * 寬螢幕（desk+，≥ 1366px）是常駐側欄、不是對話框，這時完全不介入焦點。
 */
export function useModalSheet(
  root: Ref<HTMLElement | null>,
  onClose: () => void,
  options: ModalSheetOptions & {
    /** 監聽 focusin 的範圍（含抓取把手的外框）；未提供或找不到時用 root。 */
    focusScope?: (root: HTMLElement) => HTMLElement | null;
  } = {},
) {
  const sheet = createModalSheet(
    () => root.value,
    onClose,
    {
      matchMedia: hasMatchMedia() ? (q) => window.matchMedia(q) : undefined,
      IntersectionObserver:
        typeof IntersectionObserver !== "undefined" ? IntersectionObserver : undefined,
      activeElement: () => {
        if (typeof document === "undefined") return null;
        const active = document.activeElement;
        return active === document.body ? null : active;
      },
      defer: (fn) => void nextTick(fn),
    },
    options,
  );
  let scope: HTMLElement | null = null;
  const onFocusIn = (e: FocusEvent): void =>
    sheet.onFocusIn({
      relatedTarget: e.relatedTarget,
      fromInside: e.relatedTarget instanceof Node && scope?.contains(e.relatedTarget) === true,
    });
  onMounted(() => {
    sheet.attach();
    const el = root.value;
    scope = el ? (options.focusScope?.(el) ?? el) : null;
    scope?.addEventListener("focusin", onFocusIn);
  });
  onUnmounted(() => {
    sheet.detach();
    scope?.removeEventListener("focusin", onFocusIn);
  });
  return {
    isSheet: sheet.isSheet,
    open: sheet.open,
    trapActive: sheet.trapActive,
    engage: sheet.engage,
    disengage: sheet.disengage,
    onKeydown: sheet.onKeydown,
  };
}
