<script setup lang="ts">
import { computed, useId } from "vue";
import { Stethoscope } from "lucide-vue-next";
import type { MachineLive } from "../stores/monitoring.store.js";
import { isLatchStruck, type AnomalyLatch } from "../lib/anomaly-latch.js";
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
  (e: "clear-latch", machineId: string): void;
}>();

const label = computed(() => machineLabel(props.machineId));

/**
 * 底列在卡片主按鈕外（見模板），主按鈕以 aria-describedby 指向「標記文字」與「更新時間」兩段，螢幕閱讀器仍讀得到；
 * 不指向整個底列——那會把清除鈕的可讀名稱（含「清除…」）一併讀成卡片描述。診斷 chip 在按鈕內，已含於名稱。
 */
const latchTextId = useId();
const updatedId = useId();

/**
 * 異常標記（FR-026）：「嚴重 · 進入 N 秒前」（仍異常，錨 enteredAt）／「嚴重 · 已回復 N 秒前」（錨 recoveredAt）。
 * `formatRelative` 在 2 秒內回「剛剛」，此時改寫成「剛進入」／「剛回復」，避免「進入 剛剛」的語序（與異常摘要列同一套文案）。
 * 已確認（劃線）者不可再清除：按鈕 disabled、可讀名稱改為「已確認：…」。
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
  const recovered = latch.recoveredAt !== null;
  const rel = formatRelative(latch.recoveredAt ?? latch.enteredAt, props.now);
  const phrase = rel === "剛剛" ? (recovered ? "剛回復" : "剛進入") : `${recovered ? "已回復" : "進入"} ${rel}`;
  const text = `${STATE_STYLE[latch.level].label} · ${phrase}`;
  return {
    level: latch.level,
    struck,
    text,
    cls: struck ? LATCH_STRUCK_STYLE : LATCH_STYLE[latch.level],
    ariaLabel: struck ? `已確認：${label.value} ${text}` : `${text}，清除 ${label.value} 的異常標記`,
  };
});

const describedBy = computed(() => (latchView.value ? `${latchTextId} ${updatedId}` : updatedId));

function onClearLatch(event: MouseEvent): void {
  // 清除鈕不在卡片主按鈕內，仍擋下冒泡：外層若日後掛點擊行為，清除不可連帶選台。
  event.stopPropagation();
  if (latchView.value && !latchView.value.struck) emit("clear-latch", props.machineId);
}

/**
 * 診斷狀態 chip（FR-028，非互動）：文案由 `diagnosisBadgeText` 產生（診斷中 N%／結果 · 嚴重度／快取 · 嚴重度／失敗），
 * 無診斷不渲染。這裡只決定外觀：active 帶 `border-accent`——選取卡片的底色也是 accent-wash，沒有邊框就看不出 pill。
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
  <!-- 每張卡片只佔一個 Tab 停駐點（FR-034d）：卡片主按鈕 tabindex=0，底列清除鈕與診斷圖示 tabindex=-1。
       焦點環不用 ring（box-shadow）：critical 的 pulse 動畫動的是 box-shadow，會把 ring 蓋掉；
       改由 tailwind.css 的 `.machine-card:focus-visible` 畫 2px 外框 outline，並排在選取規則之後，選取＋聚焦時焦點環勝出 -->
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
      @click="emit('select', machineId)"
    >
      <!-- 標頭：名稱列只放中文名稱｜狀態文字徽章 + 狀態燈；id 列（固定 20px 高）依序放 id → 停滯徽章 → 診斷 chip，
           出現與否不改高度，220px 寬時名稱不被擠成「壓製機 0…」。id 列空間不足時 id 先讓位（shrink 權重大、可截斷），
           徽章不縮；停滯與 chip 同時出現又極窄時 chip 才截斷（不溢出蓋到右側狀態徽章） -->
      <div class="flex items-start justify-between gap-2">
        <div class="min-w-0">
          <div class="truncate text-md font-semibold text-ink">{{ label }}</div>
          <div class="flex h-5 min-w-0 items-center gap-1.5">
            <span class="min-w-0 shrink-[999] truncate font-mono text-xs text-ink-3">{{ machineId }}</span>
            <span
              v-if="stale"
              class="inline-flex shrink-0 items-center gap-1 rounded-pill border border-stale bg-surface-strong px-2 py-px text-xs font-semibold leading-4 text-ink-2"
            >
              <span class="h-1.5 w-1.5 rounded-pill bg-stale" aria-hidden="true" />停滯
            </span>
            <!-- 診斷狀態 chip（非互動）：在卡片主按鈕內，文字已含於按鈕的可讀名稱，以「診斷：」前綴區分 -->
            <span
              v-if="chipView"
              class="min-w-0 truncate rounded-pill border px-2 py-px text-xs font-semibold leading-4"
              :class="chipView.cls"
            ><span class="sr-only">診斷：</span>{{ chipView.text }}</span>
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

      <!-- 底列佔位：固定 20px 高，實際內容（異常標記、更新時間）疊在其上（見下方底列）。
           標記清除鈕是按鈕，不能巢狀在卡片按鈕內，所以底列放在卡片按鈕外、絕對定位對齊這一格；
           佔位恆在，標記出現與否都不改卡片尺寸（FR-026、FR-031）。
           底列不接收指標事件，滑過時落在這一格，24 小時制絕對時間 tooltip 掛在這裡 -->
      <div class="mt-auto h-5" :title="absoluteTime" aria-hidden="true" />
    </button>

    <!-- 底列：左起 異常標記 → 更新時間，右側留給診斷圖示（right-12 = 圖示 28px ＋ 間距）。
           位置對齊卡片內容區（1px 邊框 ＋ 14px 內距）。空間不足時更新時間先收（shrink 權重大），標記不縮。
           整列不接收指標事件（點擊落到卡片＝選台），只有未確認的清除鈕可點；
           mousedown.prevent：點清除後按鈕轉 disabled，不讓焦點先移到它、再掉到 body -->
    <div
      class="pointer-events-none absolute bottom-[15px] left-[15px] right-12 flex h-5 min-w-0 items-center gap-1.5 overflow-hidden text-xs text-ink-3"
    >
      <button
        v-if="latchView"
        type="button"
        data-fg="latch-clear"
        tabindex="-1"
        class="max-w-full shrink-0 animate-latch-in truncate rounded-pill border px-2 py-px font-semibold leading-4 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus"
        :class="[latchView.cls, latchView.struck ? '' : 'pointer-events-auto hover:border-current']"
        :disabled="latchView.struck"
        :aria-label="latchView.ariaLabel"
        @mousedown.prevent
        @click="onClearLatch"
      >
        <span :id="latchTextId"><span v-if="latchView.struck" class="sr-only">已確認：</span>{{ latchView.text }}</span>
      </button>
      <span :id="updatedId" class="min-w-0 shrink-[999] truncate">更新 {{ relativeTime }}</span>
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
      title="診斷（鍵盤：選取卡片後按 d）"
      @mousedown.prevent
      @click="emit('diagnose', machineId)"
    >
      <Stethoscope class="h-3.5 w-3.5" aria-hidden="true" />
    </button>
  </div>
</template>
