<script setup lang="ts">
import { computed, ref, useId, watch } from "vue";
import { Stethoscope, X, ChevronDown, RotateCcw, Ban } from "lucide-vue-next";
import { DIAGNOSIS_QUEUE } from "@flow-gatekeeper/contracts";
import type { MachineLive } from "../../monitoring/stores/monitoring.store.js";
import { progressLabel, type CopilotJobState } from "../lib/copilot-reducer.js";
import { jobSteps, type StepStatus } from "../lib/job-steps.js";
import ProgressBar from "../../../shared/components/ProgressBar.vue";
import StreamingPanel from "./StreamingPanel.vue";
import DiagnosisResultView from "./DiagnosisResultView.vue";
import { useModalSheet } from "../composables/useModalSheet.js";

/**
 * Copilot 主面板（design-spec §7.7、FR-002/FR-006/FR-014）。依 `selectedMachineId` 呈現
 * 對應那一份狀態機：idle（機台摘要＋Run diagnosis）／active（進度＋串流）／completed
 * （結構化結果＋Cached badge，串流文字保留但預設收合，Clarifications Q2）／failed（可讀錯誤＋Retry）。
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
  (e: "close"): void;
}>();

/** 任務短碼（active/completed/failed 才有 jobId）。 */
const jobShort = computed(() =>
  "jobId" in props.state && props.state.jobId ? props.state.jobId.slice(0, 8) : null,
);

/** 狀態 chip（狀態不只靠顏色：附文字 label）。 */
const STATUS_CHIP: Record<CopilotJobState["status"], { cls: string; label: string }> = {
  idle: { cls: "text-fg-subtle bg-elevated", label: "Idle" },
  active: { cls: "text-accent bg-accent-bg", label: "Active" },
  completed: { cls: "text-ok-fg bg-ok-bg", label: "Completed" },
  failed: { cls: "text-crit-fg bg-crit-bg", label: "Failed" },
};

const progressText = computed(() =>
  props.state.status === "active" ? progressLabel(props.state.progress) : "",
);

/** US7 active 步驟清單（衍生自既有 progress，不新增事件/契約；research R11）。 */
const steps = computed(() =>
  props.state.status === "active" ? jobSteps(props.state.progress) : [],
);

/** 003 設定的最大嘗試次數（BullMQ attempts）；僅用於呈現。 */
const MAX_ATTEMPTS = 3;

/**
 * job meta——queue 自契約 import 常數值；attempt 取自串流事件，讓重試換輪時使用者看得出串流
 * 文字為何從頭開始。不顯示 concurrency：它現在是 worker 端可設定的 `WORKER_CONCURRENCY`，前端拿不到
 * 真實值，寫死數字只會與實際不符。
 */
const jobMeta = computed<readonly { label: string; value: string }[]>(() => [
  { label: "Queue", value: DIAGNOSIS_QUEUE },
  {
    label: "Attempt",
    value: props.state.status === "active" ? `${props.state.attempt} / ${MAX_ATTEMPTS}` : `${MAX_ATTEMPTS}`,
  },
]);

const STEP_STYLE: Record<StepStatus, { dot: string; text: string }> = {
  done: { dot: "bg-ok", text: "text-fg-muted" },
  active: { dot: "bg-accent animate-critical-pulse", text: "text-fg" },
  todo: { dot: "bg-strong", text: "text-fg-subtle" },
};

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
const { isSheet, onKeydown } = useModalSheet(root, () => emit("close"));

/** completed/failed 後串流文字預設收合（Q2）；每次任務切換重置為收合。 */
const showStream = ref(false);
watch(
  () => ("jobId" in props.state ? `${props.state.status}:${props.state.jobId}` : props.state.status),
  () => {
    showStream.value = false;
  },
);
</script>

