// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import BackpressureStrip from "./BackpressureStrip.vue";
import type { RateSample } from "../../domains/monitoring/lib/rate-series.js";

/**
 * 背壓 strip（spec FR-009／FR-009a／FR-010／FR-011、US2；tasks T037）。
 * 只收 props，不需 store：直接以樣本與衍生值掛載。高度與實際排版由主 session 截圖驗證，
 * 這裡驗結構（誰和誰同一個容器、手機省略項的 class、恆佔位的格子）。
 */

let wrapper: VueWrapper | null = null;

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
});

const sample = (msgsPerSec: number, batchesPerSec: number, droppedPerSec = 0): RateSample => ({
  t: 0,
  msgsPerSec,
  batchesPerSec,
  droppedPerSec,
});

type Props = InstanceType<typeof BackpressureStrip>["$props"];

function mountStrip(overrides: Partial<Props> = {}): VueWrapper {
  wrapper = mount(BackpressureStrip, {
    props: {
      samples: [sample(40, 10), sample(44, 10)],
      peak: 44,
      windowRatio: 4.2,
      cumulativeRatio: 5,
      dropped: 0,
      stale: false,
      msgsPerSec: 44,
      batchesPerSec: 10,
      ...overrides,
    },
  });
  return wrapper;
}

const text = (w: VueWrapper): string => w.text().replace(/\s+/g, " ");
const level = (w: VueWrapper) => w.find(".bp-level");
const regionName = (w: VueWrapper) => w.get('[data-fg="backpressure"]').attributes("aria-label");

