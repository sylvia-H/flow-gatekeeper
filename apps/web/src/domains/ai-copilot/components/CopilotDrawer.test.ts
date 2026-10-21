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
import { diagnosisBadgeText } from "../lib/diagnosis-badge.js";

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

/** 以真 store 驅動 drawer 的最小 host；`label` 可覆寫傳入的 machineLabel prop（驗公告不讀 prop）。 */
function mountWithStore(label: string = LABEL): VueWrapper {
  const Host = defineComponent({
    setup() {
      const copilot = useCopilotStore();
      return () =>
        h(CopilotDrawer, {
          state: copilot.stateFor(MACHINE),
          machineId: MACHINE,
          machineLabel: label,
          summary: null,
          canDiagnose: copilot.canDiagnose(MACHINE, true),
          connectionBlockedReason: null,
          onDiagnose: () => void copilot.diagnose(MACHINE, SOCKET),
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

/**
 * 推擠式側欄（≥ 1366px）：matchMedia 不命中 sheet 斷點。happy-dom 預設視窗 1024 寬會命中 `MOBILE_QUERY`，
 * 以標頭＋內容兩區斷言的測試要明確釘在桌機形態（sheet 閒置改為單列，見行動版 describe）。
 */
function stubDesktop(): void {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({ matches: false, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  );
}

describe("CopilotDrawer 空狀態與 idle", () => {
  beforeEach(stubDesktop);

  it("未選機台 → 顯示選台提示，不出現診斷鈕", () => {
    const w = mountDrawer({ machineId: null });
    expect(w.text()).toContain("選取機台後按「診斷」，開始 AI 診斷。");
    expect(buttonExact(w, "診斷")).toBeUndefined();
  });

  it("閒置：標頭顯示「AI 診斷」與「未診斷」；連線未就緒時診斷鈕停用並以 title 說明原因；就緒時點擊送出 diagnose", async () => {
    const blocked = mountDrawer({ canDiagnose: false, connectionBlockedReason: "連線未就緒" });
    expect(headerText(blocked)).toContain("AI 診斷");
    expect(headerText(blocked)).toContain("未診斷");
    expect(headerText(blocked)).not.toContain("閒置");
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

  it("閒置帶遙測：只有一列「機台中文名 · 狀態徽章」＋診斷鈕，不重複卡片的 2×2 遙測，且無舊英文標籤（critique 第二輪 P1）", () => {
    const summary: MachineLive = {
      machineId: MACHINE,
      state: "warning",
      telemetry: { temperature: 81.26, vibration: 2.4, throughput: 120, errorRate: 0.034 },
      lastUpdated: Date.now(),
    };
    const w = mountDrawer({ summary });
    const h3 = w.get("h3");
    expect(h3.text()).toBe(LABEL);
    // 機台名、徽章、診斷鈕同一列
    const row = h3.element.parentElement!;
    expect(row.textContent).toContain("狀態：警告");
    expect(row.querySelector("button")?.textContent?.trim()).toBe("診斷");
    // 遙測四格不再出現（數值與標籤都不在面板內）
    expect(w.find("dl").exists()).toBe(false);
    expect(w.find("[data-metric]").exists()).toBe(false);
    for (const label of ["溫度", "振動", "產能", "錯誤率", "81.3", "2.40"]) expect(w.text()).not.toContain(label);
    // 遙測新鮮：沒有停滯徽章
    expect(w.text()).not.toContain("停滯");
    expect(w.text()).not.toMatch(LEGACY_EN_LABEL);
  });

  it("閒置：遙測逾 10 秒未更新 → 狀態徽章旁加「停滯」徽章（與卡片同一判定）；尚無遙測 → 「尚未收到遙測」", () => {
    const stale: MachineLive = {
      machineId: MACHINE,
      state: "critical",
      telemetry: { temperature: 81.26, vibration: 2.4, throughput: 120, errorRate: 0.034 },
      lastUpdated: Date.now() - 60_000,
    };
    const w = mountDrawer({ summary: stale });
    const row = w.get("h3").element.parentElement!;
    expect(row.textContent).toContain("狀態：嚴重");
    expect(row.textContent).toContain("停滯");

    const empty = mountDrawer({ summary: null });
    expect(empty.get("h3").element.parentElement!.textContent).toContain("尚未收到遙測");
    expect(buttonExact(empty, "診斷")).toBeDefined();
  });

  it("內容區與標頭內層以 max-w-xl 置中（1024 寬的 sheet 不拉到 1000px）", () => {
    const w = mountDrawer();
    expect(w.findAll(".max-w-xl.mx-auto")).toHaveLength(2);
    expect(w.get("header").get(".max-w-xl").text()).toContain("AI 診斷");
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
    // 步驟標籤全中文（標籤來自 job-steps.ts，元件層不再另放對照表）
    const steps = w.get('[aria-label="診斷處理步驟"]').text();
    expect(steps).toContain("彙整診斷資料");
    expect(steps).toContain("收到首段串流");
    expect(steps).not.toMatch(/context|token/);
    // 步驟列（critique 第二輪 Minor）：目前步驟、佇列、嘗試在進度條正下方、骨架之前，骨架填滿也不被擠出畫面
    const html = w.html();
    const stepLine = w.get('[role="progressbar"]').element.nextElementSibling as HTMLElement;
    expect(stepLine.textContent).toContain("任務啟動");
    expect(stepLine.textContent).toContain("佇列diagnosis");
    expect(stepLine.textContent).toContain("嘗試1 / 3");
    expect(stepLine.className).toContain("text-xs");
    expect(html.indexOf("佇列")).toBeLessThan(html.indexOf('data-fg="result-skeleton"'));
    // 尚無 token：骨架四區段全是佔位（不顯示錯誤、不空白）
    const fields = w.findAll('[data-fg="result-skeleton"] [data-field]');
    expect(fields.map((f) => f.attributes("data-field-state"))).toEqual([
      "missing",
      "missing",
      "missing",
      "missing",
      "missing",
    ]);

    useCopilotStore().applyEvent({ type: "job/status", jobId, machineId: MACHINE, status: "active", progress: 40 });
    await flushPromises();
    expect(w.text()).toContain("40%");
  });

  it("ai/token 逐段累加到原始串流區（預設收合、展開後可見）；換輪（attempt 2）清空舊輪文字並顯示嘗試 2 / 3", async () => {
    const w = mountWithStore();
    const jobId = await startJob();
    const copilot = useCopilotStore();
    const stream = () => w.get('[aria-label="原始串流"]');

    // 進行中的主角是骨架：原始串流預設收合，展開鈕可切換
    expect(w.find('[aria-label="原始串流"]').exists()).toBe(false);
    const toggle = buttonExact(w, "原始串流")!;
    expect(toggle.attributes("aria-expanded")).toBe("false");
    expect(toggle.attributes("aria-controls")).toBeUndefined(); // 收合時面板不在 DOM，不指向它
    await toggle.trigger("click");
    expect(toggle.attributes("aria-expanded")).toBe("true");
    expect(toggle.attributes("aria-controls")).toBe(stream().attributes("id"));
    expect(stream().attributes("id")).toBeTruthy();

    // 中止鈕在進度列旁、位於骨架之前（骨架填滿後不必捲動也找得到）
    const cancel = buttonByText(w, "中止診斷")!.element;
    const skeleton = w.get('[data-fg="result-skeleton"]').element;
    expect(cancel.compareDocumentPosition(skeleton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

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

  it("串流中的 JSON 逐格填入骨架：同一掛載下欄位狀態隨 token 推進、游標跟著移到正在生成的欄位", async () => {
    const w = mountWithStore();
    const jobId = await startJob();
    const copilot = useCopilotStore();
    const field = (name: string) => w.get(`[data-fg="result-skeleton"] [data-field="${name}"]`);
    const state = (name: string) => field(name).attributes("data-field-state");
    const hasCaret = (name: string) => field(name).find(".animate-stream-caret").exists();

    // 第一段：摘要與嚴重度完成、可能原因截斷中
    copilot.applyEvent({
      type: "ai/token",
      jobId,
      attempt: 1,
      seq: 0,
      text: '{"summary":"主軸軸承磨耗","severity":"warning","likelyCauses":["潤滑不',
    });
    await flushPromises();
    expect(state("summary")).toBe("complete");
    expect(field("summary").text()).toContain("主軸軸承磨耗");
    expect(field("severity").text()).toContain("警告");
    expect(state("likelyCauses")).toBe("streaming");
    expect(field("likelyCauses").text()).toContain("潤滑不");
    expect(field("likelyCauses").text()).toContain("生成中");
    expect(hasCaret("likelyCauses")).toBe(true);
    expect(state("evidence")).toBe("missing");
    expect(hasCaret("evidence")).toBe(false);

    // 第二段：可能原因收尾、證據開始（半截物件元素不顯示）
    copilot.applyEvent({
      type: "ai/token",
      jobId,
      attempt: 1,
      seq: 1,
      text: '足"],"evidence":[{"source":"telemetry","excerpt":"vib',
    });
    await flushPromises();
    expect(state("likelyCauses")).toBe("complete");
    expect(field("likelyCauses").text()).toContain("潤滑不足");
    expect(field("likelyCauses").text()).toContain("已完成");
    expect(hasCaret("likelyCauses")).toBe(false);
    expect(state("evidence")).toBe("streaming");
    expect(field("evidence").text()).toContain("生成中");
    expect(field("evidence").text()).not.toContain("vib");
    expect(hasCaret("evidence")).toBe(true);
    expect(w.findAll('[data-fg="result-skeleton"] .animate-stream-caret')).toHaveLength(1);
    expect(w.text()).not.toMatch(LEGACY_EN_LABEL);
  });

  it("中止診斷 → store.cancel 讓畫面回到閒置（診斷鈕可再按）", async () => {
    stubDesktop();
    const w = mountWithStore();
    await startJob();
    await buttonByText(w, "中止診斷")!.trigger("click");
    expect(useCopilotStore().stateFor(MACHINE).status).toBe("idle");
    expect(headerText(w)).toContain("未診斷");
    const run = buttonExact(w, "診斷");
    expect(run).toBeDefined();
    expect(run!.attributes("disabled")).toBeUndefined();
  });
});

describe("CopilotDrawer 終態", () => {
  it("ai/done → 已完成、四區段依「摘要→建議動作→可能原因→證據」、快取標記，無骨架與滿版進度條，並以 polite live region 公告摘要", async () => {
    const w = mountWithStore();
    const jobId = await startJob();
    useCopilotStore().applyEvent({ type: "ai/done", jobId, attempt: 1, cached: true, result: RESULT });
    await flushPromises();

    expect(headerText(w)).toContain("已完成");
    // 「已完成」chip 為中性底：結果為警告時不再出現綠色 ok 底與之衝突（critique 第二輪 Minor）
    const chip = w.get("header").findAll("span").find((s) => s.text() === "已完成")!;
    expect(chip.classes()).toEqual(expect.arrayContaining(["bg-surface-strong", "border-edge", "text-ink-2"]));
    expect(chip.classes().join(" ")).not.toMatch(/\bbg-ok|text-ok/);
    expect(w.findAll("h3").map((x) => x.text())).toEqual(["摘要", "建議動作", "可能原因", "證據"]);
    expect(w.find('[data-fg="result-skeleton"]').exists()).toBe(false); // 完成態只用驗證過的 result
    expect(w.find('[role="progressbar"]').exists()).toBe(false); // 不以滿版進度條表達完成（FR-022）
    const timing = w.get('[data-fg="timing"]');
    expect(timing.attributes("data-cached")).toBe("true");
    expect(timing.text()).toContain("快取 ·");
    expect(timing.text()).not.toContain("上一次"); // 無非快取紀錄時只顯示本次
    expect(timing.find('[data-fg="timing-bars"]').exists()).toBe(false); // 單獨一條沒有比較對象，不畫橫條
    expect(w.text()).toContain("警告"); // severity warning → 中文徽章（SeverityBadge）
    expect(w.text()).toContain("遙測"); // evidence source telemetry → 中文標籤
    expect(w.text()).toContain(RESULT.summary);
    expect(w.text()).toContain("軸承潤滑不足");
    expect(w.text()).toContain("vibration 2.4 > 2.0");
    expect(w.text()).toContain("無建議動作。"); // 空陣列以空狀態文字呈現、不崩潰
    expect(timing.text()).toMatch(/^結果來自快取 · /); // 視覺隱藏前綴＋可見「快取 · N ms」
    expect(w.text()).not.toMatch(LEGACY_EN_LABEL);
    expect(w.get('[data-testid="copilot-announcement"]').text()).toBe(`${LABEL} 診斷完成（快取）：${RESULT.summary}`);
  });

  it("完成公告的機台名取自事件的 machineId（繁中名），不讀 machineLabel prop（合併門第 2 輪 #4：watch 觸發時 prop 可能已換台）", async () => {
    const w = mountWithStore("（別台的名稱）");
    const jobId = await startJob();
    useCopilotStore().applyEvent({ type: "ai/done", jobId, attempt: 1, cached: false, result: RESULT });
    await flushPromises();
    const live = w.get('[data-testid="copilot-announcement"]').text();
    expect(live).toBe(`${LABEL} 診斷完成：${RESULT.summary}`);
    expect(live).not.toContain(MACHINE);
    expect(live).not.toContain("別台");
  });

  it("結果未送達（AR-6）：失敗文案＋重試、公告失敗；同 job 遲到的 ai/done 救回後改顯示完成並公告", async () => {
    const w = mountWithStore();
    const jobId = await startJob();
    const copilot = useCopilotStore();
    copilot.applyEvent({ type: "ai/token", jobId, attempt: 1, seq: 0, text: "完整的推理" });
    copilot.applyEvent({ type: "job/status", jobId, machineId: MACHINE, status: "completed", progress: 100 });
    copilot.checkStalls(Date.now(), 45_000, performance.now() + 2_001);
    await flushPromises();
    const message = "診斷已在後端完成，但結果未送達畫面，請重試";
    expect(headerText(w)).toContain("失敗");
    expect(w.text()).toContain(message);
    expect(buttonExact(w, "重試")).toBeDefined();
    // 後端已完成、串流是完整的：展開鈕標「原始串流」，不加「（中斷前）」
    expect(buttonExact(w, "原始串流")!.attributes("aria-expanded")).toBe("true");
    expect(buttonExact(w, "原始串流（中斷前）")).toBeUndefined();
    expect(w.get('[data-testid="copilot-announcement"]').text()).toBe(`${LABEL} 診斷失敗：${message}`);

    copilot.applyEvent({ type: "ai/done", jobId, attempt: 1, cached: false, result: RESULT });
    await flushPromises();
    expect(headerText(w)).toContain("已完成");
    expect(w.get('[data-testid="copilot-announcement"]').text()).toBe(`${LABEL} 診斷完成：${RESULT.summary}`);
  });

  it("ai/error → 失敗、可讀錯誤與重試；重試走 store 重回進行中；不可診斷時重試停用並說明原因", async () => {
    const w = mountWithStore();
    const jobId = await startJob();
    useCopilotStore().applyEvent({ type: "ai/error", jobId, attempt: 1, code: "timeout", message: "request timed out" });
    await flushPromises();

    expect(headerText(w)).toContain("失敗");
    expect(w.text()).not.toMatch(LEGACY_EN_LABEL);
    expect(w.text()).toContain("AI 診斷逾時，請重試。");
    expect(w.get('[data-testid="copilot-announcement"]').text()).toBe(`${LABEL} 診斷失敗：AI 診斷逾時，請重試。`);
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

  it("串流中途失敗 → 不顯示骨架，原始串流預設展開保留中斷前推理（FR-024）", async () => {
    const w = mountWithStore();
    const jobId = await startJob();
    const copilot = useCopilotStore();
    copilot.applyEvent({ type: "ai/token", jobId, attempt: 1, seq: 0, text: '{"summary":"比對振動' });
    await flushPromises();
    expect(w.find('[data-fg="result-skeleton"]').exists()).toBe(true);

    copilot.applyEvent({ type: "ai/error", jobId, attempt: 1, code: "provider", message: "socket hang up" });
    await flushPromises();
    expect(headerText(w)).toContain("失敗");
    expect(w.text()).toContain("無法連線 AI 服務，請稍後重試。"); // humanizeError 分類文案
    expect(w.find('[data-fg="result-skeleton"]').exists()).toBe(false);
    expect(buttonExact(w, "原始串流（中斷前）")!.attributes("aria-expanded")).toBe("true");
    const panel = w.get('[aria-label="原始串流"]');
    expect(panel.text()).toBe('{"summary":"比對振動');
    expect(panel.find(".animate-stream-caret").exists()).toBe(false);
  });

  it("未能分類的英文錯誤 → 主訊息通用繁中句，原文收在預設收合的「技術細節」（fix/20261022-ui-humanize-error-zh）", async () => {
    const w = mountWithStore();
    const jobId = await startJob();
    useCopilotStore().applyEvent({ type: "ai/error", jobId, attempt: 1, code: "worker_failed", message: "Worker crashed unexpectedly" });
    await flushPromises();

    expect(w.text()).toContain("診斷失敗，請重試。");
    // 公告只念通用句，不念英文原文
    expect(w.get('[data-testid="copilot-announcement"]').text()).toBe(`${LABEL} 診斷失敗：診斷失敗，請重試。`);
    const toggle = buttonExact(w, "技術細節")!;
    expect(toggle.attributes("aria-expanded")).toBe("false");
    expect(toggle.attributes("aria-controls")).toBeUndefined();
    expect(w.text()).not.toContain("Worker crashed unexpectedly");

    await toggle.trigger("click");
    const id = toggle.attributes("aria-controls")!;
    expect(toggle.attributes("aria-expanded")).toBe("true");
    const detail = w.get(`[id="${id}"]`);
    expect(detail.text()).toBe("Worker crashed unexpectedly");
    expect(detail.classes()).toEqual(expect.arrayContaining(["font-mono", "bg-bench"]));

    // 重試 → 進行中，技術細節消失；再失敗時回到收合
    await buttonExact(w, "重試")!.trigger("click");
    await flushPromises();
    expect(w.find('[data-testid="copilot-error-detail"]').exists()).toBe(false);
    const nextJob = (useCopilotStore().stateFor(MACHINE) as { jobId: string }).jobId;
    useCopilotStore().applyEvent({ type: "ai/error", jobId: nextJob, attempt: 1, code: "worker_failed", message: "boom" });
    await flushPromises();
    expect(buttonExact(w, "技術細節")!.attributes("aria-expanded")).toBe("false");
  });

  it.each([
    ["已分類（逾時）", "request timed out", "AI 診斷逾時，請重試。"],
    ["中文短句", "機台名冊載入失敗", "機台名冊載入失敗"],
  ])("%s的錯誤經 store／reducer → 不顯示「技術細節」", async (_name, message, shown) => {
    const w = mountWithStore();
    const jobId = await startJob();
    useCopilotStore().applyEvent({ type: "ai/error", jobId, attempt: 1, code: "worker_failed", message });
    await flushPromises();

    expect(useCopilotStore().stateFor(MACHINE).status).toBe("failed");
    expect(w.text()).toContain(shown);
    expect(w.find('[data-testid="copilot-error-detail"]').exists()).toBe(false);
    expect(buttonExact(w, "技術細節")).toBeUndefined();
  });
});

describe("CopilotDrawer 完成 meta 與快取耗時對比（FR-022／FR-023）", () => {
  /** 跑完一輪診斷：送出時 performance.now()=start，ai/done 時 =end。 */
  async function runOnce(start: number, end: number, cached: boolean): Promise<void> {
    const perf = vi.spyOn(performance, "now").mockReturnValue(start);
    const jobId = await startJob();
    perf.mockReturnValue(end);
    useCopilotStore().applyEvent({ type: "ai/done", jobId, attempt: 1, cached, result: RESULT });
    await flushPromises();
  }

  it("非快取：一行「完成 HH:mm:ss · N.N s」、data-cached=false、不用大字", async () => {
    const doneAt = new Date(2026, 9, 15, 14, 10, 56).getTime();
    vi.spyOn(Date, "now").mockReturnValue(doneAt);
    const w = mountWithStore();
    await runOnce(1_000, 9_200, false);

    const timing = w.get('[data-fg="timing"]');
    expect(timing.attributes("data-cached")).toBe("false");
    expect(timing.text()).toBe("完成 14:10:56 · 8.2 s");
    expect(timing.find(".text-ratio").exists()).toBe(false);
  });

  it("再診斷命中快取：「快取 · N ms」以 text-ratio 大字並列「上一次 N.N s」，結果整塊直接呈現", async () => {
    const w = mountWithStore();
    await runOnce(1_000, 9_200, false);
    await runOnce(20_000, 20_014, true);

    const timing = w.get('[data-fg="timing"][data-cached="true"]');
    const big = timing.get(".text-ratio");
    expect(big.text()).toBe("結果來自快取 · 14 ms");
    expect(big.classes()).toContain("font-mono");
    const rows = timing.findAll('[data-fg="timing-bars"] li');
    expect(rows.map((r) => r.text())).toEqual(["快取：14 ms", "上一次：8.2 s"]);
    expect(rows[1]!.get(".bg-ink-3").attributes("style")).toContain("width: 100.00%");
    // 整塊結果直接在 DOM 上（沒有骨架、沒有逐字游標）
    expect(w.text()).toContain(RESULT.summary);
    expect(w.find('[data-fg="result-skeleton"]').exists()).toBe(false);
    expect(w.find(".animate-stream-caret").exists()).toBe(false);
  });
});

describe("CopilotDrawer 完成態「再次診斷」（critique 第一輪 B）", () => {
  const DONE: CopilotJobState = {
    status: "completed",
    machineId: MACHINE,
    jobId: "33333333-3333-4333-8333-333333333333",
    cached: false,
    streamText: "",
    result: RESULT,
    source: "ai/done",
    streamIncomplete: false,
  };

  it("完成態在 meta 列下、摘要之前有次要鈕「再次診斷」；面板內沒有精確文字「診斷」的鈕（截圖劇本不誤配）", () => {
    const w = mountDrawer({ state: DONE });
    const again = buttonExact(w, "再次診斷")!;
    expect(again).toBeDefined();
    expect(again.attributes("aria-label")).toBeUndefined();
    expect(again.classes()).toContain("border-edge"); // 次要（Tool）樣式，不是主要的 bg-accent
    expect(again.classes()).not.toContain("bg-accent");
    expect(buttonExact(w, "診斷")).toBeUndefined();
    const html = w.html();
    expect(html.indexOf("再次診斷")).toBeLessThan(html.indexOf('data-section="summary"'));
  });

  it("連線未就緒：再次診斷停用並以 title 說明原因；就緒時點擊送出 diagnose", async () => {
    const blocked = mountDrawer({ state: DONE, canDiagnose: false, connectionBlockedReason: "連線未就緒" });
    const btn = buttonExact(blocked, "再次診斷")!;
    expect(btn.attributes("disabled")).toBeDefined();
    expect(btn.attributes("title")).toBe("連線未就緒");

    const ready = mountDrawer({ state: DONE });
    await buttonExact(ready, "再次診斷")!.trigger("click");
    expect(ready.emitted("diagnose")).toHaveLength(1);
  });

  it("走同一條 store.diagnose：完成 → 再次診斷 → 新任務進行中（新 jobId）", async () => {
    const w = mountWithStore();
    const first = await startJob();
    const copilot = useCopilotStore();
    copilot.applyEvent({ type: "ai/done", jobId: first, attempt: 1, cached: false, result: RESULT });
    await flushPromises();
    await buttonExact(w, "再次診斷")!.trigger("click");
    await flushPromises();
    const next = copilot.stateFor(MACHINE);
    expect(next.status).toBe("active");
    expect("jobId" in next && next.jobId).not.toBe(first);
    expect(headerText(w)).toContain("進行中");
    expect(buttonExact(w, "再次診斷")).toBeUndefined();
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
    source: "ai/done",
    streamIncomplete: false,
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
    // 非快取且 store 沒有這台的量測與完成時刻 → 不畫空的 meta 列，也不出現快取字樣
    expect(w.find('[data-fg="timing"]').exists()).toBe(false);
    expect(w.text()).not.toContain("快取");
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

  it("失敗後的串流殘文以「原始串流（中斷前）」預設展開，可收合；不顯示骨架", async () => {
    const w = mountDrawer({
      state: { status: "failed", machineId: MACHINE, streamText: "比對到一半", error: "AI 診斷逾時，請重試。" },
    });
    expect(w.find('[data-fg="result-skeleton"]').exists()).toBe(false);
    const toggle = buttonExact(w, "原始串流（中斷前）")!;
    expect(toggle.attributes("aria-expanded")).toBe("true");
    expect(w.get('[aria-label="原始串流"]').text()).toBe("比對到一半");
    await toggle.trigger("click");
    expect(w.find('[aria-label="原始串流"]').exists()).toBe(false);
  });
});

describe("CopilotDrawer 原始串流標題（012 FR-038、contracts/ui-copy §2）", () => {
  const JOB = "44444444-4444-4444-8444-444444444444";
  const completed = (streamIncomplete: boolean, source: "ai/done" | "status"): CopilotJobState => ({
    status: "completed",
    machineId: MACHINE,
    jobId: JOB,
    cached: false,
    streamText: "推理",
    result: RESULT,
    source,
    streamIncomplete,
  });

  /** 原始串流展開鈕的文字（每態只會有一顆）。 */
  function streamToggleLabel(w: VueWrapper): string | undefined {
    return w.findAll("button").map((b) => b.text()).find((t) => t.startsWith("原始串流"));
  }

  it.each<[string, CopilotJobState, string]>([
    ["進行中", { status: "active", machineId: MACHINE, jobId: JOB, attempt: 1, lastSeq: 0, execution: 1, progress: 60, streamText: "推理" }, "原始串流"],
    ["完成（ai/done 收尾）", completed(false, "ai/done"), "原始串流"],
    ["完成（job/status 收尾，不完整）", completed(true, "status"), "原始串流（不完整）"],
    [
      "結果未送達",
      { status: "failed", machineId: MACHINE, jobId: JOB, streamText: "推理", error: "診斷已在後端完成，但結果未送達畫面，請重試", reason: "undelivered", attempt: 1 },
      "原始串流",
    ],
    ["其他失敗", { status: "failed", machineId: MACHINE, jobId: JOB, streamText: "推理", error: "AI 診斷逾時，請重試。" }, "原始串流（中斷前）"],
  ])("%s → 「%s」", (_name, state, label) => {
    stubDesktop();
    const w = mountDrawer({ state });
    expect(streamToggleLabel(w)).toBe(label);
  });

  it("以真 store 驅動：帶 result 的 job/status completed 收尾 → 已完成、標「原始串流（不完整）」並公告一次", async () => {
    const w = mountWithStore();
    const jobId = await startJob();
    const copilot = useCopilotStore();
    copilot.applyEvent({ type: "ai/token", jobId, attempt: 1, seq: 0, text: "推理" });
    copilot.applyEvent({ type: "job/status", jobId, machineId: MACHINE, status: "completed", progress: 100, result: RESULT, cached: false });
    await flushPromises();
    expect(headerText(w)).toContain("已完成");
    expect(streamToggleLabel(w)).toBe("原始串流（不完整）");
    expect(w.get('[data-testid="copilot-announcement"]').text()).toBe(`${LABEL} 診斷完成：${RESULT.summary}`);
  });
});

describe("CopilotDrawer 重連續接說明行與取回 meta（012 T044、FR-035、FR-037、contracts/ui-copy §1、§4、§5）", () => {
  const SOCKET_2 = "22222222-2222-4222-8222-222222222222";
  /** GET /diagnoses/:jobId 的回應；POST 照常成功。 */
  let lookupReply: (jobId: string) => Response;

  beforeEach(() => {
    stubDesktop();
    lookupReply = (jobId) => Response.json({ status: "active", jobId, progress: 60, rebound: true });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          const body = JSON.parse(init.body as string) as { jobId: string; machineId: string };
          return Response.json({ ...body, status: "waiting" });
        }
        const jobId = new URL(url, "http://localhost").pathname.split("/").at(-1) ?? "";
        return lookupReply(jobId);
      }),
    );
  });

  /** 首次連線 → 診斷 → 進度 40 → 重連到新 socket；回傳 jobId。 */
  async function startThenReconnect(): Promise<string> {
    const copilot = useCopilotStore();
    copilot.onReconnect(SOCKET);
    const jobId = await startJob();
    copilot.applyEvent({ type: "job/status", jobId, machineId: MACHINE, status: "active", progress: 40 });
    copilot.onReconnect(SOCKET_2);
    await flushPromises();
    return jobId;
  }

  it("重連後、續接 GET 回應前：步驟列下顯示說明行並經 polite 公告區朗讀一次；面板 chip 仍「進行中」、卡片 chip 仍「診斷中 N%」", async () => {
    const w = mountWithStore();
    await startThenReconnect();
    const note = w.get('[data-testid="copilot-progress-note"]');
    expect(note.text()).toBe("已重新連線，正在取回診斷狀態…");
    expect(note.classes()).toEqual(expect.arrayContaining(["text-xs", "text-ink-3"]));
    expect(w.get('[data-testid="copilot-announcement"]').text()).toBe("已重新連線，正在取回診斷狀態…");
    expect(headerText(w)).toContain("進行中");
    expect(diagnosisBadgeText(useCopilotStore().badgeFor(MACHINE))).toBe("診斷中 40%");
  });

  it("授權後 GET 回 active → 說明行消失、維持進行中與新進度", async () => {
    const w = mountWithStore();
    await startThenReconnect();
    useCopilotStore().onAuthorized(SOCKET_2);
    await flushPromises();
    await flushPromises();
    expect(w.find('[data-testid="copilot-progress-note"]').exists()).toBe(false);
    expect(headerText(w)).toContain("進行中");
    expect(w.text()).toContain("60%");
  });

  it("說明行消失時清空公告區：第二次重連的「正在取回」會再朗讀一次（合併門第 1 輪 L2）", async () => {
    const w = mountWithStore();
    await startThenReconnect();
    const copilot = useCopilotStore();
    const live = () => w.get('[data-testid="copilot-announcement"]').text();
    expect(live()).toBe("已重新連線，正在取回診斷狀態…");
    copilot.onAuthorized(SOCKET_2);
    await flushPromises();
    await flushPromises();
    expect(w.find('[data-testid="copilot-progress-note"]').exists()).toBe(false);
    expect(live()).toBe("");
    copilot.onReconnect("33333333-3333-4333-8333-333333333333");
    await flushPromises();
    expect(live()).toBe("已重新連線，正在取回診斷狀態…");
  });

  it("沒有重連的進行中任務不顯示說明行", async () => {
    const w = mountWithStore();
    await startJob();
    await flushPromises();
    expect(w.find('[data-testid="copilot-progress-note"]').exists()).toBe(false);
  });

  it("GET 回 completed → 已完成、完成 meta 加「重新連線後取回」、串流標題「原始串流（不完整）」、公告完成", async () => {
    const w = mountWithStore();
    const jobId = await startThenReconnect();
    useCopilotStore().applyEvent({ type: "ai/token", jobId, attempt: 1, seq: 0, text: "推理" });
    lookupReply = (id) => Response.json({ status: "completed", jobId: id, result: RESULT, cached: false });
    useCopilotStore().onAuthorized(SOCKET_2);
    await flushPromises();
    await flushPromises();
    expect(headerText(w)).toContain("已完成");
    const meta = w.get('[data-testid="copilot-recovered-meta"]');
    expect(meta.text()).toBe("重新連線後取回");
    expect(meta.classes()).toEqual(expect.arrayContaining(["text-xs", "text-ink-3"]));
    expect(w.get('[data-fg="timing"]').text()).toContain("重新連線後取回");
    expect(w.find('[data-fg="timing-bars"]').exists()).toBe(false); // 取回的耗時不畫對比橫條（P16）
    expect(w.findAll("button").some((b) => b.text() === "原始串流（不完整）")).toBe(true);
    expect(w.get('[data-testid="copilot-announcement"]').text()).toBe(`${LABEL} 診斷完成：${RESULT.summary}`);
  });

  it("以 ai/done 收尾的完成態不顯示「重新連線後取回」", async () => {
    const w = mountWithStore();
    const jobId = await startJob();
    useCopilotStore().applyEvent({ type: "ai/done", jobId, attempt: 1, cached: false, result: RESULT });
    await flushPromises();
    expect(headerText(w)).toContain("已完成");
    expect(w.find('[data-testid="copilot-recovered-meta"]').exists()).toBe(false);
  });

  it("續接 GET 回 409 job_bound_elsewhere → 失敗文案指向另一個視窗", async () => {
    const w = mountWithStore();
    await startThenReconnect();
    lookupReply = () => Response.json({ code: "job_bound_elsewhere" }, { status: 409 });
    useCopilotStore().onAuthorized(SOCKET_2);
    await flushPromises();
    await flushPromises();
    expect(headerText(w)).toContain("失敗");
    expect(w.text()).toContain("這個診斷正由另一個視窗接收，請在該視窗查看或重試");
  });
});

describe("CopilotDrawer 重新排入佇列說明行與嘗試次數（012 T059、T066、FR-006、FR-035～FR-037）", () => {
  beforeEach(stubDesktop);

  /** 進行中區塊的說明行文字（不存在為 null）。 */
  function noteText(w: VueWrapper): string | null {
    const note = w.find('[data-testid="copilot-progress-note"]');
    return note.exists() ? note.text() : null;
  }

  it("reason stalled → 說明行「…（第 N 次執行）」並朗讀；N 由下一則帶 execution 的事件校正；面板 chip 仍「進行中」", async () => {
    const w = mountWithStore();
    const jobId = await startJob();
    const copilot = useCopilotStore();
    copilot.applyEvent({ type: "job/status", jobId, machineId: MACHINE, status: "active", progress: 40, execution: 1 });
    copilot.applyEvent({ type: "job/status", jobId, machineId: MACHINE, status: "waiting", reason: "stalled" });
    await flushPromises();
    expect(noteText(w)).toBe("後端處理程序中斷，任務已重新排入佇列（第 2 次執行）");
    expect(w.get('[data-testid="copilot-announcement"]').text()).toBe("後端處理程序中斷，任務已重新排入佇列（第 2 次執行）");
    expect(headerText(w)).toContain("進行中");
    expect(diagnosisBadgeText(copilot.badgeFor(MACHINE))).toBe("診斷中 40%");

    copilot.applyEvent({ type: "job/status", jobId, machineId: MACHINE, status: "active", progress: 20, execution: 3 });
    await flushPromises();
    expect(noteText(w)).toBe("後端處理程序中斷，任務已重新排入佇列（第 3 次執行）");
    expect(w.get('[data-testid="copilot-announcement"]').text()).toBe("後端處理程序中斷，任務已重新排入佇列（第 3 次執行）");

    // execution 再遞增而沒有新的 stalled → 說明消失
    copilot.applyEvent({ type: "job/status", jobId, machineId: MACHINE, status: "active", progress: 20, execution: 4 });
    await flushPromises();
    expect(noteText(w)).toBeNull();
  });

  it("重新排入佇列與重連後正在取回同時成立 → 只顯示後者", async () => {
    const w = mountWithStore();
    const copilot = useCopilotStore();
    copilot.onReconnect(SOCKET);
    const jobId = await startJob();
    copilot.applyEvent({ type: "job/status", jobId, machineId: MACHINE, status: "waiting", reason: "stalled" });
    copilot.onReconnect("33333333-3333-4333-8333-333333333333");
    await flushPromises();
    expect(noteText(w)).toBe("已重新連線，正在取回診斷狀態…");
  });

  it("execution 遞增但沒有 reason（重試、限流延後）→ 不出現說明行", async () => {
    const w = mountWithStore();
    const jobId = await startJob();
    useCopilotStore().applyEvent({ type: "job/status", jobId, machineId: MACHINE, status: "waiting", execution: 2 });
    await flushPromises();
    expect(noteText(w)).toBeNull();
  });

  it("面板與卡片渲染文字不含「worker」「stalled」，診斷任務不用「停滯」（FR-036）", async () => {
    const w = mountWithStore();
    const jobId = await startJob();
    const copilot = useCopilotStore();
    copilot.applyEvent({ type: "job/status", jobId, machineId: MACHINE, status: "waiting", reason: "stalled" });
    await flushPromises();
    const panel = w.text();
    expect(panel).toContain("重新排入佇列");
    expect(panel).not.toMatch(/worker|stalled/i);
    expect(panel).not.toContain("停滯");
    const card = diagnosisBadgeText(copilot.badgeFor(MACHINE)) ?? "";
    expect(card).not.toMatch(/worker|stalled|停滯/i);

    copilot.applyEvent({
      type: "job/status",
      jobId,
      machineId: MACHINE,
      status: "failed",
      error: "job stalled more than allowable limit",
    });
    await flushPromises();
    expect(w.text()).toContain("後端處理程序多次中斷，診斷已停止，請重試");
    expect(w.text()).not.toMatch(/worker|stalled/i);
  });

  it("等待中收到 attempt 2（尚無 token）即顯示「嘗試 2 / 3」，並清掉上一輪的串流文字", async () => {
    const w = mountWithStore();
    const jobId = await startJob();
    const copilot = useCopilotStore();
    copilot.applyEvent({ type: "ai/token", jobId, attempt: 1, seq: 0, text: "第一輪" });
    await flushPromises();
    expect(metaValue(w, "嘗試")).toBe("1 / 3");
    copilot.applyEvent({ type: "job/status", jobId, machineId: MACHINE, status: "waiting", attempt: 2 });
    await flushPromises();
    expect(metaValue(w, "嘗試")).toBe("2 / 3");
    const s = copilot.stateFor(MACHINE);
    expect(s.status === "active" ? s.streamText : null).toBe("");
  });

  it("快取命中的那一輪：嘗試次數照 job/status 推進，完成後不保留上一輪文字", async () => {
    const w = mountWithStore();
    const jobId = await startJob();
    const copilot = useCopilotStore();
    copilot.applyEvent({ type: "ai/token", jobId, attempt: 1, seq: 0, text: "第一輪半截" });
    copilot.applyEvent({ type: "job/status", jobId, machineId: MACHINE, status: "active", progress: 20, attempt: 2, execution: 2 });
    await flushPromises();
    expect(metaValue(w, "嘗試")).toBe("2 / 3");
    copilot.applyEvent({ type: "ai/done", jobId, attempt: 2, cached: true, result: RESULT });
    await flushPromises();
    expect(headerText(w)).toContain("已完成");
    expect(w.findAll("button").some((b) => b.text().startsWith("原始串流"))).toBe(false); // 沒有文字就不畫串流區
  });

  it("沒有重連的 45 s watchdog 以 GET 收尾 → 不顯示「重新連線後取回」（裁決 53）", async () => {
    const w = mountWithStore();
    const copilot = useCopilotStore();
    copilot.onReconnect(SOCKET);
    const jobId = await startJob();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ status: "completed", jobId, result: RESULT, cached: false })),
    );
    copilot.checkStalls(Date.now() + 46_000, 45_000);
    await flushPromises();
    await flushPromises();
    expect(headerText(w)).toContain("已完成");
    expect(w.find('[data-testid="copilot-recovered-meta"]').exists()).toBe(false);
  });
});

describe("CopilotDrawer 行動版 bottom sheet（dialog 語意與焦點陷阱）", () => {
  /** matchMedia 命中行動版斷點，並提供可手動觸發「sheet 出現」的 IntersectionObserver。 */
  function stubMobile(): { show: () => void; hide: () => void } {
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
    return { show: () => fire?.([{ isIntersecting: true }]), hide: () => fire?.([{ isIntersecting: false }]) };
  }

  it("手機寬度：根節點為 role=dialog + aria-modal、由標題命名；開啟時焦點移入、Tab 於邊界循環、Esc 送出 dismiss", async () => {
    const { show } = stubMobile();
    const w = mountDrawer({ machineId: null });
    await flushPromises();
    const root = w.get('[role="dialog"]');
    const title = document.getElementById(root.attributes("aria-labelledby")!);
    expect(title?.textContent).toBe("AI 診斷");

    // 未選機台的空狀態：一出現就接手焦點（modal）
    show();
    await flushPromises();
    expect(document.activeElement).toBe(root.element);
    expect(root.attributes("aria-modal")).toBe("true");

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

  /** 一張假卡片（與 MachineNodeCard 同 class 與 data-machine），焦點與捲動都記錄下來。 */
  function fakeCard(id: string): { el: HTMLButtonElement; scrolls: { margin: string; opts: ScrollIntoViewOptions }[] } {
    const el = document.createElement("button");
    el.className = "machine-card";
    el.dataset.machine = id;
    const scrolls: { margin: string; opts: ScrollIntoViewOptions }[] = [];
    el.scrollIntoView = ((opts: ScrollIntoViewOptions) => {
      scrolls.push({ margin: el.style.scrollMarginBottom, opts });
    });
    document.body.appendChild(el);
    return { el, scrolls };
  }

  it("閒置選台：sheet 不搶焦點（焦點留在卡片、aria-modal=false）、公告可用按鍵；開始診斷後才接手焦點並轉 modal", async () => {
    const { show } = stubMobile();
    const card = fakeCard(MACHINE);
    card.el.focus();
    const w = mountDrawer();
    await flushPromises();
    show();
    await flushPromises();

    const root = w.get('[role="dialog"]');
    expect(document.activeElement).toBe(card.el);
    expect(root.attributes("aria-modal")).toBe("false");
    expect(w.text()).toContain(`已開啟 ${LABEL} 的 AI 診斷面板：按 d 開始診斷，按 Escape 收合。`);
    // 焦點不在 sheet 內：Escape 不由 drawer 攔（交 App 層面板層），也不冒出 dismiss
    await root.trigger("keydown", { key: "Escape" });
    expect(w.emitted("dismiss")).toBeUndefined();

    // 開始診斷（例如在卡片上按 d）→ 有可操作內容 → 焦點搬進 sheet、modal＋焦點陷阱
    await w.setProps({ state: { status: "active", machineId: MACHINE, jobId: "job-1", attempt: 1, progress: null, streamText: "" } as CopilotJobState });
    await flushPromises();
    expect(document.activeElement).toBe(root.element);
    expect(root.attributes("aria-modal")).toBe("true");
    expect(w.text()).not.toContain("已開啟");
    await root.trigger("keydown", { key: "Escape" });
    expect(w.emitted("dismiss")).toHaveLength(1);
  });

  it("update:engaged：只在接手焦點狀態變化時各發一次——閒置非 modal 不發、接手 true、關閉 false", async () => {
    const { show, hide } = stubMobile();
    const card = fakeCard(MACHINE);
    card.el.focus();
    const w = mountDrawer();
    await flushPromises();
    show();
    await flushPromises();
    // 閒置選台（非 modal）：維持 false，不發事件
    expect(w.emitted("update:engaged")).toBeUndefined();

    await w.setProps({ state: { status: "active", machineId: MACHINE, jobId: "job-1", attempt: 1, progress: null, streamText: "" } as CopilotJobState });
    await flushPromises();
    expect(w.emitted("update:engaged")).toEqual([[true]]);
    // 同一態內的 token／進度更新不重發
    await w.setProps({ state: { status: "active", machineId: MACHINE, jobId: "job-1", attempt: 1, progress: 40, streamText: '{"summary":"' } as CopilotJobState });
    await flushPromises();
    expect(w.emitted("update:engaged")).toEqual([[true]]);

    hide();
    await flushPromises();
    expect(w.emitted("update:engaged")).toEqual([[true], [false]]);
  });

  it("觸控 Safari：點卡片不給焦點（activeElement＝body）＋閒置＋有選取 → 不接手、不發 engaged、aria-modal=false（第三輪交叉審查 medium）", async () => {
    const { show } = stubMobile();
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);
    const w = mountDrawer();
    await flushPromises();
    show();
    await flushPromises();
    const root = w.get('[role="dialog"]');
    expect(root.attributes("aria-modal")).toBe("false");
    expect(document.activeElement).toBe(document.body);
    expect(w.emitted("update:engaged")).toBeUndefined();
  });

  it("焦點在 body 但未選機台（空狀態）→ 仍接手焦點並發 engaged", async () => {
    const { show } = stubMobile();
    (document.activeElement as HTMLElement | null)?.blur();
    const w = mountDrawer({ machineId: null });
    await flushPromises();
    show();
    await flushPromises();
    expect(w.get('[role="dialog"]').attributes("aria-modal")).toBe("true");
    expect(w.emitted("update:engaged")).toEqual([[true]]);
  });

  it("update:engaged：使用者點進閒置 sheet（focusin）→ true", async () => {
    const { show } = stubMobile();
    const card = fakeCard(MACHINE);
    card.el.focus();
    const w = mountDrawer();
    await flushPromises();
    show();
    await flushPromises();
    expect(w.emitted("update:engaged")).toBeUndefined();
    (buttonExact(w, "診斷")!.element as HTMLButtonElement).focus();
    await flushPromises();
    expect(w.emitted("update:engaged")).toEqual([[true]]);
  });

  it("閒置選台：使用者自己 Tab／點進 sheet（focusin）→ 進焦點陷阱並轉 modal", async () => {
    const { show } = stubMobile();
    const card = fakeCard(MACHINE);
    card.el.focus();
    const w = mountDrawer();
    await flushPromises();
    show();
    await flushPromises();
    const root = w.get('[role="dialog"]');
    expect(root.attributes("aria-modal")).toBe("false");

    const diagnose = buttonExact(w, "診斷")!.element as HTMLButtonElement;
    diagnose.focus();
    await flushPromises();
    expect(root.attributes("aria-modal")).toBe("true");
    // 焦點陷阱生效（閒置單列：診斷鈕在前、收合鈕在後）：第一個（診斷鈕）Shift+Tab → 繞到最後一個（收合鈕），再 Tab → 回到診斷鈕
    const close = w.get('button[aria-label="關閉／收合 AI 診斷面板"]').element;
    await root.trigger("keydown", { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(close);
    await root.trigger("keydown", { key: "Tab" });
    expect(document.activeElement).toBe(diagnose);
  });

  it("閒置選台的 sheet 只一列（critique 第三輪 P1）：「AI 診斷」前綴＋機台名、狀態徽章、行內「診斷」、收合；無標頭、無「未診斷」chip、無內容區；dialog 名稱含機台 id", async () => {
    stubMobile();
    const summary: MachineLive = {
      machineId: MACHINE,
      state: "critical",
      telemetry: { temperature: 98.7, vibration: 2.4, throughput: 120, errorRate: 0.034 },
      lastUpdated: Date.now() - 60_000,
    };
    const w = mountDrawer({ summary });
    await flushPromises();
    expect(w.find("header").exists()).toBe(false);
    expect(w.text()).not.toContain("未診斷");
    expect(w.find(".overflow-auto").exists()).toBe(false);
    expect(w.text()).not.toContain("AI 會讀取這台機台的近期資料");

    const root = w.get('[role="dialog"]');
    const title = document.getElementById(root.attributes("aria-labelledby")!)!;
    expect(title.tagName).toBe("H2");
    expect(title.textContent).toBe(`AI 診斷 ${LABEL}（${MACHINE}）`);
    const prefix = title.querySelector("span")!;
    expect(prefix.textContent).toBe("AI 診斷");
    expect(prefix.className).toContain("text-xs");
    expect(prefix.className).toContain("text-ink-3");

    // 全部在同一列：標題、徽章（含停滯）、診斷鈕、收合鈕
    const row = title.parentElement!;
    expect(row.classList.contains("h-8")).toBe(true);
    expect(row.textContent).toContain("狀態：嚴重");
    expect(row.textContent).toContain("停滯");
    const buttons = Array.from(row.querySelectorAll(":scope > button"));
    expect(buttons.map((b) => b.textContent?.trim())).toEqual(["診斷", ""]);
    expect(buttons[1]!.getAttribute("aria-label")).toBe("關閉／收合 AI 診斷面板");

    await buttonExact(w, "診斷")!.trigger("click");
    expect(w.emitted("diagnose")).toHaveLength(1);
    await w.get('button[aria-label="關閉／收合 AI 診斷面板"]').trigger("click");
    expect(w.emitted("close")).toHaveLength(1);
  });

  it("sheet 閒置單列 → 開始診斷後回到原標頭（進行中 chip、id · 任務短碼）與內容區", async () => {
    stubMobile();
    const w = mountDrawer();
    await flushPromises();
    expect(w.find("header").exists()).toBe(false);
    await w.setProps({ state: { status: "active", machineId: MACHINE, jobId: "abcdef1234", attempt: 1, progress: null, streamText: "" } as CopilotJobState });
    await flushPromises();
    expect(headerText(w)).toContain("進行中");
    expect(headerText(w)).toContain(`${MACHINE} · abcdef12`);
    expect(w.find(".overflow-auto").exists()).toBe(true);
  });

  it("已有結果的機台：sheet 一出現就接手焦點（完成態有可操作內容）", async () => {
    const { show } = stubMobile();
    const card = fakeCard(MACHINE);
    card.el.focus();
    const w = mountDrawer({
      state: { status: "completed", machineId: MACHINE, jobId: "job-1", cached: false, result: RESULT, streamText: "", source: "ai/done", streamIncomplete: false } as CopilotJobState,
    });
    await flushPromises();
    show();
    await flushPromises();
    const root = w.get('[role="dialog"]');
    expect(document.activeElement).toBe(root.element);
    expect(root.attributes("aria-modal")).toBe("true");
  });

  it("sheet 出現、換機台、方向鍵把焦點移到其他卡片時，以 scroll-margin-bottom＝sheet 遮擋高度捲到 sheet 上緣之上，捲完還原", async () => {
    const { show } = stubMobile();
    const selected = fakeCard(MACHINE);
    const other = fakeCard("mixer-01");
    selected.el.focus();
    const w = mountDrawer();
    await flushPromises();
    expect(selected.scrolls).toHaveLength(0); // sheet 未出現前不捲

    show();
    await flushPromises();
    // happy-dom 無 layout：卡片與 sheet 上緣皆 0、無捲動祖先（容器＝視窗）→ 遮擋＝min(容器下緣, innerHeight) − 0 ＋ 8px 間距
    expect(selected.scrolls).toEqual([{ margin: `${window.innerHeight + 8}px`, opts: { block: "nearest" } }]);
    expect(selected.el.style.scrollMarginBottom).toBe("");

    // 方向鍵移焦到另一張卡片（focusin）→ 同樣捲出 sheet 之外
    other.el.focus();
    expect(other.scrolls).toHaveLength(1);

    // 換機台（Enter 選了另一台）→ 捲新的選取卡
    await w.setProps({ machineId: "mixer-01", state: { status: "idle", machineId: "mixer-01" } });
    await flushPromises();
    expect(other.scrolls).toHaveLength(2);
  });

  it("modal sheet 按「中止診斷」回到閒置 → 退回非 modal：aria-modal=false、發 engaged=false、焦點落在單列「診斷」鈕、Tab 到收合鈕不再接手（合併門第 2 輪 #1）", async () => {
    const { show } = stubMobile();
    const card = fakeCard(MACHINE);
    card.el.focus();
    const w = mountDrawer();
    await flushPromises();
    show();
    await flushPromises();
    await w.setProps({ state: { status: "active", machineId: MACHINE, jobId: "job-1", attempt: 1, progress: 20, streamText: "" } as CopilotJobState });
    await flushPromises();
    const root = w.get('[role="dialog"]');
    expect(root.attributes("aria-modal")).toBe("true");
    (buttonExact(w, "中止診斷")!.element as HTMLButtonElement).focus();

    // App 的 cancel → copilot.cancel → 該台 idle
    await w.setProps({ state: { status: "idle", machineId: MACHINE } });
    await flushPromises();
    expect(root.attributes("aria-modal")).toBe("false");
    expect(w.emitted("update:engaged")).toEqual([[true], [false]]);
    const diagnose = buttonExact(w, "診斷")!.element;
    expect(document.activeElement).toBe(diagnose);
    // 非 modal：Escape 交 App 層，不由 drawer 攔
    await root.trigger("keydown", { key: "Escape" });
    expect(w.emitted("dismiss")).toBeUndefined();
    // 在 sheet 內移動焦點（診斷 → 收合）不算「使用者自己進來」，維持非 modal
    (w.get('button[aria-label="關閉／收合 AI 診斷面板"]').element as HTMLButtonElement).focus();
    await flushPromises();
    expect(root.attributes("aria-modal")).toBe("false");
    expect(w.emitted("update:engaged")).toEqual([[true], [false]]);
    // 從外面（卡片）再進來才接手
    card.el.focus();
    (buttonExact(w, "診斷")!.element as HTMLButtonElement).focus();
    await flushPromises();
    expect(root.attributes("aria-modal")).toBe("true");
  });

  it("滑鼠點閒置單列「診斷」→ 轉 modal、被點的鈕隨標頭切換移除後焦點不掉到 body（落在 sheet 根節點），Tab 留在 sheet 內", async () => {
    const { show } = stubMobile();
    const card = fakeCard(MACHINE);
    card.el.focus();
    const w = mountDrawer();
    await flushPromises();
    show();
    await flushPromises();
    const root = w.get('[role="dialog"]');
    // 點擊：瀏覽器先把焦點給按鈕（focusin 接手），再 click → App 開始診斷
    const diagnose = buttonExact(w, "診斷")!.element as HTMLButtonElement;
    diagnose.focus();
    await flushPromises();
    expect(root.attributes("aria-modal")).toBe("true");
    await w.setProps({ state: { status: "active", machineId: MACHINE, jobId: "job-1", attempt: 1, progress: null, streamText: "" } as CopilotJobState });
    await flushPromises();
    expect(diagnose.isConnected).toBe(false);
    expect(document.activeElement).toBe(root.element);
    expect(root.element.contains(document.activeElement)).toBe(true);
    // Tab 由根節點的焦點陷阱處理，留在 sheet 內
    await root.trigger("keydown", { key: "Tab" });
    expect(root.element.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(document.body);
    await root.trigger("keydown", { key: "Tab", shiftKey: true });
    expect(root.element.contains(document.activeElement)).toBe(true);
  });

  it("中止退回非 modal 後，從 sheet 內收合（收合鈕／Escape 後 sheet 隱藏）→ 焦點回到選取卡，不掉到 body（合併門第 3 輪 #1）", async () => {
    const { show, hide } = stubMobile();
    const card = fakeCard(MACHINE);
    card.el.focus();
    const w = mountDrawer({
      state: { status: "active", machineId: MACHINE, jobId: "job-1", attempt: 1, progress: 20, streamText: "" } as CopilotJobState,
    });
    await flushPromises();
    show();
    await flushPromises();
    (buttonExact(w, "中止診斷")!.element as HTMLButtonElement).focus();
    await w.setProps({ state: { status: "idle", machineId: MACHINE } });
    await flushPromises();
    const root = w.get('[role="dialog"]');
    expect(root.attributes("aria-modal")).toBe("false");

    // 收合鈕：焦點在 sheet 內 → App 收合面板 → aside 隱藏
    const close = w.get('button[aria-label="關閉／收合 AI 診斷面板"]');
    (close.element as HTMLButtonElement).focus();
    await close.trigger("click");
    expect(w.emitted("close")).toHaveLength(1);
    hide();
    await flushPromises();
    expect(document.activeElement).toBe(card.el);
    expect(document.activeElement).not.toBe(document.body);

    // 再開（非 modal 閒置）→ 焦點進 sheet 後遺失（Escape 交 App 層收合、aside 隱藏時瀏覽器丟回 body）→ 一樣回到選取卡
    show();
    await flushPromises();
    (buttonExact(w, "診斷")!.element as HTMLButtonElement).focus();
    await flushPromises();
    await w.setProps({ state: { status: "active", machineId: MACHINE, jobId: "job-2", attempt: 1, progress: 20, streamText: "" } as CopilotJobState });
    await flushPromises();
    await w.setProps({ state: { status: "idle", machineId: MACHINE } });
    await flushPromises();
    expect(root.attributes("aria-modal")).toBe("false");
    (document.activeElement as HTMLElement | null)?.blur();
    hide();
    await flushPromises();
    expect(document.activeElement).toBe(card.el);
  });

  it("中止後「診斷」停用（斷線中）→ 焦點落在 sheet 根節點而非 body，仍為非 modal", async () => {
    const { show } = stubMobile();
    const w = mountDrawer({
      canDiagnose: false,
      connectionBlockedReason: "連線未就緒",
      state: { status: "active", machineId: MACHINE, jobId: "job-1", attempt: 1, progress: 20, streamText: "" } as CopilotJobState,
    });
    await flushPromises();
    show();
    await flushPromises();
    const root = w.get('[role="dialog"]');
    expect(root.attributes("aria-modal")).toBe("true");
    (buttonExact(w, "中止診斷")!.element as HTMLButtonElement).focus();
    await w.setProps({ state: { status: "idle", machineId: MACHINE } });
    await flushPromises();
    expect(root.attributes("aria-modal")).toBe("false");
    expect(document.activeElement).toBe(root.element);
  });

  it("modal sheet 時改選一台閒置機台（搜尋 Enter，焦點已移到卡片）→ 退回非 modal，焦點留在卡片不被搶走", async () => {
    const { show } = stubMobile();
    const card = fakeCard(MACHINE);
    const other = fakeCard("mixer-01");
    const w = mountDrawer({
      state: { status: "completed", machineId: MACHINE, jobId: "job-1", cached: false, result: RESULT, streamText: "", source: "ai/done", streamIncomplete: false } as CopilotJobState,
    });
    await flushPromises();
    show();
    await flushPromises();
    const root = w.get('[role="dialog"]');
    expect(root.attributes("aria-modal")).toBe("true");
    expect(card.el).toBeTruthy();

    other.el.focus();
    await w.setProps({ machineId: "mixer-01", machineLabel: machineLabel("mixer-01"), state: { status: "idle", machineId: "mixer-01" } });
    await flushPromises();
    expect(root.attributes("aria-modal")).toBe("false");
    expect(document.activeElement).toBe(other.el);
    expect(w.emitted("update:engaged")).toEqual([[true], [false]]);
  });

  it("非 modal sheet 開著時改選另一台：開啟公告換成新機台名（合併門第 2 輪 #9）", async () => {
    const { show } = stubMobile();
    const card = fakeCard(MACHINE);
    card.el.focus();
    const w = mountDrawer();
    await flushPromises();
    show();
    await flushPromises();
    expect(w.text()).toContain(`已開啟 ${LABEL} 的 AI 診斷面板`);

    const otherLabel = machineLabel("mixer-01");
    await w.setProps({ machineId: "mixer-01", machineLabel: otherLabel, state: { status: "idle", machineId: "mixer-01" } });
    await flushPromises();
    expect(w.text()).toContain(`已開啟 ${otherLabel} 的 AI 診斷面板：按 d 開始診斷，按 Escape 收合。`);
    expect(w.text()).not.toContain(`已開啟 ${LABEL} `);
  });

  it("桌機寬度：常駐側欄不掛 dialog 屬性，Esc 不被攔截", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    );
    const card = fakeCard(MACHINE);
    const w = mountDrawer();
    await flushPromises();
    expect(w.find('[role="dialog"]').exists()).toBe(false);
    expect(w.find("[aria-modal]").exists()).toBe(false);
    // 推擠式側欄：卡片就在旁邊，不捲動；閒置態多一行用途說明（sheet 形態改為單列、不顯示）
    expect(card.scrolls).toHaveLength(0);
    expect(w.text()).toContain("AI 會讀取這台機台的近期資料");
    // 推擠式側欄恆不接手焦點：即使焦點進入面板也不發 update:engaged（維持 false）
    (buttonExact(w, "診斷")!.element as HTMLButtonElement).focus();
    await w.setProps({ state: { status: "active", machineId: MACHINE, jobId: "job-1", attempt: 1, progress: null, streamText: "" } as CopilotJobState });
    await flushPromises();
    expect(w.emitted("update:engaged")).toBeUndefined();
    await w.setProps({ state: { status: "idle", machineId: MACHINE } });
    await flushPromises();
    await w.get('[tabindex="-1"]').trigger("keydown", { key: "Escape" });
    expect(w.emitted("close")).toBeUndefined();
    expect(w.emitted("dismiss")).toBeUndefined();
  });
});
