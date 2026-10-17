import { describe, expect, it } from "vitest";
import { revealAboveSheet, sheetOcclusion } from "./reveal-above-sheet.js";

describe("sheetOcclusion（sheet 在捲動容器可視區內遮住的高度＋間距）", () => {
  it("1024×768、容器下緣＝視窗底、sheet 約 130px 高（上緣 638）→ 130＋8", () => {
    expect(sheetOcclusion(638, 768, 768, 8)).toBe(138);
  });
  it("容器下緣在視窗底之上（例如 700）→ 只算容器內被遮的 62＋8，不多捲一個 sheet 高", () => {
    expect(sheetOcclusion(638, 700, 768, 8)).toBe(70);
  });
  it("容器下緣超出視窗（被視窗截掉）→ 以視窗高為界", () => {
    expect(sheetOcclusion(638, 2000, 768, 8)).toBe(138);
  });
  it("sheet 在容器可視區之下（上緣 ≥ 容器下緣）→ 只留間距", () => {
    expect(sheetOcclusion(900, 768, 768, 8)).toBe(8);
  });
});

describe("revealAboveSheet", () => {
  function target(rect: { top: number; bottom: number }, initial = "") {
    const calls: { margin: string; opts: ScrollIntoViewOptions }[] = [];
    const t = {
      style: { scrollMarginBottom: initial },
      getBoundingClientRect: () => rect,
      scrollIntoView(opts: ScrollIntoViewOptions) {
        calls.push({ margin: t.style.scrollMarginBottom, opts });
      },
    };
    return { t, calls };
  }
  const VIEWPORT = { top: 0, bottom: 768 };

  it("卡片被 sheet 蓋住：捲動當下 scroll-margin-bottom＝遮擋高度、block=nearest，捲完還原原值", () => {
    const { t, calls } = target({ top: 500, bottom: 716 }, "4px");
    revealAboveSheet(t, 638, VIEWPORT, 768);
    expect(calls).toEqual([{ margin: "138px", opts: { block: "nearest" } }]);
    expect(t.style.scrollMarginBottom).toBe("4px");
  });

  it("卡片已完整露在 sheet 之上（含間距）→ 不捲（方向鍵移焦不會被多捲）", () => {
    const { t, calls } = target({ top: 223, bottom: 439 });
    revealAboveSheet(t, 638, VIEWPORT, 768);
    expect(calls).toEqual([]);
  });

  it("卡片在 sheet 之上但上緣被捲出容器頂端 → 仍捲（交給 nearest 拉回）", () => {
    const { t, calls } = target({ top: 40, bottom: 256 });
    revealAboveSheet(t, 638, { top: 56, bottom: 768 }, 768);
    expect(calls).toHaveLength(1);
  });

  it("卡片下緣貼著 sheet 上緣（不足 8px 間距）→ 捲", () => {
    const { t, calls } = target({ top: 420, bottom: 634 });
    revealAboveSheet(t, 638, VIEWPORT, 768);
    expect(calls).toHaveLength(1);
  });

  it("scrollIntoView 擲錯也還原樣式，不在卡片上留下行內 scroll-margin", () => {
    const t = {
      style: { scrollMarginBottom: "" },
      getBoundingClientRect: () => ({ top: 600, bottom: 800 }),
      scrollIntoView() {
        throw new Error("boom");
      },
    };
    expect(() => revealAboveSheet(t, 500, VIEWPORT, 768)).toThrow("boom");
    expect(t.style.scrollMarginBottom).toBe("");
  });
});
