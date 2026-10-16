// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import EventStrip from "./EventStrip.vue";
import type { DerivedEvent } from "../lib/events.js";

/**
 * EventStrip（013 T028 視覺層、T052 可點擊選台）：標題、24 小時制時間、嚴重度中文、合併次數 `×N`、
 * 空狀態；每列為 `button[data-fg="event"]`，點擊 emit `select(machineId)`，選取中的機台列標 `aria-current`。
 */

/** 本地時間 21:05:09——下午時段才驗得出是否為 24 小時制（不是 9:05:09 PM）。 */
const TS = new Date(2026, 9, 16, 21, 5, 9).getTime();

function event(over: Partial<DerivedEvent> = {}): DerivedEvent {
  return {
    id: `${TS}-press-02#1`,
    ts: TS,
    machineId: "press-02",
    severity: "critical",
    message: "壓製機 02 進入嚴重",
    count: 1,
    ...over,
  };
}

function mountStrip(events: DerivedEvent[], selectedId: string | null = null) {
  return mount(EventStrip, { props: { events, height: 150, selectedId } });
}

describe("EventStrip 標題與計數", () => {
  it("面板標題為「事件流」、region 名稱同字，右側顯示 N/50", () => {
    const w = mountStrip([event()]);
    expect(w.text()).toContain("事件流");
    expect(w.get("section").attributes("aria-label")).toBe("事件流");
    expect(w.text()).toContain("1/50");
    expect(w.text()).not.toMatch(/Event Stream/i);
  });

  it("高度由 props 決定（外層拖曳把手）", () => {
    expect(mountStrip([]).get("section").attributes("style")).toContain("height: 150px");
  });

  it("空狀態為繁中說明", () => {
    const w = mountStrip([]);
    expect(w.find("li").exists()).toBe(false);
    expect(w.find('[data-fg="event"]').exists()).toBe(false);
    expect(w.text()).toContain("尚無事件");
  });
});

describe("EventStrip 事件列項", () => {
  it("時間以 formatClock 顯示為 24 小時制 HH:mm:ss（mono）", () => {
    const w = mountStrip([event()]);
    const time = w.findAll("li span").find((s) => s.text() === "21:05:09");
    expect(time).toBeDefined();
    expect(time!.classes()).toContain("font-mono");
    expect(w.text()).not.toMatch(/PM|AM|下午|上午/);
  });

  it.each([
    ["warning", "警告", "bg-warn"],
    ["critical", "嚴重", "bg-crit"],
    ["recovered", "回復", "bg-etch"],
  ] as const)("severity=%s 顯示中文「%s」，左側蝕刻短線為 %s（獨立小元素，非整列左邊框）", (severity, label, tick) => {
    const w = mountStrip([event({ severity })]);
    const li = w.get("li");
    expect(li.text()).toContain(label);
    const mark = li.find('span[aria-hidden="true"]');
    expect(mark.classes()).toContain(tick);
    expect(mark.classes()).toEqual(expect.arrayContaining(["h-0.5", "w-4"]));
    const row = li.get('[data-fg="event"]');
    for (const cls of [...li.classes(), ...row.classes()]) expect(cls).not.toMatch(/^border-l-/);
  });

  it("訊息為中文原文（events.ts 產生）", () => {
    expect(mountStrip([event()]).get("li").text()).toContain("壓製機 02 進入嚴重");
  });

  it("count > 1 時尾端顯示 ×N（並附可讀的「共 N 次」）；count = 1 時不顯示", () => {
    const merged = mountStrip([event({ count: 3 })]).get("li");
    expect(merged.text()).toContain("×3");
    expect(merged.text()).toContain("共 3 次");
    const times = merged.findAll("span").find((s) => s.text() === "×3")!;
    expect(times.attributes("aria-hidden")).toBe("true");
    const single = mountStrip([event({ count: 1 })]).get("li");
    expect(single.text()).not.toContain("×");
  });

  it("依傳入順序渲染（最新在頂端由 store 保證）", () => {
    const w = mountStrip([
      event({ id: "a", message: "烤爐 04 進入警告", severity: "warning" }),
      event({ id: "b", message: "壓製機 02 進入嚴重" }),
    ]);
    const items = w.findAll("li");
    expect(items).toHaveLength(2);
    expect(items[0]!.text()).toContain("烤爐 04");
    expect(items[1]!.text()).toContain("壓製機 02");
  });
});

