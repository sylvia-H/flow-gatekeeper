<script setup lang="ts">
import { computed } from "vue";
import { progressBarView, type ProgressStatus } from "../lib/progress-bar-view.js";

/**
 * 診斷任務進度條。支援數值與 indeterminate：
 * `value` 為 null／undefined 時走 indeterminate 動畫並以中文 aria 描述（FR-004）；
 * 數值時 `aria-valuenow`／填色寬度反映百分比。進行中用深青 accent，completed/failed 用 ok/crit 收尾色。
 * 軌道是 1px `border-edge` 包住的桌面色凹槽，放在玻璃面上仍看得出全長。
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
    class="relative h-2 w-full overflow-hidden rounded-control border border-edge bg-bench"
    role="progressbar"
    :aria-valuemin="0"
    :aria-valuemax="100"
    :aria-valuenow="indeterminate ? undefined : widthPct"
    :aria-label="ariaLabel"
  >
    <!-- indeterminate：滑動色塊（keyframes indeterminate；reduced-motion 時停成靜止的 1/3 條） -->
    <div
      v-if="indeterminate"
      class="absolute inset-y-0 w-1/3 bg-accent animate-indeterminate"
    />
    <!-- 數值：填色寬度反映百分比 -->
    <div
      v-else
      class="h-full transition-[width] duration-300 ease-out"
      :class="barClass"
      :style="{ width: `${widthPct}%` }"
    />
  </div>
</template>