describe("BackpressureStrip", () => {
  it("比值大字是 60 秒視窗比值（一位小數），累計比值不上畫面、只在 tooltip", () => {
    const w = mountStrip({ windowRatio: 4.25, cumulativeRatio: 9 });
    const ratio = w.get('[data-fg="ratio"]');
    expect(ratio.text()).toBe("4.3");
    expect(ratio.classes()).toContain("text-ratio");
    expect(ratio.classes()).toContain("font-mono");
    expect(text(w)).not.toContain("9:1");
    expect(w.get('[title*="自載入起累計"]').attributes("title")).toContain("自載入起累計 9:1");
  });

  it("根節點是 data-fg=backpressure 的 region，名稱含目前比值與累計比值", () => {
    const w = mountStrip();
    expect(w.get('[data-fg="backpressure"]').attributes("role")).toBe("region");
    expect(regionName(w)).toBe("背壓，比值 4.2 比 1，自載入起累計 5 比 1");
  });

  it("尚無批次時累計比值顯示「—」，region 名稱不念累計", () => {
    const w = mountStrip({ cumulativeRatio: null });
    expect(w.get('[title*="自載入起累計"]').attributes("title")).toContain("自載入起累計 —");
    expect(regionName(w)).toBe("背壓，比值 4.2 比 1");
  });

  it("三組讀數：每秒訊息 → 每秒批次 → 比值", () => {
    const w = mountStrip({ msgsPerSec: 1240, batchesPerSec: 60 });
    const t = text(w);
    expect(t).toContain("每秒訊息 1,240");
    expect(t).toContain("每秒批次 60");
    expect(t.indexOf("每秒訊息")).toBeLessThan(t.indexOf("每秒批次"));
    expect(t.indexOf("每秒批次")).toBeLessThan(t.indexOf("比值"));
  });

  it("尚無比值時顯示「—」、不畫液位線，「:1」仍恆佔位（invisible）", () => {
    const w = mountStrip({
      windowRatio: null,
      cumulativeRatio: null,
      samples: [],
      msgsPerSec: null,
      batchesPerSec: null,
    });
    expect(w.get('[data-fg="ratio"]').text()).toBe("—");
    expect(level(w).exists()).toBe(false);
    expect(regionName(w)).toBe("背壓，比值尚無資料");
    expect(w.get(".bp-ratio-unit").classes()).toContain("invisible");
  });

  it("有比值時「:1」可見", () => {
    expect(mountStrip().get(".bp-ratio-unit").classes()).not.toContain("invisible");
  });

  it("丟棄數為 0 時不渲染；> 0 時以警示色顯示", async () => {
    const w = mountStrip({ dropped: 0 });
    expect(text(w)).not.toContain("丟棄");

    await w.setProps({ dropped: 1234 });
    expect(text(w)).toContain("丟棄 1,234 筆");
    const dropped = w.get(".bp-status").findAll("span").find((s) => s.text().startsWith("丟棄"));
    expect(dropped?.classes()).toContain("text-warn-fg");
  });

  it("手機的丟棄數位置恆存在：無丟棄時為空，> 0 時顯示「丟棄 N」警示色", async () => {
    const w = mountStrip({ dropped: 0 });
    const mobile = () => w.get(".bp-dropped-mobile");
    expect(mobile().classes()).toContain("md:hidden");
    expect(mobile().text()).toBe("");

    await w.setProps({ dropped: 7 });
    expect(mobile().text().replace(/\s+/g, " ")).toBe("丟棄 7");
    expect(mobile().classes()).toContain("text-warn-fg");
  });

  it("stale 時顯示「連線中斷」，region 名稱一併說明", () => {
    const w = mountStrip({ stale: true });
    expect(text(w)).toContain("連線中斷");
    expect(regionName(w)).toBe("背壓，比值 4.2 比 1，自載入起累計 5 比 1，連線中斷");
    expect(w.get('[data-fg="backpressure"]').attributes("data-stale")).toBe("true");
  });

  it("未 stale 時不顯示「連線中斷」", () => {
    expect(text(mountStrip())).not.toContain("連線中斷");
  });

  it("狀態欄（中斷、丟棄）與走勢線同在走勢區內：窄版換列時整區一起移動、不自成一列", () => {
    const w = mountStrip({ stale: true, dropped: 3 });
    const trend = w.get(".bp-trend");
    expect(trend.find('svg[role="img"][aria-label^="近 60 秒走勢"]').exists()).toBe(true);
    expect(trend.get(".bp-status").text()).toContain("連線中斷");
    expect(trend.get(".bp-status").text()).toContain("丟棄");
    // 走勢區固定高度（h-12），狀態出現只壓縮走勢線寬度
    expect(trend.classes()).toContain("h-12");
  });

  it("手機省略的項目（每秒批次、走勢區、桌機版刻度列、箭頭）都帶 hidden + md:*；手機改用 .bp-scale-mobile", () => {
    const w = mountStrip();
    for (const sel of [".bp-batches", ".bp-trend", ".bp-scale"]) {
      const classes = w.get(sel).classes();
      expect(classes, sel).toContain("hidden");
      expect(classes, sel).toContain("md:flex");
    }
    const arrows = w.findAll(".bp-arrow");
    expect(arrows).toHaveLength(2);
    for (const arrow of arrows) expect(arrow.classes()).toEqual(expect.arrayContaining(["hidden", "md:block"]));
  });

  it("液位線位置 = 比值 / 60（比值刻度 0–60、線性），以 transform 位移", () => {
    const w = mountStrip({ windowRatio: 15 });
    expect(level(w).attributes("style")).toContain("translateX(25%)");
    expect(level(w).attributes("data-over")).toBeUndefined();
    expect(text(w)).not.toContain(">60");
  });

  it("比值 ≤ 60 時「>60」格仍存在且為空（恆佔位）", () => {
    const over = mountStrip({ windowRatio: 60 }).get(".bp-over");
    expect(over.text()).toBe("");
    expect(over.classes()).toContain("w-7");
  });

  it("比值 > 60 時液位線釘右端並標「>60」，數字照實顯示", () => {
    const w = mountStrip({ windowRatio: 84.04 });
    expect(level(w).attributes("style")).toContain("translateX(100%)");
    expect(level(w).attributes("data-over")).toBe("true");
    expect(w.get(".bp-over").text()).toBe(">60");
    expect(w.get('[data-fg="ratio"]').text()).toBe("84.0");
  });

  it("比值刻度 0–60：每 10 格標數字，含 aria 名稱", () => {
    const w = mountStrip();
    const scale = w.get('[role="img"][aria-label="背壓比值刻度 0 到 60"]');
    expect(scale.findAll("span").map((s) => s.text())).toEqual(["0", "10", "20", "30", "40", "50", "60"]);
    expect(scale.findAll("line")).toHaveLength(1 + 61); // 底線 + 0..60 每格一條
  });

  it("手機版（< md）也有比值刻度：compact 版每 10 格標數字、18px 高，且只在手機顯示（md:hidden）", () => {
    const w = mountStrip();
    const mobile = w.get(".bp-scale-mobile");
    expect(mobile.classes()).toEqual(expect.arrayContaining(["flex", "md:hidden"]));
    expect(mobile.classes()).not.toContain("hidden");
    const scale = mobile.get('[role="img"][aria-label="背壓比值刻度 0 到 60"]');
    expect(scale.classes()).toContain("h-[18px]");
    expect(scale.findAll("span").map((s) => s.text())).toEqual(["0", "10", "20", "30", "40", "50", "60"]);
    expect(scale.findAll("line")).toHaveLength(1 + 61);
    expect(scale.get("svg").classes()).toContain("h-1.5");
    // 桌機刻度仍是一般尺寸
    expect(w.get(".bp-scale").get('[role="img"]').classes()).toContain("h-6");
  });

  it("手機液位線：2px 深青短線，位置 = 比值 / 60；> 60 釘右端並標「>60」", async () => {
    const w = mountStrip({ windowRatio: 15 });
    const line = () => w.get(".bp-level-mobile");
    expect(line().attributes("style")).toContain("translateX(25%)");
    expect(line().get("span").classes()).toEqual(expect.arrayContaining(["w-0.5", "bg-accent"]));
    expect(w.get(".bp-over-mobile").text()).toBe("");
    await w.setProps({ windowRatio: 84.04 });
    expect(line().attributes("style")).toContain("translateX(100%)");
    expect(line().attributes("data-over")).toBe("true");
    expect(w.get(".bp-over-mobile").text()).toBe(">60");
  });

  it("手機刻度列恆渲染（無比值、丟棄、斷線都不改變結構）；無比值時不畫液位線，「>60」格恆佔位", () => {
    const w = mountStrip({ windowRatio: null, dropped: 3, stale: true });
    expect(w.get(".bp-scale-mobile").find('[role="img"]').exists()).toBe(true);
    expect(w.find(".bp-level-mobile").exists()).toBe(false);
    expect(w.get(".bp-over-mobile").classes()).toContain("w-7");
  });

  it("走勢線：兩條 polyline（訊息實線、批次虛線），文字摘要與「近 60 秒」標示", () => {
    const w = mountStrip({ samples: [sample(40, 10), sample(44, 10)], peak: 44 });
    const spark = w.get('svg[role="img"][aria-label^="近 60 秒走勢"]');
    expect(spark.attributes("aria-label")).toBe("近 60 秒走勢，目前每秒訊息 44、每秒批次 10");
    expect(spark.attributes("preserveAspectRatio")).toBe("none");
    const lines = spark.findAll("polyline");
    expect(lines).toHaveLength(2);
    expect(lines[0]!.attributes("stroke-dasharray")).toBeUndefined();
    expect(lines[1]!.attributes("stroke-dasharray")).toBeDefined();
    // 靠右對齊：最新一筆在 x=59，峰值貼近頂端（y=1）
    expect(lines[0]!.attributes("points")).toBe("58,3 59,1");
    expect(text(w)).toContain("近 60 秒");
  });
});
