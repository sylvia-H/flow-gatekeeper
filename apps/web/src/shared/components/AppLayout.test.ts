// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import AppLayout from "./AppLayout.vue";
import App from "../../App.vue";
import { useMonitoringStore } from "../../domains/monitoring/stores/monitoring.store.js";
import { useCopilotStore } from "../../domains/ai-copilot/stores/copilot.store.js";
import { startActiveState } from "../../domains/ai-copilot/lib/copilot-reducer.js";

/**
 * Copilot 面板開關與手動收合偏好（T059／T062／T064、data-model §2、FR-033、FR-034a）。
 *
 * 行為測試掛真的 App（AppLayout＋CopilotDrawer 原樣，其餘重元件 stub 掉、WebSocket 換成不會連線的假物件），
 * 驗的是 App 實際的接線：選取 watch、事件分流（收合鈕 `close`／Escape `dismiss`／遮罩 `dismiss-panel`）、
 * 快捷鍵面板層，以及 copilot store 的偏好讀寫；手機摘要條、異常清單覆蓋層與工具列覆蓋式搜尋的接線
 * 與 Escape 分層（T061／T060）則換成真元件驗。另以純 props 掛 AppLayout 驗 peek 條與 sheet 外觀。
 */

const KEY = "fg.copilot-panel";
let storage: Map<string, string>;
let wrapper: VueWrapper | null = null;
/** sheet 出現時手動觸發 IntersectionObserver（happy-dom 不做 layout）。 */
let showSheet: () => void = () => {};

/** 以 Map 模擬 localStorage：新版 Node 的實驗性 localStorage 會遮蔽 happy-dom 的實作。 */
function stubStorage(): void {
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
    removeItem: (k: string) => void storage.delete(k),
  });
}

/**
 * 依視窗寬度回答 `max-width`／`min-width` 媒體查詢（其餘如 reduced-motion 一律 false），
 * 並記下 change 監聽，`setViewportWidth` 改寬度時對結果翻轉的查詢送出 change。
 * < 1366px＝ bottom-sheet（T073 D 由 1024 提到 1366）；< 768px＝手機（rail 隱藏、主區摘要條）。
 */
let viewportWidth = 1366;
const mediaListeners: { query: string; cb: (e: { matches: boolean }) => void }[] = [];

function evaluateQuery(query: string, width: number): boolean {
  const max = /max-width:\s*([\d.]+)px/.exec(query);
  if (max) return width <= Number(max[1]);
  const min = /min-width:\s*([\d.]+)px/.exec(query);
  if (min) return width >= Number(min[1]);
  return false;
}

function stubViewport(width: number): void {
  viewportWidth = width;
  mediaListeners.length = 0;
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      get matches() {
        return evaluateQuery(query, viewportWidth);
      },
      media: query,
      addEventListener: (_type: string, cb: (e: { matches: boolean }) => void) => {
        mediaListeners.push({ query, cb });
      },
      removeEventListener: (_type: string, cb: (e: { matches: boolean }) => void) => {
        const i = mediaListeners.findIndex((l) => l.cb === cb);
        if (i !== -1) mediaListeners.splice(i, 1);
      },
    })),
  );
}

async function setViewportWidth(width: number): Promise<void> {
  const before = viewportWidth;
  viewportWidth = width;
  for (const { query, cb } of [...mediaListeners]) {
    const was = evaluateQuery(query, before);
    const now = evaluateQuery(query, width);
    if (was !== now) cb({ matches: now });
  }
  await flushPromises();
}

const DESKTOP = 1366;
const PHONE = 390;

/**
 * 假 ResizeObserver：TopBar 以容器寬度決定段位，測試以 `resizeToolbar` 手動送出寬度；
 * AppLayout 觀察 Copilot 面板外框（`[data-fg="copilot"]`）的高度決定主區底部留白，測試以 `resizeSheet` 送出高度。
 */
let resizeToolbar: (width: number) => void = () => {};
let resizeSheet: (height: number) => void = () => {};
class FakeResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(target: Element): void {
    if (target.matches('[data-fg="copilot"]')) {
      resizeSheet = (height) =>
        this.callback(
          [{ target, contentRect: { height }, borderBoxSize: [{ blockSize: height, inlineSize: 0 }] } as unknown as ResizeObserverEntry],
          this,
        );
      return;
    }
    resizeToolbar = (width) =>
      this.callback([{ target, contentRect: { width } } as unknown as ResizeObserverEntry], this);
  }
  unobserve(): void {}
  disconnect(): void {}
}

/** 永遠停在 CONNECTING 的 WebSocket：App 掛載時會連線，測試不需要真的通道。 */
class IdleWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = 0;
  addEventListener(): void {}
  removeEventListener(): void {}
  send(): void {}
  close(): void {
    this.readyState = 3;
  }
}

