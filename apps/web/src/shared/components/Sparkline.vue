<script setup lang="ts">
import { computed } from "vue";
import type { RateSample } from "../../domains/monitoring/lib/rate-series.js";

/**
 * 背壓走勢線（spec FR-010、FR-009a、research R4）：最近 60 秒每一秒的**合併比**（該秒訊息 ÷ 該秒批次）。
 *
 * 由來：原本畫每秒訊息（實線）與每秒批次（虛線）兩條、共用峰值正規化——批次約只有訊息的 1/5，
 * 兩條線都近乎平線，讀不出「比值在動」（critique 2026-10-17 P2）。改為只畫一條合併比，與左側 32px
 * 大字、下緣液位線是同一個量，深青 1.5px 實線（液位線的延伸，The One Teal Rule）。
 *
 * - 時間軸固定為 60 格、**靠右對齊**：最右端是最新一秒、往左每格早一秒；不足 60 筆時左側留空。
 * - y 軸以 0 為底、上限取**穩健值**：max(視窗合併比 × 2, 有效單秒比的次高值) × 1.25（至少 1）。不取最高值：
 *   單一秒的離群（例如背景分頁回來那一批）會把其餘 59 秒壓成平線；超出上限的點釘在頂端。也不做 min–max
 *   正規化，以免把 0.2 的抖動放大成滿格。y 軸不共用 0–60 刻度——比值約 5 時會壓在底部 9% 又成平線。
 * - 沒有單秒比值的格子線在該處斷開，不補 0、不連過去：該秒批次為 0（背景分頁 rAF 停），或樣本標為
 *   `invalid`（暫停期間與恢復當下，見 `rate-series` 的 `invalidateNext`）。
 * - 每秒更新一次，points 直接換新（SVG `points` 無法以 CSS 過渡），任何動態偏好下都是瞬間更新。
 * - 不新增 reactive 寫入：全部由 1 Hz 的 `samples` prop 衍生。
 */
// 檔名依 tasks T034；元件名取兩個字以符合 vue/multi-word-component-names。
defineOptions({ name: "RateSparkline" });

const props = defineProps<{
  /** 由舊到新，長度 ≤ 60。 */
  samples: readonly RateSample[];
}>();

const SLOTS = 60;
const HEIGHT = 24;
/** 上下各留 1 單位，峰值與零值的線不被裁切。 */
const PAD = 1;
/** y 軸上限 = 最高單秒合併比 × HEADROOM，線頂與框頂留白。 */
const HEADROOM = 1.25;

/** 每一格的單秒合併比；該秒無批次或樣本無效為 null。 */
const ratios = computed<(number | null)[]>(() =>
  props.samples.map((s) =>
    s.invalid !== true && s.batchesPerSec > 0 ? s.msgsPerSec / s.batchesPerSec : null,
  ),
);

/** y 軸上限：max(視窗合併比 × 2, 次高單秒比) × HEADROOM，至少 1（見檔頭）。 */
const top = computed(() => {
  let msgs = 0;
  let batches = 0;
  for (const s of props.samples) {
    if (s.invalid === true) continue;
    msgs += s.msgsPerSec;
    batches += s.batchesPerSec;
  }
  const window = batches > 0 ? msgs / batches : 0;
  const sorted = ratios.value.filter((r): r is number => r !== null).sort((a, b) => b - a);
  const secondHighest = sorted[1] ?? sorted[0] ?? 0;
  return Math.max(Math.max(window * 2, secondHighest) * HEADROOM, 1);
});

/** 連續有值的格子各成一段 polyline（遇到 null 斷開）。 */
const segments = computed<string[]>(() => {
  const n = ratios.value.length;
  const scale = (HEIGHT - PAD * 2) / top.value;
  const out: string[] = [];
  let current: string[] = [];
  ratios.value.forEach((r, i) => {
    if (r === null) {
      if (current.length > 0) out.push(current.join(" "));
      current = [];
      return;
    }
    const x = SLOTS - 1 - (n - 1 - i);
    // 超出穩健上限的離群點釘在頂端
    const y = HEIGHT - PAD - Math.min(r, top.value) * scale;
    current.push(`${x},${Number(y.toFixed(2))}`);
  });
  if (current.length > 0) out.push(current.join(" "));
  return out;
});

const fmt = (r: number): string => r.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

const summary = computed(() => {
  const values = ratios.value.filter((r): r is number => r !== null);
  const latest = ratios.value[ratios.value.length - 1];
  if (values.length === 0) return "近 60 秒走勢，尚無合併比資料";
  const min = Math.min(...values);
  const max = Math.max(...values);
  const head = latest === null || latest === undefined ? "最近 1 秒無批次" : `最近 1 秒合併比 ${fmt(latest)} 比 1`;
  return `近 60 秒走勢，${head}，區間 ${fmt(min)} 至 ${fmt(max)} 比 1`;
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
        v-for="(points, i) in segments"
        :key="i"
        :points="points"
        fill="none"
        class="spark-ratio stroke-accent"
        stroke-width="1.5"
        stroke-linejoin="round"
        stroke-linecap="round"
        vector-effect="non-scaling-stroke"
      />
    </svg>
  </div>
</template>
