<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, useId, watch } from "vue";
import { Stethoscope, X, RotateCcw, Ban } from "lucide-vue-next";
import { DIAGNOSIS_QUEUE } from "@flow-gatekeeper/contracts";
import { useMonitoringStore, type MachineLive } from "../../monitoring/stores/monitoring.store.js";
import { isStale } from "../../monitoring/lib/stale.js";
import { CARD_ROOT_CLASS } from "../../monitoring/lib/card-style.js";
import { machineLabel as labelOf } from "../../monitoring/lib/machine-labels.js";
import {
  STREAM_LABEL_INCOMPLETE,
  isUndeliveredFailure,
  progressLabel,
  type CopilotJobState,
} from "../lib/copilot-reducer.js";
import { jobSteps, type StepStatus } from "../lib/job-steps.js";
import { parsePartialDiagnosis } from "../lib/partial-json.js";
import { compareBars, compareLabel } from "../lib/diagnosis-timing.js";
import { nearestScrollParent, revealAboveSheet } from "../lib/reveal-above-sheet.js";
import { useCopilotStore } from "../stores/copilot.store.js";
import ProgressBar from "../../../shared/components/ProgressBar.vue";
import StateBadge from "../../../shared/components/StateBadge.vue";
import StalePill from "../../../shared/components/StalePill.vue";
import StreamDisclosure from "./StreamDisclosure.vue";
import DiagnosisResultView from "./DiagnosisResultView.vue";
import ResultSkeleton from "./ResultSkeleton.vue";
import { useModalSheet } from "../composables/useModalSheet.js";

/**
 * AI 診斷面板內容（FR-002/FR-006/FR-014、FR-018～FR-024；013 視覺層與繁中文案，research R13）。依
 * `selectedMachineId` 呈現對應那一份狀態機：
 * - 閒置：機台摘要＋診斷；
 * - 進行中：進度、隨串流逐格填入的結果骨架（ResultSkeleton）、可展開的原始串流（預設收合）、處理步驟；
 * - 已完成：嚴重度色條＋完成 meta（時間與耗時；快取時大字耗時＋同刻度對比橫條）＋「再次診斷」次要鈕＋結構化結果，
 *   原始串流保留但預設收合（Clarifications Q2）；結果整塊直接出現，不走任何出現動畫；
 * - 失敗：可讀分類錯誤＋重試，原始串流預設展開以保留中斷前推理，不顯示骨架。
 *
 * 外框（半透明面板、邊與高光）由 AppLayout 的 aside 負責；本元件只畫內容，不再包一層面板，
 * 內部分區以 `border-edge` 分隔線與 `bg-rim` 標頭區隔。
 */
const props = defineProps<{
  state: CopilotJobState;
  machineId: string | null;
  machineLabel: string;
  summary: MachineLive | null;
  canDiagnose: boolean;
  /** 連線面不可診斷的原因（停用 tooltip）；null＝連線就緒。 */
  connectionBlockedReason: string | null;
  /**
   * sheet 關閉時焦點歸還的次要後備（選取卡不在 DOM 時用）；App 傳 AppLayout 的 peek 條。
   * 由外部提供，drawer 不以 selector 查 AppLayout 的 DOM（合併門最後一批 #5）。
   */
  restoreFallback?: () => HTMLElement | null;
}>();

const emit = defineEmits<{
  (e: "diagnose"): void;
  (e: "retry"): void;
  (e: "cancel"): void;
  /** 面板上的收合鈕（手動收合）。 */
  (e: "close"): void;
  /** bottom-sheet（< 1366px）按 Escape（只影響當次，不算手動收合）。 */
  (e: "dismiss"): void;
  /**
   * sheet 是否已接手焦點（modal：`aria-modal="true"`＋焦點陷阱）。閒置選台的非 modal sheet 與桌機推擠式側欄恆為 false。
   * 只在值變化時發一次；App／AppLayout 以它決定是否渲染遮罩（非 modal 時不擋卡片點擊，點其他卡片即改選）。
   */
  (e: "update:engaged", engaged: boolean): void;
}>();

/** 任務短碼（active/completed/failed 才有 jobId）。 */
const jobShort = computed(() =>
  "jobId" in props.state && props.state.jobId ? props.state.jobId.slice(0, 8) : null,
);

