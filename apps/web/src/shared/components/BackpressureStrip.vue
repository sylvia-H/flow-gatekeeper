<script setup lang="ts">
import { computed } from "vue";
import { ArrowRight } from "lucide-vue-next";
import Graduation from "./Graduation.vue";
import Sparkline from "./Sparkline.vue";
import type { RateSample } from "../../domains/monitoring/lib/rate-series.js";

/**
 * 背壓 strip（spec FR-009／FR-009a／FR-010／FR-011、US2）：主區頂端常駐的一片玻璃，
 * 讀數「每秒訊息 → 每秒批次 → 比值」、近 60 秒走勢線、下緣比值刻度與深青液位線、丟棄數與中斷標示。
 *
 * 只收 props（資料由 App 從 monitoring store 餵，每秒至多更新一次），不讀 store、不訂閱任何高頻來源。
 *
 * 版面（工具列正下方；桌機約 96px 高）。原則：**任何讀數或標示的出現／消失都不改變 strip 高度**，
 * 拓樸區才不會跟著上下跳（FR-031）。
 * - 上列：三組「小字標籤在上、數值在下」的讀數，接著是走勢區（flex-1 吃掉剩餘寬度）——走勢線與
 *   狀態欄（中斷標示、丟棄數）同在走勢區內、固定高度，狀態出現時只壓縮走勢線寬度。
 * - 下列：比值刻度（0–60）與液位線；右側固定留一格給「>60」（比值超過刻度上限時才有字），
 *   這一格恆佔位，液位線與刻度不會因它出現而位移。
 * - 依 strip 自身寬度（container query）收斂：窄於 36rem 拿掉讀數間的箭頭；窄於 32rem（例：1024 寬
 *   且 Copilot 面板展開、768 直式）整個走勢區改到讀數下方獨佔一列（約 146px 高），狀態仍與走勢線同列。
 * - 手機（< md）只保留每秒訊息、比值與丟棄數（FR-009、FR-011），標籤改放數值左側、單列不換行；
 *   其下仍有比值刻度（`Graduation compact`，18px）與液位線——量筒在手機上也認得出來（FR-009a）。
 *   約 70px 高；丟棄數的位置恆存在（無丟棄時為空），出現時不改變高度。「連線中斷」手機不顯示，
 *   由主區橫幅說明。
 */
const props = defineProps<{
  /** 近 60 秒樣本（由舊到新）。 */
  samples: readonly RateSample[];
  /** 走勢線 y 軸上限。 */
  peak: number;
  /** 60 秒視窗比值；null＝視窗內尚無批次（顯示「—」、不畫液位線）。 */
  windowRatio: number | null;
  /** 自載入起的累計比值；null＝尚無任何批次。 */
  cumulativeRatio: number | null;
  /** 60 秒視窗內的丟棄總數；> 0 才顯示。 */
  dropped: number;
  /** 序列因斷線停止更新。 */
  stale: boolean;
  /** 最近一秒的每秒訊息數；null＝尚無樣本。 */
  msgsPerSec: number | null;
  /** 最近一秒的每秒批次數；null＝尚無樣本。 */
  batchesPerSec: number | null;
}>();

/** 比值刻度上限（FR-009a）。 */
const SCALE_MAX = 60;

const fmtInt = (n: number | null): string => (n === null ? "—" : n.toLocaleString("en-US"));
const fmtRatio = (r: number): string =>
  r.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

const msgsText = computed(() => fmtInt(props.msgsPerSec));
const batchesText = computed(() => fmtInt(props.batchesPerSec));
const ratioText = computed(() => (props.windowRatio === null ? "—" : fmtRatio(props.windowRatio)));
const droppedText = computed(() => props.dropped.toLocaleString("en-US"));
const cumulativeText = computed(() =>
  props.cumulativeRatio === null ? null : props.cumulativeRatio.toLocaleString("en-US"),
);

/** 比值超過刻度上限：液位線釘右端並標「>60」，數字照實顯示。 */
const overScale = computed(() => props.windowRatio !== null && props.windowRatio > SCALE_MAX);
/**
 * 液位線位移（刻度寬度的百分比）；無比值時為 null（不畫）。用 transform 而非 left，
 * 過渡走合成層、不觸發版面重排。
 */
const levelTransform = computed(() =>
  props.windowRatio === null
    ? null
    : `translateX(${(Math.min(Math.max(props.windowRatio, 0), SCALE_MAX) / SCALE_MAX) * 100}%)`,
);

