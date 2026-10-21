// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shallowMount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import type { UseHighFrequencyWsOptions } from "./domains/monitoring/composables/useHighFrequencyWs.js";

/**
 * App 的即時通道接線（012 T043、FR-016、P20；合併門第 1 輪 L4）：`onConnected` 交 copilot `onReconnect`、
 * `onAuthResult(true)` 才交 `onAuthorized(clientId)`。`useHighFrequencyWs` 換成記下 options 的替身，不建 WebSocket；
 * 子元件以 shallowMount 略過（只驗接線，不驗畫面）。
 */
const captured = vi.hoisted(() => ({ options: null as UseHighFrequencyWsOptions | null }));

vi.mock("./domains/monitoring/composables/useHighFrequencyWs.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./domains/monitoring/composables/useHighFrequencyWs.js")>();
  return {
    ...mod,
    useHighFrequencyWs: (options: UseHighFrequencyWsOptions) => {
      captured.options = options;
      return { send: vi.fn(), close: vi.fn() } as unknown as ReturnType<typeof mod.useHighFrequencyWs>;
    },
  };
});

const { default: App } = await import("./App.vue");
const { useCopilotStore } = await import("./domains/ai-copilot/stores/copilot.store.js");
const { useMonitoringStore } = await import("./domains/monitoring/stores/monitoring.store.js");

const CLIENT = "11111111-1111-4111-8111-111111111111";
let wrapper: VueWrapper | null = null;

beforeEach(() => {
  setActivePinia(createPinia());
  captured.options = null;
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({ matches: false, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  );
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function mountApp() {
  const copilot = useCopilotStore();
  const onReconnect = vi.spyOn(copilot, "onReconnect");
  const onAuthorized = vi.spyOn(copilot, "onAuthorized");
  wrapper = shallowMount(App);
  const options = captured.options;
  if (!options) throw new Error("App 沒有呼叫 useHighFrequencyWs");
  return { options, onReconnect, onAuthorized };
}

describe("App 即時通道接線（012 T043）", () => {
  it("onConnected（新 clientId）→ copilot.onReconnect；onAuthResult(true) → onAuthorized(clientId) 一次", () => {
    const { options, onReconnect, onAuthorized } = mountApp();
    options.onConnected?.(CLIENT);
    expect(onReconnect).toHaveBeenCalledWith(CLIENT);
    expect(onAuthorized).not.toHaveBeenCalled(); // 授權前不續接
    options.onAuthResult?.(true);
    expect(onAuthorized).toHaveBeenCalledTimes(1);
    expect(onAuthorized).toHaveBeenCalledWith(CLIENT);
    expect(useMonitoringStore().clientId).toBe(CLIENT);
  });

  it("socket open 後、system/connected 前，每秒 tick 不跑退路；收到 clientId 後（含未授權）才照常（合併門第 3 輪 L1）", () => {
    vi.useFakeTimers();
    try {
      const copilot = useCopilotStore();
      const checkStalls = vi.spyOn(copilot, "checkStalls");
      const { options } = mountApp();
      const monitoring = useMonitoringStore();

      options.onStatus?.("connected"); // socket open：clientId 尚未到
      expect(monitoring.clientId).toBeNull();
      vi.advanceTimersByTime(1_000);
      expect(checkStalls).toHaveBeenLastCalledWith(expect.any(Number), 45_000, expect.any(Number), false);

      options.onConnected?.(CLIENT); // system/connected：拿到本次 clientId（尚未授權）
      vi.advanceTimersByTime(1_000);
      expect(checkStalls).toHaveBeenLastCalledWith(expect.any(Number), 45_000, expect.any(Number), true);

      options.onStatus?.("reconnecting"); // 斷線：clientId 清空
      vi.advanceTimersByTime(1_000);
      expect(checkStalls).toHaveBeenLastCalledWith(expect.any(Number), 45_000, expect.any(Number), false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("onAuthResult(false) 不續接（交給 45 s watchdog，代理裁決第 47 條）", () => {
    const { options, onAuthorized } = mountApp();
    options.onConnected?.(CLIENT);
    options.onAuthResult?.(false);
    expect(onAuthorized).not.toHaveBeenCalled();
  });
});
