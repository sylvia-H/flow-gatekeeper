<script setup lang="ts">
import { computed } from "vue";
import type { RateSample } from "../../domains/monitoring/lib/rate-series.js";

/**
 * 背壓走勢線（spec FR-010、FR-009a、research R4）：最近 60 秒的每秒訊息（實線）與每秒批次（虛線）。
 *
 * - 時間軸固定為 60 格、**靠右對齊**：最右端是最新一秒、往左每格早一秒；不足 60 筆時左側留空，
 *   線不會隨樣本累積而被橫向拉長，「近 60 秒」的讀法從第一秒起就成立。
 * - 兩條線共用 `peak`（60 秒內的最大速率）正規化 y 軸，線下面積的比例才與比值一致（US2 AS2）。
 * - 不共用比值刻度：上方另以「近 60 秒」小字標示時間範圍（FR-009a）。
 * - 每秒更新一次，points 直接換新（SVG `points` 無法以 CSS 過渡），任何動態偏好下都是瞬間更新。
 */
// 檔名依 tasks T034；元件名取兩個字以符合 vue/multi-word-component-names。
defineOptions({ name: "RateSparkline" });

const props = defineProps<{
  /** 由舊到新，長度 ≤ 60。 */
  samples: readonly RateSample[];
  /** y 軸上限（兩條線共用）。 */
  peak: number;
}>();

const SLOTS = 60;
const HEIGHT = 24;
/** 上下各留 1 單位，峰值與零值的線不被裁切。 */
const PAD = 1;

function pointsOf(key: "msgsPerSec" | "batchesPerSec"): string {
  const n = props.samples.length;
  const scale = props.peak > 0 ? (HEIGHT - PAD * 2) / props.peak : 0;
  return props.samples
    .map((sample, i) => {
      const x = SLOTS - 1 - (n - 1 - i);
      const y = HEIGHT - PAD - Math.min(sample[key], props.peak) * scale;
      return `${x},${Number(y.toFixed(2))}`;
    })
    .join(" ");
}

const msgPoints = computed(() => pointsOf("msgsPerSec"));
const batchPoints = computed(() => pointsOf("batchesPerSec"));

const summary = computed(() => {
  const latest = props.samples[props.samples.length - 1];
  if (latest === undefined) return "近 60 秒走勢，尚無資料";
  return `近 60 秒走勢，目前每秒訊息 ${latest.msgsPerSec.toLocaleString("en-US")}、每秒批次 ${latest.batchesPerSec.toLocaleString("en-US")}`;
});
</script>

<template>
  <!-- 根節點的 display／寬高由父層 class 決定（父層須給 `flex flex-col`，svg 以 flex-1 吃掉剩餘高度） -->
  <div>
    <span class="text-xs text-ink-2" aria-hidden="true">近 60 秒</span>
    <svg
      class="block min-h-0 w-full flex-1 overflow-visible"
      :viewBox="`0 0 ${SLOTS - 1} ${HEIGHT}`"
      preserveAspectRatio="none"
      role="img"
      :aria-label="summary"
    >
      <polyline
        :points="msgPoints"
        fill="none"
        class="stroke-ink-2"
        stroke-width="1.5"
        stroke-linejoin="round"
        vector-effect="non-scaling-stroke"
      />
      <polyline
        :points="batchPoints"
        fill="none"
        class="stroke-accent"
        stroke-width="1.5"
        stroke-dasharray="4 3"
        stroke-linejoin="round"
        vector-effect="non-scaling-stroke"
      />
    </svg>
  </div>
</template>