const regionLabel = computed(() => {
  const parts = [
    props.windowRatio === null ? "比值尚無資料" : `比值 ${fmtRatio(props.windowRatio)} 比 1`,
  ];
  if (cumulativeText.value !== null) parts.push(`自載入起累計 ${cumulativeText.value} 比 1`);
  if (props.stale) parts.push("連線中斷");
  return `背壓，${parts.join("，")}`;
});

const ratioTitle = computed(
  () =>
    `近 60 秒視窗的訊息總數 ÷ 批次總數；自載入起累計 ${cumulativeText.value === null ? "—" : `${cumulativeText.value}:1`}`,
);
</script>

<template>
  <section
    data-fg="backpressure"
    role="region"
    :aria-label="regionLabel"
    :data-stale="stale ? 'true' : undefined"
    class="bp-root rounded-card border border-edge bg-surface/72 px-3.5 py-2 shadow-glass"
  >
    <!-- 上列：讀數、走勢區（手機單列不換行；md+ 窄版由 container query 讓走勢區換到下一列） -->
    <div class="flex flex-nowrap items-end gap-x-3 gap-y-1.5 md:flex-wrap">
      <!-- 每秒訊息（手機保留） -->
      <div class="flex shrink-0 items-baseline gap-1.5 md:flex-col md:items-start md:gap-0">
        <span class="flex items-center gap-1 text-xs text-ink-2">
          <svg class="hidden h-1 w-3 md:block" viewBox="0 0 12 4" aria-hidden="true" focusable="false">
            <line x1="0" y1="2" x2="12" y2="2" class="stroke-ink-2" stroke-width="1.5" />
          </svg>
          每秒訊息
        </span>
        <span class="min-w-[5ch] font-mono text-number font-medium tabular-nums text-ink">
          {{ msgsText }}
        </span>
      </div>

      <ArrowRight class="bp-arrow mb-1.5 hidden h-4 w-4 shrink-0 text-ink-3 md:block" aria-hidden="true" />

      <!-- 每秒批次（手機省略） -->
      <div class="bp-batches hidden md:flex md:flex-col">
        <span class="flex items-center gap-1 text-xs text-ink-2">
          <svg class="h-1 w-3" viewBox="0 0 12 4" aria-hidden="true" focusable="false">
            <line
              x1="0"
              y1="2"
              x2="12"
              y2="2"
              class="stroke-accent"
              stroke-width="1.5"
              stroke-dasharray="3 2"
            />
          </svg>
          每秒批次
        </span>
        <span class="min-w-[3ch] font-mono text-number font-medium tabular-nums text-ink">
          {{ batchesText }}
        </span>
      </div>

      <ArrowRight class="bp-arrow mb-1.5 hidden h-4 w-4 shrink-0 text-ink-3 md:block" aria-hidden="true" />

      <!-- 比值：60 秒視窗；累計比值放 tooltip 與 region 名稱 -->
      <div
        class="flex shrink-0 items-baseline gap-1.5 md:flex-col md:items-start md:gap-0"
        :title="ratioTitle"
      >
        <span class="text-xs text-ink-2">比值</span>
        <span class="flex items-baseline gap-0.5">
          <span
            data-fg="ratio"
            class="min-w-[4ch] font-mono text-ratio font-semibold leading-none tabular-nums"
            :class="stale ? 'text-ink-2' : 'text-accent'"
          >
            {{ ratioText }}
          </span>
          <!-- 恆佔位：比值 null↔有值時寬度不變，右側走勢線起點不位移 -->
          <span
            class="bp-ratio-unit font-mono text-sm text-ink-2"
            :class="{ invisible: windowRatio === null }"
            aria-hidden="true"
          >:1</span>
        </span>
      </div>

      <!-- 手機的丟棄數：位置恆存在（無丟棄時為空），出現時不改變高度 -->
      <span
        class="bp-dropped-mobile ml-auto min-w-0 truncate text-xs font-semibold text-warn-fg md:hidden"
      >
        <template v-if="dropped > 0">丟棄 <span class="font-mono tabular-nums">{{ droppedText }}</span></template>
      </span>

      <!-- 走勢區（手機省略）：近 60 秒走勢線＋狀態欄，固定高度；狀態出現只壓縮走勢線寬度 -->
      <div
        class="bp-trend hidden h-12 min-w-24 flex-1 basis-24 items-stretch gap-3 md:flex"
      >
        <Sparkline class="flex min-w-0 flex-1 flex-col" :samples="samples" :peak="peak" />

        <div
          v-if="stale || dropped > 0"
          class="bp-status flex shrink-0 flex-col items-end justify-end gap-1"
        >
          <span
            v-if="stale"
            class="inline-flex h-5 items-center gap-1.5 rounded-pill border border-edge px-2 text-xs font-semibold text-ink-2"
          >
            <span class="h-1.5 w-1.5 shrink-0 rounded-pill bg-stale" aria-hidden="true" />
            連線中斷
          </span>
          <span
            v-if="dropped > 0"
            class="inline-flex h-5 items-center gap-1.5 text-xs font-semibold text-warn-fg"
          >
            <span class="h-1.5 w-1.5 shrink-0 rounded-pill bg-warn" aria-hidden="true" />
            丟棄 <span class="font-mono tabular-nums">{{ droppedText }}</span> 筆
          </span>
        </div>
      </div>
    </div>

    <!-- 下列：比值刻度與液位線（md+；手機版在下方 .bp-scale-mobile）；右側一格恆佔位給「>60」 -->
    <div class="bp-scale mt-1.5 hidden items-start gap-2 md:flex">
      <div class="relative min-w-0 flex-1">
        <Graduation />
        <!-- 液位線：外層裁切框（左右各多 4px，釘在兩端時線不被裁半）內放一層與刻度等寬的位移層，
             以 translateX(比值/60) 移動；裁切避免位移層超出 strip 造成橫向捲動 -->
        <div
          v-if="levelTransform !== null"
          class="pointer-events-none absolute -inset-x-1 -top-1.5 bottom-0 overflow-hidden"
          aria-hidden="true"
        >
          <div
            class="bp-level absolute inset-y-0 left-1 right-1 motion-safe:transition-transform motion-safe:duration-500 motion-safe:ease-out"
            :style="{ transform: levelTransform }"
            :data-over="overScale ? 'true' : undefined"
          >
            <span class="absolute left-0 top-0 h-3.5 w-0.5 -translate-x-1/2 rounded-control bg-accent" />
          </div>
        </div>
      </div>
      <span
        class="bp-over w-7 shrink-0 font-mono text-xs font-semibold leading-4 text-accent"
        aria-hidden="true"
      >{{ overScale ? ">60" : "" }}</span>
    </div>

    <!-- 手機（< md）的比值刻度與液位線：同一套量筒縮成 18px 高（刻度 6px＋數字 12px），恆渲染、
         不隨比值有無或丟棄數出現而改變高度；液位線同桌機以 translateX 位移、>60 釘右端並標「>60」 -->
    <div class="bp-scale-mobile mt-0.5 flex items-start gap-2 md:hidden">
      <div class="relative min-w-0 flex-1">
        <Graduation compact />
        <div
          v-if="levelTransform !== null"
          class="pointer-events-none absolute -inset-x-1 -top-0.5 bottom-0 overflow-hidden"
          aria-hidden="true"
        >
          <div
            class="bp-level-mobile absolute inset-y-0 left-1 right-1 motion-safe:transition-transform motion-safe:duration-500 motion-safe:ease-out"
            :style="{ transform: levelTransform }"
            :data-over="overScale ? 'true' : undefined"
          >
            <span class="absolute left-0 top-0 h-2 w-0.5 -translate-x-1/2 rounded-control bg-accent" />
          </div>
        </div>
      </div>
      <span
        class="bp-over-mobile w-7 shrink-0 font-mono text-xs font-semibold leading-3 text-accent"
        aria-hidden="true"
      >{{ overScale ? ">60" : "" }}</span>
    </div>
  </section>
</template>

<style scoped>
/* 依 strip 自身寬度收斂（Copilot 面板開合會改變主區寬度，比視窗斷點準）。 */
.bp-root {
  container-type: inline-size;
}
@container (max-width: 36rem) {
  .bp-arrow {
    display: none;
  }
}
/* 窄版：整個走勢區（走勢線＋狀態欄）換到下一列；高度固定為狀態欄兩行所需（2×20px＋4px）。 */
@container (max-width: 32rem) {
  .bp-trend {
    order: 10;
    flex-basis: 100%;
    height: 2.75rem;
  }
}
</style>
