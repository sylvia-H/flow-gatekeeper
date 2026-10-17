<script setup lang="ts">
import { computed } from "vue";

/**
 * 背壓比值刻度（spec FR-009a）：0–60、線性、1 格 = 1:1，每 10 格一個大格並標數字，每 5 格一個中格
 * 方便目讀。只收一個版式 prop，父層重繪時不會跟著重繪；液位線由 BackpressureStrip 疊在上面。
 *
 * - 刻度線是 SVG（`viewBox` 0–600、`preserveAspectRatio="none"` 橫向拉滿），線寬以
 *   `vector-effect="non-scaling-stroke"` 固定 1px，拉伸不會變粗。
 * - 數字**不用 SVG `<text>`**（會隨拉伸變形），改以 HTML 絕對定位、`text-xs`（12px）疊在刻度下方，
 *   位置用同一個百分比，與刻度線對齊。
 * - 線色 `stroke-etch`（非文字裝飾）；數字是文字，用 `text-ink-3`。
 * - `compact`（手機背壓帶）：刻度線 8px → 6px、數字行高 16px → 12px，整條 24px → 18px；
 *   刻度與數字的位置、數量不變（仍每 10 格標數字）。
 * - `highWater`（critique 2026-10-16 P1）：近 60 秒最高水位——量筒上的蝕刻短線，1px `stroke-ink-3`、
 *   比刻度大格再往上多 3px（一般 11px、compact 9px），與 2px 深青液位線（粗細、顏色都不同）區分；
 *   > 60 釘右端。null 不畫。值每秒至多變一次（由 strip 的 computed 從 1 Hz 樣本衍生），直接改 x、不做過渡。
 * - `level`（critique 2026-10-17 P2「量筒沒有液體」）：目前比值。刻度列從 0 到液位畫一段**實心**
 *   `bg-accent/25` 液柱（單一實色、不漸層；不用 `accent-wash`——深色主題的 wash 比煙燻玻璃還暗，
 *   液柱會讀成凹洞），高度同刻度列（一般 8px、compact 6px），刻度線與最高水位短線畫在
 *   液柱之上仍可見；> 60 填滿。以 `scaleX`（origin-left）伸縮、走合成層，`motion-safe` 500ms ease-out
 *   與 strip 的液位線同步。null 不畫。
 * - **1:1 錨點**（critique 2026-10-17 第三輪 P2「合併比沒有好壞參照」）：每批至少 1 則，1:1 就是沒有合併、
 *   1 以上才是在合併。刻度 1 的位置畫一條 1px `stroke-ink-3` 蝕刻短線，**往下**延伸進數字列（一般多 4px、
 *   compact 多 3px）——方向與往上突出的最高水位短線相反，兩者不會讀混；旁邊以與大格數字同款的 12px mono ink-3
 *   標「1:1」，**靠左起排**（線右側一般 3px、compact 6px）而非置中，才不與「0」重疊；離「10」仍有一個以上字寬（390 寬 compact
 *   刻度約 290px 時，「1:1」約佔 8–30px、「10」約 41–56px）。刻度本身 0–60 線性不變（AMENDMENT 1）。
 */
// 檔名依 tasks T033；元件名取兩個字以符合 vue/multi-word-component-names。
defineOptions({ name: "RatioGraduation" });

const props = withDefaults(
  defineProps<{ compact?: boolean; highWater?: number | null; level?: number | null }>(),
  {
    compact: false,
    highWater: null,
    level: null,
  },
);

const MAX = 60;
const WIDTH = 600;
const STEP = WIDTH / MAX;

/** 刻度線高度（viewBox 單位 = px）：一般 8px、compact 6px。 */
const tickHeight = computed(() => (props.compact ? 6 : 8));

/** 每一格的刻度線：大格（10 的倍數）滿高、中格（5）次之、小格最短。 */
const ticks = computed(() => {
  const full = tickHeight.value;
  return Array.from({ length: MAX + 1 }, (_, i) => ({
    x: i * STEP,
    y2: i % 10 === 0 ? full : i % 5 === 0 ? full * 0.75 : full * 0.5,
  }));
});

