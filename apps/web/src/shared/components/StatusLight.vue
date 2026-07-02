<script setup lang="ts">
import { computed } from "vue";
import type { MachineState } from "@flow-gatekeeper/contracts";

const props = withDefaults(
  defineProps<{
    state: MachineState;
    pulse?: boolean;
  }>(),
  { pulse: false },
);

/** 狀態 → 色票 token（design-spec §7.4，healthy→ok / warning→warn / critical→crit）。 */
const DOT_CLASS: Record<MachineState, string> = {
  healthy: "bg-ok",
  warning: "bg-warn",
  critical: "bg-crit",
};
const LABEL: Record<MachineState, string> = {
  healthy: "Healthy",
  warning: "Warning",
  critical: "Critical",
};

const dotClass = computed(() => DOT_CLASS[props.state]);
const label = computed(() => LABEL[props.state]);

// critical 且要求 pulse 時才動效；wrapper 尺寸固定，pulse 不造 layout shift（FR-020、§10）。
const shouldPulse = computed(() => props.pulse && props.state === "critical");
</script>

<template>
  <!-- 固定 12px 方框置中承載 9px 圓點，pulse 只作用於圓點的 box-shadow，不改變 wrapper 尺寸 -->
  <span
    class="inline-flex h-3 w-3 shrink-0 items-center justify-center"
    role="img"
    :aria-label="`Status: ${label}`"
  >
    <span
      class="block h-[9px] w-[9px] rounded-pill"
      :class="[dotClass, shouldPulse ? 'animate-critical-pulse' : '']"
    />
  </span>
</template>
