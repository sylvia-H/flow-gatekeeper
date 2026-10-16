// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import AnomalySummary from "./AnomalySummary.vue";
import type { AnomalySummaryItem } from "../lib/anomaly-latch.js";

/**
 * AnomalySummary（T050／T053；FR-026、FR-027、ui-contract §3）：純呈現元件，只收 props、只 emit。
 * 排序由 store 的 `summarize` 負責（見 anomaly-latch.test.ts），這裡斷言渲染順序＝props 順序。
 */

const NOW = 100_000;

function item(over: Partial<AnomalySummaryItem> = {}): AnomalySummaryItem {
  return {
    machineId: "press-02",
    label: "壓製機 02",
    level: "critical",
    active: true,
    struck: false,
    since: NOW - 12_000,
    ...over,
  };
}

function mountSummary(
  items: readonly AnomalySummaryItem[],
  opts: { now?: number; selectedId?: string | null; attach?: boolean } = {},
) {
  return mount(AnomalySummary, {
    props: { items, now: opts.now ?? NOW, selectedId: opts.selectedId ?? null },
    ...(opts.attach ? { attachTo: document.body } : {}),
  });
}

const rows = (w: ReturnType<typeof mountSummary>) =>
  w.findAll('[data-fg="anomaly-summary"] [data-machine]');

describe("AnomalySummary 清單結構（ui-contract §3）", () => {
  it("根元素 data-fg=anomaly-summary，標題「最近異常」，清單為 ul[role=list]", () => {
    const w = mountSummary([item()]);
    const root = w.get('[data-fg="anomaly-summary"]');
    expect(root.get("h2").text()).toBe("最近異常");
    expect(root.attributes("aria-labelledby")).toBe(root.get("h2").attributes("id"));
    expect(root.get("ul").attributes("role")).toBe("list");
    expect(root.findAll("li")).toHaveLength(1);
  });

  it("每列帶 data-machine／data-level／data-active／data-struck（後兩者有屬性才算），且 data-machine 每台只命中一次", () => {
    const w = mountSummary([
      item(),
      item({ machineId: "oven-04", label: "烤爐 04", level: "warning", active: false, struck: true }),
    ]);
    const [a, b] = rows(w);
    expect(a!.attributes()).toMatchObject({
      "data-machine": "press-02",
      "data-level": "critical",
      "data-active": "",
    });
    expect(a!.attributes("data-struck")).toBeUndefined();
    expect(b!.attributes()).toMatchObject({
      "data-machine": "oven-04",
      "data-level": "warning",
      "data-struck": "",
    });
    expect(b!.attributes("data-active")).toBeUndefined();
    expect(w.findAll('[data-machine="press-02"]')).toHaveLength(1);
  });

  it("渲染順序與 props 順序一致（不在元件內重排）", () => {
    const ids = ["oven-04", "press-02", "mixer-01"];
    const w = mountSummary(ids.map((machineId) => item({ machineId, label: machineId })));
    expect(rows(w).map((r) => r.attributes("data-machine"))).toEqual(ids);
  });

  it("空清單顯示「目前沒有異常」且不渲染 ul", () => {
    const w = mountSummary([]);
    expect(w.text()).toContain("目前沒有異常");
    expect(w.find("ul").exists()).toBe(false);
    expect(rows(w)).toHaveLength(0);
  });
});

describe("AnomalySummary 相對時間與等級文字（FR-026、FR-027）", () => {
  it("進行中：「嚴重 · 進入 N 秒前」，錨定 since（進入時間）", () => {
    const w = mountSummary([item({ since: NOW - 12_000 })]);
    expect(rows(w)[0]!.text()).toContain("壓製機 02");
    expect(rows(w)[0]!.text()).toContain("嚴重 · 進入 12 秒前");
  });

  it("回復後：「警告 · 已回復 N 秒前」，錨定 since（回復時間）", () => {
    const w = mountSummary([item({ level: "warning", active: false, since: NOW - 5_000 })]);
    expect(rows(w)[0]!.text()).toContain("警告 · 已回復 5 秒前");
  });

  it("2 秒內寫成「剛進入」／「剛回復」，不出現「進入 剛剛」", () => {
    const w = mountSummary([
      item({ since: NOW - 1_000 }),
      item({ machineId: "oven-04", label: "烤爐 04", active: false, since: NOW }),
    ]);
    const [a, b] = rows(w);
    expect(a!.text()).toContain("剛進入");
    expect(b!.text()).toContain("剛回復");
    expect(w.text()).not.toContain("剛剛");
  });

  it("now 前進時相對時間跟著更新", async () => {
    const w = mountSummary([item({ since: NOW - 12_000 })]);
    await w.setProps({ now: NOW + 3_000 });
    expect(rows(w)[0]!.text()).toContain("進入 15 秒前");
  });
});

