// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import EventStrip from "./EventStrip.vue";
import type { DerivedEvent } from "../lib/events.js";

/**
 * EventStrip 視覺層（013 T028）：標題、24 小時制時間、嚴重度中文、合併次數 `×N`、空狀態。
 * 事件列項改 `<button>` 與點擊選台屬 T052（US5），由該任務擴充本檔。
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

function mountStrip(events: DerivedEvent[]) {
  return mount(EventStrip, { props: { events, height: 150 } });
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
    for (const cls of li.classes()) expect(cls).not.toMatch(/^border-l-/);
  });

  it("訊息為中文原文（events.ts 產生）", () => {
    expect(mountStrip([event()]).get("li").text()).toContain("壓製機 02 進入嚴重");
  });

  it("count > 1 時尾端顯示 ×N（並附可讀的「共 N 次」）；count = 1 時不顯示", () => {
    const merged = mountStrip([event({ count: 3 })]).get("li");
    expect(merged.text()).toContain("×3");
    expect(merged.text()).toContain("共 3 次");
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
