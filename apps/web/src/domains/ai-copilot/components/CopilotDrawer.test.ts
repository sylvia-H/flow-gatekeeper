// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h } from "vue";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia, type Pinia } from "pinia";
import type { DiagnosisResult } from "@flow-gatekeeper/contracts";
import CopilotDrawer from "./CopilotDrawer.vue";
import { useCopilotStore } from "../stores/copilot.store.js";
import type { CopilotJobState } from "../lib/copilot-reducer.js";

/**
 * CopilotDrawer 元件行為與可及性（review02 Batch D）。
 * Drawer 本身只吃 props；這裡用一個最小 host 把真 copilot store 的 `stateFor()` 接進來、
 * 把 cancel／retry 接回 store（對應 App.vue 的接線），WS 事件以 `applyEvent` 直接餵 store
 * （不建 WebSocket），POST /diagnoses 以 stub fetch 立即成功。
 */

const MACHINE = "press-01";
const SOCKET = "11111111-1111-4111-8111-111111111111";

const RESULT: DiagnosisResult = {
  summary: "主軸軸承磨耗導致振動升高",
  severity: "warning",
  likelyCauses: ["軸承潤滑不足"],
  suggestedActions: [],
  evidence: [{ source: "telemetry", excerpt: "vibration 2.4 > 2.0" }],
};

let pinia: Pinia;
const wrappers: VueWrapper[] = [];

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: string, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as { jobId: string; machineId: string };
      return Promise.resolve(
        new Response(JSON.stringify({ ...body, status: "waiting" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }),
  );
});

