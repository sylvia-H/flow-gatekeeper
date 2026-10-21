import { describe, expect, it } from "vitest";
import {
  cancelTiming,
  compareBars,
  compareLabel,
  createTiming,
  settleTiming,
  startTiming,
  type DiagnosisTiming,
} from "./diagnosis-timing.js";

describe("diagnosis-timing — 轉移", () => {
  it("createTiming：全空", () => {
    expect(createTiming()).toEqual({ pending: null, lastUncachedMs: null, lastCachedMs: null, lastKind: null });
  });

  it("startTiming：undefined 從初始值起算並設 pending", () => {
    expect(startTiming(undefined, "job-1", 100)).toEqual({
      pending: { jobId: "job-1", startedAt: 100 },
      lastUncachedMs: null,
      lastCachedMs: null,
      lastKind: null,
    });
  });

  it("startTiming：覆蓋先前 pending、保留歷史值、不就地改", () => {
    const prev: DiagnosisTiming = {
      pending: { jobId: "job-1", startedAt: 0 },
      lastUncachedMs: 8_200,
      lastCachedMs: null,
      lastKind: "uncached",
    };
    const next = startTiming(prev, "job-2", 50);
    expect(next).toEqual({ ...prev, pending: { jobId: "job-2", startedAt: 50 } });
    expect(prev.pending).toEqual({ jobId: "job-1", startedAt: 0 });
  });

  it("settleTiming 非快取：寫 lastUncachedMs、清 pending", () => {
    const t = settleTiming(startTiming(undefined, "job-1", 1_000), "job-1", false, 9_200);
    expect(t).toEqual({ pending: null, lastUncachedMs: 8_200, lastCachedMs: null, lastKind: "uncached" });
  });

  it("settleTiming 快取：寫 lastCachedMs、保留 lastUncachedMs", () => {
    const first = settleTiming(startTiming(undefined, "job-1", 0), "job-1", false, 8_200);
    const t = settleTiming(startTiming(first, "job-2", 10_000), "job-2", true, 10_014);
    expect(t).toEqual({ pending: null, lastUncachedMs: 8_200, lastCachedMs: 14, lastKind: "cached" });
  });

  it("settleTiming：jobId 不符或無 pending → 原樣回傳（同一參照）", () => {
    const started = startTiming(undefined, "job-1", 0);
    expect(settleTiming(started, "job-other", false, 500)).toBe(started);
    const idle = createTiming();
    expect(settleTiming(idle, "job-1", true, 500)).toBe(idle);
  });

  it("settleTiming：時鐘倒退時耗時夾為 0", () => {
    expect(settleTiming(startTiming(undefined, "j", 100), "j", false, 50).lastUncachedMs).toBe(0);
  });

  it("cancelTiming：清 pending、保留歷史值；無 pending 時原樣回傳", () => {
    const base: DiagnosisTiming = { pending: null, lastUncachedMs: 8_200, lastCachedMs: 14, lastKind: "cached" };
    const started = startTiming(base, "job-3", 0);
    expect(cancelTiming(started)).toEqual(base);
    expect(cancelTiming(base)).toBe(base);
  });
});

describe("compareLabel", () => {
  it("無任何紀錄（含 undefined、只有 pending）→ null", () => {
    expect(compareLabel(undefined)).toBeNull();
    expect(compareLabel(createTiming())).toBeNull();
    expect(compareLabel(startTiming(undefined, "j", 0))).toBeNull();
  });

  it("最近一次非快取：主字 N.N s、無對比", () => {
    const t = settleTiming(startTiming(undefined, "j", 0), "j", false, 8_200);
    expect(compareLabel(t)).toEqual({ primary: "8.2 s", cached: false });
  });

  it("最近一次快取且有非快取紀錄：快取 · N ms 並列 上一次 N.N s", () => {
    const t: DiagnosisTiming = { pending: null, lastUncachedMs: 8_200, lastCachedMs: 14, lastKind: "cached" };
    expect(compareLabel(t)).toEqual({ primary: "快取 · 14 ms", cached: true });
  });

  it("最近一次快取但無非快取紀錄：只顯示本次", () => {
    const t = settleTiming(startTiming(undefined, "j", 0), "j", true, 14);
    expect(compareLabel(t)).toEqual({ primary: "快取 · 14 ms", cached: true });
  });

  it("快取之後又跑一次非快取：主字改為非快取耗時", () => {
    const t: DiagnosisTiming = { pending: null, lastUncachedMs: 12_340, lastCachedMs: 14, lastKind: "uncached" };
    expect(compareLabel(t)).toEqual({ primary: "12.3 s", cached: false });
  });

  it("新診斷進行中（pending）仍顯示上一次完成的標籤", () => {
    const done: DiagnosisTiming = { pending: null, lastUncachedMs: 999.6, lastCachedMs: null, lastKind: "uncached" };
    expect(compareLabel(startTiming(done, "j2", 0))).toEqual({ primary: "1.0 s", cached: false });
  });
});

