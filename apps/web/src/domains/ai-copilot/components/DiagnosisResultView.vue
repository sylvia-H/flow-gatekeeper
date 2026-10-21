<script setup lang="ts">
import { computed, ref, useId, watch } from "vue";
import type { DiagnosisResult } from "@flow-gatekeeper/contracts";
import SeverityBadge from "../../../shared/components/SeverityBadge.vue";
import { formatClock } from "../../../shared/lib/format.js";
import { mergeEvidence, splitPreview } from "../lib/evidence-merge.js";
import type { CompareBar, TimingLabel } from "../lib/diagnosis-timing.js";
import SuggestedActionList from "./SuggestedActionList.vue";
import EvidenceRows from "./EvidenceRows.vue";

/**
 * 結構化診斷結果（FR-006、FR-020～FR-023；013 視覺層與繁中文案，research R13）。欄位對齊契約
 * `DiagnosisResult`（單一來源，後端已 `DiagnosisResultSchema.parse()`；前端不放寬）。
 *
 * 版面由上而下：嚴重度色條（頂部 2px，語意色只用在邊框類元素）→ 完成 meta（快取態另畫同刻度的
 * 耗時對比橫條）→ `actions` slot（再次診斷）→ 四個區段，順序「先看該做什麼」：摘要＋嚴重度 → 建議動作 → 可能原因 → 證據（FR-020）。
 * 證據以 `mergeEvidence` 合併相同來源與摘錄者（`×N`、不顯示時間），預設只列前 2 筆（FR-021）。
 *
 * 這裡直接信任契約型別、不逐欄位防禦：畸形 `ai/done.result` 在 WS 入口（safeParse）與
 * copilot store 入口（`AiDoneSchema.safeParse`，失敗轉 failed）兩道防線就被擋下，進不到這裡。
 *
 * ⚠️ 空陣列（無 evidence／suggestedActions／likelyCauses）以空狀態文字呈現，
 * 不崩潰、不殘留佔位（spec Edge Cases、CHK022、T014）。
 */
const props = defineProps<{
  result: DiagnosisResult;
  /**
   * 完成 meta（FR-022／FR-023）；未提供則不畫 meta 列。
   * - `cached`：結果是否來自快取（取自 `ai/done.cached`，是快取標記的唯一依據）。
   * - `completedAt`：完成時刻（epoch ms），顯示為 `HH:mm:ss`。
   * - `elapsed`：`compareLabel()` 的耗時標籤；尚無量測紀錄時為 null。
   * - `bars`：`compareBars()` 的快取對比橫條（僅快取態有值）；省略或 null 則不畫橫條。
   */
  meta?: {
    cached: boolean;
    completedAt: number | null;
    elapsed: TimingLabel | null;
    bars?: CompareBar[] | null;
    /** meta 列末的中性小字（012：重連後以 GET 取回時為「重新連線後取回」，代理裁決第 53 條）；null／未提供則不畫。 */
    note?: string | null;
  };
}>();

defineSlots<{
  /** meta 列下方、結果區段之前的動作列（CopilotDrawer 放「再次診斷」）。 */
  actions?: () => unknown;
}>();

/** 區段標題：與內文拉開層級，但不用全大寫或字距（中文不適用）。 */
const HEADING = "text-sm font-semibold text-ink-2";

/** 頂部嚴重度色條（2px）；語意色只出現在刻度、液位線、徽章與邊框。 */
const SEVERITY_BAR: Record<DiagnosisResult["severity"], string> = {
  ok: "bg-ok",
  warning: "bg-warn",
  critical: "bg-crit",
};

/** 完成時刻（HH:mm:ss，全站單一格式來源）。 */
const clock = computed(() =>
  props.meta?.completedAt != null ? formatClock(props.meta.completedAt) : null,
);

/**
 * 快取命中的大字：有量測時為 `快取 · N ms`；量測缺漏（理論上不會發生）時仍至少標出「快取」，
 * 快取標記不依賴耗時紀錄是否存在。
 */
