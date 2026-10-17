import { onMounted, onUnmounted, ref, type Ref } from "vue";

/**
 * 媒體查詢的共用讀法（T075：原本 `TopBar.vue`、`StageTopology.vue`、`App.vue` 各有一份 `matchMedia` 寫法）。
 *
 * 查詢字串集中在這裡，與 `tailwind.config.ts` 的斷點對齊：
 * - `BELOW_MD_QUERY`：< Tailwind `md`（768px），rail 隱藏的手機寬度；
 * - `DESK_QUERY`／`BELOW_DESK_QUERY`：自訂 `desk`（1366px）推擠式側欄門檻與其互補（< 1366 為 bottom-sheet）。
 * 改斷點時 MUST 一併改 `tailwind.config.ts` 的 `screens`。
 *
 * 環境沒有 `matchMedia`（SSR、測試環境或舊瀏覽器）時一律視為不命中（false）。
 * 依賴方向：shared 層不依賴任何 domain 模組（`shared/layering.test.ts`）。
 */
export const BELOW_MD_QUERY = "(max-width: 767.98px)";
export const DESK_QUERY = "(min-width: 1366px)";
export const BELOW_DESK_QUERY = "(max-width: 1365.98px)";
export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/** 舊版 Safari（< 14）的 MediaQueryList 只有 `addListener`／`removeListener`。 */
type ChangeListener = (event: { matches: boolean }) => void;
interface MediaQueryListLike {
  readonly matches: boolean;
  addEventListener?: (type: "change", listener: ChangeListener) => void;
  removeEventListener?: (type: "change", listener: ChangeListener) => void;
  addListener?: (listener: ChangeListener) => void;
  removeListener?: (listener: ChangeListener) => void;
}

/** 環境是否提供 `window.matchMedia`。 */
export function hasMatchMedia(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function";
}

function mediaQueryList(query: string): MediaQueryListLike | null {
  return hasMatchMedia() ? window.matchMedia(query) : null;
}

/** 單次讀取（非 reactive）：要在事件處理當下依視窗判斷時用；沒有 `matchMedia` 時回 false。 */
export function matchesMedia(query: string): boolean {
  return mediaQueryList(query)?.matches ?? false;
}

/**
 * reactive 的媒體查詢狀態：setup 當下同步讀一次，mounted 後掛 change 監聽、unmounted 解除。
 * 監聽優先用 `addEventListener("change")`，沒有時退回舊 Safari 的 `addListener`。
 * MUST 在元件 setup 內呼叫（依賴 onMounted／onUnmounted）。
 */
export function useMediaQuery(query: string): Readonly<Ref<boolean>> {
  const list = mediaQueryList(query);
  const matches = ref(list?.matches ?? false);
  const onChange: ChangeListener = (event) => {
    matches.value = event.matches;
  };
  onMounted(() => {
    if (!list) return;
    if (typeof list.addEventListener === "function") list.addEventListener("change", onChange);
    else if (typeof list.addListener === "function") list.addListener(onChange);
  });
  onUnmounted(() => {
    if (!list) return;
    if (typeof list.removeEventListener === "function") list.removeEventListener("change", onChange);
    else if (typeof list.removeListener === "function") list.removeListener(onChange);
  });
  return matches;
}
