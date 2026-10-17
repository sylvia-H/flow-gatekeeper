<script setup lang="ts">
import { computed, useId } from "vue";
import { Stethoscope } from "lucide-vue-next";
import type { MachineLive } from "../stores/monitoring.store.js";
import { isLatchStruck, latchText, type AnomalyLatch } from "../lib/anomaly-latch.js";
import { diagnosisBadgeText, type DiagnosisBadge } from "../../ai-copilot/lib/diagnosis-badge.js";
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
  /** 異常標記：只在可見期內傳入（仍異常或回復未滿 30 秒，由 store `latchVisible` 判定）；否則 null／不傳。 */
  latch?: AnomalyLatch | null;
  /** 診斷狀態 chip（copilot store `badgeFor`）；不傳視同無診斷。 */
  badge?: DiagnosisBadge;
}>();

const emit = defineEmits<{
  (e: "select", machineId: string): void;
  (e: "diagnose", machineId: string): void;
}>();

const label = computed(() => machineLabel(props.machineId));

/**
 * 底列在卡片主按鈕外（見模板），主按鈕以 aria-describedby 指向「標記文字」與「更新時間」兩段，螢幕閱讀器仍讀得到。
 * 診斷 chip 在按鈕內，已含於名稱。
 */
const latchTextId = useId();
const updatedId = useId();

/**
 * 異常標記（FR-026）：「嚴重 · 進入 N 秒前」（仍異常，錨 enteredAt，現在式）／「曾嚴重 · N 秒前回復」（錨 recoveredAt，過去式）。
 * 文案取自 `latchText`（與異常摘要列、手機異常清單同一套）：卡片上只有狀態徽章用現在式「正常／警告／嚴重」，
 * 已回復的標記以「曾」起頭、診斷 chip 以「AI：」起頭，三者不再同字同形（T073 第四輪）。
 *
 * 標記 pill 只是狀態、不可點（T073 第三輪）：它落在「點即選台」的卡片範圍內，誤觸就是不可逆的確認。
 * 確認只走 rail「最近異常」列的確認鈕、鍵盤 `x`（聚焦卡片）與手機異常清單覆蓋層；確認後 pill 劃線，期滿才消失。
 */
const LATCH_STYLE: Record<AnomalyLatch["level"], string> = {
  critical: "border-crit bg-crit-bg text-crit-fg",
  warning: "border-warn bg-warn-bg text-warn-fg",
};
const LATCH_STRUCK_STYLE = "border-edge bg-rim text-ink-3 line-through";

const latchView = computed(() => {
  const latch = props.latch;
  if (!latch) return null;
  const struck = isLatchStruck(latch);
  const active = latch.recoveredAt === null;
  const text = latchText({ level: latch.level, active, since: latch.recoveredAt ?? latch.enteredAt }, props.now);
  return {
    level: latch.level,
    struck,
    text,
    cls: struck ? LATCH_STRUCK_STYLE : LATCH_STYLE[latch.level],
  };
});

const describedBy = computed(() => (latchView.value ? `${latchTextId} ${updatedId}` : updatedId));

/**
 * 診斷狀態 chip（FR-028，非互動）：`diagnosisBadgeText` 文案，不帶圖示（診斷中 N%／AI：嚴重度／AI：嚴重度 · 快取／AI 失敗），
 * 無診斷不渲染。「AI：」前綴與方角 4px（`rounded-control`）tag 外形交代「這是 AI 判定」，
 * 與名稱列的狀態徽章、底列的異常標記（兩者皆為全圓 pill）分得開（T073 第四輪）。
 * 這裡只決定外觀：active 帶 `border-accent`——選取中的 healthy 卡片底色是 accent-wash，沒有邊框就看不出 pill。
 */
const CHIP_STYLE: Record<Exclude<DiagnosisBadge["kind"], "none">, string> = {
  active: "border-accent bg-accent-wash text-accent",
  completed: "border-edge bg-surface-strong text-ink-2",
  failed: "border-crit bg-crit-bg text-crit-fg",
};
const CHIP_CACHED_STYLE = "border-transparent bg-rim text-ink-2";

const diagnosisKind = computed(() => props.badge?.kind ?? "none");

const chipView = computed(() => {
  const badge = props.badge;
  if (!badge || badge.kind === "none") return null;
  const text = diagnosisBadgeText(badge);
  if (text === null) return null;
  const cls = badge.kind === "completed" && badge.cached ? CHIP_CACHED_STYLE : CHIP_STYLE[badge.kind];
  return { text, cls };
});

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
 *
 * 嚴重越界另換字形（`crit`，色弱 Persona，T073 第三輪）：ok 綠與 crit 紅的亮度對比僅約 1.13:1，只換色分不出來，
 * 所以 crit 時三格刻度「全填實」——三條 3px 實心全寬短柱（`fill-crit`），取代平時的 1.5px 細線（中格短）。
 * 仍在同一個 10×14px 盒內：不改卡片高度、不推動數值（數值左對齊、tabular 位置不變）；warn 維持細線只換色。
 */
