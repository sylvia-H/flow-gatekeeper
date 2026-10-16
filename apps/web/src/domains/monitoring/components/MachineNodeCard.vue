<script setup lang="ts">
import { computed } from "vue";
import { Stethoscope } from "lucide-vue-next";
import type { MachineLive } from "../stores/monitoring.store.js";
import { machineLabel } from "../lib/machine-labels.js";
import { metricUnit, offendingMetrics, type MetricKey } from "../lib/telemetry-format.js";
import { formatClock, formatRelative } from "../../../shared/lib/format.js";
import { STATE_STYLE } from "../../../shared/lib/state-style.js";
import StatusLight from "../../../shared/components/StatusLight.vue";
import { CARD_ROOT_CLASS, CARD_STALE_CLASS, cardStateClass } from "../lib/card-style.js";

const props = defineProps<{
  machine: MachineLive | null; // null = placeholder（冷啟動／首批未到）
  machineId: string;
  selected: boolean;
  stale: boolean; // >10s 未更新：虛線停滯邊框＋「停滯」徽章，數值不清空（FR-017）
  now: number; // store.staleNow：每秒 tick 驅動相對時間；Pause 且連線中時凍結（見 staleClock）
}>();

const emit = defineEmits<{
  (e: "select", machineId: string): void;
  (e: "diagnose", machineId: string): void;
}>();

const label = computed(() => machineLabel(props.machineId));

/**
 * 狀態 → 卡片外觀 token；對照、hover 與選取態的做法見 `card-style.ts`。
 * 狀態文字徽章與 `StatusLight` 同取自共用 `STATE_STYLE`（顏色＋中文文字＋可讀名稱，FR-004）。
 * 徽章固定字級／行高／內距，狀態切換不改盒模型（FR-031）。
 */
const stateClass = computed(() => cardStateClass(props.machine ? props.machine.state : null));

const PLACEHOLDER = "—";

/**
 * 越界數值染色（FR-002）：warn→`text-warn-fg`、crit→`text-crit-fg`（文字用 *-fg 才達 4.5:1）、否則 `text-ink`。
 * 數值旁的 3 格蝕刻小刻度（`tickCls`）同一份越界判定：warn→`stroke-warn`、crit→`stroke-crit`、否則 `stroke-etch`
 * （刻度是非文字裝飾，用狀態主色即可，不必用 *-fg）。
 */
interface MetricView {
  key: MetricKey;
  label: string;
  value: string;
  unit: string;
  cls: string;
  tickCls: string;
}

const VALUE_CLASS: Record<"warn" | "crit" | "none", string> = {
  crit: "text-crit-fg",
  warn: "text-warn-fg",
  none: "text-ink",
};

const TICK_CLASS: Record<"warn" | "crit" | "none", string> = {
  crit: "stroke-crit",
  warn: "stroke-warn",
  none: "stroke-etch",
};

/**
 * 單一 metric 描述子（key／中文標籤／格式化）——placeholder 與實值分支共用同一份，避免兩處漂移。
 * 單位放在標籤列（12px），數值列只放 24px 數字：220px 寬的卡片放不下「1,180 u/min」同列，
 * 拆兩列後數值位數變化不會讓單位換行、卡片高度跳動。
 */
const METRIC_DESCRIPTORS: readonly {
  key: MetricKey;
  label: string;
  format: (t: MachineLive["telemetry"]) => string;
}[] = [
  { key: "temperature", label: "溫度", format: (t) => t.temperature.toFixed(1) },
  { key: "vibration", label: "振動", format: (t) => t.vibration.toFixed(2) },
  { key: "throughput", label: "產能", format: (t) => Math.round(t.throughput).toLocaleString("en-US") },
  { key: "errorRate", label: "錯誤率", format: (t) => (t.errorRate * 100).toFixed(1) },
];

const metrics = computed<MetricView[]>(() => {
  const m = props.machine;
  const off = m ? offendingMetrics(m.telemetry) : null;
  return METRIC_DESCRIPTORS.map((d) => {
    const level = (off ? off[d.key] : null) ?? "none";
    return {
      key: d.key,
      label: d.label,
      value: m ? d.format(m.telemetry) : PLACEHOLDER,
      unit: metricUnit(d.key),
      cls: VALUE_CLASS[level],
      tickCls: TICK_CLASS[level],
    };
  });
});

/** 相對時間（「剛剛」／「N 秒前」／「N 分鐘前」，FR-022）＋ 24 小時制絕對時間 tooltip。 */
const relativeTime = computed(() =>
  props.machine ? formatRelative(props.machine.lastUpdated, props.now) : PLACEHOLDER,
);
const absoluteTime = computed(() => (props.machine ? formatClock(props.machine.lastUpdated) : undefined));
</script>