/**
 * 狀態 chip（狀態不只靠顏色：附文字 label）。chip 自帶底色，放在 rim 標頭上對比不受影響。
 * chip 講的是「任務走到哪」而非機台健康：閒置寫「未診斷」（不是機台閒置）；「已完成」用中性底，
 * 不用 ok 綠——結果是警告／嚴重時綠色「已完成」會與結果衝突（critique 第二輪 Minor），嚴重度由結果的色條與徽章承載。
 */
const STATUS_CHIP: Record<CopilotJobState["status"], { cls: string; label: string }> = {
  idle: { cls: "border-edge bg-surface-strong text-ink-2", label: "未診斷" },
  active: { cls: "border-transparent bg-accent-wash text-accent", label: "進行中" },
  completed: { cls: "border-edge bg-surface-strong text-ink-2", label: "已完成" },
  failed: { cls: "border-transparent bg-crit-bg text-crit-fg", label: "失敗" },
};

const progressText = computed(() =>
  props.state.status === "active" ? progressLabel(props.state.progress) : "",
);

/** US7 active 步驟清單（衍生自既有 progress，不新增事件/契約；research R11）。 */
const steps = computed(() =>
  props.state.status === "active" ? jobSteps(props.state.progress) : [],
);
/**
 * 目前步驟（進度列下方的一行 `text-xs`）：骨架填滿後完整步驟清單會被擠到捲動區下方，
 * 「取得去重鎖」這類進度與佇列／嘗試一起放在進度列下，不必捲動也看得到（critique 第二輪 Minor；完整清單仍保留在下方）。
 */
const currentStep = computed(() => steps.value.find((s) => s.status === "active") ?? null);

/**
 * 串流漸進解析（research R6）：只在 active 對 `streamText` 計算，token 每秒數十次、O(n) 於幾 KB，
 * computed 即可。PartialResult 只拿來畫骨架；完成態改用 `ai/done` 驗證過的 `result`（工程硬規則 6）。
 * 每個 token 都從頭重解析，整段串流累計是 O(n²)：已接受的取捨（合併門第 2 輪 #15）——診斷輸出只有數 KB、
 * 單次解析在毫秒以下，改寫成增量解析器的複雜度不值得。
 */
const partial = computed(() =>
  props.state.status === "active" ? parsePartialDiagnosis(props.state.streamText) : null,
);

/**
 * 完成 meta（FR-022／FR-023）：耗時與完成時刻由 copilot store 在任務收尾時記錄（每台一份）。
 * 直接讀本 domain 的 store，App 的接線不必多傳兩個 prop。
 */
const copilot = useCopilotStore();
const resultMeta = computed(() => {
  const s = props.state;
  if (s.status !== "completed") return undefined;
  const timing = copilot.timingFor(s.machineId);
  return {
    cached: s.cached,
    completedAt: copilot.completedAtFor(s.machineId) ?? null,
    elapsed: compareLabel(timing),
    bars: compareBars(timing),
  };
});

/**
 * 閒置態只留「機台名 · 狀態徽章（含停滯）」＋診斷鈕，不再重複卡片的 2×2 遙測（critique 第二輪 P1）：
 * < 1366px 的 sheet 原本因這四格佔掉 35–45% 視窗、蓋住剛選的卡；≥ 1366px 卡片就在旁邊，重複只是雜訊。
 * 停滯判定與卡片同一來源（`isStale` × monitoring `staleNow`，每秒 tick、Pause 且連線中時凍結），兩邊不會一個停滯一個沒有。
 */
const monitoring = useMonitoringStore();
const summaryStale = computed(() =>
  props.summary ? isStale(props.summary.lastUpdated, monitoring.staleNow) : false,
);

/** 003 設定的最大嘗試次數（BullMQ attempts）；僅用於呈現。 */
const MAX_ATTEMPTS = 3;

/**
 * job meta——queue 自契約 import 常數值；attempt 取自串流事件，讓重試換輪時使用者看得出串流
 * 文字為何從頭開始。不顯示 concurrency：它現在是 worker 端可設定的 `WORKER_CONCURRENCY`，前端拿不到
 * 真實值，寫死數字只會與實際不符。
 * 這組 `<dl>` 只在進行中區塊渲染；非 active 的回退值只為型別收斂（`attempt` 只存在於 active），畫面上不會出現。
 */
