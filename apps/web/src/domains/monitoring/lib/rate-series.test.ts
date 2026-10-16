import { describe, expect, it } from "vitest";
import {
  createRateSeries,
  droppedInWindow,
  markStale,
  maxOf,
  pushSample,
  windowRatio,
  type RateCounters,
} from "./rate-series.js";

function c(receivedMessages: number, renderedBatches: number, droppedMessages = 0): RateCounters {
  return { receivedMessages, renderedBatches, droppedMessages };
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

  it("maxOf 取視窗內各欄最大值，無樣本為 0", () => {
    const s = createRateSeries();
    expect(maxOf(s, "msgsPerSec")).toBe(0);
    pushSample(s, c(0, 0, 0), 0);
    pushSample(s, c(50, 5, 1), 1_000);
    pushSample(s, c(250, 7, 1), 2_000);
    pushSample(s, c(260, 17, 4), 3_000);
    expect(maxOf(s, "msgsPerSec")).toBe(200);
    expect(maxOf(s, "batchesPerSec")).toBe(10);
    expect(maxOf(s, "droppedPerSec")).toBe(3);
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
});
