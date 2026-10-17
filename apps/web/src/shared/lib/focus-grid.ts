/**
 * 方向鍵依視覺位置移焦（research R9、data-model §11）。抽成純函式，讓移焦規則可以拿假 rect
 * 單元測試，不必真的排版；`useKeyboardShortcuts` 讀 `.machine-card` 的 `getBoundingClientRect()`
 * 後呼叫本函式。
 *
 * 規則：
 * 1. **方向過濾**：只看中心點在目標方向上、主軸位移大於 `SAME_POSITION_EPSILON` 的候選；
 *    反方向與「幾乎同位置」（主軸位移 ≤ 1px）的卡片一律排除。
 * 2. **同列／同欄優先**：往左右時，與目前卡片「垂直方向有重疊」的候選算同列；往上下時，
 *    「水平方向有重疊」的候選算同欄。有同列／同欄候選就只在它們之中挑。
 * 3. **再比歐氏距離**：在選定的候選集合中取中心點歐氏距離最近者；距離相同取索引較小者。
 * 4. **邊界停留**：沒有候選就回傳 `current`。
 *
 * 防禦：`rects` 為空、或 `current` 不是有效索引時，一律原樣回傳 `current`（不移動）。
 * 鍵盤移焦只在焦點已在某張卡片上時才觸發，所以呼叫端拿到的 `current` 應總是有效。
 */

/** 結構型別：`DOMRect` 直接可用，測試可傳假物件。 */
export type GridRect = Pick<DOMRectReadOnly, "left" | "top" | "right" | "bottom">;

export type FocusDirection = "up" | "down" | "left" | "right";

/** 主軸位移在此以內視為「幾乎同位置」，不算該方向的候選（px）。 */
const SAME_POSITION_EPSILON = 1;

interface Point {
  x: number;
  y: number;
}

function center(r: GridRect): Point {
  return { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 };
}

/** 中心點在 `direction` 上的主軸位移（正值代表位於該方向）。 */
function forwardDelta(from: Point, to: Point, direction: FocusDirection): number {
  switch (direction) {
    case "right":
      return to.x - from.x;
    case "left":
      return from.x - to.x;
    case "down":
      return to.y - from.y;
    case "up":
      return from.y - to.y;
  }
}

/** 左右移動看垂直重疊（同列），上下移動看水平重疊（同欄）；只碰到邊不算重疊。 */
function isAligned(a: GridRect, b: GridRect, direction: FocusDirection): boolean {
  if (direction === "left" || direction === "right") {
    return b.top < a.bottom && b.bottom > a.top;
  }
  return b.left < a.right && b.right > a.left;
}

export function nextIndex(rects: readonly GridRect[], current: number, direction: FocusDirection): number {
  const origin = Number.isInteger(current) ? rects[current] : undefined;
  if (origin === undefined) return current;

  const from = center(origin);
  let bestAligned = -1;
  let bestAlignedDist = Infinity;
  let bestAny = -1;
  let bestAnyDist = Infinity;

  rects.forEach((rect, i) => {
    if (i === current) return;
    const to = center(rect);
    if (forwardDelta(from, to, direction) <= SAME_POSITION_EPSILON) return;

    const dist = Math.hypot(to.x - from.x, to.y - from.y);
    // 嚴格小於：距離相同時保留先出現（索引較小）的候選。
    if (dist < bestAnyDist) {
      bestAny = i;
      bestAnyDist = dist;
    }
    if (isAligned(origin, rect, direction) && dist < bestAlignedDist) {
      bestAligned = i;
      bestAlignedDist = dist;
    }
  });

  if (bestAligned !== -1) return bestAligned;
  if (bestAny !== -1) return bestAny;
  return current;
}
