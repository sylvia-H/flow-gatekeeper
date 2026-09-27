// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia, type Pinia } from "pinia";
import type { SystemMetrics } from "@flow-gatekeeper/contracts";
import MetricsPanel from "./MetricsPanel.vue";
import { useMetricsStore } from "../../domains/monitoring/stores/metrics.store.js";
import { useMonitoringStore } from "../../domains/monitoring/stores/monitoring.store.js";

/**
 * MetricsPanel 元件行為與可及性（review02 Batch D）。
 * 資料來源只有 metrics／monitoring 兩個 store：測試直接寫 store（applyMetrics、
 * setConnectionStatus、now），不建 WebSocket。展開層 Teleport 到 body，故查 document.body。
 */

const T0 = Date.parse("2026-09-27T00:00:00.000Z");
const WINDOW_MS = 5_000;

const SNAPSHOT: SystemMetrics = {
  type: "system/metrics",
  windowMs: WINDOW_MS,
  collectedAt: "2026-09-27T00:00:00.000Z",
  queue: { waiting: 2, active: 1, failed: 0 },
  wsConnections: 3,
  worker: {
    snapshotAt: "2026-09-27T00:00:00.000Z",
    llmLatency: { count: 4, avgMs: 1200, p95Ms: 2400, maxMs: 3100 },
    cache: { hits: 3, misses: 1, hitRate: 0.75 },
  },
};

let pinia: Pinia;
let wrapper: VueWrapper | null = null;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  pinia = createPinia();
  setActivePinia(pinia);
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  vi.useRealTimers();
  document.body.innerHTML = "";
});

function mountPanel(): VueWrapper {
  wrapper = mount(MetricsPanel, { global: { plugins: [pinia] }, attachTo: document.body });
  return wrapper;
}

const trigger = () => wrapper!.get('button[aria-label="Metrics panel"]');
const panel = () => document.body.querySelector<HTMLElement>("div.fixed");

async function openPanel(): Promise<HTMLElement> {
  await trigger().trigger("click");
  await flushPromises();
  const el = panel();
  if (!el) throw new Error("面板未展開");
  return el;
}

/** 餵一則快照並把 monitoring 時鐘推到 T0 + elapsed。 */
function receive(opts: { connected: boolean; elapsedMs: number }): void {
  const monitoring = useMonitoringStore();
  monitoring.setConnectionStatus(opts.connected ? "connected" : "disconnected");
  useMetricsStore().applyMetrics(SNAPSHOT);
  monitoring.now = T0 + opts.elapsedMs;
}

describe("MetricsPanel 四態文案（stale 與 disconnected 必須分得開）", () => {
  it("empty：尚未收到快照 → No data、無指標列、年齡為 —", async () => {
    mountPanel();
    const el = await openPanel();
    expect(el.textContent).toContain("No data");
    expect(el.textContent).toContain("尚未收到任何指標摘要");
    expect(el.querySelector("dl")).toBeNull();
    expect(el.textContent).toContain("—");
  });

  it("live：連線中且在 2×windowMs 內 → Live、顯示年齡／窗口與四項指標", async () => {
    receive({ connected: true, elapsedMs: 3_000 });
    mountPanel();
    const el = await openPanel();
    expect(el.textContent).toContain("Live");
    expect(el.textContent).toContain("3s ago");
    expect(el.textContent).toContain("5s window");
    expect(el.textContent).toContain("2/1/0"); // queue waiting/active/failed
    expect(el.textContent).toContain("1,200ms/2,400ms/3,100ms");
    expect(el.textContent).toContain("75%");
  });

  it("stale：連線中但逾 2×windowMs 未收新快照 → Stale 與「後端可能停止廣播」提示", async () => {
    receive({ connected: true, elapsedMs: 2 * WINDOW_MS + 1_000 });
    mountPanel();
    const el = await openPanel();
    expect(el.textContent).toContain("Stale");
    expect(el.textContent).toContain("後端指標可能停止廣播");
    expect(el.textContent).not.toContain("Offline");
  });

  it("disconnected：有快照但即時通道未連線 → Offline 與「顯示最後已知數值」提示，且與 stale 色點不同", async () => {
    receive({ connected: false, elapsedMs: 1_000 });
    mountPanel();
    const el = await openPanel();
    expect(el.textContent).toContain("Offline");
    expect(el.textContent).toContain("即時通道未連線");
    expect(el.textContent).toContain("2/1/0");
    // 四態以「文案 + 色點」雙重編碼（design token：disconnected=crit、stale=warn）
    const triggerDot = trigger().findAll("span").find((s) => s.classes().includes("rounded-pill"))!;
    expect(triggerDot.classes()).toContain("bg-crit");
    expect(triggerDot.classes()).not.toContain("bg-warn");
  });
});

describe("MetricsPanel 展開／收合", () => {
  it("預設收合；點觸發鈕展開並同步 aria-expanded，再點收合", async () => {
    mountPanel();
    expect(trigger().attributes("aria-expanded")).toBe("false");
    expect(panel()).toBeNull();
    await openPanel();
    expect(trigger().attributes("aria-expanded")).toBe("true");
    await trigger().trigger("click");
    expect(panel()).toBeNull();
    expect(trigger().attributes("aria-expanded")).toBe("false");
  });

  it("Escape 與面板外 mousedown 會關閉；面板內 mousedown 不關閉", async () => {
    mountPanel();
    const el = await openPanel();
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await flushPromises();
    expect(panel()).not.toBeNull();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await flushPromises();
    expect(panel()).toBeNull();

    await openPanel();
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await flushPromises();
    expect(panel()).toBeNull();
  });

  it("唯讀：展開層內沒有任何按鈕或表單控制項（憲章 II：面板不是操作介面）", async () => {
    receive({ connected: true, elapsedMs: 0 });
    mountPanel();
    const el = await openPanel();
    expect(el.querySelectorAll("button, input, select, textarea, a[href]")).toHaveLength(0);
  });
});

describe("MetricsPanel 可及性（WEB-7 記錄現況）", () => {
  it("【WEB-7 尚未修】每秒變動的「Ns ago」目前落在整塊 role=\"status\" 內——修正後此測試應改為斷言不在 live region 內", async () => {
    receive({ connected: true, elapsedMs: 3_000 });
    mountPanel();
    const el = await openPanel();
    expect(el.getAttribute("role")).toBe("status");
    const age = Array.from(el.querySelectorAll("span")).find((s) => s.textContent?.includes("s ago"));
    expect(age?.closest('[role="status"]')).toBe(el);

    useMonitoringStore().now = T0 + 4_000;
    await flushPromises();
    expect(el.textContent).toContain("4s ago"); // live region 內容每秒變動 → 螢幕閱讀器每秒播報
  });
});
