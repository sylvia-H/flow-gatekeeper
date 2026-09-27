<script setup lang="ts">
import { computed } from "vue";
import { backpressureRatio } from "../lib/backpressure.js";

/**
 * 背壓計量（design-spec §7.2.1）——把「rAF 批次提交」的效果變成畫面上看得見的數字，
 * 是本專案最直接的賣點佐證（背壓量化）。恆用中性色（非 warn/crit）。
 *
 * `receivedMessages` 已含丟棄筆數；有丟棄時另列 `N dropped`，讓比值偏移有跡可循
 * （背景分頁或長時間 Pause 後 buffer 溢位合併、或入口剔除畸形資料）。
 */
const props = withDefaults(
  defineProps<{
    receivedMessages: number;
    renderedBatches: number;
    /** buffer 溢位合併丟棄的筆數。 */
    droppedMessages?: number;
    /** 入口型別守衛剔除的筆數。 */
    invalidMessages?: number;
  }>(),
  { droppedMessages: 0, invalidMessages: 0 },
);

const ratio = computed(() => backpressureRatio(props.receivedMessages, props.renderedBatches));

// 千分位 + mono，避免高頻更新造成寬度跳動。
const receivedText = computed(() => props.receivedMessages.toLocaleString("en-US"));
const framesText = computed(() => props.renderedBatches.toLocaleString("en-US"));
const discarded = computed(() => props.droppedMessages + props.invalidMessages);
const discardedText = computed(() => discarded.value.toLocaleString("en-US"));

const title = computed(() => {
  const base = "收到的訊息 vs 實際渲染批次；比值越高代表背壓越有效";
  if (discarded.value === 0) return base;
  return `${base}\n收到數含未渲染的丟棄筆數：溢位合併 ${props.droppedMessages.toLocaleString("en-US")}、格式不符 ${props.invalidMessages.toLocaleString("en-US")}`;
});
</script>

<template>
  <span
    class="inline-flex items-center gap-1 rounded-pill bg-elevated px-2.5 py-1 font-mono text-xs text-fg-muted"
    :title="title"
  >
    <span class="hidden sm:inline">{{ receivedText }} msgs</span>
    <span class="hidden sm:inline text-fg-subtle">·</span>
    <span class="hidden sm:inline">{{ framesText }} frames</span>
    <span class="hidden sm:inline text-fg-subtle">·</span>
    <span class="font-medium text-accent">{{ ratio }}:1</span>
    <template v-if="discarded > 0">
      <span class="hidden sm:inline text-fg-subtle">·</span>
      <span class="hidden sm:inline">{{ discardedText }} dropped</span>
    </template>
  </span>
</template>
