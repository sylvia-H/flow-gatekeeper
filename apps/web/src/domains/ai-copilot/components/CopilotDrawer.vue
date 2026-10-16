<script setup lang="ts">
import { computed, ref, useId, watch } from "vue";
import { Stethoscope, X, ChevronDown, RotateCcw, Ban } from "lucide-vue-next";
import { DIAGNOSIS_QUEUE } from "@flow-gatekeeper/contracts";
import type { MachineLive } from "../../monitoring/stores/monitoring.store.js";
import { progressLabel, type CopilotJobState } from "../lib/copilot-reducer.js";
import { jobSteps, type Milestone, type StepStatus } from "../lib/job-steps.js";
import { STATE_STYLE } from "../../../shared/lib/state-style.js";
import ProgressBar from "../../../shared/components/ProgressBar.vue";
import StreamingPanel from "./StreamingPanel.vue";
import DiagnosisResultView from "./DiagnosisResultView.vue";
import { useModalSheet } from "../composables/useModalSheet.js";

/**
 * AI 診斷面板內容（FR-002/FR-006/FR-014；013 視覺層與繁中文案，research R13）。依
 * `selectedMachineId` 呈現對應那一份狀態機：閒置（機台摘要＋診斷）／進行中（進度＋串流）／
 * 已完成（結構化結果＋快取徽章，原始串流保留但預設收合，Clarifications Q2）／失敗（可讀錯誤＋重試）。
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
}>();

const emit = defineEmits<{
  (e: "diagnose"): void;
  (e: "retry"): void;
  (e: "cancel"): void;
  /** 面板上的收合鈕（手動收合）。 */
  (e: "close"): void;
  /** bottom-sheet（< 1024px）按 Escape（只影響當次，不算手動收合）。 */
  (e: "dismiss"): void;
}>();

/** 任務短碼（active/completed/failed 才有 jobId）。 */
const jobShort = computed(() =>
  "jobId" in props.state && props.state.jobId ? props.state.jobId.slice(0, 8) : null,
);

/** 狀態 chip（狀態不只靠顏色：附文字 label）。chip 自帶底色，放在 rim 標頭上對比不受影響。 */
const STATUS_CHIP: Record<CopilotJobState["status"], { cls: string; label: string }> = {
  idle: { cls: "bg-surface-strong text-ink-2", label: "閒置" },
  active: { cls: "bg-accent-wash text-accent", label: "進行中" },
  completed: { cls: "bg-ok-bg text-ok-fg", label: "已完成" },
  failed: { cls: "bg-crit-bg text-crit-fg", label: "失敗" },
};

const progressText = computed(() =>
  props.state.status === "active" ? progressLabel(props.state.progress) : "",
);

/** US7 active 步驟清單（衍生自既有 progress，不新增事件/契約；research R11）。 */
const steps = computed(() =>
  props.state.status === "active" ? jobSteps(props.state.progress) : [],
);

/**
 * 步驟標籤的繁中對照（FR-038：`job-steps.ts` 的標籤夾有 context／token 等英文字）。
 * 暫放元件層、以里程碑為 key；Phase 6 整理步驟清單時再收斂回 `job-steps.ts`。
 */
const STEP_LABEL: Record<Milestone, string> = {
  0: "任務啟動",
  20: "彙整診斷資料",
  40: "取得去重鎖",
  60: "收到首段串流",
  80: "解析結果成功",
  100: "寫入並完成",
};

/** 003 設定的最大嘗試次數（BullMQ attempts）；僅用於呈現。 */
const MAX_ATTEMPTS = 3;

/**
 * job meta——queue 自契約 import 常數值；attempt 取自串流事件，讓重試換輪時使用者看得出串流
 * 文字為何從頭開始。不顯示 concurrency：它現在是 worker 端可設定的 `WORKER_CONCURRENCY`，前端拿不到
 * 真實值，寫死數字只會與實際不符。
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
const PRIMARY_BTN =
  "flex w-full items-center justify-center gap-2 rounded-control border border-accent-strong bg-accent px-3 py-2 text-sm font-semibold text-surface-strong hover:bg-accent-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-not-allowed disabled:border-edge disabled:bg-rim disabled:text-ink-3";
/** 次要動作（中止診斷）。 */
const SECONDARY_BTN =
  "flex w-full items-center justify-center gap-2 rounded-control border border-edge bg-surface/72 px-3 py-2 text-sm font-medium text-ink shadow-glass hover:bg-rim/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-not-allowed disabled:bg-rim disabled:text-ink-3 disabled:shadow-none";
/** 原始串流的展開鈕。 */
const DISCLOSURE_BTN =
  "flex w-full items-center justify-between rounded-control text-sm font-semibold text-ink-2 hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-focus";