beforeEach(() => {
  storage = new Map();
  stubStorage();
  stubViewport(DESKTOP);
  resizeToolbar = () => {};
  resizeSheet = () => {};
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  vi.stubGlobal("WebSocket", IdleWebSocket);
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(cb: (entries: { isIntersecting: boolean }[]) => void) {
        showSheet = () => cb([{ isIntersecting: true }]);
      }
      observe(): void {}
      disconnect(): void {}
    },
  );
  // happy-dom 不做 layout：讓 sheet 內的可聚焦元素被視為有渲染（焦點陷阱才會運作）。
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
  setActivePinia(createPinia());
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const DEFAULT_STUBS = {
  TopBar: true,
  ShortcutHelp: true,
  ThemeToggle: true,
  BackpressureStrip: true,
  StageTopology: true,
  FleetHealth: true,
  AnomalySummary: true,
  EventStrip: true,
};

/**
 * 掛 App：與受測行為無關的重元件一律 stub，只留 AppLayout 與 CopilotDrawer 的真實行為；
 * `real` 列出這次要用真元件的名稱（例如手機摘要條與覆蓋層、工具列搜尋）。
 */
function mountApp(real: readonly (keyof typeof DEFAULT_STUBS)[] = []): VueWrapper {
  const stubs: Record<string, boolean> = { ...DEFAULT_STUBS };
  for (const name of real) stubs[name] = false;
  wrapper = mount(App, { attachTo: document.body, global: { stubs } });
  return wrapper;
}

/** 模擬重新載入：卸載、換一份 pinia（store 重新從 storage 讀偏好）、再掛一次。 */
function remountApp(): VueWrapper {
  wrapper?.unmount();
  document.body.innerHTML = "";
  setActivePinia(createPinia());
  return mountApp();
}

const panel = (w: VueWrapper) => w.get('[data-fg="copilot"]');
const isOpen = (w: VueWrapper): boolean => panel(w).attributes("data-open") === "true";
const peek = (w: VueWrapper) => w.find('[data-fg="copilot-peek"]');
const collapseButton = (w: VueWrapper) => w.get('button[aria-label="關閉／收合 AI 診斷面板"]');
const storedPreference = (): unknown => {
  const raw = storage.get(KEY);
  return raw === undefined ? undefined : JSON.parse(raw);
};

async function select(machineId: string | null): Promise<void> {
  const monitoring = useMonitoringStore();
  if (machineId === null) monitoring.selectedMachineId = null;
  else monitoring.selectMachine(machineId);
  await flushPromises();
}

