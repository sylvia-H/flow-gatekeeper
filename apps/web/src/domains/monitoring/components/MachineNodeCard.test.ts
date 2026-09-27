// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import type { MachineState } from "@flow-gatekeeper/contracts";
import MachineNodeCard from "./MachineNodeCard.vue";
import type { MachineLive } from "../stores/monitoring.store.js";
import { CARD_ROOT_CLASS } from "../lib/card-style.js";

/**
 * MachineNodeCard 元件行為與可及性（review02 Batch D）。
 * CSS cascade 層面的選取態勝負見 `MachineNodeCard.css.test.ts`；這裡只驗元件把「選取」
 * 輸出成那條規則認得的訊號（`.machine-card[data-selected='true']`），以及文字／事件行為。
 */

const T0 = Date.parse("2026-09-27T00:00:00.000Z");

function machine(state: MachineState, lastUpdated = T0): MachineLive {
  return {
    machineId: "press-01",
    state,
    telemetry: { temperature: 70.25, vibration: 1.234, throughput: 1180, errorRate: 0.012 },
    lastUpdated,
  };
}

function mountCard(over: Partial<{ machine: MachineLive | null; selected: boolean; stale: boolean; now: number }> = {}) {
  return mount(MachineNodeCard, {
    props: {
      machine: machine("healthy"),
      machineId: "press-01",
      selected: false,
      stale: false,
      now: T0,
      ...over,
    },
  });
}

/** 卡片主按鈕（第一個 button；第二個是 Diagnose icon）。 */
const cardButton = (w: ReturnType<typeof mountCard>) => w.findAll("button")[0]!;

describe("MachineNodeCard 選取態（WEB-1 回歸）", () => {
  it("selected=true 時輸出 design-spec §7.3 的選取錨點：machine-card + data-selected='true' + aria-pressed", () => {
    const btn = cardButton(mountCard({ selected: true }));
    expect(btn.classes()).toContain(CARD_ROOT_CLASS);
    expect(btn.attributes("data-selected")).toBe("true");
    expect(btn.attributes("aria-pressed")).toBe("true");
  });

  it("未選取時 data-selected='false'、aria-pressed='false'，且選取不可再靠一般 utility class 表達", () => {
    const states: MachineState[] = ["healthy", "warning", "critical"];
    for (const state of states) {
      const on = cardButton(mountCard({ machine: machine(state), selected: true }));
      const off = cardButton(mountCard({ machine: machine(state), selected: false }));
      expect(off.attributes("data-selected")).toBe("false");
      expect(off.attributes("aria-pressed")).toBe("false");
      // 選取與未選取差在屬性而非 class：class 集合相同，才不會重演「狀態 class 輸出順序蓋掉選取 class」
      expect(new Set(on.classes())).toEqual(new Set(off.classes()));
      expect(on.classes()).not.toContain("border-accent");
    }
  });
});

describe("MachineNodeCard 狀態徽章與 stale", () => {
  it.each([
    ["healthy", "Healthy"],
    ["warning", "Warning"],
    ["critical", "Critical"],
  ] as const)("state=%s 時徽章文字為 %s", (state, label) => {
    const w = mountCard({ machine: machine(state) });
    expect(w.text()).toContain(label);
  });

  it("stale=true 顯示 Stale 標記且數值不清空；placeholder（machine=null）以 — 佔位、無狀態徽章", () => {
    const stale = mountCard({ stale: true });
    expect(stale.text()).toContain("Stale");
    expect(stale.text()).toContain("70.3");
    expect(mountCard().text()).not.toContain("Stale");

    const ph = mountCard({ machine: null });
    expect(ph.text()).not.toMatch(/Healthy|Warning|Critical/);
    expect(ph.text()).toContain("—");
    expect(ph.text()).toContain("updated —");
  });
});

describe("MachineNodeCard 相對時間", () => {
  it("隨 now（store 每秒 tick）更新「updated Ns ago」，並以 title 提供絕對時間", async () => {
    const w = mountCard({ now: T0 + 2_000 });
    expect(w.text()).toContain("updated just now");
    await w.setProps({ now: T0 + 12_000 });
    expect(w.text()).toContain("updated 12s ago");
    await w.setProps({ now: T0 + 125_000 });
    expect(w.text()).toContain("updated 2m ago");
    expect(w.find("[title]").attributes("title")).toBe(new Date(T0).toLocaleString());
  });
});

describe("MachineNodeCard 互動", () => {
  it("卡片是原生 <button type=button>（Enter／Space 由瀏覽器觸發 click），點擊送出 select(machineId)", async () => {
    const w = mountCard();
    const btn = cardButton(w);
    expect(btn.element.tagName).toBe("BUTTON");
    expect(btn.attributes("type")).toBe("button");
    await btn.trigger("click");
    expect(w.emitted("select")).toEqual([["press-01"]]);
    expect(w.emitted("diagnose")).toBeUndefined();
  });

  it("Diagnose icon 有可讀 aria-label，點擊只送 diagnose(machineId)、不連帶 select", async () => {
    const w = mountCard();
    const diag = w.get('button[aria-label^="Diagnose "]');
    await diag.trigger("click");
    expect(w.emitted("diagnose")).toEqual([["press-01"]]);
    expect(w.emitted("select")).toBeUndefined();
  });
});
