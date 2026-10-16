// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia, type Pinia } from "pinia";
import type { MachineState, TelemetryPoint } from "@flow-gatekeeper/contracts";
import StageTopology from "./StageTopology.vue";
import { useMonitoringStore } from "../stores/monitoring.store.js";
import { useCopilotStore } from "../../ai-copilot/stores/copilot.store.js";

const diagnoseSpy = vi.hoisted(() => vi.fn<(machineId: string) => void>());
vi.mock("../../ai-copilot/composables/useDiagnoseTrigger.js", () => ({
  useDiagnoseTrigger: () => ({ diagnose: diagnoseSpy }),
}));

/**
 * StageTopology（T040；FR-013～FR-016、research R5、spec US3 Acceptance 1／2／5／6）：
 * 三欄順序與歸屬、搜尋清空某欄時欄位保留且連線不變、連線隨下游 throughput、容器過窄時堆疊。
 *
 * happy-dom 沒有版面：以假 ResizeObserver 手動送出容器寬度，驗證「並排／堆疊」切換；
 * matchMedia 以假物件固定為「非 reduced-motion、非窄螢幕」。
 */

let pinia: Pinia;
let wrapper: VueWrapper | null = null;
let resize: ((width: number) => void) | null = null;
let disconnects = 0;
/** 假 matchMedia 的設定：`narrow` 為 true 時 `max-width` 查詢成立；`removeEventListener` 供解除監聽斷言。 */
let narrow = false;
let removeListener = vi.fn();

class FakeResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(target: Element): void {
    resize = (width) => this.callback([{ target, contentRect: { width } } as unknown as ResizeObserverEntry], this);
  }
  unobserve(): void {}
  disconnect(): void {
    disconnects += 1;
    resize = null;
  }
}

beforeEach(() => {
  narrow = false;
  disconnects = 0;
  removeListener = vi.fn();
  diagnoseSpy.mockClear();
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: narrow && query.includes("max-width"),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: removeListener,
  }));
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  pinia = createPinia();
  setActivePinia(pinia);
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  resize = null;
  vi.unstubAllGlobals();
});

function point(machineId: string, throughput = 120, state: MachineState = "healthy"): TelemetryPoint {
  return {
    type: "machine/data",
    machineId,
    timestamp: new Date().toISOString(),
    telemetry: { temperature: 60, vibration: 0.5, throughput, errorRate: 0.01 },
    state,
  };
}

const ALL = ["mixer-01", "press-02", "oven-04", "pack-03", "sorter-05"];

function mountTopology(): VueWrapper {
  wrapper = mount(StageTopology, { global: { plugins: [pinia] } });
  return wrapper;
}

const stageKeys = (w: VueWrapper) => w.findAll('[data-fg="stage"]').map((s) => s.attributes("data-stage"));
const machinesIn = (w: VueWrapper, key: string) =>
  w.findAll(`[data-fg="stage"][data-stage="${key}"] .machine-card`).map((c) => c.attributes("data-machine"));
const links = (w: VueWrapper) => w.findAll('[data-fg="flow-link"]');
const linkWidths = (w: VueWrapper) => links(w).map((l) => l.findAll("line")[0]!.attributes("stroke-width"));

describe("StageTopology 三欄順序與歸屬（US3 Acceptance 1）", () => {
  it("三欄依 前處理 → 成型烘烤 → 包裝分揀 排列，region 名稱為中文", () => {
    const w = mountTopology();
    expect(stageKeys(w)).toEqual(["prep", "forming", "fulfilment"]);
    expect(w.findAll('[role="region"]').map((r) => r.attributes("aria-label"))).toEqual([
      "前處理",
      "成型烘烤",
      "包裝分揀",
    ]);
  });

  it("mixer-01 在第一欄、press-02／oven-04 在第二欄、pack-03／sorter-05 在第三欄（冷啟動即顯示 placeholder）", () => {
    const w = mountTopology();
    expect(machinesIn(w, "prep")).toEqual(["mixer-01"]);
    expect(machinesIn(w, "forming")).toEqual(["press-02", "oven-04"]);
    expect(machinesIn(w, "fulfilment")).toEqual(["pack-03", "sorter-05"]);
    for (const card of w.findAll(".machine-card")) expect(card.attributes("data-state")).toBe("placeholder");
  });

  it("欄間有兩段連線，DOM 順序為 欄、連線、欄、連線、欄", () => {
    const w = mountTopology();
    const grid = w.get('[data-fg="stage-topology"]');
    const order = Array.from(grid.element.children).map((el) =>
      el.matches('[data-fg="stage"]') ? "stage" : el.querySelector('[data-fg="flow-link"]') ? "link" : "?",
    );
    expect(order).toEqual(["stage", "link", "stage", "link", "stage"]);
  });

  it("有遙測後卡片顯示實值狀態；點卡片選台", async () => {
    const store = useMonitoringStore();
    store.applyTelemetryBatch(ALL.map((id) => point(id, 120, id === "press-02" ? "critical" : "healthy")));
    const w = mountTopology();
    const press = w.get('.machine-card[data-machine="press-02"]');
    expect(press.attributes("data-state")).toBe("critical");
    await press.trigger("click");
    expect(store.selectedMachineId).toBe("press-02");
    expect(w.get('.machine-card[data-machine="press-02"]').attributes("data-selected")).toBe("true");
  });
});

