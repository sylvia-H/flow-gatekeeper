/**
 * 把元素捲到 bottom sheet 上緣之上（013 critique 第二輪 P1：< 1366px 選台後 sheet 蓋住剛選的卡）。
 *
 * 做法是 `scroll-margin-bottom` 的等價手段：暫時把目標的 `scroll-margin-bottom` 設成「sheet 在捲動容器可視區內遮住的高度＋間距」，
 * 再 `scrollIntoView({ block: "nearest" })`，捲完立即還原，不在卡片上留下行內樣式。不指定 `behavior`（即 `auto`），
 * 跟隨頁面的 `scroll-behavior` 與減少動態設定。
 *
 * 遮擋高度以「最近捲動祖先」的下緣計算（`scroll-margin` 是相對捲動容器的可視區，而不是視窗）：
 * `max(0, min(容器下緣, 視窗高) − sheet 上緣) + 間距`。若用「視窗高 − sheet 上緣」，容器下緣比視窗高時會多算，
 * 已露在 sheet 之上的卡片也被多捲（第三輪交叉審查 low）。目標已完整露在容器內、且在 sheet 之上時直接不捲。
 *
 * 內容高度不足以再捲時（例如卡片已在可捲範圍底部），瀏覽器捲到極限即止，不另補空白。
 */
export interface RectLike {
  top: number;
  bottom: number;
}

export interface RevealTarget {
  style: { scrollMarginBottom: string };
  getBoundingClientRect(): RectLike;
  scrollIntoView(options: ScrollIntoViewOptions): void;
}

/** sheet 在捲動容器可視區內遮住的高度＋間距；sheet 在容器可視區之下時只留間距。 */
export function sheetOcclusion(
  sheetTop: number,
  containerBottom: number,
  viewportHeight: number,
  gap: number,
): number {
  return Math.max(0, Math.min(containerBottom, viewportHeight) - sheetTop) + gap;
}

/**
 * @param container 最近捲動祖先的 rect（沒有捲動祖先時傳視窗：`{ top: 0, bottom: innerHeight }`）。
 */
export function revealAboveSheet(
  target: RevealTarget,
  sheetTop: number,
  container: RectLike,
  viewportHeight: number,
  gap = 8,
): void {
  const rect = target.getBoundingClientRect();
  const visibleBottom = Math.min(sheetTop, container.bottom, viewportHeight);
  if (rect.top >= Math.max(container.top, 0) && rect.bottom + gap <= visibleBottom) return;
  const previous = target.style.scrollMarginBottom;
  target.style.scrollMarginBottom = `${sheetOcclusion(sheetTop, container.bottom, viewportHeight, gap)}px`;
  try {
    target.scrollIntoView({ block: "nearest" });
  } finally {
    target.style.scrollMarginBottom = previous;
  }
}

/** 最近的可捲動祖先（overflow-y 為 auto／scroll）；沒有則回 null（交給視窗）。 */
export function nearestScrollParent(el: Element): Element | null {
  let node = el.parentElement;
  while (node) {
    const overflowY = getComputedStyle(node).overflowY;
    if (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") return node;
    node = node.parentElement;
  }
  return null;
}