describe("Copilot 面板預設收合與選台（FR-033、data-model §2）", () => {
  it("載入時面板收合、無選取時沒有 peek 條", () => {
    const w = mountApp();
    expect(isOpen(w)).toBe(false);
    expect(peek(w).exists()).toBe(false);
  });

  it("有手動收合偏好時載入仍收合", () => {
    storage.set(KEY, JSON.stringify({ manuallyCollapsed: true }));
    const w = mountApp();
    expect(isOpen(w)).toBe(false);
  });

  it("無偏好時選台即展開；換選另一台仍展開", async () => {
    const w = mountApp();
    await select("mixer-01");
    expect(isOpen(w)).toBe(true);
    await select("press-02");
    expect(isOpen(w)).toBe(true);
  });

  it("面板收合鈕＝手動收合：寫入偏好，之後選台不自動展開", async () => {
    const w = mountApp();
    await select("mixer-01");
    await collapseButton(w).trigger("click");
    expect(isOpen(w)).toBe(false);
    expect(storedPreference()).toEqual({ manuallyCollapsed: true });

    await select("press-02");
    expect(isOpen(w)).toBe(false);
  });

  it("store diagnose（被擋下）展開並清除偏好", async () => {
    storage.set(KEY, JSON.stringify({ manuallyCollapsed: true }));
    const w = mountApp();
    await select("mixer-01");
    expect(isOpen(w)).toBe(false);

    // 連線未就緒：POST 被前置條件擋下，面板仍展開，才看得到停用原因
    await useCopilotStore().diagnose("mixer-01", null);
    await flushPromises();
    expect(isOpen(w)).toBe(true);
    expect(storedPreference()).toEqual({ manuallyCollapsed: false });
  });

  it("`d` 被擋下（斷線、或該台診斷中）也展開面板並顯示停用原因，不多送 POST", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    storage.set(KEY, JSON.stringify({ manuallyCollapsed: true }));
    const w = mountApp();
    await select("mixer-01");
    expect(isOpen(w)).toBe(false);

    // 斷線（測試的 WebSocket 永遠連不上）：前置條件擋下
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "d", bubbles: true }));
    await flushPromises();
    expect(isOpen(w)).toBe(true);
    expect(storedPreference()).toEqual({ manuallyCollapsed: false });
    // 停用原因掛在面板內診斷鈕的 tooltip
    expect(panel(w).find('button[disabled][title^="連線未就緒"]').exists()).toBe(true);

    // 該台診斷中：去重擋下，收合後按 d 仍展開
    const copilot = useCopilotStore();
    copilot.jobs.set("mixer-01", startActiveState("mixer-01", "job-1"));
    await collapseButton(w).trigger("click");
    expect(isOpen(w)).toBe(false);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "d", bubbles: true }));
    await flushPromises();
    expect(isOpen(w)).toBe(true);
    expect(copilot.stateFor("mixer-01")).toMatchObject({ status: "active", jobId: "job-1" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("桌機展開窄條＝展開把手：展開並清除偏好", async () => {
    storage.set(KEY, JSON.stringify({ manuallyCollapsed: true }));
    const w = mountApp();
    await select("mixer-01");
    await w.get('button[aria-label="展開 AI 診斷"]').trigger("click");
    expect(isOpen(w)).toBe(true);
    expect(storedPreference()).toEqual({ manuallyCollapsed: false });
  });

  it("偏好跨重新掛載保留：收合後重新載入，選台仍不展開", async () => {
    let w = mountApp();
    await select("mixer-01");
    await collapseButton(w).trigger("click");

    w = remountApp();
    expect(isOpen(w)).toBe(false);
    await select("press-02");
    expect(isOpen(w)).toBe(false);
  });

  it("取消選取收合，偏好不變", async () => {
    const w = mountApp();
    await select("mixer-01");
    await select(null);
    expect(isOpen(w)).toBe(false);
    expect(storedPreference()).toBeUndefined();
    // 無偏好：再選台照樣展開
    await select("press-02");
    expect(isOpen(w)).toBe(true);
  });

  it("桌機 Escape（快捷鍵的面板層）只收合當次、不寫偏好；再按一次才取消選取", async () => {
    const w = mountApp();
    await select("mixer-01");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await flushPromises();
    expect(isOpen(w)).toBe(false);
    expect(useMonitoringStore().selectedMachineId).toBe("mixer-01");
    expect(storedPreference()).toBeUndefined();

    // Escape 不算手動收合：再點同一台（再次選取）依偏好展開
    await select("mixer-01");
    expect(isOpen(w)).toBe(true);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await flushPromises();
    expect(useMonitoringStore().selectedMachineId).toBeNull();
  });
});

describe("手機 bottom-sheet 與 peek 條（T062、FR-033）", () => {
  beforeEach(() => stubViewport(PHONE));

  /** 選台展開 sheet，並讓 drawer 的焦點陷阱就位（sheet 內的 Escape 才由 drawer 處理）。 */
  async function openSheet(w: VueWrapper, machineId = "press-02"): Promise<void> {
    await select(machineId);
    expect(isOpen(w)).toBe(true);
    showSheet();
    await flushPromises();
  }

  it("以收合鈕收合後退為 peek 條（寫偏好），點 peek 條展開並清除偏好", async () => {
    const w = mountApp();
    await openSheet(w);
    await collapseButton(w).trigger("click");
    expect(isOpen(w)).toBe(false);
    expect(storedPreference()).toEqual({ manuallyCollapsed: true });
    expect(peek(w).exists()).toBe(true);
    expect(peek(w).text()).toContain("壓製機 02");

    await peek(w).trigger("click");
    expect(isOpen(w)).toBe(true);
    expect(peek(w).exists()).toBe(false);
    expect(storedPreference()).toEqual({ manuallyCollapsed: false });
  });

  it("以 Escape 收合後同樣退為 peek 條，但不寫偏好；點 peek 條展開", async () => {
    const w = mountApp();
    await openSheet(w);
    await w.get('[role="dialog"]').trigger("keydown", { key: "Escape" });
    expect(isOpen(w)).toBe(false);
    expect(storedPreference()).toBeUndefined();
    // drawer 攔下 Escape：同一次按鍵不會連帶取消選取
    expect(useMonitoringStore().selectedMachineId).toBe("press-02");
    expect(peek(w).exists()).toBe(true);

    await peek(w).trigger("click");
    expect(isOpen(w)).toBe(true);
  });

  it("遮罩只在 sheet 接手焦點（drawer update:engaged=true）時渲染；點擊只收合當次（退為 peek 條、不寫偏好）", async () => {
    const w = mountApp();
    await openSheet(w);
    w.findComponent({ name: "CopilotDrawer" }).vm.$emit("update:engaged", true);
    await flushPromises();
    await w.get(".bg-scrim\\/50").trigger("click");
    expect(isOpen(w)).toBe(false);
    expect(storedPreference()).toBeUndefined();
    expect(peek(w).exists()).toBe(true);
  });

  it("閒置非 modal sheet（update:engaged=false）不渲染遮罩：選取卡不被調暗，點其他卡片就是改選", async () => {
    const w = mountApp();
    await openSheet(w);
    w.findComponent({ name: "CopilotDrawer" }).vm.$emit("update:engaged", false);
    await flushPromises();
    expect(isOpen(w)).toBe(true);
    expect(w.find(".bg-scrim\\/50").exists()).toBe(false);
    // 沒有遮罩攔截：改選另一台，sheet 跟著換機台、維持展開
    await select("oven-04");
    expect(useMonitoringStore().selectedMachineId).toBe("oven-04");
    expect(isOpen(w)).toBe(true);
  });

  it("有手動收合偏好時選台不展開，直接顯示 peek 條；點擊展開並清除偏好", async () => {
    storage.set(KEY, JSON.stringify({ manuallyCollapsed: true }));
    const w = mountApp();
    await select("press-02");
    expect(isOpen(w)).toBe(false);
    expect(peek(w).exists()).toBe(true);
    await peek(w).trigger("click");
    expect(isOpen(w)).toBe(true);
    expect(storedPreference()).toEqual({ manuallyCollapsed: false });
  });

  it("peek 條帶選取機台的診斷狀態 chip，狀態併進可讀名稱", async () => {
    const w = mountApp();
    await openSheet(w);
    const copilot = useCopilotStore();
    copilot.jobs.set("press-02", startActiveState("press-02", "job-1"));
    copilot.applyEvent({ type: "job/status", jobId: "job-1", machineId: "press-02", status: "active", progress: 60 });
    await collapseButton(w).trigger("click");
    expect(peek(w).text()).toContain("診斷中 60%");
    expect(peek(w).attributes("aria-label")).toBe("展開 AI 診斷：壓製機 02，診斷：診斷中 60%");
  });

  it("取消選取後 peek 條完全不渲染（偏好不變）", async () => {
    const w = mountApp();
    await openSheet(w);
    await collapseButton(w).trigger("click");
    expect(peek(w).exists()).toBe(true);
    await select(null);
    expect(peek(w).exists()).toBe(false);
    expect(isOpen(w)).toBe(false);
    expect(storedPreference()).toEqual({ manuallyCollapsed: true });
  });
});