interface MetricView {
  key: MetricKey;
  label: string;
  value: string;
  unit: string;
  cls: string;
  tickCls: string;
  crit: boolean;
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
      crit: level === "crit",
    };
  });
});

/** 相對時間（「剛剛」／「N 秒前」／「N 分鐘前」，FR-022）＋ 24 小時制絕對時間 tooltip。 */
const relativeTime = computed(() =>
  props.machine ? formatRelative(props.machine.lastUpdated, props.now) : PLACEHOLDER,
);
const absoluteTime = computed(() => (props.machine ? formatClock(props.machine.lastUpdated) : undefined));
/** id 的 tooltip：相對時間平時不顯示時，滑過 id 仍讀得到絕對更新時間。 */
const idTitle = computed(() => (absoluteTime.value ? `更新於 ${absoluteTime.value}` : undefined));

/**
 * 相對時間何時「看得到」（T073 第三輪）：更新 ≥ 3 秒前或停滯才顯示。
 * 每張卡常駐「剛剛」是雜訊，還會在診斷 chip 出現時把 id 與 chip 一起擠到截斷；資料新鮮時不寫，舊了才寫。
 * 不顯示時元素仍在（`sr-only`）：aria-describedby 照樣念「更新 剛剛」，螢幕閱讀器語意不變。
 * placeholder（尚無資料）同樣不顯示「—」，可讀描述仍為「更新 —」。
 */
const SHOW_RELATIVE_AFTER_MS = 3_000;
const showRelative = computed(() => {
  const m = props.machine;
  if (!m) return false;
  return props.stale || props.now - m.lastUpdated >= SHOW_RELATIVE_AFTER_MS;
});
</script>