const jobMeta = computed<readonly { label: string; value: string }[]>(() => [
  { label: "佇列", value: DIAGNOSIS_QUEUE },
  {
    label: "嘗試",
    value: props.state.status === "active" ? `${props.state.attempt} / ${MAX_ATTEMPTS}` : `${MAX_ATTEMPTS}`,
  },
]);

/** 步驟以蝕刻短線標示進度；狀態另附視覺隱藏文字，不只靠顏色（FR-004）。 */
const STEP_STYLE: Record<StepStatus, { tick: string; text: string; sr: string }> = {
  done: { tick: "bg-ok", text: "text-ink-2", sr: "已完成" },
  active: { tick: "bg-accent", text: "font-medium text-ink", sr: "目前步驟" },
  todo: { tick: "bg-etch", text: "text-ink-3", sr: "尚未開始" },
};

/** 主要動作（診斷，及失敗態再次觸發診斷的重試）；停用時改為 rim 底＋ink-3 字，不用整顆半透明（停用對比仍 ≥ 3:1）。 */
const PRIMARY_BTN_BASE =
  "flex items-center justify-center gap-2 rounded-control border border-accent-strong bg-accent text-sm font-semibold text-surface-strong hover:bg-accent-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-not-allowed disabled:border-edge disabled:bg-rim disabled:text-ink-3";
/** 滿版主鈕（失敗態「重試」）。 */
const PRIMARY_BTN = `${PRIMARY_BTN_BASE} w-full px-3 py-2`;
/** 推擠式側欄（≥ 1366px）閒置態與機台名同列的主鈕「診斷」：不縮、靠右。 */
const PRIMARY_BTN_INLINE = `${PRIMARY_BTN_BASE} ml-auto shrink-0 px-4 py-2`;
/** sheet 閒置單列的主鈕「診斷」：高 30px，與把手合計讓閒置 sheet 約 51px（critique 第三輪 P1）。 */
const PRIMARY_BTN_COMPACT = `${PRIMARY_BTN_BASE} ml-auto shrink-0 px-3 py-1`;
/** 收合鈕（標頭與 sheet 閒置單列共用）。 */
const CLOSE_BTN =
  "shrink-0 rounded-control p-1.5 text-ink-2 hover:bg-surface/72 hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-focus";
/** 次要動作（進行中的「中止診斷」、完成態的「再次診斷」）：精簡的 Tool 樣式鈕。 */
const SECONDARY_BTN =
  "flex shrink-0 items-center justify-center gap-1.5 rounded-control border border-edge bg-surface/72 px-2.5 py-1 text-sm font-medium text-ink shadow-glass hover:bg-rim/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-not-allowed disabled:bg-rim disabled:text-ink-3 disabled:shadow-none";

/**
 * 螢幕閱讀器公告：串流區不逐 token 朗讀（太吵），只在同一個任務「active → 完成／失敗」時
 * 以 polite live region 公告一句摘要。切換機台造成的狀態變化不算轉移，不公告，
 * 否則點到一台早已完成的機台也會被念「診斷完成」。機台名稱以事件本身的 `machineId` 換成繁中名，
 * 不讀 `machineLabel` prop：watch 觸發時 prop 可能已換成別台（合併門第 2 輪 #4）。
 */
const announcement = ref("");
watch(
  () => props.state,
  (next, prev) => {
    const sameJob =
      "jobId" in next && "jobId" in prev && next.jobId !== undefined && next.jobId === prev.jobId;
    // 換台或開始新任務：先清空，否則下次公告與上次文字相同時 live region 不會重念。
    if (!sameJob) {
      announcement.value = "";
      return;
    }
    // 「結果未送達」失敗被遲到的結果救回（AR-6、FR-005）也算同一任務的完成轉移，照樣公告。
    // 三個完成來源先到者才造成轉移；後到者（含重複的 ai/done）reducer 原樣回傳、不觸發 watch，因此只公告一次（FR-004）。
    if (prev.status !== "active" && !isUndeliveredFailure(prev)) return;
    if (next.status === "completed") {
      announcement.value = `${labelOf(next.machineId)} 診斷完成${next.cached ? "（快取）" : ""}：${next.result.summary}`;
    } else if (next.status === "failed") {
      announcement.value = `${labelOf(next.machineId)} 診斷失敗：${next.error}`;
    }
  },
);

