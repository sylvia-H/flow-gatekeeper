// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h } from "vue";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia, type Pinia } from "pinia";
import type { DiagnosisResult } from "@flow-gatekeeper/contracts";
import CopilotDrawer from "./CopilotDrawer.vue";
import { useCopilotStore } from "../stores/copilot.store.js";
import type { CopilotJobState } from "../lib/copilot-reducer.js";
import type { MachineLive } from "../../monitoring/stores/monitoring.store.js";
import { machineLabel } from "../../monitoring/lib/machine-labels.js";

/**
 * CopilotDrawer 元件行為與可及性（review02 Batch D）。
 * Drawer 本身只吃 props；這裡用一個最小 host 把真 copilot store 的 `stateFor()` 接進來、
 * 把 cancel／retry 接回 store（對應 App.vue 的接線），WS 事件以 `applyEvent` 直接餵 store
 * （不建 WebSocket），POST /diagnoses 以 stub fetch 立即成功。
 */

const MACHINE = "press-02";
const LABEL = machineLabel(MACHINE);

/**
 * 舊英文 UI 標籤（FR-038／SC-013）：畫面上任一態都不得殘留。大小寫敏感、不加字界，
 * 所以佇列名 `diagnosis`（DIAGNOSIS_QUEUE，技術識別碼）與 AI 回覆裡的小寫英文不會誤中。
 */
const LEGACY_EN_LABEL =
  /Idle|Active|Completed|Failed|Summary|Likely causes|Evidence|Suggested actions|High|Medium|Low|Telemetry|Error log|Maintenance|Cached|Retry|Run diagnosis|Diagnose|AI Copilot|Queue|Attempt/;
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
  summary: MachineLive | null;
  canDiagnose: boolean;
  connectionBlockedReason: string | null;
}

