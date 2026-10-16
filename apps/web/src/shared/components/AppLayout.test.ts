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
 * < 1024px＝ bottom-sheet；< 768px＝手機（rail 隱藏、主區摘要條）。
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

/** 假 ResizeObserver：TopBar 以容器寬度決定段位，測試以 `resizeToolbar` 手動送出寬度。 */
let resizeToolbar: (width: number) => void = () => {};
class FakeResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(target: Element): void {
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

  it("遮罩點擊只收合當次（退為 peek 條、不寫偏好）", async () => {
    const w = mountApp();
    await openSheet(w);
    await w.get(".bg-scrim\\/50").trigger("click");
    expect(isOpen(w)).toBe(false);
    expect(storedPreference()).toBeUndefined();
    expect(peek(w).exists()).toBe(true);
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
  function mountLayout(props: { panelOpen: boolean; peekLabel: string | null; peekStatus?: string | null }) {
    wrapper = mount(AppLayout, { props, attachTo: document.body });
    return wrapper;
  }

  it("bottom-sheet 高度依內容（不設固定最小高度）、最高 85vh，並有抓取把手", () => {
    const w = mountLayout({ panelOpen: true, peekLabel: "壓製機 02" });
    const cls = panel(w).classes();
    expect(cls).toContain("max-h-[85vh]");
    expect(cls.some((c) => c.startsWith("min-h-["))).toBe(false);
    expect(panel(w).find(".lg\\:hidden .w-10").exists()).toBe(true);
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
    const w = mountLayout({ panelOpen: false, peekLabel: "攪拌機 01", peekStatus: "結果 · 嚴重" });
    const bar = w.get('[data-fg="copilot-peek"]');
    expect(bar.get("span.rounded-pill").text()).toBe("結果 · 嚴重");
    expect(bar.attributes("aria-label")).toBe("展開 AI 診斷：攪拌機 01，診斷：結果 · 嚴重");
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
