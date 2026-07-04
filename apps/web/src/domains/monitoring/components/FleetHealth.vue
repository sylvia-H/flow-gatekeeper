<script setup lang="ts">
import { computed } from "vue";
import type { FleetHealthSummary } from "../lib/fleet-health.js";
import { STATE_STYLE, STALE_DOT } from "../../../shared/lib/state-style.js";

/**
 * US2 Fleet Health 面板（design-spec §6 sidebar 左下）。純呈現：四類計數 + 比例條。
 * 資料由 `store.fleetHealth` getter 衍生（FR-006/007/008），本元件不持有狀態、不逐筆重繪。
 * 顏色一律具名 token（FR-020）：healthy→ok、warning→warn、critical→crit、stale→strong（中性）。
 */
const props = defineProps<{ summary: FleetHealthSummary }>();

interface Segment {
  key: "healthy" | "warning" | "critical" | "stale";
  label: string;
  count: number;
  bar: string; // 比例條色（token）
  dot: string; // legend 圓點色（token）
}

// 顏色 token 與 label 取自共用 STATE_STYLE；stale 為聚合層第四類（中性 STALE_DOT）。
const segments = computed<Segment[]>(() => [
  { key: "healthy", label: STATE_STYLE.healthy.label, count: props.summary.healthy, bar: STATE_STYLE.healthy.dot, dot: STATE_STYLE.healthy.dot },
  { key: "warning", label: STATE_STYLE.warning.label, count: props.summary.warning, bar: STATE_STYLE.warning.dot, dot: STATE_STYLE.warning.dot },
  { key: "critical", label: STATE_STYLE.critical.label, count: props.summary.critical, bar: STATE_STYLE.critical.dot, dot: STATE_STYLE.critical.dot },
  { key: "stale", label: "Stale", count: props.summary.stale, bar: STALE_DOT, dot: STALE_DOT },
]);

/** 各類佔比（%）；total 為固定名冊長度（>0），呈現層計算不入資料型別。 */
function pct(count: number): number {
  return props.summary.total > 0 ? (count / props.summary.total) * 100 : 0;
}
</script>

<template>
  <section class="px-1" aria-label="Fleet Health">
    <div class="px-1 pb-2 text-xs font-medium uppercase tracking-wide text-fg-subtle">
      Fleet Health
    </div>

    <!-- 比例條：四段依佔比排列；0 佔比不顯示 -->
    <div class="flex h-2 w-full overflow-hidden rounded-pill bg-inset" role="presentation">
      <div
        v-for="seg in segments"
        :key="seg.key"
        class="h-full first:rounded-l-pill last:rounded-r-pill"
        :class="seg.bar"
        :style="{ width: `${pct(seg.count)}%` }"
      />
    </div>

    <!-- Legend：色點 + label + 計數 -->
    <dl class="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5">
      <div v-for="seg in segments" :key="seg.key" class="flex items-center gap-1.5">
        <span class="h-2 w-2 shrink-0 rounded-pill" :class="seg.dot" aria-hidden="true" />
        <dt class="text-xs text-fg-muted">{{ seg.label }}</dt>
        <dd class="ml-auto font-mono text-xs text-fg">{{ seg.count }}</dd>
      </div>
    </dl>

    <div class="mt-2 px-1 text-right font-mono text-[10px] text-fg-subtle">
      total {{ summary.total }}
    </div>
  </section>
</template>