/**
 * 螢幕閱讀器公告：串流區不逐 token 朗讀（太吵），只在同一個任務「active → 完成／失敗」時
 * 以 polite live region 公告一句摘要。切換機台造成的狀態變化不算轉移，不公告，
 * 否則點到一台早已完成的機台也會被念「診斷完成」。
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
    if (prev.status !== "active") return;
    if (next.status === "completed") {
      announcement.value = `${next.machineId} 診斷完成${next.cached ? "（快取）" : ""}：${next.result.summary}`;
    } else if (next.status === "failed") {
      announcement.value = `${next.machineId} 診斷失敗：${next.error}`;
    }
  },
);

/** 行動版 bottom sheet 的 dialog 語意與焦點陷阱；桌機常駐側欄不套用。 */
const root = ref<HTMLElement | null>(null);
const titleId = useId();
const { isSheet, onKeydown } = useModalSheet(root, () => emit("dismiss"));

/** completed/failed 後原始串流預設收合（Q2）；每次任務切換重置為收合。 */
const showStream = ref(false);
watch(
  () => ("jobId" in props.state ? `${props.state.status}:${props.state.jobId}` : props.state.status),
  () => {
    showStream.value = false;
  },
);
</script>

<template>
  <!-- 根節點：寬度 < 1024px 為 bottom sheet（dialog 語意 + 焦點陷阱）；≥ 1024px 為常駐側欄，不掛 dialog 屬性。
       tabindex=-1 讓 sheet 開啟時可程式聚焦，但不進入 Tab 順序。 -->
  <div
    ref="root"
    class="flex min-h-0 flex-1 flex-col focus:outline-none"
    tabindex="-1"
    :role="isSheet ? 'dialog' : undefined"
    :aria-modal="isSheet ? 'true' : undefined"
    :aria-labelledby="isSheet ? titleId : undefined"
    @keydown="onKeydown"
  >
    <!-- 完成／失敗摘要公告（視覺隱藏；常駐掛載，live region 才能在內容變化時被念出） -->
    <div class="sr-only" aria-live="polite" aria-atomic="true">{{ announcement }}</div>

    <!-- 標頭（rim 桌邊色）：標題、機台 id · 任務短碼、狀態 chip、關閉 -->
    <header class="flex shrink-0 items-center gap-2.5 border-b border-edge bg-rim px-3.5 py-3">
      <Stethoscope class="h-4 w-4 shrink-0 text-accent-strong" aria-hidden="true" />
      <div class="min-w-0 flex-1">
        <h2 :id="titleId" class="truncate text-md font-semibold text-ink">AI 診斷</h2>
        <div class="truncate font-mono text-xs text-ink-3">
          {{ machineId ?? "—" }}<span v-if="jobShort"> · {{ jobShort }}</span>
        </div>
      </div>
      <span
        class="shrink-0 rounded-pill px-2 py-0.5 text-xs font-semibold leading-4"
        :class="STATUS_CHIP[state.status].cls"
      >{{ STATUS_CHIP[state.status].label }}</span>
      <button
        type="button"
        class="shrink-0 rounded-control p-1.5 text-ink-2 hover:bg-surface/72 hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        aria-label="關閉／收合 AI 診斷面板"
        title="關閉／收合 AI 診斷面板"
        @click="emit('close')"
      >
        <X class="h-4 w-4" aria-hidden="true" />
      </button>
    </header>

    <!-- 內容 -->
    <div class="min-h-0 flex-1 overflow-auto px-3.5 py-3.5">
      <!-- 未選機台：空狀態 -->
      <p v-if="machineId === null" class="pt-6 text-center text-sm leading-relaxed text-ink-2">
        選取機台後按「診斷」，開始 AI 診斷。
      </p>

      <!-- 閒置：機台摘要 + 診斷 -->
      <div v-else-if="state.status === 'idle'" class="space-y-4">
        <section>
          <h3 class="mb-2 text-md font-semibold text-ink">{{ machineLabel }}</h3>
          <dl
            v-if="summary"
            class="grid grid-cols-2 gap-x-4 gap-y-2.5 border-y border-edge py-3 text-sm"
          >
            <div>
              <dt class="text-xs text-ink-3">狀態</dt>
              <dd class="mt-0.5 flex items-center gap-1.5 text-ink">
                <span
                  class="h-2 w-2 shrink-0 rounded-pill"
                  :class="STATE_STYLE[summary.state].dot"
                  aria-hidden="true"
                />
                {{ STATE_STYLE[summary.state].label }}
              </dd>
            </div>
            <div>
              <dt class="text-xs text-ink-3">溫度</dt>
              <dd class="mt-0.5 font-mono tabular-nums text-ink">
                {{ summary.telemetry.temperature.toFixed(1) }}<span class="ml-0.5 text-xs text-ink-3">°C</span>
              </dd>
            </div>
            <div>
              <dt class="text-xs text-ink-3">振動</dt>
              <dd class="mt-0.5 font-mono tabular-nums text-ink">
                {{ summary.telemetry.vibration.toFixed(2) }}<span class="ml-0.5 text-xs text-ink-3">mm/s</span>
              </dd>
            </div>
            <div>
              <dt class="text-xs text-ink-3">錯誤率</dt>
              <dd class="mt-0.5 font-mono tabular-nums text-ink">
                {{ (summary.telemetry.errorRate * 100).toFixed(1) }}<span class="ml-0.5 text-xs text-ink-3">%</span>
              </dd>
            </div>
          </dl>
          <p v-else class="border-y border-edge py-3 text-sm text-ink-3">尚未收到此機台遙測。</p>
        </section>
        <button
          type="button"
          :class="PRIMARY_BTN"
          :disabled="!canDiagnose"
          :title="connectionBlockedReason ?? undefined"
          @click="emit('diagnose')"
        >
          <Stethoscope class="h-4 w-4" aria-hidden="true" />
          診斷
        </button>
      </div>

      <!-- 進行中：進度 + 串流 -->
      <div v-else-if="state.status === 'active'" class="space-y-4">
        <div class="space-y-2">
          <div class="flex items-baseline justify-between gap-2">
            <span class="text-sm text-ink-2">診斷進行中</span>
            <span class="font-mono text-md font-medium tabular-nums text-ink">{{ progressText }}</span>
          </div>
          <ProgressBar status="active" :value="state.progress" />
        </div>

        <!-- job meta（queue 自契約常數；attempt 取自串流事件） -->
        <dl class="grid grid-cols-2 divide-x divide-edge border-y border-edge">
          <div v-for="meta in jobMeta" :key="meta.label" class="min-w-0 px-2.5 py-2 first:pl-0">
            <dt class="text-xs text-ink-3">{{ meta.label }}</dt>
            <dd class="truncate font-mono text-xs tabular-nums text-ink">{{ meta.value }}</dd>
          </div>
        </dl>

        <!-- US7 處理步驟清單（衍生自進度里程碑 0/20/40/60/80/100） -->
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
              {{ STEP_LABEL[step.milestone] }}<span class="sr-only">（{{ STEP_STYLE[step.status].sr }}）</span>
            </span>
            <span class="font-mono text-xs tabular-nums text-ink-3">{{ step.milestone }}%</span>
          </li>
        </ol>

        <section class="space-y-2 border-t border-edge pt-3">
          <h3 class="text-sm font-semibold text-ink-2">原始串流</h3>
          <StreamingPanel :text="state.streamText" :streaming="true" />
        </section>

        <!-- 中止：診斷卡住或不想等時的脫身出口（→ 閒置，可立即重新診斷） -->
        <button type="button" :class="SECONDARY_BTN" @click="emit('cancel')">
          <Ban class="h-4 w-4" aria-hidden="true" />
          中止診斷
        </button>
      </div>

      <!-- 已完成：結構化結果 + 收合的原始串流 -->
      <div v-else-if="state.status === 'completed'" class="space-y-4">
        <div class="flex items-center gap-2.5">
          <ProgressBar status="completed" />
          <!-- 快取徽章：快取命中時顯示（FR-009；快取／去重屬後端 003，前端僅呈現）。
               用中性色：深青只留給主要動作、選取與液位線。 -->
          <span
            v-if="state.cached"
            class="shrink-0 rounded-pill bg-rim px-2 py-0.5 text-xs font-semibold leading-4 text-ink-2"
          ><span class="sr-only">結果來自</span>快取</span>
        </div>
        <DiagnosisResultView :result="state.result" />
        <div v-if="state.streamText" class="border-t border-edge pt-3">
          <button
            type="button"
            :class="DISCLOSURE_BTN"
            :aria-expanded="showStream"
            @click="showStream = !showStream"
          >
            <span>原始串流</span>
            <ChevronDown
              class="h-4 w-4 transition-transform"
              :class="showStream ? 'rotate-180' : ''"
              aria-hidden="true"
            />
          </button>
          <StreamingPanel v-if="showStream" class="mt-2" :text="state.streamText" :streaming="false" />
        </div>
      </div>

      <!-- 失敗：可讀錯誤 + 重試（FR-007）；串流殘文可展開回看 -->
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
        <div v-if="state.streamText" class="border-t border-edge pt-3">
          <button
            type="button"
            :class="DISCLOSURE_BTN"
            :aria-expanded="showStream"
            @click="showStream = !showStream"
          >
            <span>原始串流（中斷前）</span>
            <ChevronDown
              class="h-4 w-4 transition-transform"
              :class="showStream ? 'rotate-180' : ''"
              aria-hidden="true"
            />
          </button>
          <StreamingPanel v-if="showStream" class="mt-2" :text="state.streamText" :streaming="false" />
        </div>
      </div>
    </div>
  </div>
</template>
