<script setup lang="ts">
import { computed } from "vue";
import { Stethoscope } from "lucide-vue-next";
import type { MachineState } from "@flow-gatekeeper/contracts";
import type { MachineLive } from "../stores/monitoring.store.js";
import { machineLabel } from "../lib/machine-labels.js";
import {
  metricUnit,
  offendingMetrics,
  relativeTimeLabel,
  type MetricKey,
} from "../lib/telemetry-format.js";
import StatusLight from "../../../shared/components/StatusLight.vue";

const props = defineProps<{
  machine: MachineLive | null; // null = placeholder（冷啟動／首批未到）
  machineId: string;
  selected: boolean;
  stale: boolean; // >10s 未更新：降透明＋Stale badge，數值不清空（FR-017）
  now: number; // 每秒 tick，驅動相對時間「Ns ago」更新（FR-004）
}>();

const emit = defineEmits<{
  (e: "select", machineId: string): void;
  (e: "diagnose", machineId: string): void;
}>();

const label = computed(() => machineLabel(props.machineId));

/**
 * 狀態文字徽章（FR-001）——由契約 `machine.state` 決定，與 `StatusLight` 同源。
 * 固定字級/內距、uppercase，避免狀態切換造成盒模型變化（FR-005）。
 */
const STATE_BADGE: Record<MachineState, { label: string; cls: string }> = {
  healthy: { label: "HEALTHY", cls: "text-ok-fg bg-ok-bg" },
  warning: { label: "WARNING", cls: "text-warn-fg bg-warn-bg" },
  critical: { label: "CRITICAL", cls: "text-crit-fg bg-crit-bg" },
};

/**
 * 狀態 → 卡片外觀 token（design-spec §7.3）。
 * warning：邊框**維持 subtle**、僅加 warn 系 subtle inset（`ring-inset`，非盒模型、不位移，FR-002/005）；
 * critical：crit-bg tint + pulse。placeholder 用中性面。
 */
const stateClass = computed(() => {
  if (!props.machine) return "border-subtle bg-surface";
  switch (props.machine.state) {
    case "healthy":
      return "border-subtle bg-surface";
    case "warning":
      return "border-subtle bg-surface ring-1 ring-inset ring-warn-border";
    case "critical":
      return "border-crit-border bg-crit-bg animate-critical-pulse";
  }
  return "border-subtle bg-surface";
});

const PLACEHOLDER = "—";

/** 越界數值染色（FR-002）：warn→amber（`text-warn`）、crit→`text-crit`、否則預設 `text-fg`。 */
interface MetricView {
  key: MetricKey;
  label: string;
  text: string;
  cls: string;
}

const metrics = computed<MetricView[]>(() => {
  const m = props.machine;
  const off = m ? offendingMetrics(m.telemetry) : null;
  function view(key: MetricKey, headline: string, text: string): MetricView {
    const offense = off ? off[key] : null;
    const cls = offense === "crit" ? "text-crit" : offense === "warn" ? "text-warn" : "text-fg";
    return { key, label: headline, text, cls };
  }
  if (!m) {
    return [
      view("temperature", "Temp", PLACEHOLDER),
      view("vibration", "Vibration", PLACEHOLDER),
      view("throughput", "Throughput", PLACEHOLDER),
      view("errorRate", "Errors", PLACEHOLDER),
    ];
  }
  return [
    view("temperature", "Temp", `${m.telemetry.temperature.toFixed(1)}${metricUnit("temperature")}`),
    view("vibration", "Vibration", `${m.telemetry.vibration.toFixed(2)} ${metricUnit("vibration")}`),
    view("throughput", "Throughput", `${Math.round(m.telemetry.throughput)} ${metricUnit("throughput")}`),
    view("errorRate", "Errors", `${(m.telemetry.errorRate * 100).toFixed(1)}${metricUnit("errorRate")}`),
  ];
});

/** 相對時間「Ns ago」＋絕對時間 tooltip（FR-004）。 */
const relativeTime = computed(() =>
  props.machine ? relativeTimeLabel(props.machine.lastUpdated, props.now) : PLACEHOLDER,
);
const absoluteTime = computed(() =>
  props.machine ? new Date(props.machine.lastUpdated).toLocaleString() : undefined,
);
</script>

<template>
  <div class="group relative min-w-0">
    <button
      type="button"
      class="flex min-h-[148px] w-full min-w-0 flex-col gap-3 rounded-card border p-3 text-left shadow-card transition duration-150 hover:-translate-y-px hover:border-strong hover:bg-surface-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      :class="[
        stateClass,
        selected ? 'border-accent bg-accent-wash ring-1 ring-inset ring-accent' : '',
        stale ? 'opacity-[0.55]' : '',
      ]"
      :aria-pressed="selected"
      @click="emit('select', machineId)"
    >
      <!-- Header：顯示名稱 + machine id（mono）+ 狀態文字徽章 + 狀態燈 -->
      <div class="flex items-start justify-between gap-2">
        <div class="min-w-0">
          <div class="flex items-center gap-1.5">
            <span class="truncate text-sm font-medium text-fg">{{ label }}</span>
            <span
              v-if="stale"
              class="shrink-0 rounded-pill border border-warn-border bg-warn-bg px-1.5 py-0.5 text-[10px] font-medium uppercase leading-none text-warn-fg"
            >Stale</span>
          </div>
          <div class="truncate font-mono text-xs text-fg-muted">{{ machineId }}</div>
        </div>
        <div class="flex shrink-0 items-center gap-1.5">
          <span
            v-if="machine"
            class="rounded-pill px-1.5 py-0.5 text-[10px] font-semibold uppercase leading-none tracking-wide"
            :class="STATE_BADGE[machine.state].cls"
          >{{ STATE_BADGE[machine.state].label }}</span>
          <StatusLight
            v-if="machine"
            :state="machine.state"
            :pulse="machine.state === 'critical'"
          />
          <span v-else class="inline-flex h-3 w-3 items-center justify-center">
            <span class="block h-[9px] w-[9px] rounded-pill bg-strong" />
          </span>
        </div>
      </div>

      <!-- Telemetry：固定 2×2 grid，數值 mono，越界值染 amber/crit；避免寬度跳動造成 layout shift -->
      <div class="grid grid-cols-2 gap-x-3 gap-y-2">
        <div v-for="metric in metrics" :key="metric.key">
          <div class="text-xs text-fg-subtle">{{ metric.label }}</div>
          <div class="font-mono text-number leading-none" :class="metric.cls">{{ metric.text }}</div>
        </div>
      </div>

      <div class="mt-auto font-mono text-xs text-fg-subtle" :title="absoluteTime">
        updated {{ relativeTime }}
      </div>
    </button>

    <!-- Diagnose icon（作用於該台；hover/focus 顯示，鍵盤可達）。store 內部去重／連線把關。 -->
    <button
      type="button"
      class="absolute bottom-2 right-2 rounded-control border border-subtle bg-surface p-1.5 text-fg-subtle opacity-0 transition hover:bg-surface-hover hover:text-accent focus:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent group-hover:opacity-100"
      :aria-label="`Diagnose ${label}`"
      @click="emit('diagnose', machineId)"
    >
      <Stethoscope class="h-3.5 w-3.5" aria-hidden="true" />
    </button>
  </div>
</template>