describe("工具列快捷鍵說明鈕與 `?` 共用同一個開關（T073 C）", () => {
  const helpLayer = () => document.querySelector('[data-fg="shortcut-help"]');
  const helpButton = (w: VueWrapper) => w.get('[data-fg="shortcut-help-toggle"]');

  it("點說明鈕開說明層（aria-expanded 同步）、按 `?` 關；再按 `?` 開、點說明鈕關", async () => {
    const w = mountApp(["TopBar", "ShortcutHelp"]);
    await flushPromises();
    expect(helpLayer()).toBeNull();

    await helpButton(w).trigger("click");
    await flushPromises();
    expect(helpLayer()).not.toBeNull();
    expect(helpButton(w).attributes("aria-expanded")).toBe("true");

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "?", bubbles: true }));
    await flushPromises();
    expect(helpLayer()).toBeNull();
    expect(helpButton(w).attributes("aria-expanded")).toBe("false");

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "?", bubbles: true }));
    await flushPromises();
    expect(helpLayer()).not.toBeNull();
    await helpButton(w).trigger("click");
    await flushPromises();
    expect(helpLayer()).toBeNull();
  });
});

describe("1024–1365px 同樣走 bottom-sheet（T073 D，推擠門檻提到 desk／1366）", () => {
  it("1024 寬：選台展開為 dialog 語意的 sheet（閒置非 modal、診斷開始後接手焦點）；sheet 內 Escape 只收合當次並退為 peek 條", async () => {
    stubViewport(1024);
    const w = mountApp();
    await select("press-02");
    expect(isOpen(w)).toBe(true);
    showSheet();
    await flushPromises();
    const dialog = w.get('[role="dialog"]');
    // 閒置選台：非 modal（焦點留在卡片），不蓋遮罩
    expect(dialog.attributes("aria-modal")).toBe("false");
    expect(w.find(".bg-scrim\\/50").exists()).toBe(false);
    // 診斷開始 → sheet 接手焦點：aria-modal=true，遮罩出現
    useCopilotStore().jobs.set("press-02", startActiveState("press-02", "job-1"));
    await flushPromises();
    expect(dialog.attributes("aria-modal")).toBe("true");
    expect(w.find(".bg-scrim\\/50").exists()).toBe(true);
    await dialog.trigger("keydown", { key: "Escape" });
    expect(isOpen(w)).toBe(false);
    expect(storedPreference()).toBeUndefined();
    expect(useMonitoringStore().selectedMachineId).toBe("press-02");
    expect(peek(w).exists()).toBe(true);
  });

  it("1280、1365 寬仍是 sheet；1366 寬是常駐側欄（不掛 dialog 語意）", async () => {
    stubViewport(1280);
    const w = mountApp();
    await select("press-02");
    showSheet();
    await flushPromises();
    expect(w.find('[role="dialog"]').exists()).toBe(true);
    await setViewportWidth(1365);
    expect(w.find('[role="dialog"]').exists()).toBe(true);
    await setViewportWidth(1366);
    expect(w.find('[role="dialog"]').exists()).toBe(false);
    expect(isOpen(w)).toBe(true);
  });
});