<template>
  <!-- 每張卡片只佔一個 Tab 停駐點（FR-034d）：卡片主按鈕 tabindex=0，診斷圖示 tabindex=-1（底列異常標記不可互動）。
       焦點環不用 ring（box-shadow），由 tailwind.css 的 `.machine-card:focus-visible` 畫 2px 外框 outline，
       並排在選取規則之後，選取＋聚焦時焦點環勝出 -->
  <div class="group relative min-w-0">
    <button
      type="button"
      tabindex="0"
      class="flex min-h-[148px] w-full min-w-0 flex-col gap-3 rounded-card border p-3.5 text-left shadow-glass transition-colors duration-150 focus:outline-none"
      :class="[CARD_ROOT_CLASS, stateClass, stale ? CARD_STALE_CLASS : '']"
      :data-machine="machineId"
      :data-state="machine ? machine.state : 'placeholder'"
      :data-selected="selected ? 'true' : 'false'"
      :data-latch="latchView ? latchView.level : 'none'"
      :data-latch-cleared="latchView?.struck ? '' : undefined"
      :data-diagnosis="diagnosisKind"
      :aria-pressed="selected"
      :aria-describedby="describedBy"
      :aria-keyshortcuts="latchView && !latchView.struck ? 'x' : undefined"
      @click="emit('select', machineId)"
    >
      <!-- 標頭兩列：名稱列＝中文名稱｜狀態文字徽章 + 狀態燈（24px 高）；id 列（固定 20px 高）橫跨整張卡片內容寬，
           依序放 id ·（更新時間）→ 停滯徽章 → 診斷 chip，出現與否不改高度。
           id 列不再與右側徽章／燈共用寬度（T073 第三輪）：220px 卡寬時內容寬 190px，id、停滯徽章與 chip 同時放得下。
           截斷優先權：更新時間最先讓位（shrink 權重最大、可截斷；停滯徽章已說明「舊了」，絕對時間在 title），
           id 最後讓位（可截斷但權重 1），停滯徽章與 chip 不縮、不截斷——chip 是卡片與面板之間唯一的橋，嚴重度不能被截掉。
           更新時間放在標頭而非底列：底列的異常標記（「曾嚴重 · 28 秒前回復」）在約 230px 寬的卡片會把它擠掉，
           放這裡則所有寬度同一版面、不靠寬度分支，標記出現與否也不動它的位置 -->
      <div class="flex min-w-0 flex-col">
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0 truncate text-md font-semibold text-ink">{{ label }}</div>
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
            <!-- 狀態燈不另脈動：整張嚴重卡片的底色已在脈動，燈再閃會在半週期與 crit-bg 底同色而消失 -->
            <StatusLight v-if="machine" :state="machine.state" />
            <span v-else class="inline-flex h-3 w-3 items-center justify-center" aria-hidden="true">
              <span class="block h-2.5 w-2.5 rounded-pill bg-etch" />
            </span>
          </div>
        </div>
        <div class="flex h-5 min-w-0 items-center gap-1 overflow-hidden">
          <span class="min-w-0 truncate font-mono text-xs text-ink-3" :title="idTitle">{{ machineId }}</span>
          <!-- 更新時間：畫面只在 ≥ 3 秒前或停滯時顯示相對時間（否則 sr-only），「更新」前綴給輔助技術；
               滑過顯示 24 小時制絕對時間。分隔點放在同一個可截斷的 span 裡：空間不足時點與時間一起讓位到 0，
               不會留下孤立的「·」 -->
          <span
            :id="updatedId"
            :class="showRelative ? 'min-w-0 shrink-[999] truncate text-xs text-ink-3' : 'sr-only'"
            :title="absoluteTime"
          ><span v-if="showRelative" class="mr-1" aria-hidden="true">·</span><span class="sr-only">更新 </span>{{ relativeTime }}</span>
          <span
            v-if="stale"
            class="inline-flex shrink-0 items-center gap-1 rounded-pill border border-stale bg-surface-strong px-2 py-px text-xs font-semibold leading-4 text-ink-2"
          >
            <span class="h-1.5 w-1.5 rounded-pill bg-stale" aria-hidden="true" />停滯
          </span>
          <!-- 診斷狀態 chip（非互動）：「AI：嚴重度」方角 tag（不帶圖示：「AI：」前綴已交代來源，T073 第四輪把 16px 還給 id）；在卡片主按鈕內，文字已含於按鈕的可讀名稱，以「診斷：」前綴區分。
               sr-only 前綴是絕對定位、不佔 flex 間距 -->
          <span
            v-if="chipView"
            class="inline-flex shrink-0 items-center whitespace-nowrap rounded-control border px-1.5 py-px text-xs font-semibold leading-4"
            :class="chipView.cls"
          ><span class="sr-only">診斷：</span>{{ chipView.text }}</span>
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
            <!-- 刻度是裝飾：越界與否已由數值顏色與狀態徽章（文字）傳達。
                 嚴重越界改畫三條 3px 實心全寬短柱（刻度「全填實」），形狀與平時的細線不同，色弱也分得出 -->
            <svg
              class="h-3.5 w-2.5 shrink-0"
              :class="[metric.tickCls, metric.crit ? 'fill-crit' : 'fill-none']"
              viewBox="0 0 10 14"
              stroke-width="1.5"
              aria-hidden="true"
              focusable="false"
              data-fg="metric-tick"
            >
              <g v-if="metric.crit" stroke="none">
                <rect x="0" y="0" width="10" height="3" />
                <rect x="0" y="5.5" width="10" height="3" />
                <rect x="0" y="11" width="10" height="3" />
              </g>
              <path v-else d="M0 12.5H10M3 7H10M0 1.5H10" />
            </svg>
          </div>
        </div>
      </div>

      <!-- 底列佔位：固定 20px 高，異常標記疊在其上（見下方底列）。
           標記放在卡片按鈕外、絕對定位對齊這一格：按鈕的可讀名稱不含標記文字，標記改由 aria-describedby 描述；
           佔位恆在，標記出現與否都不改卡片尺寸（FR-026、FR-031） -->
      <div class="mt-auto h-5" aria-hidden="true" />
    </button>

    <!-- 底列：只放異常標記，右側留給診斷圖示（right-12 = 圖示 28px ＋ 間距）。
           位置對齊卡片內容區（1px 邊框 ＋ 14px 內距）。標記保留 truncate 當最後防線，正常寬度不觸發。
           整列（含標記 pill）不接收指標事件：點在標記上＝點卡片＝選台。標記不可點（T073 第三輪），
           確認走 rail「最近異常」列、鍵盤 x 與手機異常清單覆蓋層 -->
    <div
      class="pointer-events-none absolute bottom-[15px] left-[15px] right-12 flex h-5 min-w-0 items-center gap-1.5 overflow-hidden text-xs text-ink-3"
    >
      <span
        v-if="latchView"
        data-fg="latch-mark"
        class="min-w-0 max-w-full animate-latch-in truncate rounded-pill border px-2 py-px font-semibold leading-4"
        :class="latchView.cls"
      ><span :id="latchTextId"><span v-if="latchView.struck" class="sr-only">已確認：</span>{{ latchView.text }}</span></span>
    </div>

    <!-- 診斷圖示（作用於該台；滑鼠可點）。store 內部去重／連線把關。
         不另佔 Tab 停駐點（tabindex=-1，FR-034d）：鍵盤替代為 Enter 選取卡片後按 d（d 作用於選取機台）。
         卡片 hover 或取得焦點（group-focus-within）時顯示；觸控裝置沒有 hover：`opacity-0` 的按鈕看不見卻點得到，
         所以 (hover: none) 時常駐顯示。mousedown.prevent：點擊不把焦點從卡片搶走，方向鍵與 x 仍作用於原卡片 -->
    <button
      type="button"
      tabindex="-1"
      class="absolute bottom-2.5 right-2.5 rounded-control border border-edge bg-surface-strong p-1.5 text-ink-3 opacity-0 transition hover:border-accent hover:text-accent focus:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-focus group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100"
      :aria-label="`診斷 ${label}`"
      aria-keyshortcuts="d"
      title="診斷（鍵盤：選取卡片後按 d）"
      @mousedown.prevent
      @click="emit('diagnose', machineId)"
    >
      <Stethoscope class="h-3.5 w-3.5" aria-hidden="true" />
    </button>
  </div>
</template>
