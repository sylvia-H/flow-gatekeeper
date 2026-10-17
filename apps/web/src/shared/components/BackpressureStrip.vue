<script setup lang="ts">
import { computed } from "vue";
import { ArrowRight } from "lucide-vue-next";
import Graduation from "./Graduation.vue";
import Sparkline from "./Sparkline.vue";
import {
  averageOf,
  peakRatio,
  totalOf,
  validSamples,
  type RateSample,
} from "../../domains/monitoring/lib/rate-series.js";

/**
 * 背壓 strip（spec FR-009／FR-009a／FR-010／FR-011、US2）：主區頂端常駐的一片玻璃，
 * 讀數「每秒訊息 → 每秒批次 → 合併比」、近 60 秒合併比走勢線、下緣比值刻度（含液柱）與深青液位線、
 * 丟棄數與中斷／暫停標示。
 *
 * **合併比**（critique 2026-10-17 P2）：畫面標籤由「比值」改「合併比」並就地附 ink-3 說明
 * 「訊息 ÷ 批次」（窗口與兩個兄弟讀數同為近 60 秒、右鄰走勢線也標「近 60 秒」，不再重複；手機只留「合併比」，
 * 完整白話在 `title` 與 region 名稱），不必 hover 才懂；刻度從 0 到液位
 * 畫實心液柱（`Graduation` 的 `level`），量筒裡看得到液體；走勢線只畫單秒合併比一條（見 `Sparkline`）。
 *
 * **三個讀數同一個視窗**（critique 2026-10-16 P1）：每秒訊息、每秒批次都是近 60 秒樣本的平均，比值是
 * 同一組樣本的 Σ訊息 ÷ Σ批次，所以「平均訊息 ÷ 平均批次 = 比值」，箭頭鏈算得通（只差顯示的四捨五入）。
 * 最近 1 秒的瞬時值與 60 秒總量放在各讀數的 `title`，累計比值放在比值的 `title` 與 region 名稱。
 * 刻度上另有一條「近 60 秒最高水位」蝕刻短線（`Graduation` 的 `highWater`），讓比值落在刻度哪一段有參照。
 *
 * **常駐白話**（critique 2026-10-17 第三輪 P2／H10）：≥ md 時走勢區最左一行 12px ink-3「每幀合併約 5 則 ·
 * 近 60 秒最高 6.1」，不必 hover 也看得懂比值在說什麼；放在走勢區（固定高度）內，只壓縮走勢線寬度、不增加
 * strip 高度，空間不足時截斷（全文在 `title`）。手機（< md）不顯示，全文在比值的 `title` 與 region 名稱。
 * 刻度上 1:1 處另有蝕刻錨點（`Graduation`），標出「1 以上就是在合併」的起點。
 *
 * **用語**（T073 第四輪）：丟棄數一律「丟棄 N 則」（桌機、手機、tooltip、region 名稱同字）；斷線 pill 與 TopBar
 * 連線 chip、主區橫幅同字——「已斷線」，`connection` 為 `reconnecting` 時「重新連線中」。
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
 *   約 70px 高；丟棄數的位置恆存在（無丟棄時為空），出現時不改變高度。斷線與「已暫停」pill 手機不顯示，
 *   由主區橫幅說明。
 */
const props = defineProps<{
  /** 近 60 秒樣本（由舊到新）。 */
  samples: readonly RateSample[];
  /** 60 秒視窗比值；null＝視窗內尚無批次（顯示「—」、不畫液位線）。 */
  windowRatio: number | null;
  /** 自載入起的累計比值；null＝尚無任何批次。 */
  cumulativeRatio: number | null;
  /** 60 秒視窗內的丟棄總數；> 0 才顯示。 */
  dropped: number;
  /** 序列因斷線停止更新。 */
  stale: boolean;
  /**
   * 連線狀態（與 TopBar 連線 chip 同一來源 `store.connectionStatus`）：只用來決定 stale 時 pill 的字——
   * `reconnecting` 顯示「重新連線中」，其餘（含未傳）顯示「已斷線」。
   */
  connection?: "connected" | "reconnecting" | "disconnected";
  /** 使用者按了暫停（畫面凍結、資料續收）：狀態欄顯示「已暫停」。 */
  paused?: boolean;
  /** 最近一秒的每秒訊息數（只進 tooltip；主顯示是近 60 秒平均）；null＝尚無樣本。 */
  msgsPerSec: number | null;
  /** 最近一秒的每秒批次數（只進 tooltip；主顯示是近 60 秒平均）；null＝尚無樣本。 */
  batchesPerSec: number | null;
}>();

/** 比值刻度上限（FR-009a）。 */
const SCALE_MAX = 60;

const fmtInt = (n: number | null): string => (n === null ? "—" : n.toLocaleString("en-US"));
const fmtRatio = (r: number): string =>
  r.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

const fmtAvg = (n: number | null): string => (n === null ? "—" : fmtInt(Math.round(n)));

