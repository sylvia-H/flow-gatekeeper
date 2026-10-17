// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia, type Pinia } from "pinia";
import TopBar from "./TopBar.vue";
import { useMonitoringStore } from "../../domains/monitoring/stores/monitoring.store.js";
import { CONNECTION_NOT_READY_MESSAGE } from "../../domains/ai-copilot/composables/useDiagnoseTrigger.js";
import { resetThemeStateForTest } from "../composables/useTheme.js";
import { useCopilotStore } from "../../domains/ai-copilot/stores/copilot.store.js";
import { startActiveState } from "../../domains/ai-copilot/lib/copilot-reducer.js";

/**
 * TopBar 分組與文案（spec FR-034、FR-038、research R13）。
 * 資料來源只有 store：測試直接寫 monitoring store（setConnectionStatus／setClientId／
 * setLatency／setAuthorized），不建 WebSocket。dev 指標面板旗標固定為開，讓分組計數可確定。
 */

let pinia: Pinia;
let wrapper: VueWrapper | null = null;

beforeEach(() => {
  vi.stubEnv("VITE_METRICS_PANEL", "true");
  pinia = createPinia();
  setActivePinia(pinia);
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  vi.unstubAllEnvs();
  document.body.innerHTML = "";
});

function mountBar(): VueWrapper {
  wrapper = mount(TopBar, { global: { plugins: [pinia] }, attachTo: document.body });
  return wrapper;
}

/** 讓 store 進入 isLive（已連線、有 clientId、訂閱已授權）。 */
function goLive(): ReturnType<typeof useMonitoringStore> {
  const store = useMonitoringStore();
  store.setConnectionStatus("connected");
  store.setClientId("client-1");
  store.setAuthorized(true);
  return store;
}

/** 收斂空白，讓「已連線 · 12 ms」不受模板換行與 span 間距影響。 */
const text = (el: Element): string => (el.textContent ?? "").replace(/\s+/g, " ").trim();

const chip = (w: VueWrapper) => w.get('[data-fg="connection-chip"]');
const group = (w: VueWrapper, label: string) => w.get(`[role="group"][aria-label="${label}"]`);
const diagnoseButton = (w: VueWrapper) => w.get('[aria-label="主要動作"] button');

/** 「可見選項」＝可操作或會被朗讀的控制項。 */
const OPTION_SELECTOR = 'button, input, [role="status"], [role="alert"]';

describe("TopBar 語意分組（FR-034）", () => {
  it("有導航／播放控制／系統狀態／主要動作四組，依序排列", () => {
    const w = mountBar();
    const labels = w.findAll('[role="group"]').map((g) => g.attributes("aria-label"));
    expect(labels).toEqual(["導航", "播放控制", "系統狀態", "主要動作"]);
  });

  it("選項最多時（未授權 chip 出現、指標面板開）各組選項數確定且 ≤ 4", async () => {
    const store = useMonitoringStore();
    store.setConnectionStatus("connected");
    store.setAuthorized(false);
    const w = mountBar();
    await w.vm.$nextTick();

    const counts = Object.fromEntries(
      w.findAll('[role="group"]').map((g) => [g.attributes("aria-label"), g.findAll(OPTION_SELECTOR).length]),
    );
    // 系統狀態：指標面板觸發鈕、連線 chip、未授權 chip、快捷鍵說明鈕（背壓計量已於 T036 移出工具列，改為主區背壓 strip）
    expect(counts).toEqual({ 導航: 1, 播放控制: 2, 系統狀態: 4, 主要動作: 1 });
    for (const g of w.findAll('[role="group"]')) {
      expect(g.element.children.length, g.attributes("aria-label")).toBeLessThanOrEqual(4);
    }
    expect(group(w, "系統狀態").find('[data-fg="auth-chip"]').exists()).toBe(true);
    expect(group(w, "系統狀態").find('button[aria-label="指標面板"]').exists()).toBe(true);
  });

  it("導航組是繁中 placeholder 的搜尋框，輸入寫回 store", async () => {
    const store = useMonitoringStore();
    const w = mountBar();
    const input = group(w, "導航").get('input[type="search"]');
    expect(input.attributes("placeholder")).toBe("搜尋機台");
    await input.setValue("烤爐");
    expect(store.searchQuery).toBe("烤爐");
  });

  it("播放控制：暫停鈕兩態——未暫停「暫停」、暫停中文字與可讀名稱換成「恢復」並以墨色實底標出狀態（無 aria-pressed），Mock 頻率維持 disabled", async () => {
    const store = useMonitoringStore();
    const w = mountBar();
    const [pause, mock] = group(w, "播放控制").findAll("button");
    expect(text(pause!.element)).toBe("暫停");
    expect(pause!.attributes("aria-label")).toBe("暫停");
    expect(pause!.attributes("aria-pressed")).toBeUndefined();
    expect(pause!.classes()).not.toContain("bg-ink");

    await pause!.trigger("click");
    expect(store.paused).toBe(true);
    // 暫停中：可見文字與可讀名稱一起換成「恢復」（使用者裁決 2026-10-17），不用 aria-pressed；外觀比照 segmented 選中段，Play 圖示實心
    expect(text(pause!.element)).toBe("恢復");
    expect(pause!.attributes("aria-label")).toBe("恢復");
    expect(pause!.attributes("aria-pressed")).toBeUndefined();
    expect(pause!.classes()).toEqual(expect.arrayContaining(["bg-ink", "text-surface-strong", "font-semibold"]));
    expect(pause!.get("svg").classes()).toContain("fill-current");
    expect(pause!.attributes("title")).toContain("恢復");

    await pause!.trigger("click");
    expect(store.paused).toBe(false);
    expect(text(pause!.element)).toBe("暫停");
    expect(pause!.attributes("aria-label")).toBe("暫停");
    expect(text(mock!.element)).toBe("Mock 頻率");
    expect(mock!.attributes("disabled")).toBeDefined();
  });

  it("expose focusPauseToggle：把焦點交回暫停鈕（暫停橫幅的「恢復」按下後橫幅消失，焦點不掉到 body）", () => {
    const w = mountBar();
    const pause = w.get('[data-fg="pause-toggle"]');
    expect(document.activeElement).not.toBe(pause.element);
    (w.vm as unknown as { focusPauseToggle: () => void }).focusPauseToggle();
    expect(document.activeElement).toBe(pause.element);
  });
});

