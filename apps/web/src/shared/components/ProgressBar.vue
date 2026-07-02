<script setup lang="ts">
import { computed } from "vue";

/**
 * 診斷任務進度條（design-spec §7.5、§10）。支援數值與 indeterminate：
 * `value` 為 null／undefined 時走 indeterminate 動畫並以 aria 描述（FR-004）；
 * 數值時 `aria-valuenow`／填色寬度反映百分比。completed/failed 用 ok/crit 收尾色。
 */
const props = defineProps<{
  status: "waiting" | "active" | "completed" | "failed";
  value?: number | null;
}>();

/** 事件驅動：僅在有數值時顯示百分比，否則 indeterminate（前端不合成假值）。 */
const numeric = computed<number | null>(() =>
  typeof props.value === "number" ? props.value : null,
);
const indeterminate = computed(() => numeric.value === null && props.status !== "completed");

/** 填色 token 依狀態（design-spec §7.5）。 */
const barClass = computed(() => {
  switch (props.status) {
    case "completed":
      return "bg-ok";
    case "failed":
      return "bg-crit";
    default:
      return "bg-accent";
  }
});

/** completed 視為 100%；failed 保留最後已知值（或 0）。 */
const widthPct = computed(() => {
  if (props.status === "completed") return 100;
  return numeric.value ?? 0;
});

const ariaLabel = computed(() =>
  indeterminate.value ? "診斷進度：處理中…" : `診斷進度：${widthPct.value}%`,
);
</script>

<template>
  <div
    class="relative h-1.5 w-full overflow-hidden rounded-pill bg-inset"
    role="progressbar"
    :aria-valuemin="0"
    :aria-valuemax="100"
    :aria-valuenow="indeterminate ? undefined : widthPct"
    :aria-label="ariaLabel"
  >
    <!-- indeterminate：滑動色塊（design-spec §7.5，keyframes indeterminate） -->
    <div
      v-if="indeterminate"
      class="absolute inset-y-0 w-1/3 rounded-pill bg-accent animate-indeterminate"
    />
    <!-- 數值：填色寬度反映百分比 -->
    <div
      v-else
      class="h-full rounded-pill transition-[width] duration-300 ease-out"
      :class="barClass"
      :style="{ width: `${widthPct}%` }"
    />
  </div>
</template>