describe("EventStrip 可點擊選台（T052）", () => {
  it('每列為 button[data-fg="event"]，帶 data-machine／data-severity／data-count', () => {
    const w = mountStrip([
      event({ id: "a", machineId: "oven-04", severity: "warning", count: 3 }),
      event({ id: "b", machineId: "press-02", severity: "recovered" }),
    ]);
    const rows = w.findAll('[data-fg="event"]');
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.element.tagName).toBe("BUTTON");
      expect(row.attributes("type")).toBe("button");
    }
    expect(rows[0]!.attributes()).toMatchObject({ "data-machine": "oven-04", "data-severity": "warning", "data-count": "3" });
    expect(rows[1]!.attributes()).toMatchObject({ "data-machine": "press-02", "data-severity": "recovered", "data-count": "1" });
  });

  it("點擊列項 emit select 帶該事件的 machineId", async () => {
    const w = mountStrip([event({ id: "a", machineId: "oven-04" }), event({ id: "b", machineId: "press-02" })]);
    await w.findAll('[data-fg="event"]')[1]!.trigger("click");
    await w.findAll('[data-fg="event"]')[0]!.trigger("click");
    expect(w.emitted("select")).toEqual([["press-02"], ["oven-04"]]);
  });

  it("可讀名稱即列上的可見文字（時間、嚴重度、訊息、共 N 次），不另加 aria-label", () => {
    const row = mountStrip([event({ count: 2 })]).get('[data-fg="event"]');
    expect(row.attributes("aria-label")).toBeUndefined();
    for (const part of ["21:05:09", "嚴重", "壓製機 02 進入嚴重", "共 2 次"]) expect(row.text()).toContain(part);
  });

  it("selectedId 對應機台的列標 aria-current 與 bg-accent-wash；其餘列無標記、可 hover", () => {
    const w = mountStrip([event({ id: "a", machineId: "oven-04" }), event({ id: "b", machineId: "press-02" })], "press-02");
    const [other, selected] = w.findAll('[data-fg="event"]');
    expect(selected!.attributes("aria-current")).toBe("true");
    expect(selected!.classes()).toEqual(expect.arrayContaining(["bg-accent-wash", "ring-1", "ring-inset", "ring-accent"]));
    // 鍵盤聚焦時焦點環覆蓋選取內框
    expect(selected!.classes()).toEqual(expect.arrayContaining(["focus-visible:ring-2", "focus-visible:ring-focus"]));
    expect(other!.attributes("aria-current")).toBeUndefined();
    for (const cls of ["bg-accent-wash", "ring-1", "ring-accent"]) expect(other!.classes()).not.toContain(cls);
    expect(other!.classes()).toContain("hover:bg-surface");
  });

  it("選取中列的訊息文字加深為 text-ink（只換色不換字重），其餘列 text-ink-2", () => {
    const w = mountStrip([event({ id: "a", machineId: "oven-04", message: "烤爐 04 進入嚴重" }), event({ id: "b" })], "press-02");
    const msg = (i: number) => w.findAll('[data-fg="event"]')[i]!.findAll("span").find((s) => s.text().includes("進入嚴重"))!;
    expect(msg(1).classes()).toContain("text-ink");
    expect(msg(1).classes()).not.toContain("text-ink-2");
    expect(msg(0).classes()).toContain("text-ink-2");
    expect(msg(1).classes().filter((c) => c.startsWith("font-"))).toEqual(msg(0).classes().filter((c) => c.startsWith("font-")));
  });

  it("同一台多筆事件時，每一列都標 aria-current", () => {
    const w = mountStrip(
      [
        event({ id: "a", severity: "critical" }),
        event({ id: "b", machineId: "oven-04" }),
        event({ id: "c", severity: "recovered" }),
      ],
      "press-02",
    );
    const current = w.findAll('[data-fg="event"]').map((r) => r.attributes("aria-current"));
    expect(current).toEqual(["true", undefined, "true"]);
  });

  it("分隔線畫在按鈕上（最後一列不畫），li 不帶邊框，列高不因邊框超過 32px", () => {
    const w = mountStrip([event({ id: "a" }), event({ id: "b" })]);
    const li = w.get("li");
    expect(li.classes()).toContain("group");
    for (const cls of li.classes()) expect(cls).not.toMatch(/^border/);
    expect(w.get('[data-fg="event"]').classes()).toEqual(
      expect.arrayContaining(["border-b", "border-edge/60", "group-last:border-b-0", "min-h-8"]),
    );
  });

  it("未傳 selectedId 時沒有任何列標 aria-current", () => {
    const w = mount(EventStrip, { props: { events: [event()], height: 150 } });
    expect(w.get('[data-fg="event"]').attributes("aria-current")).toBeUndefined();
  });

  it("焦點環畫在列內（ring-inset，面板 overflow-hidden 不裁切），且列高固定 min-h-8", () => {
    const w = mountStrip([event()]);
    expect(w.get("section").classes()).toContain("overflow-hidden");
    const row = w.get('[data-fg="event"]');
    expect(row.classes()).toEqual(
      expect.arrayContaining(["focus-visible:ring-2", "focus-visible:ring-inset", "focus-visible:ring-focus", "min-h-8", "w-full"]),
    );
  });

  it("回復事件為中性色：蝕刻短線 bg-etch、嚴重度文字不借用任一狀態色", () => {
    const row = mountStrip([event({ severity: "recovered", message: "壓製機 02 回復正常" })]).get('[data-fg="event"]');
    expect(row.get('span[aria-hidden="true"]').classes()).toContain("bg-etch");
    const label = row.findAll("span").find((s) => s.text() === "回復")!;
    expect(label.classes()).toContain("text-ink-2");
    for (const el of row.findAll("span")) {
      for (const cls of el.classes()) expect(cls).not.toMatch(/(warn|crit|healthy|ok|accent)/);
    }
  });

  it("警告／嚴重列的短線與文字維持狀態色", () => {
    const warn = mountStrip([event({ severity: "warning" })]).get('[data-fg="event"]');
    expect(warn.get('span[aria-hidden="true"]').classes()).toContain("bg-warn");
    const crit = mountStrip([event({ severity: "critical" })]).get('[data-fg="event"]');
    expect(crit.get('span[aria-hidden="true"]').classes()).toContain("bg-crit");
  });
});