const cachedPrimary = computed(() =>
  props.meta?.elapsed?.cached ? props.meta.elapsed.primary : "快取",
);
/**
 * 快取對比橫條（`compareBars()`）；未提供、非快取或不足兩條時不畫——單獨一條滿格的條沒有比較對象，
 * 看起來像「很慢」，此時只留大字耗時與快取標記。
 */
const bars = computed(() => {
  const list = props.meta?.cached ? props.meta.bars : null;
  return list && list.length >= 2 ? list : null;
});
/** 條色：快取用深青（主角），上一次用 ink-3；底線一律 etch（非文字裝飾）。 */
const BAR_FILL: Record<CompareBar["kind"], string> = {
  cached: "bg-accent",
  previous: "bg-ink-3",
};
/** 非快取的耗時（`N.N s`）；量測缺漏時只顯示完成時刻。 */
const uncachedElapsed = computed(() =>
  props.meta?.elapsed && !props.meta.elapsed.cached ? props.meta.elapsed.primary : null,
);

/** 非快取且既無完成時刻也無耗時（量測缺漏）時不畫空的 meta 列；快取一律畫出，快取標記必須可見。 */
const showMeta = computed(
  () =>
    props.meta !== undefined &&
    (props.meta.cached || clock.value !== null || uncachedElapsed.value !== null || Boolean(props.meta.note)),
);

/** 證據：合併後預設列前 2 筆，其餘收在「還有 N 筆」之後。 */
const evidenceGroups = computed(() => mergeEvidence(props.result.evidence));
const evidenceSplit = computed(() => splitPreview(evidenceGroups.value, 2));
const evidenceExpanded = ref(false);
const visibleEvidence = computed(() =>
  evidenceExpanded.value ? evidenceGroups.value : evidenceSplit.value.preview,
);
const evidenceListId = useId();
// 換一份結果（新任務）時回到收合
watch(
  () => props.result,
  () => {
    evidenceExpanded.value = false;
  },
);

/** 展開／收起證據的文字鈕。 */
const MORE_BTN =
  "mt-2 rounded-control text-sm font-medium text-ink-2 underline underline-offset-4 decoration-etch hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-focus";
</script>