describe("手機機群健康摘要條與異常清單覆蓋層（T061 接線、FR-033a、FR-034a）", () => {
  const bar = (w: VueWrapper) => w.find('[data-fg="fleet-summary-bar"]');
  const overlay = (w: VueWrapper) => w.find('[data-fg="anomaly-overlay"]');
  const escape = async (): Promise<void> => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await flushPromises();
  };

  it("手機寬度在主區最上方渲染摘要條（在背壓 strip 之前），桌機不渲染", async () => {
    stubViewport(PHONE);
    let w = mountApp(["FleetHealth", "AnomalySummary", "BackpressureStrip"]);
    expect(bar(w).exists()).toBe(true);
    const main = w.get("main");
    const order = Array.from(main.element.querySelectorAll('[data-fg="fleet-summary-bar"], [data-fg="backpressure"]'))
      .map((el) => el.getAttribute("data-fg"));
    expect(order[0]).toBe("fleet-summary-bar");

    stubViewport(DESKTOP);
    w = remountApp();
    expect(w.find("main [data-fg='fleet-summary-bar']").exists()).toBe(false);
  });

  it("點摘要條開覆蓋層（aria-expanded 同步）；點遮罩收合", async () => {
    stubViewport(PHONE);
    const w = mountApp(["FleetHealth", "AnomalySummary"]);
    expect(overlay(w).exists()).toBe(false);
    await bar(w).trigger("click");
    expect(overlay(w).exists()).toBe(true);
    expect(overlay(w).attributes("role")).toBe("dialog");
    expect(bar(w).attributes("aria-expanded")).toBe("true");

    await w.get('[data-fg="anomaly-overlay-scrim"]').trigger("click");
    expect(overlay(w).exists()).toBe(false);
    expect(bar(w).attributes("aria-expanded")).toBe("false");
  });

  /** 讓某台進入嚴重狀態，異常清單就有這一列（latch 由遙測批次產生）。 */
  function raiseCritical(machineId: string): void {
    useMonitoringStore().applyTelemetryBatch([
      {
        type: "machine/data",
        machineId,
        timestamp: new Date().toISOString(),
        telemetry: { temperature: 108, vibration: 2.4, throughput: 75, errorRate: 0.16 },
        state: "critical",
      },
    ]);
  }
  const row = (w: VueWrapper, machineId: string) =>
    w.get(`[data-fg="anomaly-overlay"] [data-fg="anomaly-summary"] [data-machine="${machineId}"]`);

  it("覆蓋層選一台：選取該台、覆蓋層關閉；無偏好時面板展開", async () => {
    stubViewport(PHONE);
    const w = mountApp(["FleetHealth", "AnomalySummary"]);
    raiseCritical("press-02");
    await bar(w).trigger("click");
    await row(w, "press-02").get('[data-fg="anomaly-select"]').trigger("click");
    await flushPromises();
    expect(useMonitoringStore().selectedMachineId).toBe("press-02");
    expect(overlay(w).exists()).toBe(false);
    expect(isOpen(w)).toBe(true);
    expect(peek(w).exists()).toBe(false);
  });

  it("覆蓋層選一台：有手動收合偏好時面板不展開，改出現 peek 條", async () => {
    storage.set(KEY, JSON.stringify({ manuallyCollapsed: true }));
    stubViewport(PHONE);
    const w = mountApp(["FleetHealth", "AnomalySummary"]);
    raiseCritical("press-02");
    await bar(w).trigger("click");
    await row(w, "press-02").get('[data-fg="anomaly-select"]').trigger("click");
    await flushPromises();
    expect(useMonitoringStore().selectedMachineId).toBe("press-02");
    expect(overlay(w).exists()).toBe(false);
    expect(isOpen(w)).toBe(false);
    expect(peek(w).exists()).toBe(true);
  });

  it("覆蓋層清除標記：接到 store 的 clearLatch（劃線保留），覆蓋層維持開著", async () => {
    stubViewport(PHONE);
    const w = mountApp(["FleetHealth", "AnomalySummary"]);
    raiseCritical("press-02");
    await bar(w).trigger("click");
    await row(w, "press-02").get('[data-fg="anomaly-clear"]').trigger("click");
    await flushPromises();
    expect(useMonitoringStore().latchFor("press-02")?.clearedBy).toBe("user");
    expect(overlay(w).exists()).toBe(true);
    expect(row(w, "press-02").attributes("data-struck")).toBeDefined();
    expect(useMonitoringStore().selectedMachineId).toBeNull();
  });

  it("Escape 先關覆蓋層、再關 Copilot 面板，最後才取消選取", async () => {
    stubViewport(PHONE);
    const w = mountApp(["FleetHealth", "AnomalySummary"]);
    await select("press-02");
    expect(isOpen(w)).toBe(true);
    await bar(w).trigger("click");
    expect(overlay(w).exists()).toBe(true);

    await escape();
    expect(overlay(w).exists()).toBe(false);
    expect(isOpen(w)).toBe(true);

    await escape();
    expect(isOpen(w)).toBe(false);
    expect(useMonitoringStore().selectedMachineId).toBe("press-02");
    expect(storedPreference()).toBeUndefined();

    await escape();
    expect(useMonitoringStore().selectedMachineId).toBeNull();
  });

  it("寬度回到 ≥ md：摘要條與覆蓋層都不渲染且開關歸零，Escape 不會被看不見的層吃掉", async () => {
    stubViewport(PHONE);
    const w = mountApp(["FleetHealth", "AnomalySummary"]);
    await select("press-02");
    await bar(w).trigger("click");
    expect(overlay(w).exists()).toBe(true);

    await setViewportWidth(DESKTOP);
    expect(overlay(w).exists()).toBe(false);
    expect(w.find("main [data-fg='fleet-summary-bar']").exists()).toBe(false);

    // 開關已歸零：第一次 Escape 直接關 Copilot 面板
    await escape();
    expect(isOpen(w)).toBe(false);

    // 再回手機寬度，覆蓋層仍是關的
    await setViewportWidth(PHONE);
    expect(bar(w).exists()).toBe(true);
    expect(bar(w).attributes("aria-expanded")).toBe("false");
    expect(overlay(w).exists()).toBe(false);
  });

  it("`/` 在工具列 compact（< 640px）時展開覆蓋式搜尋並聚焦；Escape 先收回搜尋覆蓋", async () => {
    stubViewport(PHONE);
    const w = mountApp(["TopBar", "FleetHealth", "AnomalySummary"]);
    await select("press-02");
    resizeToolbar(320);
    await flushPromises();

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "/", bubbles: true }));
    await flushPromises();
    const topBar = w.findComponent({ name: "TopBar" }).vm as unknown as {
      isSearchOverlayOpen: boolean;
      searchInput: HTMLInputElement | null;
    };
    expect(topBar.isSearchOverlayOpen).toBe(true);
    expect(document.activeElement).toBe(topBar.searchInput);

    // App 層的 Escape 分層：搜尋覆蓋排在 Copilot 面板之前，只收回搜尋覆蓋，面板仍開著
    await escape();
    expect(topBar.isSearchOverlayOpen).toBe(false);
    expect(isOpen(w)).toBe(true);
  });
});