<template>
  <div class="group relative min-w-0">
    <button
      type="button"
      class="flex min-h-[148px] w-full min-w-0 flex-col gap-3 rounded-card border p-3.5 text-left shadow-glass transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      :class="[CARD_ROOT_CLASS, stateClass, stale ? CARD_STALE_CLASS : '']"
      :data-machine="machineId"
      :data-state="machine ? machine.state : 'placeholder'"
      :data-selected="selected ? 'true' : 'false'"
      :aria-pressed="selected"
      @click="emit('select', machineId)"
    >
      <!-- 標頭：名稱列只放中文名稱｜狀態文字徽章 + 狀態燈；停滯徽章放在 id 列（固定 20px 高，出現與否不改高度），
           220px 寬時名稱不被擠成「壓製機 0…」 -->
      <div class="flex items-start justify-between gap-2">
        <div class="min-w-0">
          <div class="truncate text-md font-semibold text-ink">{{ label }}</div>
          <div class="flex h-5 min-w-0 items-center gap-1.5">
            <span class="truncate font-mono text-xs text-ink-3">{{ machineId }}</span>
            <span
              v-if="stale"
              class="inline-flex shrink-0 items-center gap-1 rounded-pill border border-stale bg-surface-strong px-2 py-px text-xs font-semibold leading-4 text-ink-2"
            >
              <span class="h-1.5 w-1.5 rounded-pill bg-stale" aria-hidden="true" />停滯
            </span>
          </div>
        </div>
        <div class="flex shrink-0 items-center gap-1.5 pt-0.5">
          <!-- 1px 邊框 + py-px 維持 20px 高；嚴重卡片底色接近 crit-bg，徽章需 border-crit 才分得出來 -->
          <span
            v-if="machine"
            class="rounded-pill border px-2 py-px text-xs font-semibold leading-4"
            :class="[
              STATE_STYLE[machine.state].badgeText,
              STATE_STYLE[machine.state].badgeSurface,
              machine.state === 'critical' ? 'border-crit' : 'border-transparent',
            ]"
          >{{ STATE_STYLE[machine.state].label }}</span>
          <StatusLight
            v-if="machine"
            :state="machine.state"
            :pulse="machine.state === 'critical'"
          />
          <span v-else class="inline-flex h-3 w-3 items-center justify-center" aria-hidden="true">
            <span class="block h-2.5 w-2.5 rounded-pill bg-etch" />
          </span>
        </div>
      </div>

      <!-- 遙測：固定 2×2，標籤列帶單位、數值列 24px mono＋3 格蝕刻小刻度；越界值與其刻度染 warn／crit，
           刻度固定 10×14px、位數變化與狀態變化皆不改版面（FR-017／FR-031）。
           220px 欄寬時每格約 90px：「1,180」約 72px ＋ 4px 間距 ＋ 10px 刻度仍放得下 -->
      <div class="grid grid-cols-2 gap-x-3 gap-y-2">
        <div v-for="metric in metrics" :key="metric.key" class="min-w-0">
          <div class="flex items-baseline gap-1 text-xs text-ink-3">
            <span>{{ metric.label }}</span>
            <span class="font-mono">{{ metric.unit }}</span>
          </div>
          <div class="flex min-w-0 items-center gap-1">
            <span class="min-w-0 truncate font-mono text-number font-medium tabular-nums" :class="metric.cls">
              {{ metric.value }}
            </span>
            <!-- 刻度是裝飾：越界與否已由數值顏色與狀態徽章（文字）傳達 -->
            <svg
              class="h-3.5 w-2.5 shrink-0 fill-none"
              :class="metric.tickCls"
              viewBox="0 0 10 14"
              stroke-width="1.5"
              aria-hidden="true"
              focusable="false"
              data-fg="metric-tick"
            >
              <path d="M0 12.5H10M3 7H10M0 1.5H10" />
            </svg>
          </div>
        </div>
      </div>

      <!-- 右側留白給絕對定位的診斷圖示按鈕，避免文字被蓋住 -->
      <div class="mt-auto pr-9 text-xs text-ink-3" :title="absoluteTime">
        更新 {{ relativeTime }}
      </div>
    </button>

    <!-- 診斷圖示（作用於該台；hover／focus 顯示，鍵盤可達）。store 內部去重／連線把關。
         觸控裝置沒有 hover：`opacity-0` 的按鈕看不見卻點得到，所以 (hover: none) 時常駐顯示。 -->
    <button
      type="button"
      class="absolute bottom-2.5 right-2.5 rounded-control border border-edge bg-surface-strong p-1.5 text-ink-3 opacity-0 transition hover:border-accent hover:text-accent focus:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-focus group-hover:opacity-100 [@media(hover:none)]:opacity-100"
      :aria-label="`診斷 ${label}`"
      @click="emit('diagnose', machineId)"
    >
      <Stethoscope class="h-3.5 w-3.5" aria-hidden="true" />
    </button>
  </div>
</template>