describe("AnomalySummary 互動（emit select／clear）", () => {
  it("點列 emit select(machineId)", async () => {
    const w = mountSummary([item(), item({ machineId: "oven-04", label: "烤爐 04" })]);
    await rows(w)[1]!.get('[data-fg="anomaly-select"]').trigger("click");
    expect(w.emitted("select")).toEqual([["oven-04"]]);
    expect(w.emitted("clear")).toBeUndefined();
  });

  it("清除鈕的可讀名稱含中文名；點擊 emit clear(machineId) 而不 emit select", async () => {
    const w = mountSummary([item()]);
    const btn = rows(w)[0]!.get('[data-fg="anomaly-clear"]');
    expect(btn.element.tagName).toBe("BUTTON");
    expect(btn.attributes("aria-label")).toBe("清除 壓製機 02 的異常標記");
    await btn.trigger("click");
    expect(w.emitted("clear")).toEqual([["press-02"]]);
    expect(w.emitted("select")).toBeUndefined();
  });

  it("點清除後焦點移到同列的選取鈕（清除鈕隨劃線消失，焦點不掉回頁首）", async () => {
    const w = mountSummary([item()], { attach: true });
    try {
      await rows(w)[0]!.get('[data-fg="anomaly-clear"]').trigger("click");
      expect(document.activeElement).toBe(rows(w)[0]!.get('[data-fg="anomaly-select"]').element);
    } finally {
      w.unmount();
    }
  });

  it("選取中的列用 bg-accent-wash 並標 aria-current，其餘列沒有", () => {
    const w = mountSummary([item(), item({ machineId: "oven-04", label: "烤爐 04" })], {
      selectedId: "oven-04",
    });
    const [a, b] = rows(w);
    expect(b!.classes()).toContain("bg-accent-wash");
    expect(b!.classes()).toEqual(expect.arrayContaining(["ring-1", "ring-inset", "ring-accent"]));
    expect(b!.get('[data-fg="anomaly-select"]').attributes("aria-current")).toBe("true");
    expect(a!.classes()).not.toContain("bg-accent-wash");
    expect(a!.classes()).not.toContain("ring-accent");
    expect(a!.get('[data-fg="anomaly-select"]').attributes("aria-current")).toBeUndefined();
  });
});

describe("AnomalySummary 已確認（劃線保留至期滿，FR-026）", () => {
  it("struck 列名稱與時間劃線、沒有清除鈕、選取鈕名稱帶「已確認」，列仍在清單中", () => {
    const w = mountSummary([item({ struck: true })]);
    const row = rows(w)[0]!;
    const struckText = row.findAll(".line-through").map((el) => el.text());
    expect(struckText).toContain("壓製機 02");
    expect(struckText.some((t) => t.includes("進入 12 秒前"))).toBe(true);
    expect(row.find('[data-fg="anomaly-clear"]').exists()).toBe(false);
    expect(row.get('[data-fg="anomaly-select"]').text()).toContain("已確認");
    // 清除鈕原位留同尺寸佔位，列寬不因劃線改變
    const spacer = row.get("span.h-7.w-7");
    expect(spacer.attributes("aria-hidden")).toBe("true");
  });

  it("狀態燈帶 aria-hidden（等級已有可見文字，不重複念出）", () => {
    const light = rows(mountSummary([item()]))[0]!.get('[role="img"]');
    expect(light.attributes("aria-hidden")).toBe("true");
  });

  it("未確認列沒有劃線、有清除鈕", () => {
    const row = rows(mountSummary([item()]))[0]!;
    expect(row.findAll(".line-through")).toHaveLength(0);
    expect(row.find('[data-fg="anomaly-clear"]').exists()).toBe(true);
    expect(row.text()).not.toContain("已確認");
  });

  it("struck 列仍可點擊選台", async () => {
    const w = mountSummary([item({ struck: true })]);
    await rows(w)[0]!.get('[data-fg="anomaly-select"]').trigger("click");
    expect(w.emitted("select")).toEqual([["press-02"]]);
  });
});