describe("搜尋框 Enter 選取唯一結果（T056、FR-034a）", () => {
  /** 主區卡片的替身：與 MachineNodeCard 同一個錨點（`.machine-card[data-machine]`、原生 button 可聚焦）。 */
  function fakeCard(id: string): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "machine-card";
    btn.dataset["machine"] = id;
    document.body.appendChild(btn);
    return btn;
  }

  async function pressEnter(w: VueWrapper, init: KeyboardEventInit = {}): Promise<KeyboardEvent> {
    const input = group(w, "導航").get('input[type="search"]');
    (input.element as HTMLInputElement).focus();
    const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...init });
    input.element.dispatchEvent(event);
    await flushPromises();
    return event;
  }

  it("結果恰一台：選取該台、攔截按鍵（preventDefault），並把焦點移到該台卡片", async () => {
    const store = useMonitoringStore();
    const spy = vi.spyOn(store, "selectMachine");
    fakeCard("press-02");
    const oven = fakeCard("oven-04");
    const w = mountBar();
    await group(w, "導航").get('input[type="search"]').setValue("烤爐");
    expect(store.visibleMachineIds).toEqual(["oven-04"]);

    const event = await pressEnter(w);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("oven-04");
    expect(store.selectedMachineId).toBe("oven-04");
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(oven);
  });

  it("preventDefault 在移焦的 await 之前同步呼叫（冒泡到 App 層時已是 defaultPrevented，App 層據此略過）", async () => {
    const store = useMonitoringStore();
    fakeCard("oven-04");
    const w = mountBar();
    await group(w, "導航").get('input[type="search"]').setValue("烤爐");
    let preventedAtBubble: boolean | null = null;
    const onDoc = (e: Event): void => {
      preventedAtBubble = e.defaultPrevented;
    };
    document.addEventListener("keydown", onDoc);
    try {
      await pressEnter(w);
    } finally {
      document.removeEventListener("keydown", onDoc);
    }
    expect(preventedAtBubble).toBe(true);
    expect(store.selectedMachineId).toBe("oven-04");
  });

  it("IME 組字中的 Enter（確認選字）不選取、不攔截", async () => {
    const store = useMonitoringStore();
    const spy = vi.spyOn(store, "selectMachine");
    fakeCard("oven-04");
    const w = mountBar();
    await group(w, "導航").get('input[type="search"]').setValue("烤爐");

    for (const init of [{ isComposing: true }, { keyCode: 229 }] as KeyboardEventInit[]) {
      const event = await pressEnter(w, init);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(spy).not.toHaveBeenCalled();
    expect(store.selectedMachineId).toBeNull();
  });

  it("0 台或多台：不選取、不攔截、焦點留在搜尋框", async () => {
    const store = useMonitoringStore();
    const spy = vi.spyOn(store, "selectMachine");
    fakeCard("press-02");
    const w = mountBar();
    const input = group(w, "導航").get('input[type="search"]');

    for (const query of ["zzz", "0", ""]) {
      await input.setValue(query);
      expect(store.visibleMachineIds.length).not.toBe(1);
      const event = await pressEnter(w);
      expect(event.defaultPrevented).toBe(false);
      expect(document.activeElement).toBe(input.element);
    }
    expect(spy).not.toHaveBeenCalled();
    expect(store.selectedMachineId).toBeNull();
  });

  it("長按 Enter 的重複事件不處理", async () => {
    const store = useMonitoringStore();
    const spy = vi.spyOn(store, "selectMachine");
    fakeCard("oven-04");
    const w = mountBar();
    await group(w, "導航").get('input[type="search"]').setValue("烤爐");
    const event = await pressEnter(w, { repeat: true });
    expect(event.defaultPrevented).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("卡片不在 DOM 時仍選取、不拋錯", async () => {
    const store = useMonitoringStore();
    const w = mountBar();
    await group(w, "導航").get('input[type="search"]').setValue("烤爐");
    await pressEnter(w);
    expect(store.selectedMachineId).toBe("oven-04");
  });

  it("expose 搜尋框元素（App 層快捷鍵判斷「搜尋框內的 Enter」與 `/` 聚焦用）", () => {
    const w = mountBar();
    const exposed = (w.vm as unknown as { searchInput: HTMLInputElement | null }).searchInput;
    expect(exposed).toBe(group(w, "導航").get('input[type="search"]').element);
  });
});

describe("快捷鍵說明鈕（T073 C：可見入口）", () => {
  const helpButton = (w: VueWrapper) => w.get('[data-fg="shortcut-help-toggle"]');

  it("圖示鈕在系統狀態分組：可讀名稱「快捷鍵說明」、title 帶快捷鍵、宣告開啟對話框", () => {
    const w = mountBar();
    const button = group(w, "系統狀態").get('[data-fg="shortcut-help-toggle"]');
    expect(button.element.tagName).toBe("BUTTON");
    expect(button.attributes("type")).toBe("button");
    expect(button.attributes("aria-label")).toBe("快捷鍵說明");
    expect(button.attributes("title")).toBe("快捷鍵說明（?）");
    expect(button.attributes("aria-haspopup")).toBe("dialog");
    expect(button.attributes("aria-keyshortcuts")).toBe("?");
    expect(button.attributes("aria-expanded")).toBe("false");
  });

  it("點擊 emit toggle-help（開關由 App 持有，不另立狀態）；aria-expanded 跟隨 helpOpen prop", async () => {
    const w = mountBar();
    await helpButton(w).trigger("click");
    await helpButton(w).trigger("click");
    expect(w.emitted("toggle-help")).toHaveLength(2);
    await w.setProps({ helpOpen: true });
    expect(helpButton(w).attributes("aria-expanded")).toBe("true");
  });
});

describe("主要動作「診斷」", () => {
  it("文案為「診斷」、深青實心；未選台時 disabled", () => {
    const w = mountBar();
    const button = diagnoseButton(w);
    expect(text(button.element)).toBe("診斷");
    expect(button.classes()).toContain("bg-accent");
    expect(button.attributes("disabled")).toBeDefined();
    expect(button.attributes("title")).toBe("先選取機台");
  });

  it("已選台且連線活著（isLive）→ 可用", () => {
    goLive().selectMachine("press-02");
    const w = mountBar();
    const button = diagnoseButton(w);
    expect(button.attributes("disabled")).toBeUndefined();
    expect(button.attributes("title")).toBe("對選取機台執行 AI 診斷");
  });

  it("已選台但未連線 → disabled，title 為連線未就緒說明", () => {
    const store = useMonitoringStore();
    store.setConnectionStatus("disconnected");
    store.selectMachine("press-02");
    const w = mountBar();
    const button = diagnoseButton(w);
    expect(button.attributes("disabled")).toBeDefined();
    expect(button.attributes("title")).toBe(CONNECTION_NOT_READY_MESSAGE);
  });

  it("已選台、連線正常但該台診斷進行中（去重）→ disabled，title 與 describedby 為「該機台診斷進行中」", async () => {
    goLive().selectMachine("press-02");
    const copilot = useCopilotStore();
    copilot.jobs.set("press-02", startActiveState("press-02", "job-1"));
    const w = mountBar();
    await w.vm.$nextTick();
    const button = diagnoseButton(w);
    expect(button.attributes("disabled")).toBeDefined();
    expect(button.attributes("title")).toBe("該機台診斷進行中");
    expect(document.getElementById(button.attributes("aria-describedby")!)?.textContent).toBe("該機台診斷進行中");
  });

  it("停用原因（與可用時的動作說明）經 aria-describedby 給輔助技術，不只在 title", async () => {
    const store = useMonitoringStore();
    const w = mountBar();
    const describedBy = () => document.getElementById(diagnoseButton(w).attributes("aria-describedby")!);
    expect(describedBy()?.textContent).toBe("先選取機台");
    expect(describedBy()?.classList.contains("sr-only")).toBe(true);
    store.setConnectionStatus("disconnected");
    store.selectMachine("press-02");
    await w.vm.$nextTick();
    expect(describedBy()?.textContent).toBe(CONNECTION_NOT_READY_MESSAGE);
  });
});

describe("連線 chip 三態中文文案與顏色（FR-004）", () => {
  it("已連線且有 RTT：「已連線 · N ms」、ok 色", async () => {
    const store = useMonitoringStore();
    store.setConnectionStatus("connected");
    store.setLatency(12);
    const w = mountBar();
    await w.vm.$nextTick();
    expect(text(chip(w).element)).toBe("已連線 · 12 ms");
    expect(chip(w).classes()).toContain("text-ok-fg");
    expect(chip(w).attributes("aria-label")).toBe("連線狀態：已連線，延遲 12 ms");
    expect(chip(w).attributes("role")).toBe("status");
  });

  it("已連線但首個 pong 前：「已連線 · —」", () => {
    useMonitoringStore().setConnectionStatus("connected");
    const w = mountBar();
    expect(text(chip(w).element)).toBe("已連線 · —");
    expect(chip(w).attributes("aria-label")).toBe("連線狀態：已連線，延遲 尚未量測");
  });

  it("重新連線中：「重新連線中」、warn 色，不顯示 RTT", () => {
    useMonitoringStore().setConnectionStatus("reconnecting");
    const w = mountBar();
    expect(text(chip(w).element)).toBe("重新連線中");
    expect(chip(w).classes()).toContain("text-warn-fg");
    expect(chip(w).attributes("aria-label")).toBe("連線狀態：重新連線中");
  });

  it("已斷線：「已斷線」、crit 色", () => {
    useMonitoringStore().setConnectionStatus("disconnected");
    const w = mountBar();
    expect(text(chip(w).element)).toBe("已斷線");
    expect(chip(w).classes()).toContain("text-crit-fg");
  });

  it("未授權時另顯示「未授權」chip（role=alert），可讀名稱帶完整說明", async () => {
    const store = useMonitoringStore();
    store.setConnectionStatus("connected");
    const w = mountBar();
    expect(w.find('[data-fg="auth-chip"]').exists()).toBe(false);
    store.setAuthorized(false);
    await w.vm.$nextTick();
    const auth = group(w, "系統狀態").get('[data-fg="auth-chip"]');
    expect(text(auth.element)).toBe("未授權");
    expect(auth.attributes("role")).toBe("alert");
    expect(auth.attributes("aria-label")).toBe(store.authError);
  });
});

// ── US6 T060：三段收合、手機主題切換位置、覆蓋式搜尋 ─────────────────────────────

/**
 * happy-dom 沒有版面：以假 ResizeObserver 手動送出工具列寬度驅動三段（full／icons／compact）；
 * 假 matchMedia 的 `narrow` 控制「手機寬度（rail 隱藏）」。未呼叫 `resize` 前段位為 `full`。
 */
let resize: ((width: number) => void) | null = null;
let narrow = false;

class FakeResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(target: Element): void {
    resize = (width) => this.callback([{ target, contentRect: { width } } as unknown as ResizeObserverEntry], this);
  }
  unobserve(): void {}
  disconnect(): void {
    resize = null;
  }
}