/**
 * 行動版 bottom sheet 的 dialog 語意與焦點陷阱；桌機常駐側欄不套用。
 *
 * 焦點取捨（critique 第二輪 P1／鍵盤使用者）：選了機台的閒置態不搶焦點——使用者剛在卡片上按 Enter，
 * 焦點留在卡片、方向鍵可繼續導航，`d` 開始診斷、Escape 由 App 層面板層收合；此時 sheet 是
 * `role="dialog"`＋`aria-modal="false"` 的非 modal 對話框，並以 polite live region 告知面板已開與可用按鍵。
 * 有可操作內容時（進行中／完成／失敗、或未選機台的空狀態）才把焦點搬進來並啟用焦點陷阱與 `aria-modal="true"`；
 * 使用者自己 Tab／點進 sheet（含抓取把手所在的外框）時也接手。選擇非 modal 而非「modal 但不聚焦」：
 * 焦點在外面時宣告 aria-modal="true" 等於告訴輔助技術外面是惰性的，與實際可操作的卡片矛盾。
 */
const root = ref<HTMLElement | null>(null);
const titleId = useId();
const { isSheet, open: sheetOpen, trapActive, engage, disengage, quietFocus, onKeydown } = useModalSheet(
  root,
  () => emit("dismiss"),
  {
    autoFocus: () => props.machineId === null || props.state.status !== "idle",
    focusScope: (el) => el.closest<HTMLElement>('[data-fg="copilot"]'),
    // 關閉時歸還焦點的後備：目前選取卡，其次收合後出現的 peek 條（合併門第 3 輪 #1）。
    restoreTarget: () => selectedCard() ?? props.restoreFallback?.() ?? null,
  },
);

/**
 * sheet 閒置單列（critique 第三輪 P1）：< 1366px 選了機台、尚未診斷時，標頭與內容合併成一列約 51px（含把手）——
 * 「AI 診斷」縮成 `text-xs text-ink-3` 前綴、機台名、狀態徽章（含停滯）、行內「診斷」、收合鈕。原本兩列（標頭「AI 診斷 press-02 未診斷 ×」
 * ＋內容「壓製機 02 正常 診斷」）講同一件事、合計約 144px，1024／768／390 選台後蓋住整個事件流。「未診斷」chip 省略（閒置即未診斷）；
 * 機台 id 進標題的視覺隱藏文字（dialog 名稱仍完整）。進行中／完成／失敗、未選機台的空狀態、與 ≥ 1366px 推擠式側欄維持原標頭與內容。
 */
const compactIdle = computed(
  () => isSheet.value && props.machineId !== null && props.state.status === "idle",
);

/**
 * 閒置單列的「診斷」鈕：modal sheet 回到閒置（中止診斷、改選閒置機台）時的焦點落點。
 * 停用時（斷線、訂閱中）不能接焦點，改落在 sheet 根節點（tabindex=-1，不進 Tab 順序；下一個 Tab 進收合鈕）。
 */
const compactDiagnoseBtn = ref<HTMLButtonElement | null>(null);
function idleFocusTarget(): HTMLElement | null {
  const btn = compactDiagnoseBtn.value;
  return btn && !btn.disabled ? btn : root.value;
}

/**
 * peek 條重開面板後的焦點落點（App 在 `open-panel` 後呼叫）：peek 條是使用者對面板本身的明確操作，但它隨面板展開被移除，
 * 焦點會掉到 body。DOM 更新後只在「sheet 形態、閒置單列、焦點已遺失（body 或已移除的節點）」時把焦點放到單列「診斷」鈕
 * （停用時落在 sheet 根節點）；以 `quietFocus` 放入，維持非 modal、不發 engaged。選台自動展開不走這裡，焦點照舊留在卡片。
 * 非閒置態（進行中／完成／失敗）sheet 一出現就會自己接手焦點，不必處理；桌機推擠式側欄由 AppLayout 交接焦點。
 */