describe("StageTopology 搜尋與空欄（US3 Acceptance 2、FR-015）", () => {
  it("搜尋只剩一台時三欄仍在、其他欄顯示空狀態；連線數與粗細不變（以完整分組計）", async () => {
    const store = useMonitoringStore();
    store.applyTelemetryBatch(ALL.map((id) => point(id)));
    const w = mountTopology();
    const before = linkWidths(w);
    const speeds = () => links(w).map((l) => l.attributes("data-speed"));
    expect(speeds()).toEqual(["fast", "fast"]);

    store.setSearchQuery("mixer");
    await w.vm.$nextTick();

    expect(stageKeys(w)).toEqual(["prep", "forming", "fulfilment"]);
    expect(machinesIn(w, "prep")).toEqual(["mixer-01"]);
    for (const key of ["forming", "fulfilment"]) {
      const column = w.get(`[data-fg="stage"][data-stage="${key}"]`);
      expect(column.text()).toContain("此階段無符合的機台");
      expect(column.text()).toContain("0 台");
    }
    expect(links(w)).toHaveLength(2);
    expect(linkWidths(w)).toEqual(before);
    expect(speeds()).toEqual(["fast", "fast"]);

    store.setSearchQuery("");
    await w.vm.$nextTick();
    expect(machinesIn(w, "forming")).toEqual(["press-02", "oven-04"]);
    expect(w.text()).not.toContain("此階段無符合的機台");
  });

  it("搜尋查無任何機台：三欄各自顯示空狀態，不另出全域空狀態", async () => {
    const store = useMonitoringStore();
    store.setSearchQuery("不存在的機台");
    const w = mountTopology();
    await w.vm.$nextTick();
    expect(stageKeys(w)).toHaveLength(3);
    expect(w.text().match(/此階段無符合的機台/g)).toHaveLength(3);
  });
});

describe("StageTopology 連線隨下游 throughput（US3 Acceptance 6）", () => {
  it("無遙測時連線最細且不流動；下游產出升高時變粗、流速升級", async () => {
    const store = useMonitoringStore();
    const w = mountTopology();
    expect(linkWidths(w)).toEqual(["2", "2"]);
    expect(links(w).map((l) => l.attributes("data-speed"))).toEqual(["none", "none"]);

    // 成型烘烤 2 × 40 = 80（細、慢）；包裝分揀 2 × 125 = 250（最粗、快）
    store.applyTelemetryBatch([
      point("mixer-01"),
      point("press-02", 40),
      point("oven-04", 40),
      point("pack-03", 125),
      point("sorter-05", 125),
    ]);
    await w.vm.$nextTick();
    expect(linkWidths(w)).toEqual(["3.5", "8"]);
    expect(links(w).map((l) => l.attributes("data-speed"))).toEqual(["slow", "fast"]);
  });
});

describe("StageTopology 容器寬度與堆疊（FR-016、FR-031）", () => {
  it("容器放得下三欄（≥ 708px）時並排、連線水平；過窄時單欄堆疊、連線改垂直且不流動", async () => {
    const store = useMonitoringStore();
    store.applyTelemetryBatch(ALL.map((id) => point(id, 125)));
    const w = mountTopology();
    const grid = () => w.get('[data-fg="stage-topology"]');

    resize?.(900);
    await w.vm.$nextTick();
    expect(grid().attributes("data-layout")).toBe("row");
    expect(links(w).map((l) => l.attributes("data-orientation"))).toEqual(["horizontal", "horizontal"]);
    expect(links(w).map((l) => l.attributes("data-speed"))).toEqual(["fast", "fast"]);

    resize?.(400);
    await w.vm.$nextTick();
    expect(grid().attributes("data-layout")).toBe("stacked");
    expect(grid().classes()).toContain("grid-cols-1");
    expect(links(w).map((l) => l.attributes("data-orientation"))).toEqual(["vertical", "vertical"]);
    expect(links(w).map((l) => l.attributes("data-speed"))).toEqual(["none", "none"]);
    // 堆疊時順序不變、每段仍有標題
    expect(stageKeys(w)).toEqual(["prep", "forming", "fulfilment"]);
    expect(linkWidths(w)).toEqual(["8", "8"]);
  });

  it("T062 門檻：1366×768 面板展開的容器寬 708px 恰好並排、欄寬下限維持 220px；1024×768 面板展開（約 366px）堆疊", async () => {
    const store = useMonitoringStore();
    store.applyTelemetryBatch(ALL.map((id) => point(id, 125)));
    const w = mountTopology();
    const grid = () => w.get('[data-fg="stage-topology"]');

    resize?.(708);
    await w.vm.$nextTick();
    expect(grid().attributes("data-layout")).toBe("row");
    expect(grid().classes()).toContain(
      "grid-cols-[minmax(220px,1fr)_24px_minmax(220px,1fr)_24px_minmax(220px,1fr)]",
    );

    resize?.(707);
    await w.vm.$nextTick();
    expect(grid().attributes("data-layout")).toBe("stacked");

    resize?.(366);
    await w.vm.$nextTick();
    expect(grid().attributes("data-layout")).toBe("stacked");
  });

  it("捲動容器保留 8px 內距（卡片焦點環與 critical 光暈不被外層 overflow 裁掉）", () => {
    const root = mountTopology().get("div");
    expect(root.classes()).toEqual(expect.arrayContaining(["h-full", "overflow-auto", "p-2"]));
  });
});