afterEach(() => {
  while (wrappers.length) wrappers.pop()!.unmount();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

interface DrawerProps {
  state: CopilotJobState;
  machineId: string | null;
  machineLabel: string;
  summary: null;
  canDiagnose: boolean;
  connectionBlockedReason: string | null;
}

/** 直接以 props 掛 drawer（空狀態／idle／停用態用）。 */
function mountDrawer(over: Partial<DrawerProps> = {}): VueWrapper {
  const w = mount(CopilotDrawer, {
    props: {
      state: { status: "idle", machineId: MACHINE },
      machineId: MACHINE,
      machineLabel: "Press 01",
      summary: null,
      canDiagnose: true,
      connectionBlockedReason: null,
      ...over,
    },
    attachTo: document.body,
  });
  wrappers.push(w);
  return w;
}

/** 以真 store 驅動 drawer 的最小 host。 */
function mountWithStore(): VueWrapper {
  const Host = defineComponent({
    setup() {
      const copilot = useCopilotStore();
      return () =>
        h(CopilotDrawer, {
          state: copilot.stateFor(MACHINE),
          machineId: MACHINE,
          machineLabel: "Press 01",
          summary: null,
          canDiagnose: copilot.canDiagnose(MACHINE, true),
          connectionBlockedReason: null,
          onCancel: () => copilot.cancel(MACHINE),
          onRetry: () => void copilot.retry(MACHINE, SOCKET),
        });
    },
  });
  const w = mount(Host, { global: { plugins: [pinia] }, attachTo: document.body });
  wrappers.push(w);
  return w;
}

/** 對 MACHINE 開一個 active 任務並回傳 jobId。 */
async function startJob(): Promise<string> {
  const copilot = useCopilotStore();
  await copilot.diagnose(MACHINE, SOCKET);
  await flushPromises();
  const state = copilot.stateFor(MACHINE);
  if (state.status !== "active") throw new Error(`預期 active，實際 ${state.status}`);
  return state.jobId;
}

function buttonByText(w: VueWrapper, text: string) {
  return w.findAll("button").find((b) => b.text().includes(text));
}

/** 讀 job meta 的某一欄（Queue／Attempt）。 */
function metaValue(w: VueWrapper, label: string): string | undefined {
  return w
    .findAll("dl > div")
    .find((d) => d.find("dt").exists() && d.find("dt").text() === label)
    ?.find("dd")
    .text();
}

describe("CopilotDrawer 空狀態與 idle", () => {
  it("未選機台 → 顯示選台提示，不出現 Run diagnosis", () => {
    const w = mountDrawer({ machineId: null });
    expect(w.text()).toContain("選取機台以開始 AI 診斷。");
    expect(buttonByText(w, "Run diagnosis")).toBeUndefined();
  });

  it("idle：連線未就緒時 Run diagnosis 停用並以 title 說明原因；就緒時點擊送出 diagnose", async () => {
    const blocked = mountDrawer({ canDiagnose: false, connectionBlockedReason: "連線未就緒" });
    const btn = buttonByText(blocked, "Run diagnosis")!;
    expect(btn.attributes("disabled")).toBeDefined();
    expect(btn.attributes("title")).toBe("連線未就緒");

    const ready = mountDrawer();
    await buttonByText(ready, "Run diagnosis")!.trigger("click");
    expect(ready.emitted("diagnose")).toHaveLength(1);
  });
});

describe("CopilotDrawer active：進度、Attempt、串流", () => {
  it("pending（尚無進度）顯示 Active、處理中…與 Attempt 1 / 3；job/status 帶進度後更新百分比", async () => {
    const w = mountWithStore();
    const jobId = await startJob();
    expect(w.text()).toContain("Active");
    expect(w.text()).toContain("處理中…");
    expect(metaValue(w, "Attempt")).toBe("1 / 3");

    useCopilotStore().applyEvent({ type: "job/status", jobId, machineId: MACHINE, status: "active", progress: 40 });
    await flushPromises();
    expect(w.text()).toContain("40%");
  });

  it("ai/token 逐段累加到串流區；換輪（attempt 2）清空舊輪文字並顯示 Attempt 2 / 3", async () => {
    const w = mountWithStore();
    const jobId = await startJob();
    const copilot = useCopilotStore();
    const stream = () => w.get('[aria-label="AI 推理串流"]');

    copilot.applyEvent({ type: "ai/token", jobId, attempt: 1, seq: 0, text: "檢查振動" });
    copilot.applyEvent({ type: "ai/token", jobId, attempt: 1, seq: 1, text: "與溫度…" });
    await flushPromises();
    expect(stream().text()).toBe("檢查振動與溫度…");
    expect(stream().attributes("aria-busy")).toBe("true");

    copilot.applyEvent({ type: "ai/token", jobId, attempt: 2, seq: 0, text: "重試" });
    await flushPromises();
    expect(stream().text()).toBe("重試");
    expect(metaValue(w, "Attempt")).toBe("2 / 3");
  });

  it("中止診斷 → store.cancel 讓畫面回到 idle（Run diagnosis 可再按）", async () => {
    const w = mountWithStore();
    await startJob();
    await buttonByText(w, "中止診斷")!.trigger("click");
    expect(useCopilotStore().stateFor(MACHINE).status).toBe("idle");
    const run = buttonByText(w, "Run diagnosis");
    expect(run).toBeDefined();
    expect(run!.attributes("disabled")).toBeUndefined();
  });
});

describe("CopilotDrawer 終態", () => {
  it("ai/done → Completed、五區塊結果、Cached 徽章，並以 polite live region 公告摘要", async () => {
    const w = mountWithStore();
    const jobId = await startJob();
    useCopilotStore().applyEvent({ type: "ai/done", jobId, attempt: 1, cached: true, result: RESULT });
    await flushPromises();

    expect(w.text()).toContain("Completed");
    expect(w.findAll("h3").map((x) => x.text())).toEqual([
      "Summary",
      "Likely causes",
      "Evidence",
      "Suggested actions",
    ]);
    expect(w.text()).toContain(RESULT.summary);
    expect(w.text()).toContain("軸承潤滑不足");
    expect(w.text()).toContain("vibration 2.4 > 2.0");
    expect(w.text()).toContain("無建議動作。"); // 空陣列以空狀態文字呈現、不崩潰
    expect(w.get('[aria-label="結果來自快取"]').text()).toBe("Cached");
    expect(w.get('[aria-live="polite"]').text()).toBe(`${MACHINE} 診斷完成（快取）：${RESULT.summary}`);
  });

  it("ai/error → Failed、可讀錯誤與 Retry；Retry 走 store 重回 active；不可診斷時 Retry 停用並說明原因", async () => {
    const w = mountWithStore();
    const jobId = await startJob();
    useCopilotStore().applyEvent({ type: "ai/error", jobId, attempt: 1, code: "timeout", message: "request timed out" });
    await flushPromises();

    expect(w.text()).toContain("Failed");
    expect(w.text()).toContain("AI 診斷逾時，請重試。");
    expect(w.get('[aria-live="polite"]').text()).toBe(`${MACHINE} 診斷失敗：AI 診斷逾時，請重試。`);
    const retry = buttonByText(w, "Retry")!;
    expect(retry.attributes("disabled")).toBeUndefined();
    await retry.trigger("click");
    await flushPromises();
    expect(useCopilotStore().stateFor(MACHINE).status).toBe("active");

    const blocked = mountDrawer({
      state: { status: "failed", machineId: MACHINE, streamText: "", error: "x" },
      canDiagnose: false,
      connectionBlockedReason: "連線未就緒",
    });
    const blockedRetry = buttonByText(blocked, "Retry")!;
    expect(blockedRetry.attributes("disabled")).toBeDefined();
    expect(blockedRetry.attributes("title")).toBe("連線未就緒");
  });
});

describe("CopilotDrawer 行動版 bottom sheet（dialog 語意與焦點陷阱）", () => {
  /** matchMedia 命中行動版斷點，並提供可手動觸發「sheet 出現」的 IntersectionObserver。 */
  function stubMobile(): { show: () => void } {
    let fire: ((entries: { isIntersecting: boolean }[]) => void) | undefined;
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: true,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(cb: (entries: { isIntersecting: boolean }[]) => void) {
          fire = cb;
        }
        observe(): void {}
        disconnect(): void {}
      },
    );
    // happy-dom 不做 layout：讓可聚焦元素被視為「有渲染」，focusableWithin 才不會全數濾掉。
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
    return { show: () => fire?.([{ isIntersecting: true }]) };
  }

  it("手機寬度：根節點為 role=dialog + aria-modal、由標題命名；開啟時焦點移入、Tab 於邊界循環、Esc 送出 close", async () => {
    const { show } = stubMobile();
    const w = mountDrawer({ machineId: null });
    await flushPromises();
    const root = w.get('[role="dialog"]');
    expect(root.attributes("aria-modal")).toBe("true");
    const title = document.getElementById(root.attributes("aria-labelledby")!);
    expect(title?.textContent).toBe("AI Copilot");

    show();
    await flushPromises();
    expect(document.activeElement).toBe(root.element);

    // 空狀態下唯一可聚焦的是關閉鈕：Tab 與 Shift+Tab 都應留在 sheet 內
    const close = w.get('button[aria-label="關閉／收合 Copilot 面板"]').element;
    await root.trigger("keydown", { key: "Tab" });
    expect(document.activeElement).toBe(close);
    await root.trigger("keydown", { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(close);

    await root.trigger("keydown", { key: "Escape" });
    expect(w.emitted("close")).toHaveLength(1);
  });

  it("桌機寬度：常駐側欄不掛 dialog 屬性，Esc 不被攔截", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    );
    const w = mountDrawer();
    await flushPromises();
    expect(w.find('[role="dialog"]').exists()).toBe(false);
    await w.get('[tabindex="-1"]').trigger("keydown", { key: "Escape" });
    expect(w.emitted("close")).toBeUndefined();
  });
});