function focusAfterPeekOpen(): void {
  void nextTick(() => {
    if (!isSheet.value || !compactIdle.value || typeof document === "undefined") return;
    const active = document.activeElement;
    if (active !== null && active !== document.body && active.isConnected) return;
    const target = idleFocusTarget();
    if (target) quietFocus(target);
  });
}
defineExpose({ focusAfterPeekOpen });

/**
 * sheet 開著時依「有沒有可操作內容」切換 modal：開始診斷、切到已有結果的機台、取消選取（空狀態）→ 接手焦點；
 * 回到「已選台、閒置」（按「中止診斷」、搜尋 Enter 改選一台閒置機台）→ `disengage` 退回非 modal，
 * 焦點仍在 sheet 內或已遺失時移到閒置單列的「診斷」鈕（合併門第 2 輪 #1：原本沒有退出路徑，單列仍 aria-modal、
 * 遮罩還在、點其他卡只會收合、焦點掉到 body）。
 * 多來源 watch 只在 status 或 machineId 真的變化時觸發；原本回傳新陣列的 getter 在每個 token（state 換新物件）
 * 都會觸發一次 `engage()`（合併門第 2 輪 #15）。
 * 已接手時 `engage` 只在焦點遺失時把焦點拉回根節點（例如點閒置單列「診斷」後該鈕隨標頭切換被移除）。`engage`／`disengage` 在未開或已是該狀態時無作用。
 */
watch([() => props.state.status, () => props.machineId], ([status, id]) => {
  if (!sheetOpen.value) return;
  if (id === null || status !== "idle") engage();
  else disengage(idleFocusTarget);
});

/** 接手焦點狀態對外（`update:engaged`）：trapActive 只在 sheet 形態且開著時為真，桌機恆 false；值變化才發。 */
watch(
  () => isSheet.value && trapActive.value,
  (engaged) => emit("update:engaged", engaged),
);

/**
 * 非 modal 開啟時的公告（視覺隱藏）；關閉時清空，下次開啟同一句才會重念。
 * 來源含 `machineId`：非 modal sheet 開著時改選另一台，公告要換成新機台名（合併門第 2 輪 #9）。
 */
const sheetHint = ref("");
watch([sheetOpen, trapActive, () => props.machineId], ([isOpen, trapped]) => {
  sheetHint.value =
    isOpen && !trapped && props.machineId !== null
      ? `已開啟 ${props.machineLabel} 的 AI 診斷面板：按 d 開始診斷，按 Escape 收合。`
      : "";
});

/**
 * 選取卡捲到 sheet 上緣之上（只在 sheet 形態）：sheet 出現、切換機台、或方向鍵把焦點移到被 sheet 蓋住的卡片時。
 * 以 sheet 外框（`[data-fg="copilot"]`）的實際上緣計算遮擋高度，不寫死 sheet 高度。
 */
function revealCard(card: HTMLElement | null): void {
  const sheetEl = root.value?.closest<HTMLElement>('[data-fg="copilot"]') ?? root.value;
  if (!card || !sheetEl || !sheetOpen.value) return;
  const scroller = nearestScrollParent(card);
  const container = scroller ? scroller.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
  revealAboveSheet(card, sheetEl.getBoundingClientRect().top, container, window.innerHeight);
}
function selectedCard(): HTMLElement | null {
  const id = props.machineId;
  if (id === null || typeof document === "undefined") return null;
  const escaped = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(id) : id;
  return document.querySelector<HTMLElement>(`.${CARD_ROOT_CLASS}[data-machine="${escaped}"]`);
}
watch([sheetOpen, () => props.machineId], ([isOpen]) => {
  if (isOpen) void nextTick(() => revealCard(selectedCard()));
});
function onDocumentFocusIn(e: FocusEvent): void {
  const target = e.target;
  if (sheetOpen.value && target instanceof HTMLElement && target.classList.contains(CARD_ROOT_CLASS)) {
    revealCard(target);
  }
}
onMounted(() => document.addEventListener("focusin", onDocumentFocusIn));
onUnmounted(() => document.removeEventListener("focusin", onDocumentFocusIn));

/**
 * 原始串流的展開狀態：進行中與已完成預設收合（主角是骨架與結果，Q2）；失敗預設展開，
 * 讓中斷前的推理直接可見（FR-024）。每次狀態或任務切換都回到該態的預設。
 */
