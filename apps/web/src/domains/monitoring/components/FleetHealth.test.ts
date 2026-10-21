// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { mount, type DOMWrapper, type VueWrapper } from "@vue/test-utils";
import { defineComponent, h, nextTick, ref } from "vue";
import FleetHealth from "./FleetHealth.vue";
import AnomalyOverlay from "./AnomalyOverlay.vue";
import type { FleetHealthSummary } from "../lib/fleet-health.js";
import type { AnomalySummaryItem } from "../lib/anomaly-latch.js";

/**
 * FleetHealth（T061／T064；FR-033a、ui-contract §3）：
 * - 預設版面（rail 面板）維持 Phase 3 的標題、總台數、兩欄圖例與比例條；
 * - `compact` 摘要條（`data-fg="fleet-summary-bar"`）：比例條＋四計數一列、整條一顆鈕，
 *   點擊 emit `toggle`，`aria-expanded` 反映 `expanded`；
 * - 與 AnomalyOverlay 接起來：點摘要條展開異常清單覆蓋層、再點（落在遮罩上）收合。
 */

// 四類數值各不相同，任一段對錯欄位都會被抓到。
const SUMMARY: FleetHealthSummary = { healthy: 4, warning: 3, critical: 2, stale: 1, total: 10 };

let wrapper: VueWrapper | null = null;

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  document.body.innerHTML = "";
});

const text = (el: { text(): string }): string => el.text().replace(/\s+/g, " ").trim();

/** 計數項的「標籤 數字」：各段是相鄰 span，textContent 之間沒有空白，逐段取再接。 */
const countText = (el: DOMWrapper<Element>): string =>
  el.findAll("span").map((s) => s.text()).filter(Boolean).join(" ");

describe("FleetHealth 預設版面（rail 面板）", () => {
  it("以 section 呈現標題、總台數、四類圖例與比例條，不渲染摘要條", () => {
    wrapper = mount(FleetHealth, { props: { summary: SUMMARY } });
    const section = wrapper.get('section[aria-label="機群健康"]');
    expect(section.text()).toContain("機群健康");
    expect(text(section)).toContain("共 10 台");
    expect(section.findAll("dt").map((dt) => dt.text())).toEqual(["正常", "警告", "嚴重", "停滯"]);
    expect(section.findAll("dd").map((dd) => dd.text())).toEqual(["4", "3", "2", "1"]);
    expect(section.get('[role="img"]').attributes("aria-label")).toBe(
      "機群健康：正常 4、警告 3、嚴重 2、停滯 1",
    );
    expect(wrapper.find('[data-fg="fleet-summary-bar"]').exists()).toBe(false);
  });
});

// 零值計數改中性色（critique 2026-10-17「零值計數仍染狀態色」）：0 → ink-3，非 0 → 原狀態色。
const ZERO_MIX: FleetHealthSummary = { healthy: 3, warning: 0, critical: 0, stale: 1, total: 4 };
const ALL_ZERO_BUT_OK: FleetHealthSummary = { healthy: 4, warning: 0, critical: 0, stale: 0, total: 4 };
const STATE_TEXT = ["text-ok-fg", "text-warn-fg", "text-crit-fg", "text-ink"];

/** 計數元素上的文字色 class（`text-ok-fg`／`text-ink-3`…；排除字級 `text-xs`／`text-md`）。 */
const toneOf = (el: { classes(): string[] }): string[] =>
  el.classes().filter((c) => c.startsWith("text-") && !["text-xs", "text-sm", "text-md"].includes(c));

