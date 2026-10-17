// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import Sparkline from "./Sparkline.vue";
import { totalOf, type RateSample } from "../../domains/monitoring/lib/rate-series.js";

const sample = (msgsPerSec: number, batchesPerSec: number, invalid = false): RateSample => ({
  t: 0,
  msgsPerSec,
  batchesPerSec,
  droppedPerSec: 0,
  ...(invalid ? { invalid: true as const } : {}),
});

describe("Sparkline y 軸上限（合併門第 1 輪 low：視窗比值改用 rate-series 的 totalOf，不另寫迴圈）", () => {
  it("視窗合併比 = totalOf(訊息) ÷ totalOf(批次)（排除無效樣本），上限 = max(視窗 × 2, 次高) × 1.25", () => {
    // 有效：10:1、2:1 → 視窗 120 ÷ 20 = 6；無效的 600:1 離群不計入上限、該格斷線
    const samples = [sample(100, 10), sample(20, 10), sample(600, 1, true)];
    expect(totalOf(samples, "msgsPerSec") / totalOf(samples, "batchesPerSec")).toBe(6);
    const w = mount(Sparkline, { props: { samples } });
    // top = max(6 × 2, 次高 2) × 1.25 = 15；scale = 22 / 15；y = 23 − r × scale（10 → 8.33、2 → 20.07）
    const lines = w.findAll("polyline");
    expect(lines).toHaveLength(1);
    expect(lines[0]!.attributes("points")).toBe("57,8.33 58,20.07");
  });
});