const showStream = ref(false);
watch(
  () => ("jobId" in props.state ? `${props.state.status}:${props.state.jobId}` : props.state.status),
  () => {
    showStream.value = props.state.status === "failed";
  },
  { immediate: true },
);
</script>

<template>
  <!-- 根節點：寬度 < 1366px 為 bottom sheet（dialog 語意；接手焦點後才是 modal＋焦點陷阱，閒置選台時為非 modal）；
       ≥ 1366px 為推擠式常駐側欄，不掛 dialog 屬性。tabindex=-1 讓 sheet 接手時可程式聚焦，但不進入 Tab 順序。 -->
  <div
    ref="root"
    class="flex min-h-0 flex-1 flex-col focus:outline-none"
    tabindex="-1"
    :role="isSheet ? 'dialog' : undefined"
    :aria-modal="isSheet ? (trapActive ? 'true' : 'false') : undefined"
    :aria-labelledby="isSheet ? titleId : undefined"
    @keydown="onKeydown"
  >
    <!-- 完成／失敗摘要公告（視覺隱藏；常駐掛載，live region 才能在內容變化時被念出） -->
    <div class="sr-only" aria-live="polite" aria-atomic="true">{{ announcement }}</div>
    <!-- 非 modal sheet 開啟公告：焦點留在卡片時，告知面板已開與可用按鍵 -->
    <div class="sr-only" aria-live="polite" aria-atomic="true">{{ sheetHint }}</div>

    <!-- sheet 閒置單列（< 1366px、已選機台、尚未診斷）：「AI 診斷」前綴＋機台名、狀態徽章（含停滯）、「診斷」、收合。
         高 32px，與 AppLayout 的抓取把手合計約 51px；AppLayout 依 sheet 實際高度給主區等量 padding-bottom -->
    <div v-if="compactIdle" class="shrink-0 px-3.5 pb-1">
      <div class="mx-auto flex h-8 w-full min-w-0 max-w-xl items-center gap-2">
        <h2 :id="titleId" class="flex min-w-0 items-baseline gap-1.5">
          <span class="shrink-0 text-xs font-semibold text-ink-3">AI 診斷</span> <span class="min-w-0 truncate text-sm font-semibold text-ink">{{ machineLabel }}</span><span class="sr-only">（{{ machineId }}）</span>
        </h2>
        <!-- 狀態徽章：與卡片同款（文字＋底色，嚴重加 border-crit）；狀態不只靠顏色 -->
        <StateBadge v-if="summary" class="shrink-0" :state="summary.state" sr-prefix />
        <span v-else class="min-w-0 truncate text-xs text-ink-3">尚未收到遙測</span>
        <StalePill v-if="summaryStale" />
        <button
          ref="compactDiagnoseBtn"
          type="button"
          :class="PRIMARY_BTN_COMPACT"
          :disabled="!canDiagnose"
          :title="connectionBlockedReason ?? undefined"
          @click="emit('diagnose')"
        >
          <Stethoscope class="h-4 w-4" aria-hidden="true" />
          診斷
        </button>
        <button
          type="button"
          :class="CLOSE_BTN"
          aria-label="關閉／收合 AI 診斷面板"
          title="關閉／收合 AI 診斷面板"
          @click="emit('close')"
        >
          <X class="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    </div>

    <!-- 標頭（rim 桌邊色）：標題、機台 id · 任務短碼、狀態 chip、關閉。
         內層與內容區同為 max-w-xl 置中，1024 寬的 sheet 標題、chip 與內容左緣對齊、不拉到 1000px -->
    <header v-else class="shrink-0 border-b border-edge bg-rim px-3.5 py-3">
      <div class="mx-auto flex w-full max-w-xl items-center gap-2.5">
        <Stethoscope class="h-4 w-4 shrink-0 text-accent-strong" aria-hidden="true" />
        <div class="min-w-0 flex-1">
          <h2 :id="titleId" class="truncate text-md font-semibold text-ink">AI 診斷</h2>
          <div class="truncate font-mono text-xs text-ink-3">
            {{ machineId ?? "—" }}<span v-if="jobShort"> · {{ jobShort }}</span>
          </div>
        </div>
        <span
          class="shrink-0 rounded-pill border px-2 py-px text-xs font-semibold leading-4"
          :class="STATUS_CHIP[state.status].cls"
        >{{ STATUS_CHIP[state.status].label }}</span>
        <button
          type="button"
          :class="CLOSE_BTN"
          aria-label="關閉／收合 AI 診斷面板"
          title="關閉／收合 AI 診斷面板"
          @click="emit('close')"
        >
          <X class="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    </header>

    <!-- 內容（max-w-xl 置中：1024 寬的 sheet 不把各欄拉到 1000px）；sheet 閒置單列時不渲染 -->
    <div v-if="!compactIdle" class="min-h-0 flex-1 overflow-auto px-3.5 py-3">
      <div class="mx-auto w-full max-w-xl">
        <!-- 未選機台：空狀態 -->
        <p v-if="machineId === null" class="pt-6 text-center text-sm leading-relaxed text-ink-2">
          選取機台後按「診斷」，開始 AI 診斷。
        </p>

        <!-- 閒置（只剩 ≥ 1366px 推擠式側欄走這裡；sheet 形態改走上方單列）：一列「機台名 · 狀態徽章（含停滯）」＋主鈕「診斷」，
           不重複卡片的 2×2 遙測（critique 第二輪 P1）；另加一行用途說明（側欄空間充足、卡片就在旁邊）。 -->
        <div v-else-if="state.status === 'idle'">
          <div class="flex min-w-0 items-center gap-2">
            <h3 class="min-w-0 truncate text-md font-semibold text-ink">{{ machineLabel }}</h3>
            <!-- 狀態徽章：與卡片同款（文字＋底色，嚴重加 border-crit）；狀態不只靠顏色 -->
            <StateBadge v-if="summary" class="shrink-0" :state="summary.state" sr-prefix />
            <span v-else class="shrink-0 text-xs text-ink-3">尚未收到遙測</span>
            <StalePill v-if="summaryStale" />
            <button
              type="button"
              :class="PRIMARY_BTN_INLINE"
              :disabled="!canDiagnose"
              :title="connectionBlockedReason ?? undefined"
              @click="emit('diagnose')"
            >
              <Stethoscope class="h-4 w-4" aria-hidden="true" />
              診斷
            </button>
          </div>
          <p class="mt-3 text-xs leading-relaxed text-ink-3">
            AI 會讀取這台機台的近期資料，判讀可能原因並列出建議動作；鍵盤可按 d。
          </p>
        </div>

        <!-- 進行中：進度（含中止）＋目前步驟與 job meta 一行 → 逐格填入的結果骨架 → 原始串流（收合）→ 完整處理步驟 -->
        <div v-else-if="state.status === 'active'" class="space-y-4">
          <div class="space-y-2">
            <div class="flex items-center gap-2">
              <span class="text-sm text-ink-2">診斷進行中</span>
              <span class="font-mono text-md font-medium tabular-nums text-ink">{{ progressText }}</span>
              <!-- 中止：診斷卡住或不想等時的脫身出口（→ 閒置，可立即重新診斷）。
                 放在進度列旁，骨架填滿後不必捲動也找得到。 -->
              <button type="button" class="ml-auto" :class="SECONDARY_BTN" @click="emit('cancel')">
                <Ban class="h-4 w-4" aria-hidden="true" />
                中止診斷
              </button>
            </div>
            <ProgressBar status="active" :value="state.progress" />
            <!-- 步驟列：目前步驟 · 佇列 · 嘗試（text-xs ink-3）。放在進度條正下方，骨架填滿後不被擠出畫面
               （critique 第二輪 Minor）；目前步驟已由下方步驟清單的 aria-current 朗讀，這裡只給視覺 -->
            <div class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-ink-3">
              <span v-if="currentStep" class="font-medium text-ink-2" aria-hidden="true">{{ currentStep.label }}</span>
              <!-- job meta（queue 自契約常數；attempt 取自串流事件） -->
              <dl class="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                <div v-for="meta in jobMeta" :key="meta.label" class="flex items-baseline gap-1">
                  <dt>{{ meta.label }}</dt>
                  <dd class="font-mono tabular-nums text-ink-2">{{ meta.value }}</dd>
                </div>
              </dl>
            </div>
          </div>

          <!-- 結果骨架：與完成態同順序的四個區段，隨 token 逐格填入 -->
          <ResultSkeleton v-if="partial" :partial="partial" />

          <!-- 原始串流：逐字文字仍可展開查看（FR-019），預設收合 -->
          <StreamDisclosure v-model:expanded="showStream" label="原始串流" :text="state.streamText" :streaming="true" />

          <!-- US7 處理步驟清單（衍生自進度里程碑 0/20/40/60/80/100）；目前步驟另摘要在進度列下 -->
          <ol class="space-y-1.5" aria-label="診斷處理步驟">
            <li
              v-for="step in steps"
              :key="step.milestone"
              class="flex items-center gap-2.5 text-sm"
              :class="STEP_STYLE[step.status].text"
              :aria-current="step.status === 'active' ? 'step' : undefined"
            >
              <span
                class="h-0.5 w-3 shrink-0"
                :class="STEP_STYLE[step.status].tick"
                aria-hidden="true"
              />
              <span class="flex-1">
                {{ step.label }}<span class="sr-only">（{{ STEP_STYLE[step.status].sr }}）</span>
              </span>
              <span class="font-mono text-xs tabular-nums text-ink-3">{{ step.milestone }}%</span>
            </li>
          </ol>
        </div>

        <!-- 已完成：嚴重度色條 + 完成 meta（快取時大字耗時對比）+ 結構化結果 + 收合的原始串流。
           不畫滿版完成進度條（FR-022）；快取標記與耗時在 meta 列（FR-009／FR-023，快取屬後端 003，前端僅呈現）。 -->
        <div v-else-if="state.status === 'completed'" class="space-y-4">
          <DiagnosisResultView :result="state.result" :meta="resultMeta">
            <!-- 再次診斷（critique 第一輪 B）：放在視線所在的 meta 列下方，評估者不必回工具列就能走到快取對比。
               與閒置「診斷」同一條 emit('diagnose') → trigger.diagnose 路徑（去重、斷線停用與停用原因同一份）。
               次要鈕：主角是結果本身，不與失敗態的主要「重試」搶層級。文字刻意不是單獨的「診斷」，
               README 截圖劇本以精確文字「診斷」找面板主鈕，不會誤配到這顆。 -->
            <template #actions>
              <button
                type="button"
                :class="SECONDARY_BTN"
                :disabled="!canDiagnose"
                :title="connectionBlockedReason ?? undefined"
                @click="emit('diagnose')"
              >
                <Stethoscope class="h-4 w-4" aria-hidden="true" />
                再次診斷
              </button>
            </template>
          </DiagnosisResultView>
          <!-- 以 job/status／GET 收尾（或執行期間重連過）時串流可能缺段，標「原始串流（不完整）」（FR-038） -->
          <StreamDisclosure
            v-if="state.streamText"
            v-model:expanded="showStream"
            :label="state.streamIncomplete ? STREAM_LABEL_INCOMPLETE : '原始串流'"
            :text="state.streamText"
            :streaming="false"
          />
        </div>

        <!-- 失敗：可讀分類錯誤 + 重試（FR-007／FR-024）；中斷前推理以原始串流預設展開保留，不顯示骨架 -->
        <!-- 「結果未送達」（AR-6）時後端其實已完成、串流是完整的，標題不加「（中斷前）」 -->
        <div v-else-if="state.status === 'failed'" class="space-y-4">
          <ProgressBar status="failed" />
          <!-- 不另掛 role="alert"：失敗已由上方 live region 公告，避免同一則錯誤被念兩次 -->
          <p class="rounded-control border border-crit bg-crit-bg px-3 py-2.5 text-sm leading-relaxed text-crit-fg">
            {{ state.error }}
          </p>
          <button
            type="button"
            :class="PRIMARY_BTN"
            :disabled="!canDiagnose"
            :title="connectionBlockedReason ?? undefined"
            @click="emit('retry')"
          >
            <RotateCcw class="h-4 w-4" aria-hidden="true" />
            重試
          </button>
          <StreamDisclosure
            v-if="state.streamText"
            v-model:expanded="showStream"
            :label="isUndeliveredFailure(state) ? '原始串流' : '原始串流（中斷前）'"
            :text="state.streamText"
            :streaming="false"
          />
        </div>
      </div>
    </div>
  </div>
</template>