function stubLayout(): void {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: narrow && query.includes("max-width"),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
}

interface TopBarExposed {
  searchInput: HTMLInputElement | null;
  size: "full" | "icons" | "compact";
  isSearchOverlayOpen: boolean;
  openSearchOverlay: () => Promise<void>;
  closeSearchOverlay: (options?: { restoreFocus?: boolean }) => void;
  focusSearch: () => void;
}
const exposed = (w: VueWrapper): TopBarExposed => w.vm as unknown as TopBarExposed;

/** 掛載後送出工具列寬度並等重新渲染。 */
async function mountAt(width: number): Promise<VueWrapper> {
  const w = mountBar();
  resize?.(width);
  await w.vm.$nextTick();
  return w;
}

/** 工具列的四個語意分組（排除主題切換自己的「主題」群組）。 */
const toolbarGroups = (w: VueWrapper) =>
  w.findAll('[role="group"][aria-label]').filter((g) => g.attributes("aria-label") !== "主題");

/** 各組「可見選項」：主題切換（內含兩段按鈕）算一項。 */
function optionCounts(w: VueWrapper): Record<string, number> {
  return Object.fromEntries(
    toolbarGroups(w).map((g) => {
      const toggles = g.findAll('[data-fg="theme-toggle"]').length;
      const others = g
        .findAll(OPTION_SELECTOR)
        .filter((o) => o.element.closest('[data-fg="theme-toggle"]') === null);
      return [g.attributes("aria-label"), others.length + toggles];
    }),
  );
}

