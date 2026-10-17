// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import type { MachineState } from "@flow-gatekeeper/contracts";
import MachineNodeCard from "./MachineNodeCard.vue";
import type { MachineLive } from "../stores/monitoring.store.js";
import { CARD_ROOT_CLASS, CARD_STALE_CLASS, CARD_STATE_CLASS } from "../lib/card-style.js";
import { formatClock } from "../../../shared/lib/format.js";
import type { AnomalyLatch } from "../lib/anomaly-latch.js";
import type { DiagnosisBadge } from "../../ai-copilot/lib/diagnosis-badge.js";

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

function mountCard(
  over: Partial<{
    machine: MachineLive | null;
    selected: boolean;
    stale: boolean;
    now: number;
    latch: AnomalyLatch | null;
    badge: DiagnosisBadge;
  }> = {},
) {
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

/** 卡片主按鈕 aria-describedby 指向的各段文字（以空白串接、略過 aria-hidden 節點，同螢幕閱讀器的描述計算）。 */
function describedText(w: ReturnType<typeof mountCard>): string {
  const ids = (cardButton(w).attributes("aria-describedby") ?? "").split(" ").filter(Boolean);
  return ids
    .map((id) => {
      const clone = w.get(`[id="${id}"]`).element.cloneNode(true) as HTMLElement;
      for (const hidden of clone.querySelectorAll('[aria-hidden="true"]')) hidden.remove();
      return (clone.textContent ?? "").trim();
    })
    .join(" ");
}

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

  it("四個數值各一個刻度，皆為 aria-hidden 的裝飾 svg、三條刻線（未達嚴重越界）", () => {
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
    const sizeOf = (classes: string[]) => classes.filter((c) => !c.startsWith("stroke-") && !c.startsWith("fill-")).sort();
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

  it("嚴重越界：三格刻度全填實（三條 3px 全寬實心短柱、fill-crit），形狀與平時細線不同；warn 與未越界仍是細線 fill-none（色弱 Persona）", () => {
    const m: MachineLive = {
      machineId: "press-02",
      state: "critical",
      telemetry: { temperature: 97, vibration: 1.0, throughput: 1180, errorRate: 0.012 },
      lastUpdated: T0,
    };
    const [temp, vib, thr] = ticks(mountCard({ machine: m }));
    expect(temp!.classes()).toEqual(expect.arrayContaining(["fill-crit", "stroke-crit"]));
    expect(temp!.find("path").exists()).toBe(false);
    const bars = temp!.findAll("rect");
    expect(bars).toHaveLength(3);
    for (const bar of bars) {
      expect(bar.attributes("width")).toBe("10");
      expect(bar.attributes("height")).toBe("3");
    }
    for (const calm of [vib!, thr!]) {
      expect(calm.classes()).toContain("fill-none");
      expect(calm.findAll("rect")).toHaveLength(0);
      expect((calm.get("path").attributes("d") ?? "").match(/M/g)).toHaveLength(3);
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
  /** 更新時間元素（卡片 aria-describedby 的最後一段）。 */
  const timeEl = (w: ReturnType<typeof mountCard>) =>
    w.get(`[id="${cardButton(w).attributes("aria-describedby")!.split(" ").at(-1)!}"]`);

  it("隨 now（store 每秒 tick）以 formatRelative 更新（「剛剛」／「N 秒前」／「N 分鐘前」，FR-022），並以 title 提供 24 小時制絕對時間", async () => {
    const w = mountCard({ now: T0 + 2_000 });
    expect(w.text()).toContain("更新 剛剛");
    await w.setProps({ now: T0 + 12_000 });
    expect(w.text()).toContain("更新 12 秒前");
    await w.setProps({ now: T0 + 125_000 });
    expect(w.text()).toContain("更新 2 分鐘前");
    expect(timeEl(w).attributes("title")).toBe(formatClock(T0));
  });

  it("更新 < 3 秒且未停滯：畫面不顯示相對時間（sr-only、無分隔點），可讀描述仍為「更新 剛剛」、id 的 title 帶絕對時間", async () => {
    const w = mountCard({ now: T0 + 2_000 });
    expect(timeEl(w).classes()).toEqual(["sr-only"]);
    expect(describedText(w)).toBe("更新 剛剛");
    await w.setProps({ now: T0 + 2_999 });
    expect(timeEl(w).classes()).toEqual(["sr-only"]);
    const id = w.findAll("span.font-mono").find((s) => s.text() === "press-02")!;
    expect(id.attributes("title")).toBe(`更新於 ${formatClock(T0)}`);
    expect(id.element.parentElement!.textContent).not.toContain("·");
    await w.setProps({ now: T0 + 3_000 });
    expect(timeEl(w).classes()).toEqual(expect.arrayContaining(["truncate", "text-ink-3"]));
    expect(timeEl(w).classes()).not.toContain("sr-only");
    expect(timeEl(w).text()).toBe("·更新 3 秒前"); // 「·」為 aria-hidden 分隔點，與時間同一個可截斷 span
    expect(timeEl(w).get('[aria-hidden="true"]').text()).toBe("·");
    expect(id.element.parentElement!.textContent).toContain("·");
  });

  it("停滯時即使 now 未前進也顯示相對時間；placeholder 不顯示「—」但描述仍為「更新 —」", () => {
    const stale = mountCard({ stale: true, now: T0 });
    expect(timeEl(stale).classes()).not.toContain("sr-only");
    const ph = mountCard({ machine: null });
    expect(timeEl(ph).classes()).toEqual(["sr-only"]);
    expect(describedText(ph)).toBe("更新 —");
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

describe("MachineNodeCard 單一 Tab 停駐點（T056、FR-034d）", () => {
  const AT = 1_700_000_000_000;
  const withLatch: AnomalyLatch = {
    machineId: "press-02",
    level: "critical",
    enteredAt: AT,
    recoveredAt: null,
    clearedBy: null,
  };

  it("卡片主按鈕是 .machine-card[data-machine]、tabindex=0；卡片內其他按鈕（只剩診斷圖示）皆 tabindex=-1，異常標記不是按鈕", () => {
    const w = mountCard({ latch: withLatch, now: AT });
    const buttons = w.findAll("button");
    // 主按鈕 ＋ 診斷圖示；異常標記有渲染但不是按鈕（T073 第三輪：卡片上的標記不可點）
    expect(w.find('[data-fg="latch-mark"]').exists()).toBe(true);
    expect(buttons).toHaveLength(2);
    const [card, ...rest] = buttons;
    expect(card!.classes()).toContain(CARD_ROOT_CLASS);
    expect(card!.attributes("data-machine")).toBe("press-02");
    expect(card!.attributes("tabindex")).toBe("0");
    for (const b of rest) expect(b.attributes("tabindex"), b.attributes("aria-label")).toBe("-1");
  });

  it("卡片內只有主按鈕可被 Tab 走到（focusable 且非 tabindex=-1 的元素恰一個）", () => {
    const w = mountCard({ latch: withLatch, now: AT });
    const tabbable = w
      .findAll("button, a[href], input, select, textarea, [tabindex]")
      .filter((x) => x.attributes("tabindex") !== "-1" && x.attributes("disabled") === undefined);
    expect(tabbable).toHaveLength(1);
    expect(tabbable[0]!.element).toBe(cardButton(w).element);
  });

  it("診斷圖示：滑鼠仍可點（mousedown 取消預設，不搶走卡片焦點）、卡片取得焦點時可見（group-focus-within）", async () => {
    const w = mountCard();
    const diag = w.get('button[aria-label="診斷 壓製機 02"]');
    expect(diag.classes()).toContain("group-focus-within:opacity-100");
    expect(diag.attributes("title")).toContain("選取卡片後按 d");
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    diag.element.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    await diag.trigger("click");
    expect(w.emitted("diagnose")).toEqual([["press-02"]]);
  });

  it("主按鈕可程式聚焦（搜尋 Enter／方向鍵移焦的落點）", () => {
    const w = mount(MachineNodeCard, {
      props: { machine: null, machineId: "press-02", selected: false, stale: false, now: AT },
      attachTo: document.body,
    });
    const el = document.querySelector<HTMLElement>('.machine-card[data-machine="press-02"]');
    expect(el).not.toBeNull();
    el!.focus();
    expect(document.activeElement).toBe(el);
    w.unmount();
  });
});

describe("MachineNodeCard 異常標記（T051、FR-026、US5 Acceptance 1／1a）", () => {
  function latch(over: Partial<AnomalyLatch> = {}): AnomalyLatch {
    return { machineId: "press-02", level: "critical", enteredAt: T0, recoveredAt: null, clearedBy: null, ...over };
  }
  const latchMark = (w: ReturnType<typeof mountCard>) => w.find('[data-fg="latch-mark"]');

  it("無標記（latch 未傳或為 null，含已期滿）：data-latch='none'、無 data-latch-cleared、不渲染標記", () => {
    for (const w of [mountCard(), mountCard({ latch: null })]) {
      expect(cardButton(w).attributes("data-latch")).toBe("none");
      expect(cardButton(w).attributes("data-latch-cleared")).toBeUndefined();
      expect(latchMark(w).exists()).toBe(false);
    }
  });

  it("仍異常：錨 enteredAt 顯示「嚴重 · 進入 N 秒前」，卡片根 data-latch 為等級", () => {
    const w = mountCard({ machine: machine("critical"), latch: latch(), now: T0 + 12_000 });
    expect(cardButton(w).attributes("data-latch")).toBe("critical");
    expect(latchMark(w).text()).toBe("嚴重 · 進入 12 秒前");
    expect(latchMark(w).classes()).toEqual(expect.arrayContaining(["text-crit-fg", "bg-crit-bg", "border-crit"]));
  });

  it("已回復：錨 recoveredAt 顯示過去式「曾警告 · N 秒前回復」；2 秒內為「曾警告 · 剛回復」／「警告 · 剛進入」", async () => {
    const w = mountCard({ latch: latch({ level: "warning", recoveredAt: T0 + 20_000 }), now: T0 + 25_000 });
    expect(cardButton(w).attributes("data-latch")).toBe("warning");
    expect(latchMark(w).text()).toBe("曾警告 · 5 秒前回復");
    expect(latchMark(w).classes()).toEqual(expect.arrayContaining(["text-warn-fg", "bg-warn-bg", "border-warn"]));
    await w.setProps({ now: T0 + 21_000 });
    expect(latchMark(w).text()).toBe("曾警告 · 剛回復");
    await w.setProps({ latch: latch({ level: "warning" }), now: T0 + 1_000 });
    expect(latchMark(w).text()).toBe("警告 · 剛進入");
  });

  it("標記不可互動（T073 第三輪）：非按鈕的 span、無 aria-label／tabindex／hover 外框，所在底列 pointer-events-none（點擊落到卡片＝選台）", () => {
    const w = mountCard({ latch: latch(), now: T0 + 12_000 });
    const mark = latchMark(w);
    expect(mark.element.tagName).toBe("SPAN");
    for (const attr of ["aria-label", "tabindex", "disabled", "role"]) expect(mark.attributes(attr)).toBeUndefined();
    expect(mark.classes().some((c) => c.startsWith("pointer-events-auto") || c.startsWith("hover:"))).toBe(false);
    expect(mark.element.parentElement!.classList.contains("pointer-events-none")).toBe(true);
  });

  it("未確認時卡片主按鈕宣告 aria-keyshortcuts='x'（鍵盤確認入口）；已確認或無標記時不宣告", () => {
    expect(cardButton(mountCard({ latch: latch() })).attributes("aria-keyshortcuts")).toBe("x");
    expect(cardButton(mountCard({ latch: latch({ clearedBy: "user" }) })).attributes("aria-keyshortcuts")).toBeUndefined();
    expect(cardButton(mountCard()).attributes("aria-keyshortcuts")).toBeUndefined();
  });

  it("標記在卡片主按鈕外；卡片 aria-describedby 指向標記文字與更新時間", () => {
    const w = mountCard({ latch: latch(), badge: { kind: "failed" } });
    const card = cardButton(w);
    expect(card.element.querySelector("button")).toBeNull();
    expect(card.element.contains(latchMark(w).element)).toBe(false);
    expect(describedText(w)).toBe("嚴重 · 剛進入 更新 剛剛");
    // chip 在主按鈕內，已含於按鈕名稱，不重複列入描述
    expect(card.text()).toContain("診斷：AI 失敗");
  });

  it("已確認時描述帶「已確認：」前綴；無標記時描述只有更新時間", () => {
    expect(describedText(mountCard({ latch: latch({ clearedBy: "user" }) }))).toBe("已確認：嚴重 · 剛進入 更新 剛剛");
    expect(describedText(mountCard())).toBe("更新 剛剛");
  });

  it("點標記不會確認：卡片不再有 clear-latch 事件，也不連帶 diagnose", async () => {
    const w = mountCard({ latch: latch() });
    await latchMark(w).trigger("click");
    expect(w.emitted("clear-latch")).toBeUndefined();
    expect(w.emitted("diagnose")).toBeUndefined();
  });

  it("已確認（clearedBy=user）：data-latch-cleared、劃線、描述帶「已確認：」前綴", async () => {
    const w = mountCard({ latch: latch({ recoveredAt: T0 + 3_000, clearedBy: "user" }), now: T0 + 10_000 });
    const card = cardButton(w);
    expect(card.attributes("data-latch")).toBe("critical");
    expect(card.attributes("data-latch-cleared")).toBe("");
    const btn = latchMark(w);
    expect(btn.text()).toBe("已確認：曾嚴重 · 7 秒前回復"); // 「已確認：」為 sr-only 前綴
    expect(btn.classes()).toEqual(expect.arrayContaining(["line-through", "text-ink-3", "bg-rim"]));
    expect(btn.classes()).not.toContain("text-crit-fg");
    expect(describedText(w)).toBe("已確認：曾嚴重 · 7 秒前回復 更新 10 秒前");
  });

  it("確認後（props 改為已確認）由未劃線轉為劃線；期滿（store 不再傳 latch）即消失", async () => {
    const w = mountCard({ latch: latch({ recoveredAt: T0 }), now: T0 + 5_000 });
    expect(latchMark(w).classes()).not.toContain("line-through");
    await w.setProps({ latch: latch({ recoveredAt: T0, clearedBy: "user" }) });
    expect(latchMark(w).classes()).toContain("line-through");
    expect(cardButton(w).attributes("data-latch-cleared")).toBe("");
    await w.setProps({ latch: null, now: T0 + 30_000 });
    expect(latchMark(w).exists()).toBe(false);
    expect(cardButton(w).attributes("data-latch")).toBe("none");
    expect(cardButton(w).attributes("data-latch-cleared")).toBeUndefined();
  });

  it("出現動畫用 animate-latch-in（reduced-motion 規則在 tailwind.css 停用）", () => {
    expect(latchMark(mountCard({ latch: latch() })).classes()).toContain("animate-latch-in");
  });
});

describe("MachineNodeCard 診斷狀態 chip（T051、FR-028、US5 Acceptance 3）", () => {
  /** chip 以「診斷：」視覺隱藏前綴辨識（非互動 span）。 */
  const chip = (w: ReturnType<typeof mountCard>) =>
    w.findAll("span").find((s) => s.element.firstElementChild?.textContent === "診斷：");

  it("無診斷（未傳或 none）：data-diagnosis='none'、不渲染 chip", () => {
    for (const w of [mountCard(), mountCard({ badge: { kind: "none" } })]) {
      expect(cardButton(w).attributes("data-diagnosis")).toBe("none");
      expect(chip(w)).toBeUndefined();
    }
  });

  const CASES: readonly [DiagnosisBadge, string, string, string][] = [
    [{ kind: "active", progress: 60 }, "active", "診斷中 60%", "border-accent"],
    [{ kind: "active", progress: null }, "active", "診斷中", "border-accent"],
    [{ kind: "completed", severity: "critical", cached: false }, "completed", "AI：嚴重", "bg-surface-strong"],
    [{ kind: "completed", severity: "warning", cached: true }, "completed", "AI：警告 · 快取", "bg-rim"],
    [{ kind: "failed" }, "failed", "AI 失敗", "bg-crit-bg"],
  ];

  it.each(CASES)("%o → data-diagnosis=%s、文案「%s」", (badge, kind, text, bg) => {
    const w = mountCard({ badge });
    expect(cardButton(w).attributes("data-diagnosis")).toBe(kind);
    const el = chip(w)!;
    expect(el.text()).toBe(`診斷：${text}`);
    expect(el.element.tagName).toBe("SPAN");
    expect(el.classes()).toContain(bg);
    // 只有文字、不帶圖示（T073 第四輪：「AI：」前綴已交代來源，16px 還給 id）；chip 不縮、不截斷
    expect(el.find("svg").exists()).toBe(false);
    expect(el.classes()).toEqual(expect.arrayContaining(["shrink-0", "whitespace-nowrap"]));
    expect(el.classes()).not.toContain("truncate");
    // 方角 4px tag（T073 第四輪）：與狀態徽章、異常標記（全圓 pill）分形
    expect(el.classes()).toContain("rounded-control");
    expect(el.classes()).not.toContain("rounded-pill");
  });

  it("完成態 chip 以「AI：」起頭、狀態徽章維持現在式且為全圓 pill：同一張卡上三者不同字同形（T073 第四輪）", () => {
    const w = mountCard({
      machine: machine("healthy"),
      latch: { machineId: "press-02", level: "critical", enteredAt: T0, recoveredAt: T0 + 2_000, clearedBy: null },
      now: T0 + 5_000,
      badge: { kind: "completed", severity: "critical", cached: true },
    });
    const el = chip(w)!;
    expect(el.text()).toBe("診斷：AI：嚴重 · 快取");
    const badge = w.findAll("span").find((s) => s.text() === "正常" && s.classes().includes("rounded-pill"));
    expect(badge).toBeDefined();
    const mark = w.get('[data-fg="latch-mark"]');
    expect(mark.text()).toBe("曾嚴重 · 3 秒前回復");
    expect(mark.classes()).toContain("rounded-pill");
  });

  it("chip 在 id 列（id · 更新時間 → 停滯徽章 → chip），更新時間最先讓位、id 最後讓位、徽章與 chip 不縮；id 列是標頭第二列、獨佔整寬；chip 不在底列", () => {
    const w = mountCard({
      stale: true,
      now: T0 + 12_000,
      latch: { machineId: "press-02", level: "warning", enteredAt: T0, recoveredAt: null, clearedBy: null },
      badge: { kind: "active", progress: 60 },
    });
    const el = chip(w)!;
    const row = el.element.parentElement!;
    expect(row.classList.contains("h-5")).toBe(true);
    const items = Array.from(row.children).map((c) => c.textContent?.trim());
    expect(items).toEqual(["press-02", "·更新 12 秒前", "停滯", "診斷：診斷中 60%"]);
    const id = row.children[0]!;
    expect(id.classList.contains("truncate")).toBe(true);
    expect(Array.from(id.classList).some((c) => c.startsWith("shrink"))).toBe(false); // 預設 shrink 1：最後讓位
    const time = row.children[1]!;
    expect(time.firstElementChild!.getAttribute("aria-hidden")).toBe("true"); // 分隔點在時間 span 內，一起讓位
    expect(Array.from(time.classList)).toEqual(expect.arrayContaining(["shrink-[999]", "truncate", "min-w-0", "text-ink-3"]));
    expect(row.children[2]!.classList.contains("shrink-0")).toBe(true);
    expect(cardButton(w).element.contains(el.element)).toBe(true);
    // id 列是標頭的第二列（第一列是名稱｜狀態徽章＋燈），不與狀態徽章共用寬度
    const header = row.parentElement!;
    expect(header.children[1]).toBe(row);
    expect(header.children[0]!.textContent).toContain("壓製機 02");
    expect(header.children[0]!.textContent).toContain("正常");
    const footer = w.get('[data-fg="latch-mark"]').element.parentElement!;
    expect(footer.contains(el.element)).toBe(false);
  });

  it("底列只有異常標記（更新時間在標頭 id 列）；底列與標記皆不接收指標事件", () => {
    const w = mountCard({
      latch: { machineId: "press-02", level: "warning", enteredAt: T0, recoveredAt: null, clearedBy: null },
      badge: { kind: "failed" },
    });
    const btn = w.get('[data-fg="latch-mark"]');
    const footer = btn.element.parentElement!;
    expect(Array.from(footer.children).map((c) => c.textContent?.trim())).toEqual(["警告 · 剛進入"]);
    expect(footer.classList.contains("pointer-events-none")).toBe(true);
    expect(btn.classes()).not.toContain("pointer-events-auto");
    // 標記保留截斷當最後防線（可縮），不再 shrink-0 擠壓其他內容
    expect(btn.classes()).toEqual(expect.arrayContaining(["min-w-0", "truncate"]));
    expect(btn.classes()).not.toContain("shrink-0");
    // 更新時間在卡片主按鈕內的 id 列，不受底列標記長度影響
    const updatedId = cardButton(w).attributes("aria-describedby")!.split(" ").at(-1)!;
    const time = w.get(`[id="${updatedId}"]`);
    expect(cardButton(w).element.contains(time.element)).toBe(true);
    expect(footer.contains(time.element)).toBe(false);
  });
});

describe("MachineNodeCard 底列不改卡片尺寸（FR-026、FR-031）", () => {
  it("標記與 chip 出現與否，卡片主按鈕 class 與底列佔位相同；底列固定 h-5、絕對定位", () => {
    const plain = mountCard();
    const busy = mountCard({
      latch: { machineId: "press-02", level: "critical", enteredAt: T0, recoveredAt: null, clearedBy: "user" },
      badge: { kind: "active", progress: 40 },
    });
    expect(new Set(cardButton(plain).classes())).toEqual(new Set(cardButton(busy).classes()));
    for (const w of [plain, busy]) {
      expect(cardButton(w).classes()).toContain("min-h-[148px]");
      const spacer = cardButton(w).get(".mt-auto");
      expect(spacer.classes()).toEqual(expect.arrayContaining(["mt-auto", "h-5"]));
      // 更新時間所在的 id 列固定 h-5：標記／chip 出現與否都不改標頭高度
      const updatedId = cardButton(w).attributes("aria-describedby")!.split(" ").at(-1)!;
      expect(w.get(`[id="${updatedId}"]`).element.parentElement!.classList.contains("h-5")).toBe(true);
    }
    {
      const footer = busy.get('[data-fg="latch-mark"]').element.parentElement!;
      expect(Array.from(footer.classList)).toEqual(expect.arrayContaining(["absolute", "h-5", "overflow-hidden"]));
    }
  });
});
