import { nextTick, onMounted, onUnmounted, ref, type Ref } from "vue";

/** 與 Tailwind `md` 斷點（768px）對齊：低於它時 drawer 是覆蓋畫面的 bottom sheet。 */
const MOBILE_QUERY = "(max-width: 767.98px)";

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/** 焦點陷阱只需要的元素能力；以最小介面描述，測試不必有真 DOM。 */
export interface FocusableLike {
  focus(): void;
  getClientRects(): { length: number };
  isConnected?: boolean;
}
export interface SheetRootLike extends FocusableLike {
  querySelectorAll(selector: string): ArrayLike<FocusableLike>;
}

/** 取容器內可 Tab 到、且目前有渲染（非 display:none）的元素。 */
export function focusableWithin(root: SheetRootLike): FocusableLike[] {
  return Array.from(root.querySelectorAll(FOCUSABLE)).filter((el) => el.getClientRects().length > 0);
}

/**
 * 計算 Tab／Shift+Tab 在容器內循環時下一個要聚焦的元素；回傳 null 表示交給瀏覽器預設行為。
 */
export function nextTrapTarget<T>(
  items: readonly T[],
  active: T | null,
  backwards: boolean,
): T | null {
  if (items.length === 0) return null;
  const first = items[0] as T;
  const last = items[items.length - 1] as T;
  const idx = active === null ? -1 : items.indexOf(active);
  if (idx === -1) return backwards ? last : first; // 焦點不在清單內（例如容器本身）→ 拉回邊界
  if (backwards && idx === 0) return last;
  if (!backwards && idx === items.length - 1) return first;
  return null;
}

type IOCtor = new (cb: (entries: { isIntersecting: boolean }[]) => void) => {
  observe(target: never): void;
  disconnect(): void;
};

interface MediaQueryLike {
  matches: boolean;
  addEventListener(type: "change", cb: (e: { matches: boolean }) => void): void;
  removeEventListener(type: "change", cb: (e: { matches: boolean }) => void): void;
}

export interface ModalSheetEnv {
  matchMedia?: (query: string) => MediaQueryLike;
  IntersectionObserver?: IOCtor;
  activeElement: () => unknown;
  /** 延後到 DOM 更新後再聚焦（元件內為 Vue nextTick）。 */
  defer: (fn: () => void) => void;
}

export interface KeyEventLike {
  key: string;
  shiftKey: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}

/**
 * 不依賴元件生命週期的核心：由 `useModalSheet` 在 mounted／unmounted 呼叫 attach／detach，
 * 測試則直接注入 stub 的 matchMedia／IntersectionObserver 驅動。
 */
export function createModalSheet(
  getRoot: () => SheetRootLike | null,
  onClose: () => void,
  env: ModalSheetEnv,
) {
  /** 目前是否為 bottom sheet 形態（決定要不要掛 role="dialog" 等屬性）。 */
  const isSheet = ref(false);
  /** sheet 形態且正顯示中：焦點陷阱只在這時生效。 */
  const trapActive = ref(false);

  let visible = false;
  let restoreTo: FocusableLike | null = null;
  let mql: MediaQueryLike | null = null;
  let observer: InstanceType<IOCtor> | null = null;

  function sync(): void {
    const next = isSheet.value && visible;
    if (next === trapActive.value) return;
    trapActive.value = next;
    if (next) {
      const active = env.activeElement() as FocusableLike | null;
      restoreTo = active && typeof active.focus === "function" ? active : null;
      env.defer(() => getRoot()?.focus());
    } else if (restoreTo && restoreTo.isConnected !== false) {
      restoreTo.focus();
      restoreTo = null;
    }
  }

  function onMediaChange(e: { matches: boolean }): void {
    isSheet.value = e.matches;
    sync();
  }

  function attach(): void {
    mql = env.matchMedia?.(MOBILE_QUERY) ?? null;
    isSheet.value = mql?.matches ?? false;
    mql?.addEventListener("change", onMediaChange);
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
    mql?.removeEventListener("change", onMediaChange);
    observer?.disconnect();
  }

  /** 掛在 drawer 根節點的 keydown。 */
  function onKeydown(event: KeyEventLike): void {
    const root = getRoot();
    if (!trapActive.value || !root) return;
    if (event.key === "Escape") {
      // 攔下冒泡：AppLayout 在 window 上也監聽 Esc，避免同一次按鍵關兩次。
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

  return { isSheet, trapActive, attach, detach, onKeydown };
}

/**
 * 行動版 bottom sheet 的 modal 行為：開啟時把焦點移進 sheet、Tab 在 sheet 內循環、Esc 關閉，
 * 關閉後把焦點還給開啟前的元素。
 *
 * 為什麼靠 IntersectionObserver 偵測「開啟」：sheet 的外層 `<aside>` 與開關狀態由 AppLayout／
 * App 持有，drawer 元件拿不到 `drawerOpen`；外層以 `display:none` 切換顯示，而 display:none
 * 的元素不會 intersect，觀察 drawer 根節點即可得知 sheet 何時出現／消失，不必改外層介面。
 * 桌機（md+）是常駐側欄、不是對話框，這時完全不介入焦點。
 */
export function useModalSheet(root: Ref<HTMLElement | null>, onClose: () => void) {
  const sheet = createModalSheet(() => root.value, onClose, {
    matchMedia: typeof window !== "undefined" && window.matchMedia ? (q) => window.matchMedia(q) : undefined,
    IntersectionObserver:
      typeof IntersectionObserver !== "undefined" ? (IntersectionObserver as unknown as IOCtor) : undefined,
    activeElement: () => (typeof document !== "undefined" ? document.activeElement : null),
    defer: (fn) => void nextTick(fn),
  });
  onMounted(sheet.attach);
  onUnmounted(sheet.detach);
  return { isSheet: sheet.isSheet, trapActive: sheet.trapActive, onKeydown: sheet.onKeydown };
}
