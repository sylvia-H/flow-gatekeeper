import { describe, expect, it } from "vitest";
import { nextIndex, type FocusDirection, type GridRect } from "./focus-grid.js";

const W = 200;
const H = 120;
const GAP = 16;

/** 第 row 列、第 col 欄的假卡片 rect（卡寬 200、卡高 120、間距 16）。 */
function cell(col: number, row: number): GridRect {
  const left = col * (W + GAP);
  const top = row * (H + GAP);
  return { left, top, right: left + W, bottom: top + H };
}

/**
 * 三欄兩列：
 *   0 1 2
 *   3 4 5
 */
const GRID_3x2: GridRect[] = [cell(0, 0), cell(1, 0), cell(2, 0), cell(0, 1), cell(1, 1), cell(2, 1)];

describe("nextIndex — 3×2 格線四方向（research R9）", () => {
  // [起點, 方向, 預期]；預期等於起點者即邊界停留。
  const cases: [number, FocusDirection, number][] = [
    [0, "up", 0],
    [0, "down", 3],
    [0, "left", 0],
    [0, "right", 1],
    [1, "up", 1],
    [1, "down", 4],
    [1, "left", 0],
    [1, "right", 2],
    [2, "up", 2],
    [2, "down", 5],
    [2, "left", 1],
    [2, "right", 2],
    [3, "up", 0],
    [3, "down", 3],
    [3, "left", 3],
    [3, "right", 4],
    [4, "up", 1],
    [4, "down", 4],
    [4, "left", 3],
    [4, "right", 5],
    [5, "up", 2],
    [5, "down", 5],
    [5, "left", 4],
    [5, "right", 5],
  ];

  it.each(cases)("從 %i 往 %s → %i", (from, direction, expected) => {
    expect(nextIndex(GRID_3x2, from, direction)).toBe(expected);
  });
});

describe("nextIndex — 邊界停留與防禦", () => {
  it("四個角落往外側皆停留在原位", () => {
    expect(nextIndex(GRID_3x2, 0, "up")).toBe(0);
    expect(nextIndex(GRID_3x2, 0, "left")).toBe(0);
    expect(nextIndex(GRID_3x2, 2, "right")).toBe(2);
    expect(nextIndex(GRID_3x2, 5, "down")).toBe(5);
  });

  it("只有一張卡：任何方向都停留", () => {
    for (const d of ["up", "down", "left", "right"] as const) {
      expect(nextIndex([cell(0, 0)], 0, d)).toBe(0);
    }
  });

  it("空陣列：原樣回傳 current", () => {
    expect(nextIndex([], 0, "right")).toBe(0);
    expect(nextIndex([], -1, "down")).toBe(-1);
  });

  it("越界或非整數的 current：原樣回傳，不移動", () => {
    expect(nextIndex(GRID_3x2, -1, "right")).toBe(-1);
    expect(nextIndex(GRID_3x2, 6, "left")).toBe(6);
    expect(nextIndex(GRID_3x2, 1.5, "down")).toBe(1.5);
    expect(nextIndex(GRID_3x2, Number.NaN, "up")).toBeNaN();
  });

  it("幾乎同位置（主軸位移 ≤ 1px）的卡片不算候選", () => {
    const rects: GridRect[] = [cell(0, 0), { left: 0.5, top: 0, right: W + 0.5, bottom: H }];
    expect(nextIndex(rects, 0, "right")).toBe(0);
    expect(nextIndex(rects, 1, "left")).toBe(1);
  });

  it("直接接受 DOMRect 形狀（多出 x／y／width／height 欄位）", () => {
    const withExtras = GRID_3x2.map((r) => ({ ...r, x: r.left, y: r.top, width: W, height: H }));
    expect(nextIndex(withExtras, 0, "right")).toBe(1);
  });
});

describe("nextIndex — 列未對齊與同列／同欄優先", () => {
  /**
   * 下一列只有兩張卡：
   *   0 1 2
   *   3 4
   */
  const RAGGED: GridRect[] = [cell(0, 0), cell(1, 0), cell(2, 0), cell(0, 1), cell(1, 1)];

  it("從第三欄往下：沒有同欄候選，落到歐氏距離最近的 4", () => {
    expect(nextIndex(RAGGED, 2, "down")).toBe(4);
  });

  it("下一列有同欄卡時仍走同欄", () => {
    expect(nextIndex(RAGGED, 0, "down")).toBe(3);
    expect(nextIndex(RAGGED, 1, "down")).toBe(4);
  });

  it("短列末端往右：同列已無候選，依歐氏距離落到右上方的 2（非邊界停留）", () => {
    expect(nextIndex(RAGGED, 4, "right")).toBe(2);
  });

  it("同列候選即使較遠，也優先於較近的斜向候選", () => {
    const rects: GridRect[] = [
      { left: 0, top: 0, right: 100, bottom: 100 },
      // 同列（垂直重疊）但較遠
      { left: 400, top: 20, right: 500, bottom: 120 },
      // 不重疊（top 101 > 100）但較近
      { left: 110, top: 101, right: 210, bottom: 201 },
    ];
    expect(nextIndex(rects, 0, "right")).toBe(1);
  });

  it("往下：同欄候選即使較遠，也優先於斜下方較近、無水平重疊的干擾卡", () => {
    const rects: GridRect[] = [
      { left: 0, top: 0, right: 100, bottom: 100 },
      // 同欄（水平重疊）但較遠
      { left: 10, top: 400, right: 110, bottom: 500 },
      // 不重疊（left 101 > 100）但較近
      { left: 101, top: 110, right: 201, bottom: 210 },
    ];
    expect(nextIndex(rects, 0, "down")).toBe(1);
  });

  it("往上：同欄候選即使較遠，也優先於斜上方較近、無水平重疊的干擾卡", () => {
    const rects: GridRect[] = [
      { left: 0, top: 500, right: 100, bottom: 600 },
      // 同欄（水平重疊）但較遠
      { left: 10, top: 0, right: 110, bottom: 100 },
      // 不重疊（left 101 > 100）但較近
      { left: 101, top: 390, right: 201, bottom: 490 },
    ];
    expect(nextIndex(rects, 0, "up")).toBe(1);
  });

  it("只碰到邊（bottom === top）不算同列", () => {
    const rects: GridRect[] = [
      { left: 0, top: 0, right: 100, bottom: 100 },
      { left: 400, top: 100, right: 500, bottom: 200 },
      { left: 120, top: 150, right: 220, bottom: 250 },
    ];
    // 兩者都不重疊 → 取歐氏距離最近的 2
    expect(nextIndex(rects, 0, "right")).toBe(2);
  });

  it("距離相同時取索引較小者", () => {
    const rects: GridRect[] = [
      { left: 100, top: 0, right: 200, bottom: 100 },
      { left: 0, top: 200, right: 100, bottom: 300 },
      { left: 200, top: 200, right: 300, bottom: 300 },
    ];
    expect(nextIndex(rects, 0, "down")).toBe(1);
  });
});
