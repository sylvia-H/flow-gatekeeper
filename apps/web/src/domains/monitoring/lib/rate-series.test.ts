import { describe, expect, it } from "vitest";
import {
  averageOf,
  clearSamples,
  createRateSeries,
  droppedInWindow,
  invalidateNext,
  markStale,
  peakRatio,
  pushSample,
  totalOf,
  windowRatio,
  type RateCounters,
  type RateSample,
} from "./rate-series.js";

function c(receivedMessages: number, renderedBatches: number, droppedMessages = 0, invalidMessages = 0): RateCounters {
  return { receivedMessages, renderedBatches, droppedMessages, invalidMessages };
}

describe("rate-series 差分（data-model §3、research R4）", () => {
  it("首筆只取基準不產生樣本，第二筆起為差分", () => {
    const s = createRateSeries();
    expect(pushSample(s, c(1_000, 50, 3), 0)).toBe(false);
    expect(s.samples).toEqual([]);
    expect(pushSample(s, c(1_120, 52, 5), 1_000)).toBe(true);
    expect(s.samples).toEqual([{ t: 1_000, msgsPerSec: 120, batchesPerSec: 2, droppedPerSec: 2 }]);
    pushSample(s, c(1_150, 60, 5), 2_000);
    expect(s.samples[1]).toEqual({ t: 2_000, msgsPerSec: 30, batchesPerSec: 8, droppedPerSec: 0 });
  });

  it("不就地引用呼叫端的 counters 物件（呼叫端改值不影響基準）", () => {
    const s = createRateSeries();
    const counters = c(10, 1);
    pushSample(s, counters, 0);
    counters.receivedMessages = 999;
    pushSample(s, c(20, 2), 1_000);
    expect(s.samples[0]?.msgsPerSec).toBe(10);
  });

  it("計數器倒退：只重設基準、不寫入負值，下一筆起恢復差分", () => {
    const s = createRateSeries();
    pushSample(s, c(500, 10), 0);
    expect(pushSample(s, c(0, 0), 1_000)).toBe(false);
    expect(s.samples).toEqual([]);
    pushSample(s, c(40, 4), 2_000);
    expect(s.samples).toEqual([{ t: 2_000, msgsPerSec: 40, batchesPerSec: 4, droppedPerSec: 0 }]);
  });
});

describe("rate-series 環狀", () => {
  it("滿 60 格後丟最舊、長度恆 ≤ 60，讀取順序由舊到新", () => {
    const s = createRateSeries();
    pushSample(s, c(0, 0), 0);
    for (let i = 1; i <= 75; i += 1) pushSample(s, c(i * 10, i), i * 1_000);
    expect(s.samples.length).toBe(60);
    expect(s.samples[0]?.t).toBe(16_000); // 1..15 已被覆寫
    expect(s.samples[59]?.t).toBe(75_000);
    const ts = s.samples.map((x) => x.t);
    expect([...ts].sort((a, b) => a - b)).toEqual(ts);
  });

  it("capacity 可自訂", () => {
    const s = createRateSeries(3);
    pushSample(s, c(0, 0), 0);
    for (let i = 1; i <= 5; i += 1) pushSample(s, c(i, i), i);
    expect(s.samples.map((x) => x.t)).toEqual([3, 4, 5]);
  });
});