<template>
  <div>
    <!-- 嚴重度色條（裝飾；嚴重度另由摘要旁的文字徽章傳達） -->
    <div
      class="mb-3 h-0.5"
      :class="SEVERITY_BAR[result.severity]"
      :data-severity="result.severity"
      aria-hidden="true"
    />

    <!-- 完成 meta：非快取一行「完成 HH:mm:ss · N.N s」；快取以大字耗時與上一次非快取耗時並列 -->
    <div
      v-if="showMeta && meta"
      class="mb-3.5"
      data-fg="timing"
      :data-cached="meta.cached ? 'true' : 'false'"
    >
      <template v-if="meta.cached">
        <span class="block font-mono text-ratio font-semibold tabular-nums text-ink"><span class="sr-only">結果來自</span>{{ cachedPrimary }}</span>
        <!-- 耗時對比：同一刻度的蝕刻橫條（etch 底線＋快取 accent／上一次 ink-3 條），把差距畫出來。
             每列固定 20px 高、數值欄固定寬，出現時不推擠下方內容以外的版面；不走出現動畫。 -->
        <ul v-if="bars" class="mt-2 space-y-1" aria-label="耗時對比" data-fg="timing-bars">
          <li
            v-for="bar in bars"
            :key="bar.kind"
            class="grid h-5 grid-cols-[3rem_minmax(0,1fr)_4.5rem] items-center gap-2.5"
            :data-bar="bar.kind"
          >
            <span class="text-xs text-ink-3">{{ bar.label }}</span>
            <span class="relative h-2" aria-hidden="true">
              <span class="absolute inset-x-0 bottom-0 h-px bg-etch" />
              <span
                class="absolute bottom-0 left-0 h-1.5 min-w-0.5"
                :class="BAR_FILL[bar.kind]"
                :style="{ width: `${(bar.ratio * 100).toFixed(2)}%` }"
              />
            </span>
            <span class="text-right font-mono text-sm tabular-nums text-ink-2"><span class="sr-only">：</span>{{ bar.value }}</span>
          </li>
        </ul>
        <p v-if="clock" class="mt-1 text-xs text-ink-3">
          完成 <span class="font-mono tabular-nums">{{ clock }}</span>
        </p>
        <p v-if="meta.note" class="mt-1 text-xs text-ink-3" data-testid="copilot-recovered-meta">{{ meta.note }}</p>
      </template>
      <p v-else class="text-sm text-ink-2">
        <template v-if="clock">完成 <span class="font-mono tabular-nums">{{ clock }}</span></template><span v-if="clock && uncachedElapsed"> · </span><span v-if="uncachedElapsed" class="font-mono tabular-nums">{{ uncachedElapsed }}</span><template v-if="meta.note"><span v-if="clock || uncachedElapsed"> · </span><span class="text-xs text-ink-3" data-testid="copilot-recovered-meta">{{ meta.note }}</span></template>
      </p>
    </div>

    <!-- meta 列下方的動作（CopilotDrawer 放「再次診斷」）；不論 meta 是否畫出都在結果區段之前 -->
    <div v-if="$slots.actions" class="mb-3.5">
      <slot name="actions" />
    </div>

    <div class="divide-y divide-edge">
      <!-- 1. 摘要 + 嚴重度 -->
      <section class="py-3.5 first:pt-0 last:pb-0" data-section="summary">
        <div class="mb-2 flex items-center justify-between gap-2">
          <h3 :class="HEADING">摘要</h3>
          <SeverityBadge :severity="result.severity" />
        </div>
        <p class="text-sm leading-relaxed text-ink">{{ result.summary }}</p>
      </section>

      <!-- 2. 建議動作 -->
      <section class="py-3.5 first:pt-0 last:pb-0" data-section="suggestedActions">
        <h3 class="mb-2" :class="HEADING">建議動作</h3>
        <SuggestedActionList v-if="result.suggestedActions.length" :actions="result.suggestedActions" />
        <p v-else class="text-sm text-ink-3">無建議動作。</p>
      </section>

      <!-- 3. 可能原因 -->
      <section class="py-3.5 first:pt-0 last:pb-0" data-section="likelyCauses">
        <h3 class="mb-2" :class="HEADING">可能原因</h3>
        <ul v-if="result.likelyCauses.length" class="space-y-1.5">
          <li
            v-for="(cause, i) in result.likelyCauses"
            :key="i"
            class="flex gap-2.5 text-sm leading-relaxed text-ink"
          >
            <span class="mt-2.5 h-0.5 w-2.5 shrink-0 bg-ink-3" aria-hidden="true" />
            <span>{{ cause }}</span>
          </li>
        </ul>
        <p v-else class="text-sm text-ink-3">未提供可能原因。</p>
      </section>

      <!-- 4. 證據（合併 ×N、預設 2 筆） -->
      <section class="py-3.5 first:pt-0 last:pb-0" data-section="evidence">
        <h3 class="mb-2" :class="HEADING">證據</h3>
        <template v-if="evidenceGroups.length">
          <EvidenceRows :id="evidenceListId" :groups="visibleEvidence" />
          <button
            v-if="evidenceSplit.rest.length"
            type="button"
            :class="MORE_BTN"
            :aria-expanded="evidenceExpanded ? 'true' : 'false'"
            :aria-controls="evidenceListId"
            @click="evidenceExpanded = !evidenceExpanded"
          >
            {{ evidenceExpanded ? "收起" : `還有 ${evidenceSplit.rest.length} 筆` }}
          </button>
        </template>
        <p v-else class="text-sm text-ink-3">無佐證資料。</p>
      </section>
    </div>
  </div>
</template>