// 以下全由 `samples`（store 每秒至多換一次）衍生，不新增任何高頻 reactive 寫入。
const avgMsgs = computed(() => averageOf(props.samples, "msgsPerSec"));
const avgBatches = computed(() => averageOf(props.samples, "batchesPerSec"));
const msgsText = computed(() => fmtAvg(avgMsgs.value));
const batchesText = computed(() => fmtAvg(avgBatches.value));
/** 近 60 秒最高水位；視窗內無批次時為 null（不畫）。 */
const highWater = computed(() => peakRatio(props.samples));

/** 讀數 tooltip：視窗平均的來由（N 秒共 M 筆）與最近 1 秒的瞬時值。 */
function rateTitle(unit: string, key: "msgsPerSec" | "batchesPerSec", latest: number | null): string {
  // 暫停期間與恢復當下的樣本不計（rate-series 的 invalid），「N 秒」與平均的分母一致
  const n = validSamples(props.samples).length;
  const head =
    n === 0
      ? `近 60 秒平均：尚無資料`
      : `近 60 秒平均：${n} 秒共 ${totalOf(props.samples, key).toLocaleString("en-US")} ${unit} ÷ ${n}`;
  return `${head}；最近 1 秒 ${fmtInt(latest)}`;
}
const msgsTitle = computed(() => rateTitle("則", "msgsPerSec", props.msgsPerSec));
const batchesTitle = computed(() => rateTitle("批", "batchesPerSec", props.batchesPerSec));
const ratioText = computed(() => (props.windowRatio === null ? "—" : fmtRatio(props.windowRatio)));
const droppedText = computed(() => props.dropped.toLocaleString("en-US"));
/** 累計比值與視窗比值、最高水位同用一位小數（store 給未取整的值）。 */
const cumulativeText = computed(() => (props.cumulativeRatio === null ? null : fmtRatio(props.cumulativeRatio)));

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

/**
 * 常駐白話行（≥ md）：「每幀合併約 N 則 · 近 60 秒最高 X」。N 取整（「約」）、最高水位沿用一位小數；
 * 兩者都由排除無效樣本（暫停期間、恢復當下）的視窗值衍生。四捨五入到 1 以下時改說「幾乎無合併」——
 * 每批至少 1 則，1:1 就是每則訊息各自重繪。
 */
const plainText = computed(() => {
  const r = props.windowRatio;
  const head =
    r === null ? "每幀合併約 — 則" : Math.round(r) <= 1 ? "每幀約 1 則 · 幾乎無合併" : `每幀合併約 ${Math.round(r)} 則`;
  return highWater.value === null ? head : `${head} · 近 60 秒最高 ${fmtRatio(highWater.value)}`;
});

/** 丟棄數的統一說法（桌機、手機、tooltip、region 名稱同字）。 */
const droppedLabel = computed(() => `丟棄 ${droppedText.value} 則`);
const droppedTitle = computed(() => `近 60 秒${droppedLabel.value}訊息（buffer 溢位合併或格式不符被剔除）`);

/** 斷線 pill 的字：與 TopBar 連線 chip、主區橫幅同字。 */
const staleText = computed(() => (props.connection === "reconnecting" ? "重新連線中" : "已斷線"));

const regionLabel = computed(() => {
  const parts =
    props.windowRatio === null
      ? ["合併比尚無資料"]
      : [
          `合併比 ${fmtRatio(props.windowRatio)} 比 1`,
          `每幀平均合併 ${fmtRatio(props.windowRatio)} 則訊息`,
        ];
  if (highWater.value !== null) parts.push(`近 60 秒最高 ${fmtRatio(highWater.value)} 比 1`);
  if (cumulativeText.value !== null) parts.push(`自載入起累計 ${cumulativeText.value} 比 1`);
  if (props.dropped > 0) parts.push(`近 60 秒${droppedLabel.value}`);
  if (props.stale) parts.push(staleText.value);
  if (props.paused === true) parts.push("已暫停畫面更新");
  return `背壓，${parts.join("，")}`;
});

