import { describe, expect, it } from "vitest";
import {
  cancelTiming,
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
    expect(compareLabel(t)).toEqual({ primary: "8.2 s", secondary: null, cached: false });
  });

  it("最近一次快取且有非快取紀錄：快取 · N ms 並列 上一次 N.N s", () => {
    const t: DiagnosisTiming = { pending: null, lastUncachedMs: 8_200, lastCachedMs: 14, lastKind: "cached" };
    expect(compareLabel(t)).toEqual({ primary: "快取 · 14 ms", secondary: "上一次 8.2 s", cached: true });
  });

  it("最近一次快取但無非快取紀錄：只顯示本次", () => {
    const t = settleTiming(startTiming(undefined, "j", 0), "j", true, 14);
    expect(compareLabel(t)).toEqual({ primary: "快取 · 14 ms", secondary: null, cached: true });
  });

  it("快取之後又跑一次非快取：主字改為非快取耗時", () => {
    const t: DiagnosisTiming = { pending: null, lastUncachedMs: 12_340, lastCachedMs: 14, lastKind: "uncached" };
    expect(compareLabel(t)).toEqual({ primary: "12.3 s", secondary: null, cached: false });
  });

  it("新診斷進行中（pending）仍顯示上一次完成的標籤", () => {
    const done: DiagnosisTiming = { pending: null, lastUncachedMs: 999.6, lastCachedMs: null, lastKind: "uncached" };
    expect(compareLabel(startTiming(done, "j2", 0))).toEqual({ primary: "1.0 s", secondary: null, cached: false });
  });
});
