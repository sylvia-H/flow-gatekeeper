<script setup lang="ts">
import { computed } from "vue";
import type { FlowSpeed } from "../lib/flow-link.js";

/**
 * stage 之間的流向連線（research R5、FR-014／FR-016）：一段管線加箭頭，畫在 24px 溝槽內。
 * 粗細（`width`，2–8px）與流速等級（`speed`）由呼叫端以 `flow-link.ts` 的 computed 衍生（每幀至多一次），
 * 本元件只負責呈現：
 * - 底線 `stroke-etch` 表達管線本身，粗細永遠隨產出量變化（reduced-motion 時仍保留）；
 * - 上層虛線 `stroke-ink-3` 沿線流動（`animate-flow` 位移 -24／週期），三檔時長由等級決定；
 *   `none` 時不掛動畫，虛線靜止。用等級而非連續值：時長只在跨檔時變，不會每批次重啟動畫。
 * - 垂直模式（手機堆疊）：箭頭朝下，流速強制 `none`（FR-016 手機無流動）。
 * 純裝飾（流向已由 stage 標題順序傳達），整個 svg `aria-hidden`。
 */
const props = withDefaults(
  defineProps<{
    /** 線寬（px），`widthFor(sum)` 的結果。 */
    width: number;
    /** 流速等級，`speedFor(sum, reducedMotion, vertical)` 的結果。 */
    speed: FlowSpeed;
    orientation?: "horizontal" | "vertical";
  }>(),
  { orientation: "horizontal" },
);

/** 三檔流動時長：位移 24px／週期，約 10、20、40 px/s。 */
const DURATION: Record<Exclude<FlowSpeed, "none">, string> = {
  slow: "2.4s",
  mid: "1.2s",
  fast: "0.6s",
};

/** 畫布固定 24×24（溝槽寬度），箭頭長 8px、半高隨線寬放大，最粗時仍在畫布內。 */
const SIZE = 24;
const MID = SIZE / 2;
const HEAD_LENGTH = 8;

const vertical = computed(() => props.orientation === "vertical");
const effectiveSpeed = computed<FlowSpeed>(() => (vertical.value ? "none" : props.speed));
const flowStyle = computed(() =>
  effectiveSpeed.value === "none" ? undefined : { animationDuration: DURATION[effectiveSpeed.value] },
);

const geometry = computed(() => {
  const half = props.width / 2 + 3;
  const end = SIZE - HEAD_LENGTH;
  if (vertical.value) {
    return {
      line: { x1: MID, y1: 0, x2: MID, y2: end },
      head: `${MID - half},${end} ${MID},${SIZE} ${MID + half},${end}`,
    };
  }
  return {
    line: { x1: 0, y1: MID, x2: end, y2: MID },
    head: `${end},${MID - half} ${SIZE},${MID} ${end},${MID + half}`,
  };
});
</script>

<template>
  <svg
    class="block h-6 w-6 shrink-0"
    :viewBox="`0 0 ${SIZE} ${SIZE}`"
    aria-hidden="true"
    focusable="false"
    data-fg="flow-link"
    :data-speed="effectiveSpeed"
    :data-orientation="orientation"
  >
    <line v-bind="geometry.line" class="stroke-etch" :stroke-width="width" />
    <line
      v-bind="geometry.line"
      class="stroke-ink-3"
      :class="effectiveSpeed === 'none' ? '' : 'animate-flow'"
      :style="flowStyle"
      :stroke-width="width"
      stroke-dasharray="6 6"
    />
    <polygon :points="geometry.head" class="fill-ink-3" />
  </svg>
</template>
