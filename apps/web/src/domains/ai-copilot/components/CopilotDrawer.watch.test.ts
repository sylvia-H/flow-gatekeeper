// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import CopilotDrawer from "./CopilotDrawer.vue";
import type { DiagnosisResult } from "@flow-gatekeeper/contracts";
import { copilotReducer, startActiveState, type CopilotJobState } from "../lib/copilot-reducer.js";

/**
 * 合併門第 2 輪 #15：sheet 的 engage／disengage watch 只在 status 或 machineId 真的變化時觸發。
 * 原本的 getter 每次回傳新陣列，串流每個 token（state 換新物件）都會呼叫一次 `engage()`。
 * `engage` 在已接手時本來就無作用，畫面上看不出差異，所以這裡包一層 `useModalSheet` 計數呼叫次數。
 */
const calls = vi.hoisted(() => ({ engage: 0, disengage: 0 }));

vi.mock("../composables/useModalSheet.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../composables/useModalSheet.js")>();
  return {
    ...mod,
    useModalSheet: (...args: Parameters<typeof mod.useModalSheet>) => {
      const sheet = mod.useModalSheet(...args);
      return {
        ...sheet,
        engage: () => {
          calls.engage += 1;
          sheet.engage();
        },
        disengage: (target?: Parameters<typeof sheet.disengage>[0]) => {
          calls.disengage += 1;
          sheet.disengage(target);
        },
      };
    },
  };
});

const MACHINE = "press-02";
let show: () => void = () => {};
let wrapper: VueWrapper | null = null;

beforeEach(() => {
  setActivePinia(createPinia());
  calls.engage = 0;
  calls.disengage = 0;
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({ matches: true, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  );
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(cb: (entries: { isIntersecting: boolean }[]) => void) {
        show = () => cb([{ isIntersecting: true }]);
      }
      observe(): void {}
      disconnect(): void {}
    },
  );
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

function active(progress: number, streamText: string): CopilotJobState {
  return { status: "active", machineId: MACHINE, jobId: "job-1", attempt: 1, lastSeq: -1, execution: 1, progress, streamText };
}

describe("CopilotDrawer sheet 的 engage watch（合併門第 2 輪 #15）", () => {
  it("同一個 active 任務的 token／進度更新不重複呼叫 engage；回到 idle 才呼叫一次 disengage", async () => {
    wrapper = mount(CopilotDrawer, {
      props: {
        state: { status: "idle", machineId: MACHINE },
        machineId: MACHINE,
        machineLabel: "壓製機 02",
        summary: null,
        canDiagnose: true,
        connectionBlockedReason: null,
      },
      attachTo: document.body,
    });
    await flushPromises();
    show();
    await flushPromises();

    await wrapper.setProps({ state: active(20, "") });
    await flushPromises();
    expect(calls.engage).toBe(1);

    for (const [i, text] of ['{"sum', '{"summary":"主', '{"summary":"主軸'].entries()) {
      await wrapper.setProps({ state: active(40 + i, text) });
      await flushPromises();
    }
    expect(calls.engage).toBe(1);
    expect(calls.disengage).toBe(0);

    await wrapper.setProps({ state: { status: "idle", machineId: MACHINE } });
    await flushPromises();
    expect(calls.disengage).toBe(1);
    expect(calls.engage).toBe(1);
  });
});

describe("CopilotDrawer 完成公告只一次（012 FR-004、SC-006）", () => {
  const RESULT: DiagnosisResult = {
    summary: "主軸軸承磨耗",
    severity: "warning",
    likelyCauses: [],
    suggestedActions: [],
    evidence: [],
  };

  it("completed+result 後再到 ai/done（含重複）：live region 只在第一次轉移時寫入", async () => {
    const jobId = "55555555-5555-4555-8555-555555555555";
    const started = startActiveState(MACHINE, jobId);
    wrapper = mount(CopilotDrawer, {
      props: {
        state: started,
        machineId: MACHINE,
        machineLabel: "壓製機 02",
        summary: null,
        canDiagnose: true,
        connectionBlockedReason: null,
      },
      attachTo: document.body,
    });
    await flushPromises();
    const live = wrapper.get('[data-testid="copilot-announcement"]');
    expect(live.text()).toBe("");
    // 以 MutationObserver 計數 live region 的寫入：重念同一句時文字不變，單看 text 看不出重複公告
    let mutations = 0;
    const observer = new MutationObserver((records) => {
      mutations += records.length;
    });
    observer.observe(live.element, { childList: true, characterData: true, subtree: true });

    // 先到：帶 result 的 job/status completed（cached:false）
    const completed = copilotReducer(started, {
      type: "job/status",
      jobId,
      machineId: MACHINE,
      status: "completed",
      progress: 100,
      result: RESULT,
      cached: false,
    });
    await wrapper.setProps({ state: completed });
    await flushPromises();
    expect(live.text()).toBe(`壓製機 02 診斷完成：${RESULT.summary}`);
    expect(mutations).toBeGreaterThan(0); // 觀察器確實看得到寫入
    mutations = 0;

    // 後到：ai/done 與重複的 ai/done。reducer 對 completed 原樣回傳同一個物件（這一層由 reducer 測試保證），
    // 所以 props 沒變、watch 根本不觸發。
    let state = completed;
    for (let i = 0; i < 2; i++) {
      state = copilotReducer(state, { type: "ai/done", jobId, attempt: 1, cached: true, result: RESULT });
      await wrapper.setProps({ state });
      await flushPromises();
    }
    expect(state).toBe(completed);
    expect(mutations).toBe(0);

    // watch 本身的守門：即使傳入不同 identity 的 completed（cached:true），prev 已非 active，
    // 也不重新公告（若誤公告，文字會多出「（快取）」）。
    if (completed.status !== "completed") throw new Error("預期 completed");
    await wrapper.setProps({ state: { ...completed, cached: true } });
    await flushPromises();
    observer.disconnect();
    expect(mutations).toBe(0);
    expect(live.text()).toBe(`壓製機 02 診斷完成：${RESULT.summary}`);
  });
});