/** 直接以 props 掛 drawer（空狀態／idle／停用態用）。 */
function mountDrawer(over: Partial<DrawerProps> = {}): VueWrapper {
  const w = mount(CopilotDrawer, {
    props: {
      state: { status: "idle", machineId: MACHINE },
      machineId: MACHINE,
      machineLabel: LABEL,
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
          machineLabel: LABEL,
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

/** 文字完全相符的按鈕（「診斷」會被「中止診斷」的 includes 誤中，需精確比對）。 */
function buttonExact(w: VueWrapper, text: string) {
  return w.findAll("button").find((b) => b.text() === text);
}

/** 文字完全相符的 span（視覺隱藏前綴＋可見字合併後的可讀名稱，例「結果來自快取」）。 */
function spanExact(w: VueWrapper, text: string) {
  return w.findAll("span").find((s) => s.text() === text);
}

/** 標頭文字（標題、機台 id、狀態 chip）；狀態斷言限縮在標頭，避免與內文的同字詞混淆。 */
function headerText(w: VueWrapper): string {
  return w.get("header").text();
}

/** 讀 job meta 的某一欄（佇列／嘗試）。 */
function metaValue(w: VueWrapper, label: string): string | undefined {
  return w
    .findAll("dl > div")
    .find((d) => d.find("dt").exists() && d.find("dt").text() === label)
    ?.find("dd")
    .text();
}

describe("CopilotDrawer 空狀態與 idle", () => {
  it("未選機台 → 顯示選台提示，不出現診斷鈕", () => {
    const w = mountDrawer({ machineId: null });
    expect(w.text()).toContain("選取機台後按「診斷」，開始 AI 診斷。");
    expect(buttonExact(w, "診斷")).toBeUndefined();
  });

  it("閒置：標頭顯示「AI 診斷」與「閒置」；連線未就緒時診斷鈕停用並以 title 說明原因；就緒時點擊送出 diagnose", async () => {
    const blocked = mountDrawer({ canDiagnose: false, connectionBlockedReason: "連線未就緒" });
    expect(headerText(blocked)).toContain("AI 診斷");
    expect(headerText(blocked)).toContain("閒置");
    const btn = buttonExact(blocked, "診斷")!;
    expect(btn.attributes("disabled")).toBeDefined();
    expect(btn.attributes("title")).toBe("連線未就緒");
    // 停用態改用 rim 底＋ink-3 字（不靠整顆半透明，停用對比仍 ≥ 3:1）
    expect(btn.classes()).toEqual(expect.arrayContaining(["disabled:bg-rim", "disabled:text-ink-3"]));
    expect(btn.classes()).not.toContain("disabled:opacity-50");

    const ready = mountDrawer();
    await buttonExact(ready, "診斷")!.trigger("click");
    expect(ready.emitted("diagnose")).toHaveLength(1);
  });

  it("閒置帶遙測：機台中文名、狀態中文名、溫度／振動／錯誤率標籤與單位，且無舊英文標籤", () => {
    const summary: MachineLive = {
      machineId: MACHINE,
      state: "warning",
      telemetry: { temperature: 81.26, vibration: 2.4, throughput: 120, errorRate: 0.034 },
      lastUpdated: 0,
    };
    const w = mountDrawer({ summary });
    expect(w.get("h3").text()).toBe(LABEL);
    const dl = w.get("dl");
    const field = (dt: string) =>
      dl.findAll("div").find((d) => d.find("dt").exists() && d.get("dt").text() === dt)?.get("dd").text();
    expect(field("狀態")).toBe("警告");
    expect(field("溫度")).toBe("81.3°C");
    expect(field("振動")).toBe("2.40mm/s");
    expect(field("錯誤率")).toBe("3.4%");
    expect(w.text()).not.toMatch(LEGACY_EN_LABEL);
  });
});

describe("CopilotDrawer active：進度、Attempt、串流", () => {
  it("pending（尚無進度）顯示進行中、處理中…與嘗試 1 / 3；job/status 帶進度後更新百分比", async () => {
    const w = mountWithStore();
    const jobId = await startJob();
    expect(headerText(w)).toContain("進行中");
    expect(w.text()).toContain("處理中…");
    expect(metaValue(w, "嘗試")).toBe("1 / 3");
    expect(metaValue(w, "佇列")).toBe("diagnosis"); // 技術識別碼維持原文
    expect(w.text()).not.toMatch(LEGACY_EN_LABEL);
    // 步驟標籤全中文（job-steps 的 context／token 由元件層對照翻譯）
    const steps = w.get('[aria-label="診斷處理步驟"]').text();
    expect(steps).toContain("彙整診斷資料");
    expect(steps).toContain("收到首段串流");
    expect(steps).not.toMatch(/context|token/);

    useCopilotStore().applyEvent({ type: "job/status", jobId, machineId: MACHINE, status: "active", progress: 40 });
    await flushPromises();
    expect(w.text()).toContain("40%");
  });

  it("ai/token 逐段累加到原始串流區；換輪（attempt 2）清空舊輪文字並顯示嘗試 2 / 3", async () => {
    const w = mountWithStore();
    const jobId = await startJob();
    const copilot = useCopilotStore();
    const stream = () => w.get('[aria-label="原始串流"]');

    copilot.applyEvent({ type: "ai/token", jobId, attempt: 1, seq: 0, text: "檢查振動" });
    copilot.applyEvent({ type: "ai/token", jobId, attempt: 1, seq: 1, text: "與溫度…" });
    await flushPromises();
    expect(stream().text()).toBe("檢查振動與溫度…");
    expect(stream().attributes("aria-busy")).toBe("true");

    copilot.applyEvent({ type: "ai/token", jobId, attempt: 2, seq: 0, text: "重試" });
    await flushPromises();
    expect(stream().text()).toBe("重試");
    expect(metaValue(w, "嘗試")).toBe("2 / 3");
  });

  it("中止診斷 → store.cancel 讓畫面回到閒置（診斷鈕可再按）", async () => {
    const w = mountWithStore();
    await startJob();
    await buttonByText(w, "中止診斷")!.trigger("click");
    expect(useCopilotStore().stateFor(MACHINE).status).toBe("idle");
    expect(headerText(w)).toContain("閒置");
    const run = buttonExact(w, "診斷");
    expect(run).toBeDefined();
    expect(run!.attributes("disabled")).toBeUndefined();
  });
});

describe("CopilotDrawer 終態", () => {
  it("ai/done → 已完成、四區段結果與嚴重度、快取徽章，並以 polite live region 公告摘要", async () => {
    const w = mountWithStore();
    const jobId = await startJob();
    useCopilotStore().applyEvent({ type: "ai/done", jobId, attempt: 1, cached: true, result: RESULT });
    await flushPromises();

    expect(headerText(w)).toContain("已完成");
    expect(w.findAll("h3").map((x) => x.text())).toEqual(["摘要", "可能原因", "證據", "建議動作"]);
    expect(w.text()).toContain("警告"); // severity warning → 中文徽章（SeverityBadge）
    expect(w.text()).toContain("遙測"); // evidence source telemetry → 中文標籤
    expect(w.text()).toContain(RESULT.summary);
    expect(w.text()).toContain("軸承潤滑不足");
    expect(w.text()).toContain("vibration 2.4 > 2.0");
    expect(w.text()).toContain("無建議動作。"); // 空陣列以空狀態文字呈現、不崩潰
    expect(spanExact(w, "結果來自快取")).toBeDefined(); // 視覺隱藏前綴＋可見「快取」
    expect(w.text()).not.toMatch(LEGACY_EN_LABEL);
    expect(w.get('[aria-live="polite"]').text()).toBe(`${MACHINE} 診斷完成（快取）：${RESULT.summary}`);
  });

  it("ai/error → 失敗、可讀錯誤與重試；重試走 store 重回進行中；不可診斷時重試停用並說明原因", async () => {
    const w = mountWithStore();
    const jobId = await startJob();
    useCopilotStore().applyEvent({ type: "ai/error", jobId, attempt: 1, code: "timeout", message: "request timed out" });
    await flushPromises();

    expect(headerText(w)).toContain("失敗");
    expect(w.text()).not.toMatch(LEGACY_EN_LABEL);
    expect(w.text()).toContain("AI 診斷逾時，請重試。");
    expect(w.get('[aria-live="polite"]').text()).toBe(`${MACHINE} 診斷失敗：AI 診斷逾時，請重試。`);
    const retry = buttonExact(w, "重試")!;
    expect(retry.attributes("disabled")).toBeUndefined();
    await retry.trigger("click");
    await flushPromises();
    expect(useCopilotStore().stateFor(MACHINE).status).toBe("active");

    const blocked = mountDrawer({
      state: { status: "failed", machineId: MACHINE, streamText: "", error: "x" },
      canDiagnose: false,
      connectionBlockedReason: "連線未就緒",
    });
    const blockedRetry = buttonExact(blocked, "重試")!;
    expect(blockedRetry.attributes("disabled")).toBeDefined();
    expect(blockedRetry.attributes("title")).toBe("連線未就緒");
    // 重試與「診斷」同為主要層級（失敗態唯一動作）；停用態同樣改 rim 底＋ink-3 字
    expect(blockedRetry.classes()).toEqual(expect.arrayContaining(["bg-accent", "disabled:bg-rim", "disabled:text-ink-3"]));
  });
});

describe("CopilotDrawer 建議動作與原始串流（013 視覺層）", () => {
  const COMPLETED: CopilotJobState = {
    status: "completed",
    machineId: MACHINE,
    jobId: "22222222-2222-4222-8222-222222222222",
    cached: false,
    streamText: "先比對振動與溫度",
    result: {
      ...RESULT,
      severity: "critical",
      suggestedActions: [
        { label: "停機檢查軸承", priority: "high", command: "ops inspect press-01" },
        { label: "排程潤滑", priority: "low" },
      ],
    },
  };

  it("建議動作以中文優先度徽章呈現，不用左緣色條；指令旁標示 AI 建議需審閱", () => {
    const w = mountDrawer({ state: COMPLETED });
    const items = w.findAll("li").filter((li) => li.text().includes("停機檢查軸承") || li.text().includes("排程潤滑"));
    expect(items).toHaveLength(2);
    for (const li of items) expect(li.classes().some((c) => c.startsWith("border-l"))).toBe(false);
    expect(spanExact(w, "優先度：高")).toBeDefined();
    expect(spanExact(w, "優先度：低")).toBeDefined();
    expect(w.text()).not.toMatch(LEGACY_EN_LABEL);
    expect(w.text()).toContain("AI 建議，執行前請審閱");
    expect(w.text()).toContain("嚴重"); // severity critical → 中文徽章
    expect(spanExact(w, "結果來自快取")).toBeUndefined();
  });

  it("完成後原始串流預設收合，展開後顯示串流文字且不帶游標", async () => {
    const w = mountDrawer({ state: COMPLETED });
    expect(w.find('[aria-label="原始串流"]').exists()).toBe(false);
    const toggle = buttonExact(w, "原始串流")!;
    expect(toggle.attributes("aria-expanded")).toBe("false");
    await toggle.trigger("click");
    const panel = w.get('[aria-label="原始串流"]');
    expect(panel.text()).toBe("先比對振動與溫度");
    expect(panel.attributes("aria-busy")).toBe("false");
    expect(panel.find(".animate-stream-caret").exists()).toBe(false);
  });

  it("失敗後的串流殘文以「原始串流（中斷前）」展開回看", async () => {
    const w = mountDrawer({
      state: { status: "failed", machineId: MACHINE, streamText: "比對到一半", error: "AI 診斷逾時，請重試。" },
    });
    await buttonExact(w, "原始串流（中斷前）")!.trigger("click");
    expect(w.get('[aria-label="原始串流"]').text()).toBe("比對到一半");
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

  it("手機寬度：根節點為 role=dialog + aria-modal、由標題命名；開啟時焦點移入、Tab 於邊界循環、Esc 送出 dismiss", async () => {
    const { show } = stubMobile();
    const w = mountDrawer({ machineId: null });
    await flushPromises();
    const root = w.get('[role="dialog"]');
    expect(root.attributes("aria-modal")).toBe("true");
    const title = document.getElementById(root.attributes("aria-labelledby")!);
    expect(title?.textContent).toBe("AI 診斷");

    show();
    await flushPromises();
    expect(document.activeElement).toBe(root.element);

    // 空狀態下唯一可聚焦的是關閉鈕：Tab 與 Shift+Tab 都應留在 sheet 內
    const close = w.get('button[aria-label="關閉／收合 AI 診斷面板"]').element;
    await root.trigger("keydown", { key: "Tab" });
    expect(document.activeElement).toBe(close);
    await root.trigger("keydown", { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(close);

    await root.trigger("keydown", { key: "Escape" });
    expect(w.emitted("dismiss")).toHaveLength(1);
    expect(w.emitted("close")).toBeUndefined();
  });

  it("收合鈕 emit close（手動收合）、Escape emit dismiss（只影響當次），兩者不混用", async () => {
    const { show } = stubMobile();
    const w = mountDrawer({ machineId: null });
    await flushPromises();
    show();
    await flushPromises();

    await w.get('button[aria-label="關閉／收合 AI 診斷面板"]').trigger("click");
    expect(w.emitted("close")).toHaveLength(1);
    expect(w.emitted("dismiss")).toBeUndefined();

    await w.get('[role="dialog"]').trigger("keydown", { key: "Escape" });
    expect(w.emitted("dismiss")).toHaveLength(1);
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
    expect(w.emitted("dismiss")).toBeUndefined();
  });
});
