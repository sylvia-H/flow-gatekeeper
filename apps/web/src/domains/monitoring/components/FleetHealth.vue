<script setup lang="ts">
import { computed } from "vue";
import type { FleetHealthSummary } from "../lib/fleet-health.js";
import { STATE_STYLE, STALE_DOT } from "../../../shared/lib/state-style.js";

/**
 * 機群健康面板（rail）。純呈現：四類計數 + 比例條，本身就是一片玻璃面板（呼叫端不需再包外框）。
 * 資料由 `store.fleetHealth` getter 衍生（FR-006/007/008），本元件不持有狀態、不逐筆重繪。
 * 顏色一律語意 token，與卡片同一組（FR-004）：正常→ok、警告→warn、嚴重→crit、停滯→stale。
 * 計數文字用 `text-*-fg`（對玻璃 ≥ 6.6:1）；實心色只用在圓點與比例條。
 */
const props = defineProps<{ summary: FleetHealthSummary }>();

interface Segment {
  key: "healthy" | "warning" | "critical" | "stale";
  label: string;
  count: number;
  bar: string; // 比例條與圖例圓點色（實心 token）
  text: string; // 計數文字色（*-fg token）
}

// 顏色 token 與 label 取自共用 STATE_STYLE；停滯為聚合層第四類（STALE_DOT，與卡片停滯徽章同色）。
const segments = computed<Segment[]>(() => [
  { key: "healthy", label: STATE_STYLE.healthy.label, count: props.summary.healthy, bar: STATE_STYLE.healthy.dot, text: STATE_STYLE.healthy.badgeText },
  { key: "warning", label: STATE_STYLE.warning.label, count: props.summary.warning, bar: STATE_STYLE.warning.dot, text: STATE_STYLE.warning.badgeText },
  { key: "critical", label: STATE_STYLE.critical.label, count: props.summary.critical, bar: STATE_STYLE.critical.dot, text: STATE_STYLE.critical.badgeText },
  { key: "stale", label: "停滯", count: props.summary.stale, bar: STALE_DOT, text: "text-ink" },
]);

/** 比例條的可讀名稱，例：「機群健康：正常 3、警告 1、嚴重 1、停滯 0」。 */
const barLabel = computed(
  () => `機群健康：${segments.value.map((seg) => `${seg.label} ${seg.count}`).join("、")}`,
);

/** 各類佔比（%）；total 為固定名冊長度（>0），呈現層計算不入資料型別。 */
function pct(count: number): number {
  return props.summary.total > 0 ? (count / props.summary.total) * 100 : 0;
}
</script>

<template>
  <section
    class="rounded-card border border-edge bg-surface/72 p-3.5 shadow-glass"
    aria-label="機群健康"
  >
    <div class="flex items-baseline justify-between gap-2">
      <span class="text-sm font-semibold text-ink-2">機群健康</span>
      <span class="text-xs text-ink-3">共 <span class="font-mono">{{ summary.total }}</span> 台</span>
    </div>

    <!-- 圖例：色點 + 中文 label + 計數（mono） -->
    <dl class="mt-2 grid grid-cols-2 gap-x-3 gap-y-1">
      <div v-for="seg in segments" :key="seg.key" class="flex items-center gap-1.5">
        <span class="h-2 w-2 shrink-0 rounded-pill" :class="seg.bar" aria-hidden="true" />
        <dt class="text-xs text-ink-2">{{ seg.label }}</dt>
        <dd class="ml-auto font-mono text-md font-medium tabular-nums" :class="seg.text">{{ seg.count }}</dd>
      </div>
    </dl>

    <!-- 比例條：四段依佔比排列；0 佔比寬度為 0 -->
    <div
      class="mt-2 flex h-2 w-full overflow-hidden rounded-control border border-edge bg-bench"
      role="img"
      :aria-label="barLabel"
    >
      <div
        v-for="seg in segments"
        :key="seg.key"
        class="h-full"
        :class="seg.bar"
        :style="{ width: `${pct(seg.count)}%` }"
      />
    </div>
  </section>
</template>