/** 最高水位短線比大格高出的長度（往上，viewBox 單位 = px）。 */
const HIGH_WATER_OVERSHOOT = 3;

/** 最高水位短線的 x（viewBox 單位）；null＝不畫。 */
const highWaterX = computed(() =>
  props.highWater === null ? null : (Math.min(Math.max(props.highWater, 0), MAX) / MAX) * WIDTH,
);

/** 液柱的 `scaleX`（0–1，> 60 釘 1）；null＝不畫。 */
const liquidTransform = computed(() =>
  props.level === null ? null : `scaleX(${Math.min(Math.max(props.level, 0), MAX) / MAX})`,
);

/** 1:1 錨點的 x（viewBox 單位）與水平位置（百分比）；錨點短線往下突出進數字列的長度（px）。 */
const UNITY_X = STEP;
const UNITY_LEFT = `${(1 / MAX) * 100}%`;
const unityY2 = computed(() => tickHeight.value + (props.compact ? 3 : 4));

/** 大格數字與其水平位置（百分比）。 */
const LABELS = Array.from({ length: MAX / 10 + 1 }, (_, i) => ({
  value: i * 10,
  left: `${((i * 10) / MAX) * 100}%`,
}));
</script>

<template>
  <div
    role="img"
    aria-label="背壓比值刻度 0 到 60，1 比 1 處標示無合併"
    class="relative w-full"
    :class="compact ? 'h-[18px]' : 'h-6'"
  >
    <!-- 液柱：在刻度線之下（svg 為 relative，疊在液柱上） -->
    <div
      v-if="liquidTransform !== null"
      class="grad-liquid pointer-events-none absolute left-0 top-0 w-full origin-left bg-accent/25 motion-safe:transition-transform motion-safe:duration-500 motion-safe:ease-out"
      :class="compact ? 'h-1.5' : 'h-2'"
      :style="{ transform: liquidTransform }"
      aria-hidden="true"
    />
    <svg
      class="relative block w-full overflow-visible stroke-etch"
      :class="compact ? 'h-1.5' : 'h-2'"
      :viewBox="`0 0 ${WIDTH} ${tickHeight}`"
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
    >
      <line x1="0" y1="0.5" :x2="WIDTH" y2="0.5" stroke-width="1" vector-effect="non-scaling-stroke" />
      <line
        v-for="tick in ticks"
        :key="tick.x"
        :x1="tick.x"
        y1="0"
        :x2="tick.x"
        :y2="tick.y2"
        stroke-width="1"
        vector-effect="non-scaling-stroke"
      />
      <line
        class="grad-unity stroke-ink-3"
        :x1="UNITY_X"
        y1="0"
        :x2="UNITY_X"
        :y2="unityY2"
        stroke-width="1"
        vector-effect="non-scaling-stroke"
      />
      <line
        v-if="highWaterX !== null"
        class="grad-high-water stroke-ink-3"
        :x1="highWaterX"
        :y1="-HIGH_WATER_OVERSHOOT"
        :x2="highWaterX"
        :y2="tickHeight"
        stroke-width="1"
        vector-effect="non-scaling-stroke"
      />
    </svg>
    <span
      v-for="label in LABELS"
      :key="label.value"
      class="absolute -translate-x-1/2 font-mono text-xs tabular-nums text-ink-3"
      :class="compact ? 'top-1.5 leading-3' : 'top-2'"
      :style="{ left: label.left }"
      aria-hidden="true"
    >
      {{ label.value }}
    </span>
    <!-- 1:1 錨點標字：靠左起排於錨點線右側（一般 3px、compact 6px——compact 刻度窄，錨點線離「0」只約 1px，
         間距不夠會讀成「01:1」），不與置中的「0」重疊 -->
    <span
      class="grad-unity-label absolute whitespace-nowrap font-mono text-xs tabular-nums text-ink-3"
      :class="compact ? 'top-1.5 ml-1.5 leading-3' : 'top-2 ml-[3px]'"
      :style="{ left: UNITY_LEFT }"
      title="1:1＝每批只有 1 則、沒有合併；1 以上就是在合併"
      aria-hidden="true"
    >1:1</span>
  </div>
</template>
