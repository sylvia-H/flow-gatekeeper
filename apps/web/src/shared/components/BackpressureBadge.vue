<script setup lang="ts">
import { computed } from "vue";

/**
 * 背壓計量（design-spec §7.2.1）——把「rAF 批次提交」的效果變成畫面上看得見的數字，
 * 是本專案最直接的賣點佐證（背壓量化）。恆用中性色（非 warn/crit）。
 */
const props = defineProps<{
  receivedMessages: number;
  renderedBatches: number;
}>();

const ratio = computed(() =>
  props.renderedBatches > 0
    ? Math.round(props.receivedMessages / props.renderedBatches)
    : 0,
);

// 千分位 + mono，避免高頻更新造成寬度跳動。
const receivedText = computed(() => props.receivedMessages.toLocaleString("en-US"));
const framesText = computed(() => props.renderedBatches.toLocaleString("en-US"));
</script>

<template>
  <span
    class="inline-flex items-center gap-1 rounded-pill bg-elevated px-2.5 py-1 font-mono text-xs text-fg-muted"
    title="收到的訊息 vs 實際渲染批次；比值越高代表背壓越有效"
  >
    <span class="hidden sm:inline">{{ receivedText }} msgs</span>
    <span class="hidden sm:inline text-fg-subtle">·</span>
    <span class="hidden sm:inline">{{ framesText }} frames</span>
    <span class="hidden sm:inline text-fg-subtle">·</span>
    <span class="font-medium text-accent">{{ ratio }}:1</span>
  </span>
</template>
