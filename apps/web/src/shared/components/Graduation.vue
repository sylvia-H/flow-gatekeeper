<script setup lang="ts">
/**
 * 背壓比值刻度（spec FR-009a）：0–60、線性、1 格 = 1:1，每 10 格一個大格並標數字，每 5 格一個中格
 * 方便目讀。靜態、無 props，父層重繪時不會跟著重繪；液位線由 BackpressureStrip 疊在上面。
 *
 * - 刻度線是 SVG（`viewBox` 0–600、`preserveAspectRatio="none"` 橫向拉滿），線寬以
 *   `vector-effect="non-scaling-stroke"` 固定 1px，拉伸不會變粗。
 * - 數字**不用 SVG `<text>`**（會隨拉伸變形），改以 HTML 絕對定位、`text-xs`（12px）疊在刻度下方，
 *   位置用同一個百分比，與刻度線對齊。
 * - 線色 `stroke-etch`（非文字裝飾）；數字是文字，用 `text-ink-3`。
 */
// 檔名依 tasks T033；元件名取兩個字以符合 vue/multi-word-component-names。
defineOptions({ name: "RatioGraduation" });

const MAX = 60;
const WIDTH = 600;
const STEP = WIDTH / MAX;

/** 每一格的刻度線：大格（10 的倍數）滿高、中格（5）次之、小格最短。 */
const TICKS = Array.from({ length: MAX + 1 }, (_, i) => ({
  x: i * STEP,
  y2: i % 10 === 0 ? 8 : i % 5 === 0 ? 6 : 4,
}));

/** 大格數字與其水平位置（百分比）。 */
const LABELS = Array.from({ length: MAX / 10 + 1 }, (_, i) => ({
  value: i * 10,
  left: `${((i * 10) / MAX) * 100}%`,
}));
</script>

<template>
  <div role="img" aria-label="背壓比值刻度 0 到 60" class="relative h-6 w-full">
    <svg
      class="block h-2 w-full overflow-visible stroke-etch"
      :viewBox="`0 0 ${WIDTH} 8`"
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
    >
      <line x1="0" y1="0.5" :x2="WIDTH" y2="0.5" stroke-width="1" vector-effect="non-scaling-stroke" />
      <line
        v-for="tick in TICKS"
        :key="tick.x"
        :x1="tick.x"
        y1="0"
        :x2="tick.x"
        :y2="tick.y2"
        stroke-width="1"
        vector-effect="non-scaling-stroke"
      />
    </svg>
    <span
      v-for="label in LABELS"
      :key="label.value"
      class="absolute top-2 -translate-x-1/2 font-mono text-xs tabular-nums text-ink-3"
      :style="{ left: label.left }"
      aria-hidden="true"
    >
      {{ label.value }}
    </span>
  </div>
</template>
