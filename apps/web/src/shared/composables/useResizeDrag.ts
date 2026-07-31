import { onUnmounted, ref } from "vue";

/**
 * 單軸拖曳調整尺寸（側欄寬度 / 面板高度共用）。
 * `direction: -1` 用於「往負方向拖曳才增加尺寸」的把手（例如面板上緣把手，往上拖增高）。
 * 尺寸以 `storageKey` 存 localStorage，重新整理後保留使用者調整過的值。
 */
export interface UseResizeDragOptions {
  axis: "x" | "y";
  min: number;
  max: number;
  initial: number;
  storageKey: string;
  direction?: 1 | -1;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function useResizeDrag(options: UseResizeDragOptions) {
  const { axis, min, max, initial, storageKey, direction = 1 } = options;

  const stored = Number(localStorage.getItem(storageKey));
  const startValue = Number.isFinite(stored) && stored > 0 ? clamp(stored, min, max) : initial;
  const size = ref(startValue);

  let dragging = false;
  let startPos = 0;
  let startSize = 0;

  function onPointerMove(event: PointerEvent): void {
    if (!dragging) return;
    const pos = axis === "x" ? event.clientX : event.clientY;
    size.value = clamp(startSize + direction * (pos - startPos), min, max);
  }

  function stopDrag(): void {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove("select-none");
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", stopDrag);
    localStorage.setItem(storageKey, String(size.value));
  }

  function startDrag(event: PointerEvent): void {
    dragging = true;
    startPos = axis === "x" ? event.clientX : event.clientY;
    startSize = size.value;
    document.body.classList.add("select-none");
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", stopDrag);
  }

  onUnmounted(() => {
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", stopDrag);
  });

  return { size, startDrag };
}