describe("工具列三段收合（T060、FR-032、research R10）", () => {
  beforeEach(() => {
    narrow = false;
    stubLayout();
  });
  afterEach(() => {
    resize = null;
    vi.unstubAllGlobals();
    resetThemeStateForTest();
    delete document.documentElement.dataset["theme"];
  });

  it("門檻：≥ 820 全部、640–819 只留圖示、< 640 精簡；尚未量到寬度時為 full", async () => {
    const w = mountBar();
    expect(exposed(w).size).toBe("full");
    const cases: [number, string][] = [
      [1200, "full"],
      [820, "full"],
      [819.5, "icons"],
      [640, "icons"],
      [639.5, "compact"],
      [320, "compact"],
    ];
    for (const [width, size] of cases) {
      resize!(width);
      await w.vm.$nextTick();
      expect(exposed(w).size, `${width}px`).toBe(size);
      expect(w.get(".tb-bar").attributes("data-tb-size")).toBe(size);
    }
  });

  it("full：控制項文字可見，分組計數與 Phase 3 相同", async () => {
    const store = useMonitoringStore();
    store.setConnectionStatus("connected");
    store.setAuthorized(false);
    const w = await mountAt(1000);
    const [pause, mock] = group(w, "播放控制").findAll("button");
    for (const button of [pause!, mock!, diagnoseButton(w)]) {
      expect(button.get("span").classes()).not.toContain("sr-only");
    }
    expect(optionCounts(w)).toEqual({ 導航: 1, 播放控制: 2, 系統狀態: 4, 主要動作: 1 });
  });

  it("icons：暫停／Mock 頻率／診斷的文字改為 sr-only，可讀名稱保留；搜尋框與指標面板仍在", async () => {
    const store = useMonitoringStore();
    const w = await mountAt(700);
    const [pause, mock] = group(w, "播放控制").findAll("button");
    const named = [
      [pause!, "暫停"],
      [mock!, "Mock 頻率"],
      [diagnoseButton(w), "診斷"],
    ] as const;
    for (const [button, label] of named) {
      expect(button.attributes("aria-label")).toBe(label);
      expect(button.get("span").classes()).toContain("sr-only");
      expect(text(button.element)).toBe(label);
    }
    await pause!.trigger("click");
    expect(store.paused).toBe(true);
    // 只剩圖示的段位也看得出暫停中：墨色實底、實心 Play 圖示；可讀名稱換成「恢復」
    expect(pause!.attributes("aria-label")).toBe("恢復");
    expect(text(pause!.element)).toBe("恢復");
    expect(pause!.attributes("aria-pressed")).toBeUndefined();
    expect(pause!.classes()).toContain("bg-ink");
    expect(pause!.get("svg").classes()).toContain("fill-current");
    expect(group(w, "導航").find('input[type="search"]').exists()).toBe(true);
    expect(group(w, "系統狀態").find('button[aria-label="指標面板"]').exists()).toBe(true);
    expect(w.find('[data-fg="search-toggle"]').exists()).toBe(false);
  });

  it("compact：搜尋收成圖示鈕、Mock 頻率與指標面板不渲染、RTT 數字省略（可讀名稱仍帶）", async () => {
    const store = useMonitoringStore();
    store.setConnectionStatus("connected");
    store.setLatency(12);
    store.setAuthorized(false);
    const w = await mountAt(500);

    expect(w.find('input[type="search"]').exists()).toBe(false);
    expect(exposed(w).searchInput).toBeNull();
    const toggle = group(w, "導航").get('[data-fg="search-toggle"]');
    expect(toggle.element.tagName).toBe("BUTTON");
    expect(toggle.attributes("aria-label")).toBe("搜尋機台");
    expect(toggle.attributes("aria-expanded")).toBe("false");

    expect(group(w, "播放控制").findAll("button")).toHaveLength(1);
    expect(w.find('button[aria-label="Mock 頻率"]').exists()).toBe(false);
    expect(w.find('button[aria-label="指標面板"]').exists()).toBe(false);

    expect(text(chip(w).element)).toBe("已連線");
    expect(chip(w).attributes("aria-label")).toBe("連線狀態：已連線，延遲 12 ms");
    const auth = group(w, "系統狀態").get('[data-fg="auth-chip"]');
    expect(auth.attributes("aria-label")).toBe(store.authError);
    expect(auth.get("span:not([aria-hidden])").classes()).toContain("sr-only");

    // 桌機（rail 在）時工具列即使 < 640px 也不放主題切換，避免與 rail 重複；快捷鍵說明鈕 ≥ md 恆常駐
    expect(w.find('[data-fg="theme-toggle"]').exists()).toBe(false);
    expect(group(w, "系統狀態").find('[data-fg="shortcut-help-toggle"]').exists()).toBe(true);
    expect(optionCounts(w)).toEqual({ 導航: 1, 播放控制: 1, 系統狀態: 3, 主要動作: 1 });
  });

  it("手機寬度（rail 隱藏）：主題切換以單一圖示鈕移入系統狀態分組，各組 ≤ 4", async () => {
    narrow = true;
    const store = useMonitoringStore();
    store.setConnectionStatus("connected");
    store.setAuthorized(false);
    const w = await mountAt(366);
    expect(exposed(w).size).toBe("compact");
    const toggle = group(w, "系統狀態").get('[data-fg="theme-toggle"]');
    expect(toggle.element.tagName).toBe("BUTTON");
    expect(toggle.attributes("aria-label")).toBe("切換為深色主題");
    expect(toggle.attributes("aria-pressed")).toBeUndefined();
    expect(toggle.find('[role="group"]').exists()).toBe(false);
    await toggle.trigger("click");
    expect(document.documentElement.dataset["theme"]).toBe("dark");
    expect(toggle.attributes("aria-label")).toBe("切換為淺色主題");
    expect(optionCounts(w)).toEqual({ 導航: 1, 播放控制: 1, 系統狀態: 3, 主要動作: 1 });
    for (const g of toolbarGroups(w)) {
      expect(g.element.children.length, g.attributes("aria-label")).toBeLessThanOrEqual(4);
    }
  });

  it("390px 最寬組合（重新連線中＋未授權＋compact）：各元素都在、各組 ≤ 4", async () => {
    narrow = true;
    const store = useMonitoringStore();
    store.setConnectionStatus("reconnecting");
    store.setAuthorized(false);
    const w = await mountAt(366);
    expect(exposed(w).size).toBe("compact");
    expect(group(w, "導航").find('[data-fg="search-toggle"]').exists()).toBe(true);
    expect(group(w, "播放控制").findAll("button")).toHaveLength(1);
    const status = group(w, "系統狀態");
    expect(text(status.get('[data-fg="connection-chip"]').element)).toBe("重新連線中");
    expect(status.get('[data-fg="auth-chip"]').attributes("role")).toBe("alert");
    expect(status.get('[data-fg="theme-toggle"]').element.tagName).toBe("BUTTON");
    expect(status.find('button[aria-label="指標面板"]').exists()).toBe(false);
    // 390 compact＋未授權：餘裕不足，快捷鍵說明鈕讓位（`?` 仍可用）
    expect(status.find('[data-fg="shortcut-help-toggle"]').exists()).toBe(false);
    expect(diagnoseButton(w).attributes("aria-label")).toBe("診斷");
    expect(optionCounts(w)).toEqual({ 導航: 1, 播放控制: 1, 系統狀態: 3, 主要動作: 1 });
  });

  it("640–767px 視窗（rail 已隱藏、工具列仍是 icons）：主題切換進系統狀態分組、指標面板讓位給搜尋框", async () => {
    narrow = true;
    const store = useMonitoringStore();
    store.setConnectionStatus("connected");
    store.setAuthorized(false);
    const w = await mountAt(700);
    expect(exposed(w).size).toBe("icons");
    expect(group(w, "系統狀態").find('[data-fg="theme-toggle"]').exists()).toBe(true);
    expect(group(w, "系統狀態").find('button[aria-label="指標面板"]').exists()).toBe(false);
    expect(group(w, "導航").find('input[type="search"]').exists()).toBe(true);
    // 非 compact 有餘裕：快捷鍵說明鈕照常渲染（連線 chip、未授權 chip、主題切換、說明鈕）
    expect(group(w, "系統狀態").find('[data-fg="shortcut-help-toggle"]').exists()).toBe(true);
    expect(optionCounts(w)).toEqual({ 導航: 1, 播放控制: 2, 系統狀態: 4, 主要動作: 1 });
  });

  it("桌機寬度（rail 在）的 full：工具列不放主題切換", async () => {
    const w = await mountAt(1000);
    expect(w.find('[data-fg="theme-toggle"]').exists()).toBe(false);
  });

  it("手機寬度 compact、無未授權 chip：快捷鍵說明鈕在系統狀態分組（連線 chip、主題切換、說明鈕）", async () => {
    narrow = true;
    goLive();
    const w = await mountAt(366);
    expect(exposed(w).size).toBe("compact");
    expect(group(w, "系統狀態").find('[data-fg="shortcut-help-toggle"]').exists()).toBe(true);
    expect(optionCounts(w)).toEqual({ 導航: 1, 播放控制: 1, 系統狀態: 3, 主要動作: 1 });
  });
});

