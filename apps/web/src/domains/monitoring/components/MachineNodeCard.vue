<script setup lang="ts">
import { computed } from "vue";
import type { MachineLive } from "../stores/monitoring.store.js";
import { machineLabel } from "../lib/machine-labels.js";
import StatusLight from "../../../shared/components/StatusLight.vue";

const props = defineProps<{
  machine: MachineLive | null; // null = placeholder（冷啟動／首批未到）
  machineId: string;
  selected: boolean;
  stale: boolean; // >10s 未更新：降透明＋Stale badge，數值不清空（FR-017）
}>();

const emit = defineEmits<{
  (e: "select", machineId: string): void;
}>();

const label = computed(() => machineLabel(props.machineId));

/** 狀態 → 卡片外觀 token（design-spec §7.3）；placeholder 用中性面。 */
const stateClass = computed(() => {
  if (!props.machine) return "border-subtle bg-surface";
  switch (props.machine.state) {
    case "healthy":
      return "border-subtle bg-surface";
    case "warning":
      return "border-warn-border bg-surface";
    case "critical":
      return "border-crit-border bg-crit-bg animate-critical-pulse";
  }
  return "border-subtle bg-surface";
});

const PLACEHOLDER = "—";

const temperature = computed(() =>
  props.machine ? `${props.machine.telemetry.temperature.toFixed(1)}°` : PLACEHOLDER,
);
const vibration = computed(() =>
  props.machine ? props.machine.telemetry.vibration.toFixed(2) : PLACEHOLDER,
);
const throughput = computed(() =>
  props.machine ? String(Math.round(props.machine.telemetry.throughput)) : PLACEHOLDER,
);
const errorRate = computed(() =>
  props.machine
    ? `${(props.machine.telemetry.errorRate * 100).toFixed(1)}%`
    : PLACEHOLDER,
);
const lastUpdated = computed(() =>
  props.machine
    ? new Date(props.machine.lastUpdated).toLocaleTimeString()
    : PLACEHOLDER,
);
</script>

<template>
  <button
    type="button"
    class="group relative flex min-h-[148px] w-full min-w-0 flex-col gap-3 rounded-card border p-3 text-left shadow-card transition duration-150 hover:-translate-y-px hover:border-strong hover:bg-surface-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    :class="[
      stateClass,
      selected ? 'border-accent bg-accent-wash ring-1 ring-inset ring-accent' : '',
      stale ? 'opacity-[0.55]' : '',
    ]"
    :aria-pressed="selected"
    @click="emit('select', machineId)"
  >
    <!-- Header：顯示名稱 + machine id（mono）+ 狀態燈 -->
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
      <StatusLight
        v-if="machine"
        :state="machine.state"
        :pulse="machine.state === 'critical'"
      />
      <span v-else class="inline-flex h-3 w-3 shrink-0 items-center justify-center">
        <span class="block h-[9px] w-[9px] rounded-pill bg-strong" />
      </span>
    </div>

    <!-- Telemetry：固定 2×2 grid，數值 mono，避免寬度跳動造成 layout shift -->
    <div class="grid grid-cols-2 gap-x-3 gap-y-2">
      <div>
        <div class="text-xs text-fg-subtle">Temp</div>
        <div class="font-mono text-number leading-none text-fg">{{ temperature }}</div>
      </div>
      <div>
        <div class="text-xs text-fg-subtle">Vibration</div>
        <div class="font-mono text-number leading-none text-fg">{{ vibration }}</div>
      </div>
      <div>
        <div class="text-xs text-fg-subtle">Throughput</div>
        <div class="font-mono text-number leading-none text-fg">{{ throughput }}</div>
      </div>
      <div>
        <div class="text-xs text-fg-subtle">Errors</div>
        <div class="font-mono text-number leading-none text-fg">{{ errorRate }}</div>
      </div>
    </div>

    <div class="mt-auto font-mono text-xs text-fg-subtle">
      updated {{ lastUpdated }}
    </div>
  </button>
</template>
