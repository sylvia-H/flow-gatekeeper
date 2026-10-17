import { describe, expect, it } from "vitest";
import { speedFor, throughputSum, widthFor, type FlowMachine } from "./flow-link.js";

function m(throughput: number, lastUpdated: number): FlowMachine {
  return { telemetry: { temperature: 70, vibration: 0.3, throughput, errorRate: 0 }, lastUpdated };
}

describe("throughputSum（data-model §4）", () => {
  const NOW = 100_000;

  it("加總下游 stage 各機台最新 throughput，不含其他 stage", () => {
    const machines = new Map([
      ["press-02", m(120, NOW)],
      ["oven-04", m(110, NOW - 1_000)],
      ["mixer-01", m(999, NOW)],
    ]);
    expect(throughputSum(["press-02", "oven-04"], machines, NOW)).toBe(230);
  });

  it("stale 機台（> 10 s 未更新）計 0；恰 10 s 仍計入", () => {
    const machines = new Map([
      ["press-02", m(120, NOW - 10_001)],
      ["oven-04", m(110, NOW - 10_000)],
    ]);
    expect(throughputSum(["press-02", "oven-04"], machines, NOW)).toBe(110);
  });

  it("尚無資料的機台計 0；空 stage 為 0", () => {
    expect(throughputSum(["press-02"], new Map(), NOW)).toBe(0);
    expect(throughputSum([], new Map([["press-02", m(120, NOW)]]), NOW)).toBe(0);
  });

  it("負值或非有限值計 0（防禦）", () => {
    const machines = new Map([
      ["a", m(-5, NOW)],
      ["b", m(Number.NaN, NOW)],
      ["c", m(40, NOW)],
    ]);
    expect(throughputSum(["a", "b", "c"], machines, NOW)).toBe(40);
  });
});

describe("widthFor（五段 2–8px）", () => {
  it("sum 為 0（或負值）時最細 2px", () => {
    expect(widthFor(0)).toBe(2);
    expect(widthFor(-1)).toBe(2);
    expect(widthFor(Number.NaN)).toBe(2);
  });

  it("各段邊界", () => {
    expect(widthFor(1)).toBe(3.5);
    expect(widthFor(89.9)).toBe(3.5);
    expect(widthFor(90)).toBe(5);
    expect(widthFor(169)).toBe(5);
    expect(widthFor(170)).toBe(6.5);
    expect(widthFor(224)).toBe(6.5);
    expect(widthFor(225)).toBe(8);
    expect(widthFor(10_000)).toBe(8);
  });

  it("mock 常見情境：2 台健康 → 8、一台 stale → 5、全 stale → 2", () => {
    expect(widthFor(240)).toBe(8);
    expect(widthFor(120)).toBe(5);
    expect(widthFor(0)).toBe(2);
  });
});

describe("speedFor（none／slow／mid／fast）", () => {
  it("sum 為 0 → none", () => {
    expect(speedFor(0, false, false)).toBe("none");
  });

  it("各檔邊界", () => {
    expect(speedFor(1, false, false)).toBe("slow");
    expect(speedFor(149, false, false)).toBe("slow");
    expect(speedFor(150, false, false)).toBe("mid");
    expect(speedFor(224, false, false)).toBe("mid");
    expect(speedFor(225, false, false)).toBe("fast");
  });

  it("reducedMotion 或 vertical 時恆為 none（粗細不受影響）", () => {
    expect(speedFor(240, true, false)).toBe("none");
    expect(speedFor(240, false, true)).toBe("none");
    expect(speedFor(240, true, true)).toBe("none");
    expect(widthFor(240)).toBe(8);
  });
});
