// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia, type Pinia } from "pinia";
import TopBar from "./TopBar.vue";
import { useMonitoringStore } from "../../domains/monitoring/stores/monitoring.store.js";
import { CONNECTION_NOT_READY_MESSAGE } from "../../domains/ai-copilot/composables/useDiagnoseTrigger.js";

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
    // 系統狀態：指標面板觸發鈕、連線 chip、未授權 chip（背壓計量已於 T036 移出工具列，改為主區背壓 strip）
    expect(counts).toEqual({ 導航: 1, 播放控制: 2, 系統狀態: 3, 主要動作: 1 });
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

  it("播放控制：暫停／恢復文案隨狀態切換，Mock 頻率維持 disabled", async () => {
    const store = useMonitoringStore();
    const w = mountBar();
    const [pause, mock] = group(w, "播放控制").findAll("button");
    expect(text(pause!.element)).toBe("暫停");
    await pause!.trigger("click");
    expect(store.paused).toBe(true);
    expect(text(pause!.element)).toBe("恢復");
    expect(text(mock!.element)).toBe("Mock 頻率");
    expect(mock!.attributes("disabled")).toBeDefined();
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