describe("FleetHealth 零值計數中性色", () => {
  it("rail 面板：計數為 0 的 dd 用 text-ink-3，非 0 維持狀態色", () => {
    wrapper = mount(FleetHealth, { props: { summary: ZERO_MIX } });
    const dds = wrapper.get("section").findAll("dd");
    expect(dds.map(toneOf)).toEqual([["text-ok-fg"], ["text-ink-3"], ["text-ink-3"], ["text-ink"]]);
  });

  it("rail 面板：非 0 時四類皆為各自狀態色（停滯用 ink），沒有 ink-3", () => {
    wrapper = mount(FleetHealth, { props: { summary: SUMMARY } });
    const dds = wrapper.get("section").findAll("dd");
    expect(dds.map(toneOf)).toEqual(STATE_TEXT.map((c) => [c]));
  });

  it("compact 摘要條：計數為 0 的數字用 text-ink-3，非 0 維持狀態色；圓點保留狀態色", () => {
    wrapper = mount(FleetHealth, { props: { summary: ALL_ZERO_BUT_OK, compact: true } });
    const counts = wrapper.findAll("[data-count]");
    expect(counts.map((c) => toneOf(c.get(".font-mono")))).toEqual([
      ["text-ok-fg"],
      ["text-ink-3"],
      ["text-ink-3"],
      ["text-ink-3"],
    ]);
    expect(counts.map((c) => c.get(".rounded-pill").classes().find((k) => k.startsWith("bg-")))).toEqual([
      "bg-ok",
      "bg-warn",
      "bg-crit",
      "bg-stale",
    ]);
  });

  it("計數由 0 變非 0 時恢復狀態色；可讀名稱不受影響", async () => {
    wrapper = mount(FleetHealth, { props: { summary: ALL_ZERO_BUT_OK, compact: true } });
    const critical = () => wrapper!.get('[data-count="critical"] .font-mono');
    expect(toneOf(critical())).toEqual(["text-ink-3"]);
    await wrapper.setProps({ summary: { healthy: 3, warning: 0, critical: 1, stale: 0, total: 4 } });
    expect(toneOf(critical())).toEqual(["text-crit-fg"]);
    expect(wrapper.get('[data-fg="fleet-summary-bar"]').attributes("aria-label")).toBe(
      "機群健康：正常 3、警告 0、嚴重 1、停滯 0，展開異常清單",
    );
  });
});

describe("FleetHealth compact 摘要條", () => {
  function mountBar(props: Partial<{ expanded: boolean; controls: string; summary: FleetHealthSummary }> = {}) {
    wrapper = mount(FleetHealth, { props: { summary: SUMMARY, compact: true, ...props } });
    return wrapper;
  }

  it("根元素是 data-fg=fleet-summary-bar 的按鈕，固定高度、不渲染 rail 面板", () => {
    const w = mountBar();
    const bar = w.get('[data-fg="fleet-summary-bar"]');
    expect(bar.element.tagName).toBe("BUTTON");
    expect(bar.attributes("type")).toBe("button");
    expect(bar.classes()).toContain("h-11");
    expect(w.find("section").exists()).toBe(false);
  });

  it("四計數一列：依正常、警告、嚴重、停滯排列，數字為 mono 且各帶色點", () => {
    const w = mountBar();
    const counts = w.findAll("[data-count]");
    expect(counts.map((c) => c.attributes("data-count"))).toEqual(["healthy", "warning", "critical", "stale"]);
    expect(counts.map((c) => countText(c))).toEqual(["正常 4", "警告 3", "嚴重 2", "停滯 1"]);
    for (const c of counts) {
      expect(c.find(".rounded-pill").exists()).toBe(true);
      expect(c.get(".font-mono").classes()).toContain("tabular-nums");
    }
  });

  it("比例條為 role=img，名稱同 rail 面板；四段寬度依佔比", () => {
    const w = mountBar();
    const img = w.get('[data-fg="fleet-summary-bar"] [role="img"]');
    expect(img.attributes("aria-label")).toBe("機群健康：正常 4、警告 3、嚴重 2、停滯 1");
    const segs = img.findAll("span");
    expect(segs.map((s) => parseFloat((s.element as HTMLElement).style.width))).toEqual([40, 30, 20, 10]);
    expect(segs.map((s) => s.classes().find((c) => c.startsWith("bg-")))).toEqual([
      "bg-ok",
      "bg-warn",
      "bg-crit",
      "bg-stale",
    ]);
  });

  it("佔比為 0 的段寬度為 0", () => {
    const w = mountBar({ summary: { healthy: 3, warning: 0, critical: 1, stale: 0, total: 4 } });
    const segs = w.get('[data-fg="fleet-summary-bar"] [role="img"]').findAll("span");
    expect(segs.map((s) => parseFloat((s.element as HTMLElement).style.width))).toEqual([75, 0, 25, 0]);
  });

  it("按鈕名稱含四計數與動作；aria-expanded 與 aria-controls 反映 expanded", async () => {
    const w = mountBar({ controls: "overlay-x" });
    const bar = w.get('[data-fg="fleet-summary-bar"]');
    expect(bar.attributes("aria-label")).toBe("機群健康：正常 4、警告 3、嚴重 2、停滯 1，展開異常清單");
    expect(bar.attributes("aria-expanded")).toBe("false");
    expect(bar.attributes("aria-controls")).toBeUndefined();

    await w.setProps({ expanded: true });
    expect(bar.attributes("aria-expanded")).toBe("true");
    expect(bar.attributes("aria-controls")).toBe("overlay-x");
    expect(bar.attributes("aria-label")).toBe("機群健康：正常 4、警告 3、嚴重 2、停滯 1，收合異常清單");
  });

  it("點擊 emit toggle（每次一筆）", async () => {
    const w = mountBar();
    const bar = w.get('[data-fg="fleet-summary-bar"]');
    await bar.trigger("click");
    await bar.trigger("click");
    expect(w.emitted("toggle")).toHaveLength(2);
  });

  it("計數更新只改文字，按鈕高度 class 不變", async () => {
    const w = mountBar();
    await w.setProps({ summary: { healthy: 2, warning: 0, critical: 15, stale: 3, total: 20 } });
    const bar = w.get('[data-fg="fleet-summary-bar"]');
    expect(bar.classes()).toContain("h-11");
    expect(w.findAll("[data-count]").map((c) => countText(c))).toEqual(["正常 2", "警告 0", "嚴重 15", "停滯 3"]);
  });
});