describe("compact 覆蓋式搜尋（T060、FR-032、FR-034a）", () => {
  beforeEach(() => {
    narrow = true;
    stubLayout();
  });
  afterEach(() => {
    resize = null;
    vi.unstubAllGlobals();
  });

  const toggleOf = (w: VueWrapper) => w.get('[data-fg="search-toggle"]');
  const overlayOf = (w: VueWrapper) => w.find('[data-fg="search-overlay"]');

  async function openByClick(w: VueWrapper): Promise<HTMLInputElement> {
    await toggleOf(w).trigger("click");
    await flushPromises();
    return w.get('input[type="search"]').element as HTMLInputElement;
  }

  function keydown(target: Element, init: KeyboardEventInit): KeyboardEvent {
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(event);
    return event;
  }

  it("點圖示鈕展開覆蓋並聚焦輸入框；aria-expanded／aria-controls 指向覆蓋；導航組 ≤ 4", async () => {
    const w = await mountAt(366);
    const input = await openByClick(w);
    const overlay = overlayOf(w);
    expect(overlay.exists()).toBe(true);
    expect(overlay.classes()).toEqual(expect.arrayContaining(["absolute", "inset-0", "z-30"]));
    expect(document.activeElement).toBe(input);
    expect(exposed(w).isSearchOverlayOpen).toBe(true);
    expect(exposed(w).searchInput).toBe(input);
    expect(toggleOf(w).attributes("aria-expanded")).toBe("true");
    expect(toggleOf(w).attributes("aria-controls")).toBe(overlay.attributes("id"));
    expect(optionCounts(w)["導航"]).toBe(3);
  });

  it("覆蓋內輸入仍寫回 store；收回後搜尋字串保留", async () => {
    const store = useMonitoringStore();
    const w = await mountAt(366);
    await openByClick(w);
    await w.get('input[type="search"]').setValue("烤爐");
    expect(store.searchQuery).toBe("烤爐");
    exposed(w).closeSearchOverlay();
    await w.vm.$nextTick();
    expect(overlayOf(w).exists()).toBe(false);
    expect(store.searchQuery).toBe("烤爐");
  });

  it("Escape 收回：攔截按鍵（defaultPrevented）、不冒泡到 App 層，焦點回到圖示鈕", async () => {
    const w = await mountAt(366);
    const input = await openByClick(w);
    const onDoc = vi.fn();
    document.addEventListener("keydown", onDoc);
    try {
      const event = keydown(input, { key: "Escape" });
      await w.vm.$nextTick();
      expect(event.defaultPrevented).toBe(true);
      expect(onDoc).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener("keydown", onDoc);
    }
    expect(overlayOf(w).exists()).toBe(false);
    expect(exposed(w).isSearchOverlayOpen).toBe(false);
    expect(document.activeElement).toBe(toggleOf(w).element);
  });

  it("輸入法組字中的 Escape 不收回、不攔截", async () => {
    const w = await mountAt(366);
    const input = await openByClick(w);
    const event = keydown(input, { key: "Escape", isComposing: true });
    await w.vm.$nextTick();
    expect(event.defaultPrevented).toBe(false);
    expect(overlayOf(w).exists()).toBe(true);
  });

  it("失焦到覆蓋外收回；焦點在覆蓋內移動（輸入框 → 收回鈕）不收", async () => {
    const w = await mountAt(366);
    await openByClick(w);
    const shell = overlayOf(w).element;
    const closeButton = overlayOf(w).get("button").element;
    shell.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: closeButton }));
    await w.vm.$nextTick();
    expect(overlayOf(w).exists()).toBe(true);

    shell.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: diagnoseButton(w).element }));
    await w.vm.$nextTick();
    expect(overlayOf(w).exists()).toBe(false);
    // 失焦收回不搶焦點（restoreFocus: false）：焦點要去的地方由使用者決定，不拉回圖示鈕
    expect(document.activeElement).not.toBe(toggleOf(w).element);
  });

  it("失焦到頁面以外（relatedTarget 為 null）同樣收回", async () => {
    const w = await mountAt(366);
    await openByClick(w);
    overlayOf(w).element.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: null }));
    await w.vm.$nextTick();
    expect(exposed(w).isSearchOverlayOpen).toBe(false);
  });

  it("收回鈕：可讀名稱「收回搜尋」、mousedown 不搶焦點、點擊收回並把焦點交回圖示鈕", async () => {
    const w = await mountAt(366);
    await openByClick(w);
    const closeButton = overlayOf(w).get("button");
    expect(text(closeButton.element)).toBe("收回");
    expect(closeButton.attributes("aria-label")).toBe("收回搜尋");
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    closeButton.element.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    await closeButton.trigger("click");
    expect(overlayOf(w).exists()).toBe(false);
    expect(document.activeElement).toBe(toggleOf(w).element);
  });

  it("Enter 選取唯一結果：選取該台、覆蓋收回、焦點移到該台卡片", async () => {
    const store = useMonitoringStore();
    const card = document.createElement("button");
    card.className = "machine-card";
    card.dataset["machine"] = "oven-04";
    document.body.appendChild(card);
    const w = await mountAt(366);
    await openByClick(w);
    await w.get('input[type="search"]').setValue("烤爐");
    const event = keydown(w.get('input[type="search"]').element, { key: "Enter" });
    await flushPromises();
    expect(event.defaultPrevented).toBe(true);
    expect(store.selectedMachineId).toBe("oven-04");
    expect(overlayOf(w).exists()).toBe(false);
    expect(document.activeElement).toBe(card);
  });

  it("expose：openSearchOverlay／focusSearch 在 compact 展開並聚焦，closeSearchOverlay 收回並交回焦點", async () => {
    const w = await mountAt(366);
    await exposed(w).openSearchOverlay();
    await w.vm.$nextTick();
    expect(exposed(w).isSearchOverlayOpen).toBe(true);
    expect(document.activeElement).toBe(exposed(w).searchInput);
    exposed(w).closeSearchOverlay();
    await w.vm.$nextTick();
    expect(exposed(w).isSearchOverlayOpen).toBe(false);
    // 焦點原在覆蓋內 → 交回圖示鈕
    expect(document.activeElement).toBe(toggleOf(w).element);

    exposed(w).focusSearch();
    await flushPromises();
    expect(exposed(w).isSearchOverlayOpen).toBe(true);
  });

  it("非 compact 時 focusSearch 只聚焦一般搜尋框，不開覆蓋", async () => {
    const w = await mountAt(1000);
    exposed(w).focusSearch();
    await flushPromises();
    expect(exposed(w).isSearchOverlayOpen).toBe(false);
    expect(overlayOf(w).exists()).toBe(false);
    expect(document.activeElement).toBe(w.get('input[type="search"]').element);
  });

  it("覆蓋開著時工具列變寬（離開 compact）：覆蓋收回，輸入框仍是同一元素且保有焦點", async () => {
    const w = await mountAt(366);
    const input = await openByClick(w);
    resize!(700);
    await w.vm.$nextTick();
    expect(exposed(w).isSearchOverlayOpen).toBe(false);
    expect(overlayOf(w).exists()).toBe(false);
    expect(w.get('input[type="search"]').element).toBe(input);
    expect(document.activeElement).toBe(input);
  });

  it("搜尋框有焦點時工具列變窄（進入 compact）：直接展開覆蓋，不把輸入中的框收掉", async () => {
    const w = await mountAt(700);
    const input = w.get('input[type="search"]').element as HTMLInputElement;
    input.focus();
    resize!(500);
    await w.vm.$nextTick();
    expect(exposed(w).isSearchOverlayOpen).toBe(true);
    expect(w.get('input[type="search"]').element).toBe(input);
  });
});