describe("StageTopology 退路與清理", () => {
  it("沒有 ResizeObserver 時以 viewport 判斷：窄螢幕（max-width 成立）→ 堆疊、連線垂直且不流動", () => {
    vi.stubGlobal("ResizeObserver", undefined);
    narrow = true;
    const store = useMonitoringStore();
    store.applyTelemetryBatch(ALL.map((id) => point(id, 125)));
    const w = mountTopology();
    expect(w.get('[data-fg="stage-topology"]').attributes("data-layout")).toBe("stacked");
    expect(links(w).map((l) => l.attributes("data-orientation"))).toEqual(["vertical", "vertical"]);
    expect(links(w).map((l) => l.attributes("data-speed"))).toEqual(["none", "none"]);
  });

  it("unmount 後解除 ResizeObserver 與兩個 matchMedia 監聽", () => {
    const w = mountTopology();
    expect(disconnects).toBe(0);
    w.unmount();
    wrapper = null;
    expect(disconnects).toBe(1);
    // reduced-motion 與窄螢幕兩個查詢各解除一次
    expect(removeListener).toHaveBeenCalledTimes(2);
    expect(removeListener.mock.calls.every((call) => call[0] === "change")).toBe(true);
  });
});

describe("StageTopology 卡片診斷接線", () => {
  it("點卡片的診斷圖示 → useDiagnoseTrigger().diagnose(machineId)，只呼叫一次", async () => {
    const w = mountTopology();
    await w.get('button[aria-label="診斷 壓製機 02"]').trigger("click");
    expect(diagnoseSpy).toHaveBeenCalledTimes(1);
    expect(diagnoseSpy).toHaveBeenCalledWith("press-02");
  });
});

describe("StageTopology 卡片底列接線：異常標記與診斷 chip（T051）", () => {
  it("可見期內的 latch 傳進卡片；點清除鈕 → store.clearLatch（劃線，不選台）；回復滿 30 秒後不再傳", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const store = useMonitoringStore();
    store.tickNow();
    store.applyTelemetryBatch([point("press-02", 120, "critical")]);
    const w = mountTopology();
    const card = () => w.get('.machine-card[data-machine="press-02"]');
    expect(card().attributes("data-latch")).toBe("critical");
    expect(w.get('.machine-card[data-machine="oven-04"]').attributes("data-latch")).toBe("none");

    await w.get('[data-fg="latch-clear"]').trigger("click");
    expect(store.latchFor("press-02")?.clearedBy).toBe("user");
    expect(card().attributes("data-latch-cleared")).toBe("");
    expect(store.selectedMachineId).toBeNull();

    clock.mockReturnValue(1_002_000);
    store.applyTelemetryBatch([point("press-02", 120, "healthy")]);
    clock.mockReturnValue(1_032_000); // 回復後滿 30 秒
    store.tickNow();
    await w.vm.$nextTick();
    expect(store.latchVisible("press-02")).toBeFalsy();
    expect(card().attributes("data-latch")).toBe("none");
    expect(w.find('[data-fg="latch-clear"]').exists()).toBe(false);
    clock.mockRestore();
  });

  it("診斷 chip 取 copilot store 的 badgeFor：各卡各自顯示，未診斷者為 none", async () => {
    const copilot = useCopilotStore();
    const w = mountTopology();
    expect(w.get('.machine-card[data-machine="press-02"]').attributes("data-diagnosis")).toBe("none");
    copilot.jobs.set("press-02", {
      status: "active",
      machineId: "press-02",
      jobId: "j1",
      attempt: 1,
      progress: 60,
      streamText: "",
    });
    await w.vm.$nextTick();
    expect(w.get('.machine-card[data-machine="press-02"]').attributes("data-diagnosis")).toBe("active");
    expect(w.text()).toContain("診斷中 60%");
    expect(w.get('.machine-card[data-machine="mixer-01"]').attributes("data-diagnosis")).toBe("none");
  });
});