const ratioTitle = computed(() => {
  const parts = [
    props.windowRatio === null
      ? "近 60 秒訊息總數 ÷ 批次總數（每幀一批）：尚無批次"
      : `近 60 秒訊息總數 ÷ 批次總數（每幀一批）：每幀平均合併 ${fmtRatio(props.windowRatio)} 則訊息`,
    "1:1 表示每則訊息各自重繪、沒有合併；比值越高，代表替畫面省下越多次重繪",
  ];
  if (highWater.value !== null) parts.push(`近 60 秒最高 ${fmtRatio(highWater.value)}:1（刻度上的細短線）`);
  parts.push(`自載入起累計 ${cumulativeText.value === null ? "—" : `${cumulativeText.value}:1`}`);
  return parts.join("；");
});
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
      <div
        class="bp-msgs flex shrink-0 items-baseline gap-1.5 md:flex-col md:items-start md:gap-0"
        :title="msgsTitle"
      >
        <span class="whitespace-nowrap text-xs text-ink-2">
          每秒訊息<span class="text-ink-3"> · 近 60 秒</span>
        </span>
        <span class="min-w-[5ch] font-mono text-number font-medium tabular-nums text-ink">
          {{ msgsText }}
        </span>
      </div>

      <ArrowRight class="bp-arrow mb-1.5 hidden h-4 w-4 shrink-0 text-ink-3 md:block" aria-hidden="true" />

      <!-- 每秒批次（手機省略） -->
      <div class="bp-batches hidden md:flex md:flex-col" :title="batchesTitle">
        <span class="whitespace-nowrap text-xs text-ink-2">
          每秒批次<span class="text-ink-3"> · 近 60 秒</span>
        </span>
        <span class="min-w-[3ch] font-mono text-number font-medium tabular-nums text-ink">
          {{ batchesText }}
        </span>
      </div>

      <ArrowRight class="bp-arrow mb-1.5 hidden h-4 w-4 shrink-0 text-ink-3 md:block" aria-hidden="true" />

      <!-- 合併比：同一個 60 秒視窗（= 左兩數相除）；就地說明「訊息 ÷ 批次」，最高水位與累計比值放 tooltip 與 region 名稱 -->
      <div
        class="bp-ratio flex shrink-0 items-baseline gap-1.5 md:flex-col md:items-start md:gap-0"
        :title="ratioTitle"
      >
        <span class="whitespace-nowrap text-xs text-ink-2">
          合併比<span class="bp-ratio-hint hidden text-ink-3 md:inline"> · 訊息 ÷ 批次</span>
        </span>
        <!-- 最小寬度給整組（數字＋「:1」，約 4 位數；md+ 才需要，手機右側沒有走勢線），「:1」緊貼數字，
             比值位數變化時右側走勢線起點不位移 -->
        <span class="bp-ratio-group flex items-baseline gap-0.5 md:min-w-24">
          <span
            data-fg="ratio"
            class="font-mono text-ratio font-semibold leading-none tabular-nums"
            :class="stale ? 'text-ink-2' : 'text-accent'"
          >
            {{ ratioText }}
          </span>
          <!-- 恆佔位：比值 null↔有值時版面不變 -->
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
        :title="dropped > 0 ? droppedTitle : undefined"
      >
        <template v-if="dropped > 0">丟棄 <span class="font-mono tabular-nums">{{ droppedText }}</span> 則</template>
      </span>

      <!-- 走勢區（手機省略）：常駐白話行＋近 60 秒走勢線＋狀態欄，固定高度；白話行與狀態只壓縮走勢線寬度 -->
      <div
        class="bp-trend hidden h-12 min-w-24 flex-1 basis-24 items-stretch gap-3 md:flex"
      >
        <!-- 常駐白話（critique 第三輪 P2）：底端對齊比值數字；恆渲染（無比值時「—」），走勢線起點不因它出現而位移；
             空間不足時截斷，全文在 title；aria-hidden——同樣的內容由 region 名稱念，避免重複朗讀 -->
        <p
          data-fg="ratio-plain"
          class="bp-plain flex min-w-0 shrink flex-col justify-end pb-0.5 text-xs text-ink-3"
          :title="plainText"
          aria-hidden="true"
        >
          <span class="truncate tabular-nums">{{ plainText }}</span>
        </p>
        <Sparkline class="flex min-w-16 flex-1 flex-col" :samples="samples" />

        <div
          v-if="stale || paused || dropped > 0"
          class="bp-status flex shrink-0 flex-col items-end justify-end gap-1"
        >
          <span
            v-if="stale"
            class="inline-flex h-5 items-center gap-1.5 rounded-pill border border-edge px-2 text-xs font-semibold text-ink-2"
          >
            <span class="h-1.5 w-1.5 shrink-0 rounded-pill bg-stale" aria-hidden="true" />
            {{ staleText }}
          </span>
          <!-- 暫停：比照斷線 pill；斷線時兩者都成立則只顯示斷線（資料本身已停，較要緊），
               狀態欄維持至多兩行（中斷或暫停一行＋丟棄一行），走勢區高度不變 -->
          <span
            v-else-if="paused"
            data-fg="bp-paused"
            class="inline-flex h-5 items-center gap-1.5 rounded-pill border border-edge px-2 text-xs font-semibold text-ink-2"
          >
            <span class="h-1.5 w-1.5 shrink-0 rounded-pill bg-ink-2" aria-hidden="true" />
            已暫停
          </span>
          <span
            v-if="dropped > 0"
            class="inline-flex h-5 items-center gap-1.5 text-xs font-semibold text-warn-fg"
            :title="droppedTitle"
          >
            <span class="h-1.5 w-1.5 shrink-0 rounded-pill bg-warn" aria-hidden="true" />
            丟棄 <span class="font-mono tabular-nums">{{ droppedText }}</span> 則
          </span>
        </div>
      </div>
    </div>

    <!-- 下列：比值刻度與液位線（md+；手機版在下方 .bp-scale-mobile）；右側一格恆佔位給「>60」 -->
    <div class="bp-scale mt-1.5 hidden items-start gap-2 md:flex">
      <div class="relative min-w-0 flex-1">
        <Graduation :high-water="highWater" :level="windowRatio" />
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
        <Graduation compact :high-water="highWater" :level="windowRatio" />
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