describe("rate-series stale", () => {
  it("stale 時不推入，既有樣本保留", () => {
    const s = createRateSeries();
    pushSample(s, c(0, 0), 0);
    pushSample(s, c(10, 1), 1_000);
    markStale(s);
    expect(s.stale).toBe(true);
    expect(pushSample(s, c(20, 2), 2_000)).toBe(false);
    expect(s.samples.length).toBe(1);
  });

  it("markStale 冪等：已連線時每次 tick 先 markStale(s, false) 再 pushSample，樣本照常累積", () => {
    const s = createRateSeries();
    for (let i = 0; i <= 5; i += 1) {
      markStale(s, false);
      pushSample(s, c(i * 10, i), i * 1_000);
    }
    expect(s.samples.map((x) => x.msgsPerSec)).toEqual([10, 10, 10, 10, 10]);
  });

  it("重複 markStale(s) 不影響；只有翻轉時才清基準", () => {
    const s = createRateSeries();
    markStale(s);
    markStale(s);
    expect(s.stale).toBe(true);
    markStale(s, false);
    expect(s.stale).toBe(false);
    expect(pushSample(s, c(0, 0), 0)).toBe(false); // 翻轉後首筆只取基準
    expect(pushSample(s, c(5, 1), 1_000)).toBe(true);
  });

  it("解除 stale 後重新取基準：斷線期間累積量不灌進單一格", () => {
    const s = createRateSeries();
    pushSample(s, c(0, 0), 0);
    pushSample(s, c(10, 1), 1_000);
    markStale(s);
    pushSample(s, c(5_000, 300), 2_000); // 斷線期間（實務上不會增加，這裡刻意加大）
    markStale(s, false);
    expect(s.stale).toBe(false);
    expect(pushSample(s, c(9_000, 400), 30_000)).toBe(false); // 恢復後首筆只取基準
    pushSample(s, c(9_020, 402), 31_000);
    expect(s.samples.map((x) => x.msgsPerSec)).toEqual([10, 20]);
  });

  it("clearSamples：清空樣本，stale 旗標與基準不動；視窗從頭累積", () => {
    const s = createRateSeries();
    pushSample(s, c(0, 0), 0);
    pushSample(s, c(10, 1), 1_000);
    pushSample(s, c(30, 2), 2_000);
    clearSamples(s);
    expect(s.samples).toEqual([]);
    expect(s.stale).toBe(false);
    expect(windowRatio(s)).toBeNull();
    expect(pushSample(s, c(33, 3), 3_000)).toBe(true); // 基準仍在，下一格照常差分
    expect(s.samples.map((x) => x.msgsPerSec)).toEqual([3]);
  });
});

describe("rate-series 衍生值", () => {
  it("windowRatio = Σ訊息 ÷ Σ批次（非逐格比值平均）", () => {
    const s = createRateSeries();
    pushSample(s, c(0, 0), 0);
    pushSample(s, c(100, 1), 1_000); // 100:1
    pushSample(s, c(120, 11), 2_000); // 20:10
    expect(windowRatio(s)).toBeCloseTo(120 / 11);
  });

  it("批次總和為 0（含無樣本）時 windowRatio 為 null", () => {
    const s = createRateSeries();
    expect(windowRatio(s)).toBeNull();
    pushSample(s, c(0, 0), 0);
    pushSample(s, c(30, 0), 1_000); // 有訊息、無批次（Pause 中）
    expect(windowRatio(s)).toBeNull();
  });

  it("droppedInWindow = Σ droppedPerSec，滑出視窗者不計", () => {
    const s = createRateSeries(2);
    pushSample(s, c(0, 0, 0), 0);
    pushSample(s, c(0, 0, 5), 1_000);
    pushSample(s, c(0, 0, 6), 2_000);
    expect(droppedInWindow(s)).toBe(6);
    pushSample(s, c(0, 0, 9), 3_000); // 第一格（5）滑出
    expect(droppedInWindow(s)).toBe(4);
  });

  it("丟棄數＝溢位合併丟棄＋格式不符剔除的差分（合併門第 1 輪 medium）", () => {
    const s = createRateSeries();
    pushSample(s, c(0, 0, 1, 2), 0);
    pushSample(s, c(10, 2, 4, 5), 1_000); // 溢位 +3、剔除 +3
    pushSample(s, c(20, 4, 4, 7), 2_000); // 只有剔除 +2
    expect(s.samples.map((x) => x.droppedPerSec)).toEqual([6, 2]);
    expect(droppedInWindow(s)).toBe(8);
  });
});

