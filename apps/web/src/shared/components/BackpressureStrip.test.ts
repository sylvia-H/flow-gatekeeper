// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import BackpressureStrip from "./BackpressureStrip.vue";
import type { RateSample } from "../lib/rate-series.js";

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
    expect(w.get('[title*="自載入起累計"]').attributes("title")).toContain("自載入起累計 9.0:1");
  });

  it("根節點是 data-fg=backpressure 的 region，名稱含目前比值的白話、最高水位與累計比值", () => {
    const w = mountStrip();
    expect(w.get('[data-fg="backpressure"]').attributes("role")).toBe("region");
    expect(regionName(w)).toBe(
      "背壓，合併比 4.2 比 1，每幀平均合併 4.2 則訊息，近 60 秒最高 4.4 比 1，自載入起累計 5.0 比 1",
    );
  });

  it("累計比值與視窗值同用一位小數：1.4 顯示「1.4」而非取整成 1（合併門第 1 輪 low）", () => {
    const w = mountStrip({ cumulativeRatio: 1.4 });
    expect(w.get('[title*="自載入起累計"]').attributes("title")).toContain("自載入起累計 1.4:1");
    expect(regionName(w)).toContain("自載入起累計 1.4 比 1");
  });

  it("尚無批次時累計比值顯示「—」，region 名稱不念累計", () => {
    const w = mountStrip({ cumulativeRatio: null });
    expect(w.get('[title*="自載入起累計"]').attributes("title")).toContain("自載入起累計 —");
    expect(regionName(w)).toBe("背壓，合併比 4.2 比 1，每幀平均合併 4.2 則訊息，近 60 秒最高 4.4 比 1");
  });

  it("比值 tooltip：白話「每幀平均合併 N 則訊息」、1:1 的意義與近 60 秒最高水位", () => {
    const title = mountStrip().get('[title*="自載入起累計"]').attributes("title");
    expect(title).toBe(
      "近 60 秒訊息總數 ÷ 批次總數（每幀一批）：每幀平均合併 4.2 則訊息；" +
        "1:1 表示每則訊息各自重繪、沒有合併；比值越高，代表替畫面省下越多次重繪；" +
        "近 60 秒最高 4.4:1（刻度上的細短線）；自載入起累計 5.0:1",
    );
  });

  it("常駐白話行（≥ md）：「每幀合併約 N 則 · 近 60 秒最高 X」，在走勢區內、走勢線左側，全文同 title", () => {
    // 單秒 4、4.4；視窗 4.2 → 約 4；最高水位 4.4
    const w = mountStrip();
    const plain = w.get('[data-fg="ratio-plain"]');
    expect(plain.text()).toBe("每幀合併約 4 則 · 近 60 秒最高 4.4");
    expect(plain.attributes("title")).toBe("每幀合併約 4 則 · 近 60 秒最高 4.4");
    expect(plain.classes()).toEqual(expect.arrayContaining(["text-xs", "text-ink-3", "min-w-0"]));
    // 同樣內容由 region 名稱念（合併比、最高水位），白話行不重複朗讀
    expect(plain.attributes("aria-hidden")).toBe("true");
    expect(regionName(w)).toContain("近 60 秒最高 4.4 比 1");
    // 在走勢區（hidden md:flex、固定 h-12）內，排在走勢線之前：不增加 strip 高度，手機不顯示
    const trend = w.get(".bp-trend");
    expect(trend.element.firstElementChild).toBe(plain.element);
    expect(plain.get("span").classes()).toContain("truncate");
  });

  it("常駐白話行：取整後 ≤ 1 說「幾乎無合併」；無比值時恆渲染「—」；無最高水位時不帶後半", async () => {
    const w = mountStrip({ samples: [sample(12, 10)], windowRatio: 1.2 });
    const plain = () => w.get('[data-fg="ratio-plain"]').text();
    expect(plain()).toBe("每幀約 1 則 · 幾乎無合併 · 近 60 秒最高 1.2");
    await w.setProps({ samples: [sample(10, 0)], windowRatio: null });
    expect(plain()).toBe("每幀合併約 — 則");
  });

  it("常駐白話行排除無效樣本（暫停期間、恢復當下）：最高水位不被離群值拉高", () => {
    const resume: RateSample = { t: 0, msgsPerSec: 300, batchesPerSec: 1, droppedPerSec: 0, invalid: true };
    const w = mountStrip({ samples: [sample(50, 10), resume, sample(61, 10)], windowRatio: 5.55 });
    expect(w.get('[data-fg="ratio-plain"]').text()).toBe("每幀合併約 6 則 · 近 60 秒最高 6.1");
  });

  it("三組讀數：每秒訊息 → 每秒批次 → 合併比，標籤標明「近 60 秒」", () => {
    const w = mountStrip({ samples: [sample(1200, 60), sample(1280, 60)], msgsPerSec: 1280, batchesPerSec: 60 });
    const t = text(w);
    expect(t).toContain("每秒訊息 · 近 60 秒");
    expect(t).toContain("每秒批次 · 近 60 秒");
    expect(w.get(".bp-msgs").text()).toMatch(/1,240$/);
    expect(w.get(".bp-batches").text()).toMatch(/60$/);
    expect(t.indexOf("每秒訊息")).toBeLessThan(t.indexOf("每秒批次"));
    expect(t.indexOf("每秒批次")).toBeLessThan(t.indexOf("合併比"));
  });

  it("每秒訊息／每秒批次是近 60 秒平均（與比值同一個視窗，相除即比值），不是最近 1 秒", () => {
    // 三秒：訊息 300／330／360、批次 50／50／50 → 平均 330 與 50，比值 = 990 ÷ 150 = 6.6
    const w = mountStrip({
      samples: [sample(300, 50), sample(330, 50), sample(360, 50)],
      windowRatio: 6.6,
      msgsPerSec: 360,
      batchesPerSec: 49,
    });
    expect(w.get(".bp-msgs").text()).toContain("330");
    expect(w.get(".bp-msgs").text()).not.toContain("360");
    expect(w.get(".bp-batches").text()).toContain("50");
    expect(w.get('[data-fg="ratio"]').text()).toBe("6.6");
  });

  it("讀數 tooltip 放視窗總量與最近 1 秒瞬時值", () => {
    const w = mountStrip({ samples: [sample(1200, 60), sample(1280, 61)], msgsPerSec: 1280, batchesPerSec: 61 });
    expect(w.get(".bp-msgs").attributes("title")).toBe("近 60 秒平均：2 秒共 2,480 則 ÷ 2；最近 1 秒 1,280");
    expect(w.get(".bp-batches").attributes("title")).toBe("近 60 秒平均：2 秒共 121 批 ÷ 2；最近 1 秒 61");
  });

  it("無樣本時讀數為「—」，tooltip 說明尚無資料", () => {
    const w = mountStrip({ samples: [], windowRatio: null, msgsPerSec: null, batchesPerSec: null });
    expect(w.get(".bp-msgs").text()).toContain("—");
    expect(w.get(".bp-msgs").attributes("title")).toBe("近 60 秒平均：尚無資料；最近 1 秒 —");
  });

  it("「:1」緊貼數字：最小寬度給整組（md+），數字本身不撐寬", () => {
    const w = mountStrip();
    expect(w.get('[data-fg="ratio"]').classes().some((c) => c.startsWith("min-w"))).toBe(false);
    expect(w.get(".bp-ratio-group").classes()).toContain("md:min-w-24");
    expect(w.get(".bp-ratio-group").element.lastElementChild?.classList.contains("bp-ratio-unit")).toBe(true);
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
    expect(regionName(w)).toBe("背壓，合併比尚無資料");
    expect(w.get(".bp-ratio-unit").classes()).toContain("invisible");
  });

  it("有比值時「:1」可見", () => {
    expect(mountStrip().get(".bp-ratio-unit").classes()).not.toContain("invisible");
  });

  it("丟棄數為 0 時不渲染；> 0 時以警示色顯示", async () => {
    const w = mountStrip({ dropped: 0 });
    expect(text(w)).not.toContain("丟棄");

    await w.setProps({ dropped: 1234 });
    expect(text(w)).toContain("丟棄 1,234 則");
    const dropped = w.get(".bp-status").findAll("span").find((s) => s.text().startsWith("丟棄"));
    expect(dropped?.classes()).toContain("text-warn-fg");
    // 用語統一：桌機、手機、tooltip、region 名稱都是「丟棄 N 則」
    expect(dropped?.attributes("title")).toBe("近 60 秒丟棄 1,234 則訊息（buffer 溢位合併或格式不符被剔除）");
    expect(w.get(".bp-dropped-mobile").attributes("title")).toBe(dropped?.attributes("title"));
    expect(regionName(w)).toContain("，近 60 秒丟棄 1,234 則");
    expect(text(w)).not.toContain("筆");
  });

  it("手機的丟棄數位置恆存在：無丟棄時為空，> 0 時顯示「丟棄 N 則」警示色", async () => {
    const w = mountStrip({ dropped: 0 });
    const mobile = () => w.get(".bp-dropped-mobile");
    expect(mobile().classes()).toContain("md:hidden");
    expect(mobile().text()).toBe("");

    await w.setProps({ dropped: 7 });
    expect(mobile().text().replace(/\s+/g, " ")).toBe("丟棄 7 則");
    expect(mobile().classes()).toContain("text-warn-fg");
  });

  it("stale 時 pill 與 TopBar 連線 chip 同字「已斷線」，region 名稱一併說明", () => {
    const w = mountStrip({ stale: true, connection: "disconnected" });
    expect(w.get(".bp-status").text()).toBe("已斷線");
    expect(text(w)).not.toContain("連線中斷");
    expect(regionName(w)).toBe(
      "背壓，合併比 4.2 比 1，每幀平均合併 4.2 則訊息，近 60 秒最高 4.4 比 1，自載入起累計 5.0 比 1，已斷線",
    );
    expect(w.get('[data-fg="backpressure"]').attributes("data-stale")).toBe("true");
  });

  it("重新連線中：pill 與 chip 同字「重新連線中」；未傳 connection 時預設「已斷線」", async () => {
    const w = mountStrip({ stale: true, connection: "reconnecting" });
    expect(w.get(".bp-status").text()).toBe("重新連線中");
    expect(regionName(w)).toMatch(/，重新連線中$/);
    await w.setProps({ connection: undefined });
    expect(w.get(".bp-status").text()).toBe("已斷線");
  });

  it("未 stale 時不顯示斷線 pill", () => {
    const t = text(mountStrip({ connection: "connected" }));
    expect(t).not.toContain("已斷線");
    expect(t).not.toContain("重新連線中");
  });

  it("狀態欄（中斷、丟棄）與走勢線同在走勢區內：窄版換列時整區一起移動、不自成一列", () => {
    const w = mountStrip({ stale: true, dropped: 3 });
    const trend = w.get(".bp-trend");
    expect(trend.find('svg[role="img"][aria-label^="近 60 秒走勢"]').exists()).toBe(true);
    expect(trend.get(".bp-status").text()).toContain("已斷線");
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
    const scale = w.get('[role="img"][aria-label="背壓比值刻度 0 到 60，1 比 1 處標示無合併"]');
    expect(scale.findAll("span:not(.grad-unity-label)").map((s) => s.text())).toEqual([
      "0",
      "10",
      "20",
      "30",
      "40",
      "50",
      "60",
    ]);
    expect(scale.findAll("line:not(.grad-high-water):not(.grad-unity)")).toHaveLength(1 + 61); // 底線 + 0..60 每格一條
  });

  it("1:1 錨點：桌機與手機刻度都有一條往下突出的 ink-3 短線（x = 1 格）與靠左起排的「1:1」標字", () => {
    const w = mountStrip();
    for (const [sel, y2] of [
      [".bp-scale", "12"],
      [".bp-scale-mobile", "9"],
    ] as const) {
      const line = w.get(sel).get(".grad-unity");
      expect(line.attributes("x1"), sel).toBe("10");
      expect(line.attributes("x2"), sel).toBe("10");
      expect(line.attributes("y1"), sel).toBe("0");
      // 往下延伸進數字列（一般 8+4、compact 6+3），與往上突出的最高水位短線方向相反
      expect(line.attributes("y2"), sel).toBe(y2);
      expect(line.classes(), sel).toContain("stroke-ink-3");
      const label = w.get(sel).get(".grad-unity-label");
      expect(label.text(), sel).toBe("1:1");
      expect(label.attributes("style"), sel).toContain("left: 1.66");
      // 靠左起排（不置中），才不與置中的「0」重疊
      expect(label.classes().some((c) => c.includes("translate-x")), sel).toBe(false);
      expect(label.classes(), sel).toEqual(expect.arrayContaining(["font-mono", "text-xs", "text-ink-3"]));
      expect(label.attributes("title"), sel).toContain("沒有合併");
    }
    // compact 刻度窄、錨點線緊貼「0」：標字離線 6px（一般 3px），不讀成「01:1」
    expect(w.get(".bp-scale .grad-unity-label").classes()).toContain("ml-[3px]");
    expect(w.get(".bp-scale-mobile .grad-unity-label").classes()).toContain("ml-1.5");
  });

  it("手機版（< md）也有比值刻度：compact 版每 10 格標數字、18px 高，且只在手機顯示（md:hidden）", () => {
    const w = mountStrip();
    const mobile = w.get(".bp-scale-mobile");
    expect(mobile.classes()).toEqual(expect.arrayContaining(["flex", "md:hidden"]));
    expect(mobile.classes()).not.toContain("hidden");
    const scale = mobile.get('[role="img"][aria-label="背壓比值刻度 0 到 60，1 比 1 處標示無合併"]');
    expect(scale.classes()).toContain("h-[18px]");
    expect(scale.findAll("span:not(.grad-unity-label)").map((s) => s.text())).toEqual([
      "0",
      "10",
      "20",
      "30",
      "40",
      "50",
      "60",
    ]);
    expect(scale.findAll("line:not(.grad-high-water):not(.grad-unity)")).toHaveLength(1 + 61);
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

  it("最高水位：桌機與手機刻度各一條 1px ink-3 短線，位置 = 視窗內單秒比值最大值 / 60", () => {
    // 單秒比值 4、15、5；視窗比值 (40+150+50)/(10+10+10) = 8 → 最高水位 15 → x = 150（viewBox 0–600）
    const w = mountStrip({ samples: [sample(40, 10), sample(150, 10), sample(50, 10)], windowRatio: 8 });
    for (const sel of [".bp-scale", ".bp-scale-mobile"]) {
      const mark = w.get(sel).get(".grad-high-water");
      expect(mark.attributes("x1"), sel).toBe("150");
      expect(mark.attributes("x2"), sel).toBe("150");
      expect(mark.attributes("stroke-width"), sel).toBe("1");
      expect(mark.classes(), sel).toContain("stroke-ink-3");
    }
    expect(regionName(w)).toContain("近 60 秒最高 15.0 比 1");
  });

  it("最高水位 > 60 釘右端；視窗內無批次時不畫", async () => {
    const w = mountStrip({ samples: [sample(900, 10)], windowRatio: 90 });
    expect(w.get(".bp-scale .grad-high-water").attributes("x1")).toBe("600");
    await w.setProps({ samples: [sample(10, 0)], windowRatio: null });
    expect(w.find(".grad-high-water").exists()).toBe(false);
    expect(regionName(w)).not.toContain("最高");
  });

  it("走勢線：只畫單秒合併比一條（深青實線），文字摘要與「近 60 秒」標示", () => {
    // 單秒合併比 4、5；視窗 90 ÷ 20 = 4.5（strip 的 windowRatio 傳給走勢線）→ 上限 = max(4.5 × 2, 次高 4) × 1.25 = 11.25；
    // scale = 22 / 11.25
    const w = mountStrip({ samples: [sample(40, 10), sample(50, 10)], windowRatio: 4.5 });
    const spark = w.get('svg[role="img"][aria-label^="近 60 秒走勢"]');
    expect(spark.attributes("aria-label")).toBe("近 60 秒走勢，最近 1 秒合併比 5.0 比 1，區間 4.0 至 5.0 比 1");
    expect(spark.attributes("preserveAspectRatio")).toBe("none");
    const lines = spark.findAll("polyline");
    expect(lines).toHaveLength(1);
    expect(lines[0]!.classes()).toContain("stroke-accent");
    expect(lines[0]!.attributes("stroke-dasharray")).toBeUndefined();
    // 靠右對齊：最新一筆在 x=59；y = 24 − 1 − r × scale（4 → 15.18、5 → 13.22），0 為底、頂端留白
    expect(lines[0]!.attributes("points")).toBe("58,15.18 59,13.22");
    expect(text(w)).toContain("近 60 秒");
  });

  it("走勢線：無效樣本（暫停期間、恢復當下）處斷線，不計入摘要區間與 y 軸上限", () => {
    const resume: RateSample = { t: 0, msgsPerSec: 300, batchesPerSec: 1, droppedPerSec: 0, invalid: true };
    const w = mountStrip({ samples: [sample(40, 10), sample(50, 10), resume, sample(60, 10)], windowRatio: 5 });
    const spark = w.get('svg[role="img"][aria-label^="近 60 秒走勢"]');
    const lines = spark.findAll("polyline").map((l) => l.attributes("points")!.split(" "));
    expect(lines).toHaveLength(2);
    expect(lines[0]![0]).not.toBe(lines[0]![1]);
    // 無效樣本後只剩一秒的段：兩個相同座標畫成圓點（合併門第 2 輪 low），x = 最新一格 59
    expect(lines[1]![0]).toBe(lines[1]![1]);
    expect(lines[1]![0]!.startsWith("59,")).toBe(true);
    expect(spark.find("circle").exists()).toBe(false);
    expect(spark.attributes("aria-label")).toBe("近 60 秒走勢，最近 1 秒合併比 6.0 比 1，區間 4.0 至 6.0 比 1");
    // 讀數與 tooltip 也只算有效的三秒
    expect(w.get(".bp-msgs").text()).toContain("50");
    expect(w.get(".bp-msgs").attributes("title")).toBe("近 60 秒平均：3 秒共 150 則 ÷ 3；最近 1 秒 44");
  });

  it("走勢線：y 軸上限取穩健值，單一秒離群不把其餘壓成平線（離群點釘頂）", () => {
    // 59 秒 5:1 加 1 秒 60:1（未標無效的離群，例如背景分頁回來）
    const samples = [...Array.from({ length: 59 }, () => sample(50, 10)), sample(600, 10)];
    const w = mountStrip({ samples, windowRatio: 650 / 60 });
    const points = w.get('svg[role="img"][aria-label^="近 60 秒走勢"] polyline').attributes("points")!.split(" ");
    const ys = points.map((p) => Number(p.split(",")[1]));
    // 上限 = max(視窗 ≈10.83 × 2, 次高 5) × 1.25 ≈ 27.08：5:1 落在約 15%～20% 高度以上，不貼底
    expect(ys[0]).toBeLessThan(23 - 3);
    // 離群點釘頂（y = PAD = 1）
    expect(ys[ys.length - 1]).toBe(1);
  });

  it("走勢線：該秒無批次時線斷開（不補 0），無任何批次時摘要說明尚無資料", async () => {
    const w = mountStrip({ samples: [sample(40, 10), sample(30, 0), sample(50, 10), sample(60, 10)], windowRatio: 4.5 });
    const spark = () => w.get('svg[role="img"][aria-label^="近 60 秒走勢"]');
    const lines = spark().findAll("polyline").map((l) => l.attributes("points")!.split(" "));
    expect(lines).toHaveLength(2);
    // 斷開前的單點段：兩個相同座標畫成圓點（x = 56），不消失
    expect(lines[0]![0]).toBe(lines[0]![1]);
    expect(lines[0]![0]!.startsWith("56,")).toBe(true);
    expect(lines[1]![0]).not.toBe(lines[1]![1]);
    await w.setProps({ samples: [sample(10, 0)], windowRatio: null });
    expect(spark().findAll("polyline")).toHaveLength(0);
    expect(spark().attributes("aria-label")).toBe("近 60 秒走勢，尚無合併比資料");
  });

  it("走勢線的圖例短線已移除：讀數標籤不再帶訊息實線／批次虛線的 svg", () => {
    const w = mountStrip();
    expect(w.get(".bp-msgs").find("svg").exists()).toBe(false);
    expect(w.get(".bp-batches").find("svg").exists()).toBe(false);
  });

  it("合併比標籤就地說明「訊息 ÷ 批次」（md+ 顯示、手機只留「合併比」；不重複走勢線的「近 60 秒」）", () => {
    const w = mountStrip();
    const hint = w.get(".bp-ratio .bp-ratio-hint");
    expect(hint.text()).toBe("· 訊息 ÷ 批次");
    expect(hint.classes()).toEqual(expect.arrayContaining(["hidden", "md:inline", "text-ink-3"]));
    expect(w.get(".bp-ratio").text().replace(/\s+/g, " ")).toMatch(/^合併比 · 訊息 ÷ 批次 ?[—0-9]/);
  });

  it("液柱：桌機與手機刻度各一段實心 accent/25，從 0 到液位（scaleX = 比值 / 60），不用漸層", async () => {
    const w = mountStrip({ windowRatio: 15 });
    for (const sel of [".bp-scale", ".bp-scale-mobile"]) {
      const liquid = w.get(sel).get(".grad-liquid");
      expect(liquid.attributes("style"), sel).toContain("scaleX(0.25)");
      expect(liquid.classes(), sel).toEqual(expect.arrayContaining(["bg-accent/25", "origin-left", "left-0"]));
      expect(liquid.classes().some((c) => c.startsWith("bg-gradient")), sel).toBe(false);
    }
    expect(w.get(".bp-scale .grad-liquid").classes()).toContain("h-2");
    expect(w.get(".bp-scale-mobile .grad-liquid").classes()).toContain("h-1.5");
    // 刻度線疊在液柱之上：svg 為 relative，且在 DOM 中排在液柱之後
    const scale = w.get(".bp-scale").get('[role="img"]');
    expect(scale.get("svg").classes()).toContain("relative");
    expect(scale.element.firstElementChild?.classList.contains("grad-liquid")).toBe(true);

    await w.setProps({ windowRatio: 84.04 });
    expect(w.get(".bp-scale .grad-liquid").attributes("style")).toContain("scaleX(1)");
    await w.setProps({ windowRatio: null });
    expect(w.find(".grad-liquid").exists()).toBe(false);
  });

  it("暫停時狀態欄比照斷線 pill 顯示「已暫停」pill，region 名稱一併說明", async () => {
    const w = mountStrip({ paused: true });
    const pill = w.get('.bp-status [data-fg="bp-paused"]');
    expect(pill.text()).toBe("已暫停");
    expect(pill.classes()).toEqual(expect.arrayContaining(["rounded-pill", "border-edge", "text-xs"]));
    expect(regionName(w)).toMatch(/，已暫停畫面更新$/);
    await w.setProps({ paused: false });
    expect(w.find('[data-fg="bp-paused"]').exists()).toBe(false);
    expect(w.find(".bp-status").exists()).toBe(false);
  });

  it("暫停中又斷線：狀態欄只顯示「已斷線」（至多兩行，走勢區高度不變）", () => {
    const w = mountStrip({ paused: true, stale: true, dropped: 2 });
    const status = w.get(".bp-status");
    expect(status.text()).toContain("已斷線");
    expect(status.text()).not.toContain("已暫停");
    expect(status.findAll(":scope > span")).toHaveLength(2);
  });
});
