<script setup lang="ts">
import { computed } from "vue";
import { ChevronDown } from "lucide-vue-next";
import type { FleetHealthSummary } from "../lib/fleet-health.js";
import { STATE_STYLE, STALE_DOT } from "../../../shared/lib/state-style.js";

/**
 * 機群健康。純呈現：四類計數 + 比例條，本身就是一片玻璃（呼叫端不需再包外框）。
 * 資料由 `store.fleetHealth` getter 衍生（FR-006/007/008），本元件不持有狀態、不逐筆重繪。
 * 顏色一律語意 token，與卡片同一組（FR-004）：正常→ok、警告→warn、嚴重→crit、停滯→stale。
 * 計數文字用 `text-*-fg`（對玻璃 ≥ 6.6:1）；實心色只用在圓點與比例條。
 * 計數為 0 時文字退為中性 `text-ink-3`（「嚴重 0」染紅沒有資訊、只增加雜訊；critique 2026-10-17）；
 * 圓點是圖例鍵、保留狀態色，比例條 0 佔比本來就不渲染。
 *
 * 兩種版面：
 * - 預設：rail 裡的面板（標題、總台數、兩欄圖例、比例條）。
 * - `compact`：手機主畫面頂端常駐的「機群健康摘要條」（FR-033a），整條是一顆展開鈕，
 *   左比例條、右四計數一列，固定 44px 高（數字變動不改高度）；點擊 emit `toggle`，
 *   由呼叫端開關異常清單覆蓋層，`expanded` 回寫 `aria-expanded`。
 */
const props = withDefaults(
  defineProps<{
    summary: FleetHealthSummary;
    /** 摘要條版面（手機）。 */
    compact?: boolean;
    /** compact 時：異常清單覆蓋層是否開著（`aria-expanded`）。 */
    expanded?: boolean;
    /** compact 時：覆蓋層面板的 id（展開時寫入 `aria-controls`）。 */
    controls?: string;
  }>(),
  { compact: false, expanded: false, controls: "anomaly-overlay-panel" },
);

const emit = defineEmits<{ toggle: [] }>();

interface Segment {
  key: "healthy" | "warning" | "critical" | "stale";
  label: string;
  count: number;
  bar: string; // 比例條與圖例圓點色（實心 token）
  text: string; // 計數文字色（*-fg token；計數為 0 時為中性 ink-3）
}

/** 計數文字色：非 0 用該類狀態色，0 退為中性（零值不該讀成告警）。 */
function countTone(count: number, stateText: string): string {
  return count === 0 ? "text-ink-3" : stateText;
}

// 顏色 token 與 label 取自共用 STATE_STYLE；停滯為聚合層第四類（STALE_DOT，與卡片停滯徽章同色）。
const segments = computed<Segment[]>(() => [
  { key: "healthy", label: STATE_STYLE.healthy.label, count: props.summary.healthy, bar: STATE_STYLE.healthy.dot, text: countTone(props.summary.healthy, STATE_STYLE.healthy.badgeText) },
  { key: "warning", label: STATE_STYLE.warning.label, count: props.summary.warning, bar: STATE_STYLE.warning.dot, text: countTone(props.summary.warning, STATE_STYLE.warning.badgeText) },
  { key: "critical", label: STATE_STYLE.critical.label, count: props.summary.critical, bar: STATE_STYLE.critical.dot, text: countTone(props.summary.critical, STATE_STYLE.critical.badgeText) },
  { key: "stale", label: "停滯", count: props.summary.stale, bar: STALE_DOT, text: countTone(props.summary.stale, "text-ink") },
]);

/** 比例條的可讀名稱，例：「機群健康：正常 3、警告 1、嚴重 1、停滯 0」。 */
const barLabel = computed(
  () => `機群健康：${segments.value.map((seg) => `${seg.label} ${seg.count}`).join("、")}`,
);

/** 摘要條按鈕的名稱：計數之後接動作，例：「機群健康：正常 5、警告 1、嚴重 1、停滯 0，展開異常清單」。 */
const toggleLabel = computed(
  () => `${barLabel.value}，${props.expanded ? "收合" : "展開"}異常清單`,
);

/** 各類佔比（%）；total 為固定名冊長度（>0），呈現層計算不入資料型別。 */
function pct(count: number): number {
  return props.summary.total > 0 ? (count / props.summary.total) * 100 : 0;
}
</script>

<template>
  <!-- 摘要條：整條一顆鈕；按鈕名稱已含全部計數，內部圖形只作視覺 -->
  <button
    v-if="compact"
    type="button"
    data-fg="fleet-summary-bar"
    class="flex h-11 w-full items-center gap-3 rounded-card border border-edge bg-surface/72 px-3 text-left shadow-glass transition-colors duration-150 hover:bg-surface focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
    :aria-label="toggleLabel"
    :aria-expanded="expanded ? 'true' : 'false'"
    :aria-controls="expanded ? controls : undefined"
    @click="emit('toggle')"
  >
    <span
      class="flex h-2 min-w-8 flex-1 overflow-hidden rounded-control border border-edge bg-bench"
      role="img"
      :aria-label="barLabel"
    >
      <span
        v-for="seg in segments"
        :key="seg.key"
        class="h-full"
        :class="seg.bar"
        :style="{ width: `${pct(seg.count)}%` }"
      />
    </span>

    <span class="flex shrink-0 items-center gap-2.5" aria-hidden="true">
      <span
        v-for="seg in segments"
        :key="seg.key"
        :data-count="seg.key"
        class="flex items-center gap-1"
      >
        <span class="h-2 w-2 shrink-0 rounded-pill" :class="seg.bar" />
        <span class="text-xs text-ink-2">{{ seg.label }}</span>
        <span class="font-mono text-xs font-medium tabular-nums" :class="seg.text">{{ seg.count }}</span>
      </span>
    </span>

    <ChevronDown
      class="h-4 w-4 shrink-0 text-ink-3 transition-transform duration-150 motion-reduce:transition-none"
      :class="expanded ? 'rotate-180' : ''"
      aria-hidden="true"
    />
  </button>

  <section
    v-else
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
