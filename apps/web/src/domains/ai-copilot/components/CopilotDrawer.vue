<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Stethoscope, X, ChevronDown, RotateCcw } from "lucide-vue-next";
import { DIAGNOSIS_QUEUE } from "@flow-gatekeeper/contracts";
import type { MachineLive } from "../../monitoring/stores/monitoring.store.js";
import { progressLabel, type CopilotJobState } from "../lib/copilot-reducer.js";
import { jobSteps, type StepStatus } from "../lib/job-steps.js";
import ProgressBar from "../../../shared/components/ProgressBar.vue";
import StreamingPanel from "./StreamingPanel.vue";
import DiagnosisResultView from "./DiagnosisResultView.vue";

/**
 * Copilot 主面板（design-spec §7.7、FR-002/FR-006/FR-014）。依 `selectedMachineId` 呈現
 * 對應那一份狀態機：idle（機台摘要＋Run diagnosis）／active（進度＋串流）／completed
 * （結構化結果，串流文字保留但預設收合，Clarifications Q2）。failed／Cached 於後續 phase 補。
 */
const props = defineProps<{
  state: CopilotJobState;
  machineId: string | null;
  machineLabel: string;
  summary: MachineLive | null;
  canDiagnose: boolean;
  hasClient: boolean;
}>();

const emit = defineEmits<{
  (e: "diagnose"): void;
  (e: "retry"): void;
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

/**
 * US7 job meta——**全靜態、忠實對映 003 設定**（不呈現動態 attempt 計數：契約
 * `JobStatus`／`CopilotJobState` 不帶 attempt/queue/concurrency，見 research R11）。
 * queue 自契約 import 常數值（消費、非改契約）。
 */
const JOB_META: readonly { label: string; value: string }[] = [
  { label: "Queue", value: DIAGNOSIS_QUEUE },
  { label: "Concurrency", value: "2" },
  { label: "Attempts", value: "3" },
];

const STEP_STYLE: Record<StepStatus, { dot: string; text: string }> = {
  done: { dot: "bg-ok", text: "text-fg-muted" },
  active: { dot: "bg-accent animate-critical-pulse", text: "text-fg" },
  todo: { dot: "bg-strong", text: "text-fg-subtle" },
};

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
  <!-- Header：machine label / job short / close -->
  <div class="flex shrink-0 items-center gap-2 border-b border-subtle px-4 py-3">
    <Stethoscope class="h-4 w-4 shrink-0 text-accent" aria-hidden="true" />
    <div class="min-w-0 flex-1">
      <div class="truncate text-sm font-semibold text-fg">AI Copilot</div>
      <div class="truncate font-mono text-xs text-fg-subtle">
        {{ machineId ?? "—" }}<span v-if="jobShort"> · {{ jobShort }}</span>
      </div>
    </div>
    <span
      class="shrink-0 rounded-pill px-2 py-0.5 text-[11px] font-medium"
      :class="STATUS_CHIP[state.status].cls"
    >{{ STATUS_CHIP[state.status].label }}</span>
    <button
      type="button"
      class="ml-1 shrink-0 rounded-control p-1 text-fg-subtle hover:bg-surface-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-accent md:hidden"
      aria-label="關閉 Copilot"
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
        class="flex w-full items-center justify-center gap-2 rounded-control bg-accent px-3 py-2 text-sm font-medium text-base hover:bg-accent-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50"
        :disabled="!canDiagnose"
        :title="hasClient ? undefined : '尚未連線，請待連線後再診斷'"
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

      <!-- US7 job meta（全靜態，忠實對映 003；不呈現動態 attempt 計數） -->
      <dl class="grid grid-cols-3 gap-2">
        <div
          v-for="meta in JOB_META"
          :key="meta.label"
          class="rounded-control border border-subtle bg-surface px-2 py-1.5"
        >
          <dt class="text-[10px] uppercase tracking-wide text-fg-subtle">{{ meta.label }}</dt>
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
          <span class="font-mono text-[10px] text-fg-subtle">{{ step.milestone }}%</span>
        </li>
      </ol>

      <StreamingPanel :text="state.streamText" :streaming="true" />
    </div>

    <!-- completed：結構化結果 + 收合的串流文字 -->
    <div v-else-if="state.status === 'completed'" class="space-y-4">
      <div class="flex items-center gap-2">
        <ProgressBar status="completed" />
        <!-- Cached badge：快取命中時顯示（FR-009；快取／去重屬後端 003，前端僅呈現） -->
        <span
          v-if="state.cached"
          class="shrink-0 rounded-pill border border-accent-bg-strong bg-accent-bg px-2 py-0.5 text-[11px] font-medium text-accent"
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
      <div
        class="rounded-control border border-crit-border bg-crit-bg px-3 py-2.5 text-sm text-crit-fg"
        role="alert"
      >
        {{ state.error }}
      </div>
      <button
        type="button"
        class="flex w-full items-center justify-center gap-2 rounded-control bg-accent px-3 py-2 text-sm font-medium text-base hover:bg-accent-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50"
        :disabled="!hasClient"
        :title="hasClient ? undefined : '尚未連線，請待連線後再重試'"
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
</template>
