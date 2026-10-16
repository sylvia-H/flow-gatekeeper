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

/** 卡片主按鈕 aria-describedby 指向的各段文字（以空白串接，同螢幕閱讀器的描述計算）。 */
function describedText(w: ReturnType<typeof mountCard>): string {
  const ids = (cardButton(w).attributes("aria-describedby") ?? "").split(" ").filter(Boolean);
  return ids.map((id) => w.get(`[id="${id}"]`).text()).join(" ");
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

describe("MachineNodeCard 單一 Tab 停駐點（T056、FR-034d）", () => {
  const AT = 1_700_000_000_000;
  const withLatch: AnomalyLatch = {
    machineId: "press-02",
    level: "critical",
    enteredAt: AT,
    recoveredAt: null,
    clearedBy: null,
  };

  it("卡片主按鈕是 .machine-card[data-machine]、tabindex=0；卡片內其他按鈕（清除鈕、診斷圖示）皆 tabindex=-1", () => {
    const w = mountCard({ latch: withLatch, now: AT });
    const buttons = w.findAll("button");
    // 主按鈕 ＋ 清除鈕 ＋ 診斷圖示：確認清除鈕確實有渲染，否則「其他按鈕」的斷言會空轉
    expect(buttons).toHaveLength(3);
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
  const clearBtn = (w: ReturnType<typeof mountCard>) => w.find('[data-fg="latch-clear"]');

  it("無標記（latch 未傳或為 null，含已期滿）：data-latch='none'、無 data-latch-cleared、不渲染清除鈕", () => {
    for (const w of [mountCard(), mountCard({ latch: null })]) {
      expect(cardButton(w).attributes("data-latch")).toBe("none");
      expect(cardButton(w).attributes("data-latch-cleared")).toBeUndefined();
      expect(clearBtn(w).exists()).toBe(false);
    }
  });

  it("仍異常：錨 enteredAt 顯示「嚴重 · 進入 N 秒前」，卡片根 data-latch 為等級", () => {
    const w = mountCard({ machine: machine("critical"), latch: latch(), now: T0 + 12_000 });
    expect(cardButton(w).attributes("data-latch")).toBe("critical");
    expect(clearBtn(w).text()).toBe("嚴重 · 進入 12 秒前");
    expect(clearBtn(w).classes()).toEqual(expect.arrayContaining(["text-crit-fg", "bg-crit-bg", "border-crit"]));
  });

  it("已回復：錨 recoveredAt 顯示「警告 · 已回復 N 秒前」；2 秒內為「剛進入」／「剛回復」", async () => {
    const w = mountCard({ latch: latch({ level: "warning", recoveredAt: T0 + 20_000 }), now: T0 + 25_000 });
    expect(cardButton(w).attributes("data-latch")).toBe("warning");
    expect(clearBtn(w).text()).toBe("警告 · 已回復 5 秒前");
    expect(clearBtn(w).classes()).toEqual(expect.arrayContaining(["text-warn-fg", "bg-warn-bg", "border-warn"]));
    await w.setProps({ now: T0 + 21_000 });
    expect(clearBtn(w).text()).toBe("警告 · 剛回復");
    await w.setProps({ latch: latch({ level: "warning" }), now: T0 + 1_000 });
    expect(clearBtn(w).text()).toBe("警告 · 剛進入");
  });

  it("清除鈕：原生 button、tabindex=-1（不佔 Tab 停駐點，FR-034d）、可讀名稱含可見文字與動作", () => {
    const btn = clearBtn(mountCard({ latch: latch(), now: T0 + 12_000 }));
    expect(btn.element.tagName).toBe("BUTTON");
    expect(btn.attributes("type")).toBe("button");
    expect(btn.attributes("tabindex")).toBe("-1");
    expect(btn.attributes("disabled")).toBeUndefined();
    expect(btn.attributes("aria-label")).toBe("嚴重 · 進入 12 秒前，清除 壓製機 02 的異常標記");
  });

  it("清除鈕不巢狀在卡片主按鈕內（互動元素不可巢狀）；卡片 aria-describedby 只指向標記文字與更新時間，不含清除動作", () => {
    const w = mountCard({ latch: latch(), badge: { kind: "failed" } });
    const card = cardButton(w);
    expect(card.element.querySelector("button")).toBeNull();
    expect(describedText(w)).toBe("嚴重 · 剛進入 更新 剛剛");
    expect(describedText(w)).not.toContain("清除");
    // chip 在主按鈕內，已含於按鈕名稱，不重複列入描述
    expect(card.text()).toContain("診斷：失敗");
  });

  it("已確認時描述帶「已確認：」前綴；無標記時描述只有更新時間", () => {
    expect(describedText(mountCard({ latch: latch({ clearedBy: "user" }) }))).toBe("已確認：嚴重 · 剛進入 更新 剛剛");
    expect(describedText(mountCard())).toBe("更新 剛剛");
  });

  it("清除鈕 mousedown 取消預設（點擊後轉 disabled 時焦點不掉到 body）", async () => {
    const w = mountCard({ latch: latch() });
    const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    clearBtn(w).element.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it("點清除鈕 emit clear-latch(machineId)，不連帶 select／diagnose", async () => {
    const w = mountCard({ latch: latch() });
    await clearBtn(w).trigger("click");
    expect(w.emitted("clear-latch")).toEqual([["press-02"]]);
    expect(w.emitted("select")).toBeUndefined();
    expect(w.emitted("diagnose")).toBeUndefined();
  });

  it("已確認（clearedBy=user）：data-latch-cleared、劃線、disabled、可讀名稱「已確認：…」，點擊不再 emit", async () => {
    const w = mountCard({ latch: latch({ recoveredAt: T0 + 3_000, clearedBy: "user" }), now: T0 + 10_000 });
    const card = cardButton(w);
    expect(card.attributes("data-latch")).toBe("critical");
    expect(card.attributes("data-latch-cleared")).toBe("");
    const btn = clearBtn(w);
    expect(btn.text()).toBe("已確認：嚴重 · 已回復 7 秒前"); // 「已確認：」為 sr-only 前綴
    expect(btn.classes()).toEqual(expect.arrayContaining(["line-through", "text-ink-3", "bg-rim"]));
    expect(btn.classes()).not.toContain("text-crit-fg");
    expect(btn.attributes("disabled")).toBeDefined();
    expect(btn.attributes("aria-label")).toBe("已確認：壓製機 02 嚴重 · 已回復 7 秒前");
    await btn.trigger("click");
    expect(w.emitted("clear-latch")).toBeUndefined();
  });

  it("清除後（props 改為已確認）由未劃線轉為劃線；期滿（store 不再傳 latch）即消失", async () => {
    const w = mountCard({ latch: latch({ recoveredAt: T0 }), now: T0 + 5_000 });
    expect(clearBtn(w).classes()).not.toContain("line-through");
    await w.setProps({ latch: latch({ recoveredAt: T0, clearedBy: "user" }) });
    expect(clearBtn(w).classes()).toContain("line-through");
    expect(cardButton(w).attributes("data-latch-cleared")).toBe("");
    await w.setProps({ latch: null, now: T0 + 30_000 });
    expect(clearBtn(w).exists()).toBe(false);
    expect(cardButton(w).attributes("data-latch")).toBe("none");
    expect(cardButton(w).attributes("data-latch-cleared")).toBeUndefined();
  });

  it("出現動畫用 animate-latch-in（reduced-motion 規則在 tailwind.css 停用）", () => {
    expect(clearBtn(mountCard({ latch: latch() })).classes()).toContain("animate-latch-in");
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
    [{ kind: "completed", severity: "critical", cached: false }, "completed", "結果 · 嚴重", "bg-surface-strong"],
    [{ kind: "completed", severity: "ok", cached: true }, "completed", "快取 · 正常", "bg-rim"],
    [{ kind: "failed" }, "failed", "失敗", "bg-crit-bg"],
  ];

  it.each(CASES)("%o → data-diagnosis=%s、文案「%s」", (badge, kind, text, bg) => {
    const w = mountCard({ badge });
    expect(cardButton(w).attributes("data-diagnosis")).toBe(kind);
    const el = chip(w)!;
    expect(el.text()).toBe(`診斷：${text}`);
    expect(el.element.tagName).toBe("SPAN");
    expect(el.classes()).toContain(bg);
  });

  it("chip 在 id 列（id → 停滯徽章 → chip），id 讓位可截斷、徽章不縮；chip 不在底列", () => {
    const w = mountCard({
      stale: true,
      latch: { machineId: "press-02", level: "warning", enteredAt: T0, recoveredAt: null, clearedBy: null },
      badge: { kind: "active", progress: 60 },
    });
    const el = chip(w)!;
    const row = el.element.parentElement!;
    expect(row.classList.contains("h-5")).toBe(true);
    const items = Array.from(row.children).map((c) => c.textContent?.trim());
    expect(items).toEqual(["press-02", "停滯", "診斷：診斷中 60%"]);
    const id = row.children[0]!;
    expect(id.classList.contains("shrink-[999]")).toBe(true);
    expect(id.classList.contains("truncate")).toBe(true);
    expect(row.children[1]!.classList.contains("shrink-0")).toBe(true);
    expect(cardButton(w).element.contains(el.element)).toBe(true);
    const footer = w.get('[data-fg="latch-clear"]').element.parentElement!;
    expect(footer.contains(el.element)).toBe(false);
  });

  it("底列只有標記與更新時間；底列不接收指標事件，只有未確認的清除鈕可點", () => {
    const w = mountCard({
      latch: { machineId: "press-02", level: "warning", enteredAt: T0, recoveredAt: null, clearedBy: null },
      badge: { kind: "failed" },
    });
    const btn = w.get('[data-fg="latch-clear"]');
    const footer = btn.element.parentElement!;
    expect(Array.from(footer.children).map((c) => c.textContent?.trim())).toEqual(["警告 · 剛進入", "更新 剛剛"]);
    expect(footer.classList.contains("pointer-events-none")).toBe(true);
    expect(btn.classes()).toContain("pointer-events-auto");
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
      const spacer = cardButton(w).get("[title]");
      expect(spacer.classes()).toEqual(expect.arrayContaining(["mt-auto", "h-5"]));
      const updatedId = cardButton(w).attributes("aria-describedby")!.split(" ").at(-1)!;
      const footer = w.get(`[id="${updatedId}"]`).element.parentElement!;
      expect(Array.from(footer.classList)).toEqual(expect.arrayContaining(["absolute", "h-5", "overflow-hidden"]));
    }
  });
});
