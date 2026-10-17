<script setup lang="ts">
/**
 * 「停滯」徽章（遙測逾 10 秒未更新）：卡片 id 列與 AI 診斷面板閒置列共用（合併門第 2 輪 #13，原本三份 markup）。
 * 停滯點＋文字，狀態不只靠顏色；不縮、不截斷（`shrink-0`）。
 */
</script>

<template>
  <span
    class="inline-flex shrink-0 items-center gap-1 rounded-pill border border-stale bg-surface-strong px-2 py-px text-xs font-semibold leading-4 text-ink-2"
  >
    <span class="h-1.5 w-1.5 rounded-pill bg-stale" aria-hidden="true" />停滯
  </span>
</template>