describe("diagnosis-timing — 以 GET 取回（012 P16、data-model §6.4）", () => {
  const history: DiagnosisTiming = { pending: null, lastUncachedMs: 8_200, lastCachedMs: 14, lastKind: "cached" };

  it("settleTiming recovered：只寫 lastRecoveredMs／lastRecoveredCached／lastKind，不動非快取與快取兩欄", () => {
    const t = settleTiming(startTiming(history, "job-9", 1_000), "job-9", false, 31_000, { recovered: true });
    expect(t).toEqual({
      pending: null,
      lastUncachedMs: 8_200,
      lastCachedMs: 14,
      lastRecoveredMs: 30_000,
      lastRecoveredCached: false,
      lastKind: "recovered",
    });
  });

  it("settleTiming recovered：jobId 不符時原樣回傳", () => {
    const started = startTiming(history, "job-9", 0);
    expect(settleTiming(started, "job-x", false, 10, { recovered: true })).toBe(started);
  });

  it("compareLabel recovered：主字顯示本次耗時，快取與否照當次結果", () => {
    const uncached = settleTiming(startTiming(history, "j", 0), "j", false, 12_340, { recovered: true });
    expect(compareLabel(uncached)).toEqual({ primary: "12.3 s", cached: false });
    const cached = settleTiming(startTiming(history, "j", 0), "j", true, 14, { recovered: true });
    expect(compareLabel(cached)).toEqual({ primary: "快取 · 14 ms", cached: true });
  });

  it("compareBars recovered → null；之後的快取診斷仍以原本的非快取耗時為「上一次」", () => {
    const recovered = settleTiming(startTiming(history, "j", 0), "j", true, 30_000, { recovered: true });
    expect(compareBars(recovered)).toBeNull();
    const next = settleTiming(startTiming(recovered, "j2", 0), "j2", true, 20);
    expect(compareBars(next)?.[1]).toMatchObject({ kind: "previous", value: "8.2 s" });
  });
});

describe("compareBars", () => {
  it("非快取、無紀錄、只有 pending → null", () => {
    expect(compareBars(undefined)).toBeNull();
    expect(compareBars(createTiming())).toBeNull();
    const uncached: DiagnosisTiming = { pending: null, lastUncachedMs: 8_200, lastCachedMs: 14, lastKind: "uncached" };
    expect(compareBars(uncached)).toBeNull();
  });

  it("快取且有上一次：兩條同刻度（較大者滿格）", () => {
    const t: DiagnosisTiming = { pending: null, lastUncachedMs: 7_600, lastCachedMs: 1_300, lastKind: "cached" };
    const bars = compareBars(t);
    expect(bars).toHaveLength(2);
    expect(bars?.[0]).toMatchObject({ kind: "cached", label: "快取", value: "1.3 s" });
    expect(bars?.[0]?.ratio).toBeCloseTo(1_300 / 7_600);
    expect(bars?.[1]).toEqual({ kind: "previous", label: "上一次", value: "7.6 s", ratio: 1 });
  });

  it("快取比上一次慢（理論上少見）：快取滿格、上一次依比例", () => {
    const t: DiagnosisTiming = { pending: null, lastUncachedMs: 500, lastCachedMs: 1_000, lastKind: "cached" };
    expect(compareBars(t)?.map((b) => b.ratio)).toEqual([1, 0.5]);
  });

  it("快取但無非快取紀錄 → null（單獨一條沒有比較對象，不畫）；兩者皆 0 不除以零", () => {
    expect(compareBars({ pending: null, lastUncachedMs: null, lastCachedMs: 14, lastKind: "cached" })).toBeNull();
    expect(compareBars({ pending: null, lastUncachedMs: 0, lastCachedMs: 0, lastKind: "cached" })?.map((b) => b.ratio)).toEqual([1, 1]);
  });
});
