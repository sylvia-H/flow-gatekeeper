<script setup lang="ts">
import { useId } from "vue";

/**
 * 側欄「最近異常」摘要（spec FR-027）。目前只有標題與空狀態；
 * 列項（可點選台、可清除、劃線保留至期滿）與資料接線於 US5 T050 改寫。
 */
const headingId = useId();
</script>

<template>
  <section data-fg="anomaly-summary" :aria-labelledby="headingId" class="flex flex-col gap-2">
    <h2 :id="headingId" class="text-sm font-semibold text-ink-2">最近異常</h2>
    <p class="rounded-card border border-dashed border-edge px-3 py-2 text-sm text-ink-3">
      目前沒有異常
    </p>
  </section>
</template>
