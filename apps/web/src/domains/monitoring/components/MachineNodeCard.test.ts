// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import type { MachineState } from "@flow-gatekeeper/contracts";
import MachineNodeCard from "./MachineNodeCard.vue";
import type { MachineLive } from "../stores/monitoring.store.js";
import { CARD_ROOT_CLASS, CARD_STALE_CLASS, CARD_STATE_CLASS } from "../lib/card-style.js";
import { formatClock } from "../../../shared/lib/format.js";

/**
 * MachineNodeCard 元件行為與可及性（review02 Batch D；013 T027 視覺層重做後更新）。
 * CSS cascade 層面的選取態勝負見 `MachineNodeCard.css.test.ts`；這裡只驗元件把「選取」
 * 輸出成那條規則認得的訊號（`.machine-card[data-selected='true']`），以及文字／事件行為。
 */

const T0 = Date.parse("2026-09-27T00:00:00.000Z");

function machine(state: MachineState, lastUpdated = T0): MachineLive {
  return {
    machineId: "press-02",
    state,
    telemetry: { temperature: 70.25, vibration: 1.234, throughput: 1180, errorRate: 0.012 },
    lastUpdated,
  };
}

function mountCard(over: Partial<{ machine: MachineLive | null; selected: boolean; stale: boolean; now: number }> = {}) {
  return mount(MachineNodeCard, {
    props: {
      machine: machine("healthy"),
      machineId: "press-02",
      selected: false,
      stale: false,
      now: T0,
      ...over,
    },
  });
}

/** 卡片主按鈕（第一個 button；第二個是診斷圖示）。 */
const cardButton = (w: ReturnType<typeof mountCard>) => w.findAll("button")[0]!;

