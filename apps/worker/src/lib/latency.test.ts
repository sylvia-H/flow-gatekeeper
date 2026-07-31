import { describe, expect, it } from "vitest";
import { summarizeLatency } from "./latency.js";

describe("summarizeLatency", () => {
  it("空樣本時三項統計值皆為 null（不是 0）", () => {
    expect(summarizeLatency([])).toEqual({ count: 0, avgMs: null, p95Ms: null, maxMs: null });
  });

  it("單一樣本：avg／p95／max 皆為該樣本", () => {
    expect(summarizeLatency([2184])).toEqual({
      count: 1,
      avgMs: 2184,
      p95Ms: 2184,
      maxMs: 2184,
    });
  });

  it("多樣本：avg 取整、max 為最大值", () => {
    const summary = summarizeLatency([100, 200, 300]);
    expect(summary.count).toBe(3);
    expect(summary.avgMs).toBe(200);
    expect(summary.maxMs).toBe(300);
  });

  it("p95 採最近秩：20 個樣本取第 19 名（ceil(0.95×20)）", () => {
    const samples = Array.from({ length: 20 }, (_, i) => (i + 1) * 100); // 100..2000
    expect(summarizeLatency(samples).p95Ms).toBe(1900);
  });

  it("p95 邊界：樣本數少時不插值，落在既有樣本上", () => {
    // ceil(0.95 × 2) = 2 → 第 2 名（升冪）
    expect(summarizeLatency([500, 100]).p95Ms).toBe(500);
    // ceil(0.95 × 3) = 3 → 第 3 名
    expect(summarizeLatency([300, 100, 200]).p95Ms).toBe(300);
  });

  it("不改動傳入陣列（純函式）", () => {
    const samples = [300, 100, 200];
    summarizeLatency(samples);
    expect(samples).toEqual([300, 100, 200]);
  });
});