<template>
  <!-- 根節點：手機為 bottom sheet（dialog 語意 + 焦點陷阱）；桌機為常駐側欄，不掛 dialog 屬性。
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

    <!-- Header：machine label / job short / close -->
    <div class="flex shrink-0 items-center gap-2 border-b border-subtle px-4 py-3">
      <Stethoscope class="h-4 w-4 shrink-0 text-accent" aria-hidden="true" />
      <div class="min-w-0 flex-1">
        <div :id="titleId" class="truncate text-sm font-semibold text-fg">AI Copilot</div>
        <div class="truncate font-mono text-xs text-fg-subtle">
          {{ machineId ?? "—" }}<span v-if="jobShort"> · {{ jobShort }}</span>
        </div>
      </div>
      <span
        class="shrink-0 rounded-pill px-2 py-0.5 text-pill font-medium"
        :class="STATUS_CHIP[state.status].cls"
      >{{ STATUS_CHIP[state.status].label }}</span>
      <button
        type="button"
        class="ml-1 shrink-0 rounded-control p-1 text-fg-subtle hover:bg-surface-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        aria-label="關閉／收合 Copilot 面板"
        title="關閉／收合 Copilot 面板"
        @click="emit('close')"
      >
        <X class="h-4 w-4" aria-hidden="true" />
      </button>
    </div>

    <!-- Body -->
    <div class="min-h-0 flex-1 overflow-auto px-4 py-4">
      <!-- 未選機台：空狀態 -->
      <div v-if="machineId === null" class="pt-6 text-center text-sm text-fg-subtle">
        選取機台以開始 AI 診斷。
      </div>

      <!-- idle：機台摘要 + Run diagnosis -->
      <div v-else-if="state.status === 'idle'" class="space-y-4">
        <div class="rounded-card border border-subtle bg-surface p-3">
          <div class="mb-2 text-sm font-medium text-fg">{{ machineLabel }}</div>
          <dl v-if="summary" class="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
            <div>
              <dt class="text-fg-subtle">State</dt>
              <dd class="text-fg">{{ summary.state }}</dd>
            </div>
            <div>
              <dt class="text-fg-subtle">Temp</dt>
              <dd class="font-mono text-fg">{{ summary.telemetry.temperature.toFixed(1) }}°</dd>
            </div>
            <div>
              <dt class="text-fg-subtle">Vibration</dt>
              <dd class="font-mono text-fg">{{ summary.telemetry.vibration.toFixed(2) }}</dd>
            </div>
            <div>
              <dt class="text-fg-subtle">Errors</dt>
              <dd class="font-mono text-fg">{{ (summary.telemetry.errorRate * 100).toFixed(1) }}%</dd>
            </div>
          </dl>
          <p v-else class="text-xs text-fg-subtle">尚未收到此機台遙測。</p>
        </div>
        <button
          type="button"
          class="flex w-full items-center justify-center gap-2 rounded-control bg-accent px-3 py-2 text-sm font-medium text-canvas hover:bg-accent-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50"
          :disabled="!canDiagnose"
          :title="connectionBlockedReason ?? undefined"
          @click="emit('diagnose')"
        >
          <Stethoscope class="h-4 w-4" aria-hidden="true" />
          Run diagnosis
        </button>
      </div>

      <!-- active：進度 + 串流 -->
      <div v-else-if="state.status === 'active'" class="space-y-4">
        <div class="space-y-1.5">
          <div class="flex items-center justify-between text-xs text-fg-muted">
            <span>診斷進行中</span>
            <span class="font-mono">{{ progressText }}</span>
          </div>
          <ProgressBar status="active" :value="state.progress" />
        </div>

        <!-- job meta（queue 自契約常數；attempt 取自串流事件） -->
        <dl class="grid grid-cols-2 gap-2">
          <div
            v-for="meta in jobMeta"
            :key="meta.label"
            class="rounded-control border border-subtle bg-surface px-2 py-1.5"
          >
            <dt class="text-2xs uppercase tracking-wide text-fg-subtle">{{ meta.label }}</dt>
            <dd class="truncate font-mono text-xs text-fg">{{ meta.value }}</dd>
          </div>
        </dl>

        <!-- US7 處理步驟清單（衍生自進度里程碑 0/20/40/60/80/100） -->
        <ol class="space-y-1.5" aria-label="診斷處理步驟">
          <li
            v-for="step in steps"
            :key="step.milestone"
            class="flex items-center gap-2 text-xs"
            :class="STEP_STYLE[step.status].text"
          >
            <span
              class="h-1.5 w-1.5 shrink-0 rounded-pill"
              :class="STEP_STYLE[step.status].dot"
              aria-hidden="true"
            />
            <span class="flex-1">{{ step.label }}</span>
            <span class="font-mono text-2xs text-fg-subtle">{{ step.milestone }}%</span>
          </li>
        </ol>

        <StreamingPanel :text="state.streamText" :streaming="true" />

        <!-- 中止／放棄：診斷卡住或不想等時的脫身出口（→ idle，可立即重新診斷） -->
        <button
          type="button"
          class="flex w-full items-center justify-center gap-2 rounded-control border border-subtle bg-surface px-3 py-2 text-sm text-fg-muted hover:bg-surface-hover hover:text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          @click="emit('cancel')"
        >
          <Ban class="h-4 w-4" aria-hidden="true" />
          中止診斷
        </button>
      </div>

      <!-- completed：結構化結果 + 收合的串流文字 -->
      <div v-else-if="state.status === 'completed'" class="space-y-4">
        <div class="flex items-center gap-2">
          <ProgressBar status="completed" />
          <!-- Cached badge：快取命中時顯示（FR-009；快取／去重屬後端 003，前端僅呈現） -->
          <span
            v-if="state.cached"
            class="shrink-0 rounded-pill border border-accent-bg-strong bg-accent-bg px-2 py-0.5 text-pill font-medium text-accent"
            aria-label="結果來自快取"
          >Cached</span>
        </div>
        <DiagnosisResultView :result="state.result" />
        <div v-if="state.streamText" class="border-t border-subtle pt-3">
          <button
            type="button"
            class="flex w-full items-center justify-between text-xs font-medium text-fg-subtle hover:text-fg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            :aria-expanded="showStream"
            @click="showStream = !showStream"
          >
            <span>推理過程</span>
            <ChevronDown
              class="h-4 w-4 transition-transform"
              :class="showStream ? 'rotate-180' : ''"
              aria-hidden="true"
            />
          </button>
          <StreamingPanel v-if="showStream" class="mt-2" :text="state.streamText" :streaming="false" />
        </div>
      </div>

      <!-- failed：可讀錯誤 + Retry（FR-007）；串流殘文可展開回看 -->
      <div v-else-if="state.status === 'failed'" class="space-y-4">
        <ProgressBar status="failed" />
        <!-- 不另掛 role="alert"：失敗已由上方 live region 公告，避免同一則錯誤被念兩次 -->
        <div class="rounded-control border border-crit-border bg-crit-bg px-3 py-2.5 text-sm text-crit-fg">
          {{ state.error }}
        </div>
        <button
          type="button"
          class="flex w-full items-center justify-center gap-2 rounded-control bg-accent px-3 py-2 text-sm font-medium text-canvas hover:bg-accent-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50"
          :disabled="!canDiagnose"
          :title="connectionBlockedReason ?? undefined"
          @click="emit('retry')"
        >
          <RotateCcw class="h-4 w-4" aria-hidden="true" />
          Retry
        </button>
        <div v-if="state.streamText" class="border-t border-subtle pt-3">
          <button
            type="button"
            class="flex w-full items-center justify-between text-xs font-medium text-fg-subtle hover:text-fg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            :aria-expanded="showStream"
            @click="showStream = !showStream"
          >
            <span>中斷前的推理過程</span>
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