describe("MachineNodeCard 選取態（WEB-1 回歸）", () => {
  it("selected=true 時輸出選取錨點：machine-card + data-selected='true' + aria-pressed", () => {
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

describe("MachineNodeCard 測試鉤子與狀態外觀（ui-contract §3）", () => {
  it("卡片根元素帶 data-machine 與 data-state；placeholder 的 data-state 為 placeholder", () => {
    const btn = cardButton(mountCard({ machine: machine("critical") }));
    expect(btn.attributes("data-machine")).toBe("press-02");
    expect(btn.attributes("data-state")).toBe("critical");
    expect(cardButton(mountCard({ machine: null })).attributes("data-state")).toBe("placeholder");
  });

  it.each(["healthy", "warning", "critical"] as const)("state=%s 套用 card-style 的狀態 class（玻璃／警告全邊框／嚴重底）", (state) => {
    const classes = cardButton(mountCard({ machine: machine(state) })).classes();
    for (const cls of CARD_STATE_CLASS[state].split(" ")) expect(classes).toContain(cls);
  });

  it("warning 為 1px border-warn 全邊框（FR-030）、critical 為半透明 crit-bg + border-crit + pulse；兩者都不用左色條", () => {
    const warn = cardButton(mountCard({ machine: machine("warning") })).classes();
    expect(warn).toContain("border");
    expect(warn).toContain("border-warn");
    const crit = cardButton(mountCard({ machine: machine("critical") })).classes();
    expect(crit).toContain("border-crit");
    expect(crit.some((c) => c.startsWith("bg-crit-bg/"))).toBe(true);
    expect(crit).toContain("animate-critical-pulse");
    for (const cls of [...warn, ...crit]) expect(cls).not.toMatch(/^border-l-/);
  });
});

describe("MachineNodeCard 狀態徽章與停滯", () => {
  it.each([
    ["healthy", "正常"],
    ["warning", "警告"],
    ["critical", "嚴重"],
  ] as const)("state=%s 時徽章文字為 %s，狀態燈可讀名稱同字", (state, label) => {
    const w = mountCard({ machine: machine(state) });
    expect(w.text()).toContain(label);
    expect(w.find('[role="img"]').attributes("aria-label")).toBe(`狀態：${label}`);
  });

  it("名稱為中文、id 以 mono 顯示", () => {
    const w = mountCard();
    expect(w.text()).toContain("壓製機 02");
    const id = w.findAll(".font-mono").find((el) => el.text() === "press-02");
    expect(id).toBeDefined();
  });

  it("stale=true 顯示「停滯」徽章與虛線停滯邊框、數值不清空；不再整卡降透明", () => {
    const stale = mountCard({ stale: true });
    expect(stale.text()).toContain("停滯");
    expect(stale.text()).toContain("70.3");
    const classes = cardButton(stale).classes();
    for (const cls of CARD_STALE_CLASS.split(" ")) expect(classes).toContain(cls);
    expect(classes.some((c) => c.startsWith("opacity-"))).toBe(false);
    expect(mountCard().text()).not.toContain("停滯");
  });

  it("停滯徽章與 id 同列，名稱列只有名稱（220px 寬時名稱不被擠掉）", () => {
    const w = mountCard({ stale: true });
    const name = w.findAll("div").find((d) => d.text() === "壓製機 02");
    expect(name).toBeDefined();
    const id = w.findAll("span.font-mono").find((s) => s.text() === "press-02")!;
    expect(id.element.parentElement?.textContent).toContain("停滯");
  });

  it("嚴重卡片的狀態徽章帶 1px border-crit（與 crit-bg 卡底分得開），其他狀態為透明邊框、高度一致", () => {
    const badge = (state: MachineState) =>
      mountCard({ machine: machine(state) })
        .findAll("span")
        .find((s) => s.text() === { healthy: "正常", warning: "警告", critical: "嚴重" }[state])!;
    expect(badge("critical").classes()).toEqual(expect.arrayContaining(["border", "border-crit", "py-px"]));
    for (const state of ["healthy", "warning"] as const) {
      expect(badge(state).classes()).toEqual(expect.arrayContaining(["border", "border-transparent", "py-px"]));
    }
  });

  it("placeholder（machine=null）以 — 佔位、無狀態徽章", () => {
    const ph = mountCard({ machine: null });
    expect(ph.text()).not.toMatch(/正常|警告|嚴重/);
    expect(ph.text()).toContain("—");
    expect(ph.text()).toContain("更新 —");
  });
});

describe("MachineNodeCard 遙測數值", () => {
  it("四項中文標籤與單位、數值格式不變", () => {
    const text = mountCard().text();
    for (const label of ["溫度", "振動", "產能", "錯誤率", "°C", "mm/s", "u/min", "%"]) {
      expect(text).toContain(label);
    }
    for (const value of ["70.3", "1.23", "1,180", "1.2"]) expect(text).toContain(value);
    expect(text).not.toMatch(/Temp|Vibration|Throughput|Errors/);
  });

  it("數值使用 text-number（24px）mono，單位為 12px（text-xs）", () => {
    const w = mountCard();
    const values = w.findAll(".text-number");
    expect(values).toHaveLength(4);
    for (const v of values) expect(v.classes()).toContain("font-mono");
    const unit = w.findAll("span").find((s) => s.text() === "°C")!;
    expect(unit.element.closest(".text-xs")).not.toBeNull();
  });
});

describe("MachineNodeCard 數值旁的 3 格蝕刻小刻度（T042）", () => {
  const ticks = (w: ReturnType<typeof mountCard>) => w.findAll('[data-fg="metric-tick"]');
  const strokeOf = (classes: string[]) => classes.filter((c) => c.startsWith("stroke-"));

  it("四個數值各一個刻度，皆為 aria-hidden 的裝飾 svg、三條刻線", () => {
    const list = ticks(mountCard());
    expect(list).toHaveLength(4);
    for (const tick of list) {
      expect(tick.element.tagName.toLowerCase()).toBe("svg");
      expect(tick.attributes("aria-hidden")).toBe("true");
      expect((tick.get("path").attributes("d") ?? "").match(/M/g)).toHaveLength(3);
    }
  });

  it("越界判定沿用 offendingMetrics：crit → stroke-crit、warn → stroke-warn、未越界與 throughput → stroke-etch", () => {
    const m: MachineLive = {
      machineId: "press-02",
      state: "critical",
      // 溫度 97 > 95（crit）、振動 1.0 > 0.9（warn）、產能不參與越界、錯誤率 1.2% 未越界
      telemetry: { temperature: 97, vibration: 1.0, throughput: 1180, errorRate: 0.012 },
      lastUpdated: T0,
    };
    const list = ticks(mountCard({ machine: m }));
    expect(list.map((t) => strokeOf(t.classes()))).toEqual([
      ["stroke-crit"],
      ["stroke-warn"],
      ["stroke-etch"],
      ["stroke-etch"],
    ]);
  });

  /** 四項皆未越界的健康機台（預設 fixture 的振動 1.234 已越 warn 門檻 0.9）。 */
  const calmMachine: MachineLive = {
    machineId: "press-02",
    state: "healthy",
    telemetry: { temperature: 60, vibration: 0.5, throughput: 1180, errorRate: 0.012 },
    lastUpdated: T0,
  };

  it("正常數值與 placeholder 的刻度為 stroke-etch", () => {
    for (const w of [mountCard({ machine: calmMachine }), mountCard({ machine: null })]) {
      for (const tick of ticks(w)) expect(strokeOf(tick.classes())).toEqual(["stroke-etch"]);
    }
  });

  it("刻度尺寸固定：狀態與越界變化只換 stroke 色，尺寸 class 相同；卡片 min-h 與 2×2 格線不變（FR-031）", () => {
    const hot: MachineLive = {
      machineId: "press-02",
      state: "critical",
      telemetry: { temperature: 99, vibration: 2, throughput: 60, errorRate: 0.2 },
      lastUpdated: T0,
    };
    const calm = mountCard({ machine: calmMachine });
    const alarm = mountCard({ machine: hot });
    const sizeOf = (classes: string[]) => classes.filter((c) => !c.startsWith("stroke-")).sort();
    const calmTicks = ticks(calm);
    const alarmTicks = ticks(alarm);
    calmTicks.forEach((tick, i) => {
      expect(sizeOf(tick.classes())).toEqual(sizeOf(alarmTicks[i]!.classes()));
      expect(tick.attributes("viewBox")).toBe(alarmTicks[i]!.attributes("viewBox"));
    });
    expect(sizeOf(calmTicks[0]!.classes())).toEqual(expect.arrayContaining(["h-3.5", "w-2.5", "shrink-0"]));
    for (const w of [calm, alarm]) {
      expect(cardButton(w).classes()).toContain("min-h-[148px]");
      expect(w.find(".grid-cols-2").exists()).toBe(true);
    }
  });

  it("刻度放在數值同列、數值可截斷而刻度不被擠掉", () => {
    const tick = ticks(mountCard())[2]!;
    const row = tick.element.parentElement!;
    expect(row.querySelector(".text-number")?.textContent?.trim()).toBe("1,180");
    expect(row.querySelector(".text-number")?.classList.contains("truncate")).toBe(true);
    expect(row.classList.contains("min-w-0")).toBe(true);
  });
});

describe("MachineNodeCard 相對時間", () => {
  it("隨 now（store 每秒 tick）以 formatRelative 更新（「剛剛」／「N 秒前」／「N 分鐘前」，FR-022），並以 title 提供 24 小時制絕對時間", async () => {
    const w = mountCard({ now: T0 + 2_000 });
    expect(w.text()).toContain("更新 剛剛");
    await w.setProps({ now: T0 + 12_000 });
    expect(w.text()).toContain("更新 12 秒前");
    await w.setProps({ now: T0 + 125_000 });
    expect(w.text()).toContain("更新 2 分鐘前");
    expect(w.find("[title]").attributes("title")).toBe(formatClock(T0));
  });
});

describe("MachineNodeCard 互動", () => {
  it("卡片是原生 <button type=button>（Enter／Space 由瀏覽器觸發 click），點擊送出 select(machineId)", async () => {
    const w = mountCard();
    const btn = cardButton(w);
    expect(btn.element.tagName).toBe("BUTTON");
    expect(btn.attributes("type")).toBe("button");
    await btn.trigger("click");
    expect(w.emitted("select")).toEqual([["press-02"]]);
    expect(w.emitted("diagnose")).toBeUndefined();
  });

  it("診斷圖示有中文 aria-label，點擊只送 diagnose(machineId)、不連帶 select", async () => {
    const w = mountCard();
    const diag = w.get('button[aria-label="診斷 壓製機 02"]');
    await diag.trigger("click");
    expect(w.emitted("diagnose")).toEqual([["press-02"]]);
    expect(w.emitted("select")).toBeUndefined();
  });
});
