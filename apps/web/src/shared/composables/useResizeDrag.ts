import { computed, onUnmounted, ref } from "vue";
import { readPreference, writePreference } from "./useLocalPreference.js";

/**
 * 單軸調整尺寸的把手（側欄寬度 / 面板高度共用）：指標拖曳＋鍵盤方向鍵。
 *
 * - 拖曳：`direction: -1` 用於「往負方向拖曳才增加尺寸」的把手（例如面板上緣把手，往上拖增高）；
 *   `direction` 只影響拖曳位移的換算。
 * - 鍵盤（FR-034c）：語意固定、不受 `direction` 影響——`axis: "x"` 時 ArrowRight 加寬／ArrowLeft 減寬，
 *   `axis: "y"` 時 ArrowUp 增高／ArrowDown 減少，每次 `step`（預設 16px）；Home／End 跳到下限／上限。
 * - 尺寸以 `storageKey` 經 `useLocalPreference` 存成純數字字串（與舊版直接寫 localStorage 的格式相容），
 *   storage 不可用或內容壞掉時回 `initial`，重新整理後保留使用者調整過的值。
 * - `handleAttrs` 給把手元素 `v-bind`：`tabindex`、`role="separator"`、`aria-label`、
 *   `aria-orientation`（分隔線本身的方向：x 軸調整的把手是垂直線、y 軸是水平線）與 `aria-value*`。
 */
export interface UseResizeDragOptions {
  axis: "x" | "y";
  min: number;
  max: number;
  initial: number;
  storageKey: string;
  direction?: 1 | -1;
  /** 把手的可讀名稱（aria-label），例如「調整側欄寬度」。 */
  label: string;
  /** 鍵盤步距（px），預設 16。 */
  step?: number;
  /** 目前值的可讀文字（aria-valuetext）；預設「<px> 像素」。 */
  ariaValueText?: (px: number) => string;
}

export const RESIZE_KEY_STEP = 16;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 解析舊版存的純數字字串；非有限正數視為壞值（交給 readPreference 回預設）。 */
function parseSize(raw: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error("invalid size preference");
  return value;
}

export function useResizeDrag(options: UseResizeDragOptions) {
  const {
    axis,
    min,
    max,
    initial,
    storageKey,
    direction = 1,
    label,
    step = RESIZE_KEY_STEP,
    ariaValueText = (px: number) => `${px} 像素`,
  } = options;

  const size = ref(clamp(readPreference(storageKey, initial, parseSize), min, max));

  function persist(): void {
    writePreference(storageKey, String(size.value));
  }

  let dragging = false;
  let startPos = 0;
  let startSize = 0;

  function onPointerMove(event: PointerEvent): void {
    if (!dragging) return;
    const pos = axis === "x" ? event.clientX : event.clientY;
    // 取整：clientX/Y 在縮放或高 DPI 下可能帶小數，避免 aria-valuetext 唸出小數、storage 存小數。
    size.value = Math.round(clamp(startSize + direction * (pos - startPos), min, max));
  }

  function detach(): void {
    document.body.classList.remove("select-none");
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", stopDrag);
    window.removeEventListener("pointercancel", stopDrag);
  }

  function stopDrag(): void {
    if (!dragging) return;
    dragging = false;
    detach();
    persist();
  }

  function startDrag(event: PointerEvent): void {
    dragging = true;
    startPos = axis === "x" ? event.clientX : event.clientY;
    startSize = size.value;
    document.body.classList.add("select-none");
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", stopDrag);
    // 指標被系統取消（觸控被手勢接手、視窗失焦等）也要結束拖曳，否則會一直跟隨 move。
    window.addEventListener("pointercancel", stopDrag);
  }

  /** 方向鍵對應的增量；非本軸的方向鍵回 null（不攔截，交還瀏覽器預設行為）。 */
  function keyDelta(key: string): number | null {
    if (axis === "x") {
      if (key === "ArrowRight") return step;
      if (key === "ArrowLeft") return -step;
    } else {
      if (key === "ArrowUp") return step;
      if (key === "ArrowDown") return -step;
    }
    return null;
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    let next: number;
    if (event.key === "Home") next = min;
    else if (event.key === "End") next = max;
    else {
      const delta = keyDelta(event.key);
      if (delta === null) return;
      next = size.value + delta;
    }
    event.preventDefault();
    const clamped = clamp(next, min, max);
    if (clamped === size.value) return;
    size.value = clamped;
    persist();
  }

  const handleAttrs = computed(() => ({
    tabindex: 0,
    role: "separator",
    "aria-label": label,
    "aria-orientation": axis === "x" ? ("vertical" as const) : ("horizontal" as const),
    "aria-valuenow": size.value,
    "aria-valuemin": min,
    "aria-valuemax": max,
    "aria-valuetext": ariaValueText(size.value),
  }));

  onUnmounted(() => {
    // 拖曳中卸載也要把 body 的 select-none 收掉，不讓整頁留在不可選取文字的狀態。
    if (!dragging) return;
    dragging = false;
    detach();
  });

  return { size, startDrag, onKeydown, handleAttrs };
}