describe("rate-series 無效樣本（暫停期間與恢復當下，013 第三輪交叉審查）", () => {
  it("invalidateNext(n)：接下來 n 筆推入的樣本標 invalid；只取基準的 tick 不消耗", () => {
    const s = createRateSeries();
    invalidateNext(s, 2);
    pushSample(s, c(0, 0), 0); // 只取基準：不消耗
    pushSample(s, c(10, 2), 1_000);
    pushSample(s, c(20, 4), 2_000);
    pushSample(s, c(30, 6), 3_000);
    expect(s.samples.map((x) => x.invalid === true)).toEqual([true, true, false]);
    expect(s.invalidPushes).toBe(0);
  });

  it("invalidateNext 取較大者，不縮短已排定的筆數", () => {
    const s = createRateSeries();
    invalidateNext(s, 2);
    invalidateNext(s, 1);
    expect(s.invalidPushes).toBe(2);
  });

  it("windowRatio／averageOf／totalOf／peakRatio 排除無效樣本；droppedInWindow 仍計入", () => {
    const s = createRateSeries();
    pushSample(s, c(0, 0, 0), 0);
    pushSample(s, c(50, 10, 0), 1_000); // 5:1
    invalidateNext(s, 1);
    pushSample(s, c(350, 11, 7), 2_000); // 恢復那一幀：300 則 1 批（離群）、暫停期間丟 7
    pushSample(s, c(410, 21, 7), 3_000); // 6:1
    expect(windowRatio(s)).toBeCloseTo((50 + 60) / (10 + 10));
    expect(averageOf(s.samples, "msgsPerSec")).toBe(55);
    expect(totalOf(s.samples, "msgsPerSec")).toBe(110);
    expect(peakRatio(s.samples)).toBe(6);
    expect(droppedInWindow(s)).toBe(7);
  });

  it("視窗內只剩無效樣本時：比值 null、平均 null、最高水位不畫", () => {
    const s = createRateSeries();
    pushSample(s, c(0, 0), 0);
    invalidateNext(s, 1);
    pushSample(s, c(300, 1), 1_000);
    expect(windowRatio(s)).toBeNull();
    expect(averageOf(s.samples, "msgsPerSec")).toBeNull();
    expect(peakRatio(s.samples)).toBeNull();
  });
});

const smp = (msgsPerSec: number, batchesPerSec: number): RateSample => ({
  t: 0,
  msgsPerSec,
  batchesPerSec,
  droppedPerSec: 0,
});

describe("rate-series 視窗平均與最高水位（critique 2026-10-16 P1）", () => {
  it("averageOf：無樣本為 null；平均訊息 ÷ 平均批次 = 視窗比值", () => {
    expect(averageOf([], "msgsPerSec")).toBeNull();
    const s = createRateSeries();
    pushSample(s, c(0, 0), 0);
    pushSample(s, c(330, 50), 1_000);
    pushSample(s, c(660, 99), 2_000);
    pushSample(s, c(1_000, 150), 3_000);
    const avgM = averageOf(s.samples, "msgsPerSec")!;
    const avgB = averageOf(s.samples, "batchesPerSec")!;
    expect(avgM).toBeCloseTo(1_000 / 3);
    expect(avgB).toBe(50);
    expect(avgM / avgB).toBeCloseTo(windowRatio(s)!);
  });

  it("totalOf：視窗總和；無樣本為 0", () => {
    expect(totalOf([], "batchesPerSec")).toBe(0);
    expect(totalOf([smp(3, 1), smp(5, 2)], "msgsPerSec")).toBe(8);
  });

  it("peakRatio：單秒比值的最大值；批次為 0 的格子不算單格比值", () => {
    expect(peakRatio([])).toBeNull();
    expect(peakRatio([smp(40, 10), smp(150, 10), smp(50, 10)])).toBe(15);
    expect(peakRatio([smp(40, 10), smp(0, 0)])).toBe(4);
  });

  it("peakRatio：視窗內完全沒有批次時為 null", () => {
    expect(peakRatio([smp(100, 0), smp(5, 0)])).toBeNull();
  });

  it("peakRatio 不低於視窗比值（無批次格子的訊息拉高視窗比值時，最高水位不畫在液位線左邊）", () => {
    // 單格比值 5、5；另一格 300 則訊息 0 批 → 視窗比值 (50+50+300)/20 = 20
    expect(peakRatio([smp(50, 10), smp(50, 10), smp(300, 0)])).toBe(20);
  });
});