describe("AppLayout 外觀（純 props）", () => {
  function mountLayout(props: {
    panelOpen: boolean;
    peekLabel: string | null;
    peekStatus?: string | null;
    sheetEngaged?: boolean;
    sheetCompact?: boolean;
  }) {
    wrapper = mount(AppLayout, { props, attachTo: document.body });
    return wrapper;
  }

  it("bottom-sheet 高度依內容（不設固定最小高度）、最高 85vh，並有抓取把手", () => {
    const w = mountLayout({ panelOpen: true, peekLabel: "壓製機 02" });
    const cls = panel(w).classes();
    expect(cls).toContain("max-h-[85vh]");
    expect(cls.some((c) => c.startsWith("min-h-["))).toBe(false);
    expect(panel(w).find(".desk\\:hidden .w-10").exists()).toBe(true);
  });

  it("推擠式側欄門檻為 desk（≥ 1366px）：面板、遮罩、展開窄條、peek 條都不再用 lg: 斷點", () => {
    const open = mountLayout({ panelOpen: true, peekLabel: "壓製機 02", sheetEngaged: true });
    expect(panel(open).classes()).toEqual(
      expect.arrayContaining(["desk:static", "desk:w-[360px]", "desk:shrink-0", "desk:bg-surface/72", "desk:shadow-glass"]),
    );
    expect(open.get(".bg-scrim\\/50").classes()).toContain("desk:hidden");
    open.unmount();
    // 未接手焦點（閒置非 modal sheet、未傳 prop）時不渲染遮罩
    const idle = mountLayout({ panelOpen: true, peekLabel: "壓製機 02" });
    expect(idle.find(".bg-scrim\\/50").exists()).toBe(false);
    idle.unmount();
    const closed = mountLayout({ panelOpen: false, peekLabel: "壓製機 02" });
    expect(closed.get('button[aria-label="展開 AI 診斷"]').classes()).toContain("desk:flex");
    expect(closed.get('[data-fg="copilot-peek"]').classes()).toContain("desk:hidden");
    expect(closed.html()).not.toMatch(/\b(lg|xl):/);
  });

  it("peek 條：無診斷時不渲染 chip，可讀名稱只有機台名；按鈕內沒有互動元素", () => {
    const w = mountLayout({ panelOpen: false, peekLabel: "攪拌機 01", peekStatus: null });
    const bar = w.get('[data-fg="copilot-peek"]');
    expect(bar.element.tagName).toBe("BUTTON");
    expect(bar.attributes("aria-label")).toBe("展開 AI 診斷：攪拌機 01");
    expect(bar.findAll("span.rounded-pill")).toHaveLength(0);
    expect(bar.findAll("button, a, input")).toHaveLength(0);
  });

  it("peek 條：有診斷時顯示 chip 文字並併進可讀名稱", () => {
    const w = mountLayout({ panelOpen: false, peekLabel: "壓製機 02", peekStatus: "AI：嚴重" });
    const bar = w.get('[data-fg="copilot-peek"]');
    expect(bar.get("span.rounded-pill").text()).toBe("AI：嚴重");
    expect(bar.attributes("aria-label")).toBe("展開 AI 診斷：壓製機 02，診斷：AI：嚴重");
    // 可見只剩機台名＋chip：「AI 診斷」標籤改為視覺隱藏，避免與 chip 的「AI：」重複；高度維持 32px
    const label = bar.findAll("span").find((s) => s.text() === "AI 診斷")!;
    expect(label.classes()).toEqual(["sr-only"]);
    const visible = bar.findAll("span").filter((s) => !s.classes().includes("sr-only")).map((s) => s.text());
    expect(visible).toEqual(["壓製機 02", "AI：嚴重"]);
    expect(bar.classes()).toContain("h-8");
  });

  describe("主區與 rail 底部留白（critique 第三輪 P1、第四輪交叉審查）", () => {
    const TABLET = 1024;
    const reserve = (w: VueWrapper) =>
      (w.get(".h-screen").element as HTMLElement).style.getPropertyValue("--fg-bottom-reserve");

    it("< desk：peek 條 32px、閒置單列 sheet＝實際高度；接手焦點後 sheet 長高不跟著動；收合回 peek、無選取歸零", async () => {
      stubViewport(TABLET);
      const w = mountLayout({ panelOpen: false, peekLabel: null });
      expect(reserve(w)).toBe("0px");
      // 兩處都以同一個變數留白，desk+ 由 desk:pb-0 蓋掉
      for (const el of [w.get(".bg-bench-grid-lines"), w.get('aside[aria-label="側欄"]')]) {
        expect(el.classes()).toEqual(expect.arrayContaining(["pb-[var(--fg-bottom-reserve)]", "desk:pb-0"]));
      }

      await w.setProps({ peekLabel: "壓製機 02" });
      expect(reserve(w)).toBe("32px");

      // 展開閒置單列：尚未量到時保留前值，量到後採用實際高度
      await w.setProps({ panelOpen: true, sheetCompact: true });
      expect(reserve(w)).toBe("32px");
      resizeSheet(51);
      await flushPromises();
      expect(reserve(w)).toBe("51px");

      // 開始診斷：瀏覽器順序是 sheet 先長高（ResizeObserver）、drawer 的 engaged 後到；sheetCompact 已同步轉 false，留白不動
      await w.setProps({ sheetCompact: false });
      resizeSheet(420);
      await flushPromises();
      expect(reserve(w)).toBe("51px");
      await w.setProps({ sheetEngaged: true });
      resizeSheet(653);
      await flushPromises();
      expect(reserve(w)).toBe("51px");

      // 收合 → peek 條（一次重排）
      resizeSheet(0);
      await w.setProps({ panelOpen: false, sheetEngaged: false });
      expect(reserve(w)).toBe("32px");

      await w.setProps({ peekLabel: null });
      expect(reserve(w)).toBe("0px");
    });

    it("一打開就是 modal（從 peek 重開／改選已有結果的機台）：先送大高度、再送 engaged=true，留白維持開啟前的值（第四輪交叉審查 high）", async () => {
      stubViewport(TABLET);
      const w = mountLayout({ panelOpen: false, peekLabel: "壓製機 02" });
      expect(reserve(w)).toBe("32px");
      await w.setProps({ panelOpen: true, sheetCompact: false });
      resizeSheet(653);
      await flushPromises();
      expect(reserve(w)).toBe("32px");
      await w.setProps({ sheetEngaged: true });
      await flushPromises();
      expect(reserve(w)).toBe("32px");
      w.unmount();

      // 已開著的閒置單列改選到有結果的機台：sheetCompact 同步轉 false，sheet 先長高、engaged 後到，留白維持單列高度
      const v = mountLayout({ panelOpen: true, peekLabel: "攪拌機 01", sheetCompact: true });
      resizeSheet(51);
      await flushPromises();
      expect(reserve(v)).toBe("51px");
      await v.setProps({ peekLabel: "壓製機 02", sheetCompact: false });
      resizeSheet(653);
      await flushPromises();
      expect(reserve(v)).toBe("51px");
      await v.setProps({ sheetEngaged: true });
      expect(reserve(v)).toBe("51px");
    });

    it("desk+（≥ 1366px）：推擠式側欄的高度不寫進留白，恆 0", async () => {
      stubViewport(DESKTOP);
      const w = mountLayout({ panelOpen: true, peekLabel: "壓製機 02", sheetCompact: true });
      resizeSheet(700);
      await flushPromises();
      expect(reserve(w)).toBe("0px");
      await w.setProps({ panelOpen: false });
      expect(reserve(w)).toBe("0px");
    });
  });

  it("peek 條點擊 emit open-panel；面板展開或無選取時不渲染", async () => {
    const w = mountLayout({ panelOpen: false, peekLabel: "攪拌機 01" });
    await w.get('[data-fg="copilot-peek"]').trigger("click");
    expect(w.emitted("open-panel")).toHaveLength(1);
    await w.setProps({ panelOpen: true });
    expect(w.find('[data-fg="copilot-peek"]').exists()).toBe(false);
    await w.setProps({ panelOpen: false, peekLabel: null });
    expect(w.find('[data-fg="copilot-peek"]').exists()).toBe(false);
  });
});

