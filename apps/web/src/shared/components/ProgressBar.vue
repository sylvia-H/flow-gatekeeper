<script setup lang="ts">
import { computed } from "vue";
import { progressBarView, type ProgressStatus } from "../lib/progress-bar-view.js";

/**
 * 診斷任務進度條（design-spec §7.5、§10）。支援數值與 indeterminate：
 * `value` 為 null／undefined 時走 indeterminate 動畫並以 aria 描述（FR-004）；
 * 數值時 `aria-valuenow`／填色寬度反映百分比。completed/failed 用 ok/crit 收尾色。
 * 呈現不變量抽於純函式 `progressBarView`（見同名 .test）。
 */
const props = defineProps<{
  status: ProgressStatus;
  value?: number | null;
}>();

const view = computed(() => progressBarView(props.status, props.value));
const indeterminate = computed(() => view.value.indeterminate);
const barClass = computed(() => view.value.barClass);
const widthPct = computed(() => view.value.widthPct);
const ariaLabel = computed(() => view.value.ariaLabel);
</script>

<template>
  <div
    class="relative h-1.5 w-full overflow-hidden rounded-pill bg-surface-inset"
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
