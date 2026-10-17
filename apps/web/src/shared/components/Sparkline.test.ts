// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import Sparkline from "./Sparkline.vue";
import { sampleRatio, totalOf, type RateSample } from "../lib/rate-series.js";

const sample = (msgsPerSec: number, batchesPerSec: number, invalid = false): RateSample => ({
  t: 0,
  msgsPerSec,
  batchesPerSec,
  droppedPerSec: 0,
  ...(invalid ? { invalid: true as const } : {}),
});

/** 父層（BackpressureStrip）傳入的視窗合併比 = store 的 windowRatio = 有效樣本 Σ訊息 ÷ Σ批次。 */
const windowRatioOf = (samples: readonly RateSample[]): number | null => {
  const batches = totalOf(samples, "batchesPerSec");
  return batches === 0 ? null : totalOf(samples, "msgsPerSec") / batches;
};

const mountSpark = (samples: readonly RateSample[], windowRatio = windowRatioOf(samples)) =>
  mount(Sparkline, { props: { samples, windowRatio } });

const label = (w: ReturnType<typeof mountSpark>) => w.get("svg").attributes("aria-label");

describe("Sparkline y 軸上限（合併門第 2 輪 low：視窗合併比由父層傳入，單秒比值用 rate-series 的 sampleRatio）", () => {
  it("上限 = max(傳入的視窗合併比 × 2, 次高單秒比) × 1.25；無效樣本不計入上限、該格斷線", () => {
    // 有效：10:1、2:1 → 視窗 120 ÷ 20 = 6；無效的 600:1 離群不計入上限、該格斷線
    const samples = [sample(100, 10), sample(20, 10), sample(600, 1, true)];
    expect(windowRatioOf(samples)).toBe(6);
    const w = mountSpark(samples);
    // top = max(6 × 2, 次高 2) × 1.25 = 15；scale = 22 / 15；y = 23 − r × scale（10 → 8.33、2 → 20.07）
    const lines = w.findAll("polyline");
    expect(lines).toHaveLength(1);
    expect(lines[0]!.attributes("points")).toBe("57,8.33 58,20.07");
  });

  it("y 軸上限跟著傳入的 windowRatio 走（不在元件內另算一份）", () => {
    const samples = [sample(100, 10), sample(20, 10)];
    // 傳入 8 → top = max(16, 2) × 1.25 = 20；scale = 1.1；y = 23 − r × 1.1（10 → 12、2 → 20.8）
    expect(mountSpark(samples, 8).findAll("polyline")[0]!.attributes("points")).toBe("58,12 59,20.8");
    // null（視窗內尚無批次）→ 只看次高單秒比：top = max(0, 2) × 1.25 = 2.5 → 至少 1 不影響
    expect(mountSpark(samples, null).findAll("polyline")[0]!.attributes("points")).toBe("58,1 59,5.4");
  });

  it("單秒比值與 rate-series 的 sampleRatio 同一定義", () => {
    expect(sampleRatio(sample(50, 10))).toBe(5);
    expect(sampleRatio(sample(50, 0))).toBeNull();
    expect(sampleRatio(sample(50, 10, true))).toBeNull();
  });
});

describe("Sparkline 單點段（合併門第 2 輪 low：被 null 隔開的單一秒畫成圓點）", () => {
  /** 每條 polyline 的點數與起點 x。 */
  const shape = (w: ReturnType<typeof mountSpark>) =>
    w.findAll("polyline").map((l) => {
      const pts = l.attributes("points")!.split(" ");
      return { n: pts.length, first: pts[0]!, last: pts[pts.length - 1]! };
    });

  it("前後都斷開的單點畫成兩個相同座標的 polyline（同色同粗細、round linecap、non-scaling-stroke），不用 circle", () => {
    // 5:1 ｜ 無批次 ｜ 4:1、6:1 ｜ 無效 ｜ 5:1
    const samples = [sample(50, 10), sample(30, 0), sample(40, 10), sample(60, 10), sample(300, 1, true), sample(50, 10)];
    const w = mountSpark(samples);
    expect(w.find("circle").exists()).toBe(false);
    const segs = shape(w);
    expect(segs.map((s) => s.n)).toEqual([2, 2, 2]);
    // 單點段：起訖同一座標（x = 54、59），在 preserveAspectRatio="none" 下靠 round linecap 畫成圓點
    expect(segs[0]!.first).toBe(segs[0]!.last);
    expect(segs[0]!.first.startsWith("54,")).toBe(true);
    expect(segs[2]!.first).toBe(segs[2]!.last);
    expect(segs[2]!.first.startsWith("59,")).toBe(true);
    // 兩點以上的段照常（x = 56 → 57）
    expect(segs[1]!.first.startsWith("56,")).toBe(true);
    expect(segs[1]!.last.startsWith("57,")).toBe(true);
    for (const line of w.findAll("polyline")) {
      expect(line.classes()).toContain("stroke-accent");
      expect(line.attributes("stroke-width")).toBe("1.5");
      expect(line.attributes("stroke-linecap")).toBe("round");
      expect(line.attributes("vector-effect")).toBe("non-scaling-stroke");
    }
  });

  it("只有一筆有效樣本時也畫圓點（不再整條走勢線空白）", () => {
    const segs = shape(mountSpark([sample(50, 10)]));
    expect(segs).toHaveLength(1);
    expect(segs[0]!.n).toBe(2);
    expect(segs[0]!.first).toBe(segs[0]!.last);
  });
});

describe("Sparkline 讀屏摘要的「最近 1 秒」（合併門第 2 輪 low：區分暫停不計與無批次）", () => {
  it("最新一格為無效樣本（暫停期間、恢復當下）→「最近 1 秒暫停不計」", () => {
    expect(label(mountSpark([sample(50, 10), sample(300, 1, true)]))).toBe(
      "近 60 秒走勢，最近 1 秒暫停不計，區間 5.0 至 5.0 比 1",
    );
    // 無效且批次為 0 也以「暫停不計」為準
    expect(label(mountSpark([sample(50, 10), sample(0, 0, true)]))).toContain("最近 1 秒暫停不計");
  });

  it("最新一格批次為 0 →「最近 1 秒無批次」", () => {
    expect(label(mountSpark([sample(50, 10), sample(30, 0)]))).toBe(
      "近 60 秒走勢，最近 1 秒無批次，區間 5.0 至 5.0 比 1",
    );
  });

  it("最新一格有比值 → 念數字", () => {
    expect(label(mountSpark([sample(50, 10), sample(60, 10)]))).toBe(
      "近 60 秒走勢，最近 1 秒合併比 6.0 比 1，區間 5.0 至 6.0 比 1",
    );
  });
});