describe("主區欄高度與事件流預設高度（T065：FR-031）", () => {
  const handle = (w: VueWrapper) => w.get('[aria-label="調整事件流面板高度"]');

  /** 改 window.innerHeight（happy-dom 不做 layout，App 只在掛載當下讀一次）；afterEach 前還原。 */
  let restoreHeight: (() => void) | null = null;
  function stubInnerHeight(height: number): void {
    const original = Object.getOwnPropertyDescriptor(window, "innerHeight");
    Object.defineProperty(window, "innerHeight", { configurable: true, value: height });
    restoreHeight = () => {
      if (original) Object.defineProperty(window, "innerHeight", original);
      else delete (window as { innerHeight?: number }).innerHeight;
    };
  }
  afterEach(() => {
    restoreHeight?.();
    restoreHeight = null;
  });

  it("<main> 是 flex 直欄，main slot 的根以 flex-1 取高（不用 h-full 百分比）", () => {
    const w = mountApp();
    const main = w.get("main");
    expect(main.classes()).toEqual(expect.arrayContaining(["flex", "flex-col", "min-h-0", "p-3"]));
    const column = main.element.firstElementChild as HTMLElement;
    expect([...column.classList]).toEqual(expect.arrayContaining(["flex", "flex-col", "flex-1", "min-h-0"]));
    expect(column.classList.contains("h-full")).toBe(false);
  });

  it("拓樸捲動區外層下緣有一道蝕刻邊（捲動邊界，不隨內容捲）", () => {
    const w = mountApp();
    const viewport = w.findComponent({ name: "StageTopology" }).element.parentElement as HTMLElement;
    expect([...viewport.classList]).toEqual(
      expect.arrayContaining(["min-h-0", "flex-1", "overflow-hidden", "border-b", "border-edge"]),
    );
  });

  it("視窗高 ≤ 800px 且無偏好：事件流預設 100px（標題＋2 列，最後一列不被切半）", () => {
    stubInnerHeight(768);
    const w = mountApp();
    expect(handle(w).attributes("aria-valuenow")).toBe("100");
    expect(handle(w).attributes("aria-valuemin")).toBe("100");
    expect(w.findComponent({ name: "EventStrip" }).props("height")).toBe(100);
  });

  it("視窗高 > 800px 且無偏好：事件流預設 164px（標題＋4 列，最後一列不被切半）", () => {
    stubInnerHeight(900);
    const w = mountApp();
    expect(handle(w).attributes("aria-valuenow")).toBe("164");
  });

  it("已有偏好時用偏好（不論視窗高），仍可用方向鍵調到上限 360", async () => {
    stubInnerHeight(768);
    storage.set("flow-gatekeeper:event-strip-height", "220");
    const w = mountApp();
    expect(handle(w).attributes("aria-valuenow")).toBe("220");
    await handle(w).trigger("keydown", { key: "End" });
    expect(handle(w).attributes("aria-valuenow")).toBe("360");
    expect(storage.get("flow-gatekeeper:event-strip-height")).toBe("360");
  });
});