describe("摘要條與異常清單覆蓋層（呼叫端接線）", () => {
  const ITEMS: AnomalySummaryItem[] = [
    { machineId: "press-02", label: "壓製機 02", level: "critical", active: true, struck: false, since: 90_000 },
  ];

  /** 模擬 App 的接線：摘要條 toggle 開關覆蓋層，覆蓋層 close 收合。 */
  const Harness = defineComponent({
    setup() {
      const open = ref(false);
      return () => [
        h(FleetHealth, {
          summary: SUMMARY,
          compact: true,
          expanded: open.value,
          onToggle: () => {
            open.value = !open.value;
          },
        }),
        h(AnomalyOverlay, {
          open: open.value,
          items: ITEMS,
          now: 100_000,
          selectedId: null,
          onClose: () => {
            open.value = false;
          },
        }),
      ];
    },
  });

  it("點摘要條展開覆蓋層並把焦點移進面板；再點（落在遮罩）收合，焦點還給摘要條", async () => {
    wrapper = mount(Harness, { attachTo: document.body });
    const bar = wrapper.get<HTMLButtonElement>('[data-fg="fleet-summary-bar"]');
    expect(wrapper.find('[data-fg="anomaly-overlay"]').exists()).toBe(false);

    bar.element.focus();
    await bar.trigger("click");
    await nextTick();
    const dialog = wrapper.get('[data-fg="anomaly-overlay"]');
    expect(dialog.attributes("role")).toBe("dialog");
    expect(dialog.find('[data-fg="anomaly-summary"] [data-machine="press-02"]').exists()).toBe(true);
    expect(bar.attributes("aria-expanded")).toBe("true");
    expect(bar.attributes("aria-controls")).toBe(dialog.attributes("id"));
    expect(document.activeElement).toBe(dialog.element);

    // happy-dom 沒有版面可做點擊命中，改斷言幾何：主區 p-3 內的摘要條位於 y 68–112；
    // 遮罩層起於 top-14（y 56）蓋住它，面板起於 top-16（相對遮罩層 64px → y 120）在它下方，
    // 所以在摘要條原位「再點一次」點到的是遮罩，不是面板。
    const layer = dialog.element.parentElement as HTMLElement;
    expect(layer.classList).toContain("top-14");
    expect(dialog.classes()).toContain("top-16");
    expect(dialog.classes()).not.toContain("top-2");
    await wrapper.get('[data-fg="anomaly-overlay-scrim"]').trigger("click");
    expect(wrapper.find('[data-fg="anomaly-overlay"]').exists()).toBe(false);
    expect(bar.attributes("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(bar.element);
  });
});
