<script setup lang="ts">
import { computed } from "vue";
import SeverityBadge from "../../../shared/components/SeverityBadge.vue";
import type { PartialFieldState, PartialResult } from "../lib/partial-json.js";
import { mergeEvidence, splitPreview } from "../lib/evidence-merge.js";
import SuggestedActionList from "./SuggestedActionList.vue";
import EvidenceRows from "./EvidenceRows.vue";

/**
 * 串流中的結果骨架（FR-018、research R6；US4）：把 `parsePartialDiagnosis(streamText)` 的
 * 每欄位狀態畫成與完成態相同順序的四個區段——摘要＋嚴重度 → 建議動作 → 可能原因 → 證據，
 * 讓 AI 輸出逐格填入，完成時換成 DiagnosisResultView 也不跳版。
 *
 * - missing：佔位條（靜止色塊，不用漸層閃動）；
 * - streaming：已解析的內容＋游標（`animate-stream-caret`，reduced-motion 下由 tailwind.css 停住）；
 * - complete：正常顯示。
 * 每個欄位的狀態另以視覺隱藏文字傳達（尚未產生／生成中／已完成），不只靠游標與佔位條。
 *
 * ⚠️ PartialResult 只供 active 串流態呈現、未經 schema 驗證（工程硬規則 6）：本元件只讀它畫畫面，
 * 不把它轉成或存成診斷結果；完成態一律改用 `ai/done` 驗證過的 `result`。
 */
const props = defineProps<{ partial: PartialResult }>();

const fields = computed(() => props.partial.fields);

const STATE_TEXT: Record<PartialFieldState, string> = {
  missing: "尚未產生",
  streaming: "生成中",
  complete: "已完成",
};

/** 區段標題（與 DiagnosisResultView 一致，骨架換成結果時不跳字級）。 */
const HEADING = "text-sm font-semibold text-ink-2";
/** 佔位條：靜止的淡墨色塊（20% 墨色：淺色主題下仍看得出是佔位，而不是空白）。 */
const PLACEHOLDER = "h-2.5 rounded-control bg-ink/20";
/** 游標：與原始串流面板同一種方塊游標。 */
const CARET =
  "ml-0.5 inline-block h-3.5 w-1.5 translate-y-0.5 bg-accent align-middle animate-stream-caret";

/** 證據骨架：同樣先合併，只列前 2 筆（與完成態一致），其餘以文字標出筆數，完成後才可展開。 */
const evidenceSplit = computed(() => splitPreview(mergeEvidence(fields.value.evidence.value), 2));
</script>

<template>
  <div class="divide-y divide-edge" data-fg="result-skeleton">
    <!-- 1. 摘要 + 嚴重度 -->
    <section
      class="py-3.5 first:pt-0 last:pb-0"
      data-field="summary"
      :data-field-state="fields.summary.state"
    >
      <div class="mb-2 flex items-center justify-between gap-2">
        <h3 :class="HEADING">摘要<span class="sr-only">（{{ STATE_TEXT[fields.summary.state] }}）</span></h3>
        <span data-field="severity" :data-field-state="fields.severity.state">
          <template v-if="fields.severity.value">
            <SeverityBadge :severity="fields.severity.value" /><span class="sr-only">（{{ STATE_TEXT[fields.severity.state] }}）</span>
          </template>
          <template v-else>
            <span class="sr-only">嚴重度：{{ STATE_TEXT[fields.severity.state] }}</span>
            <span class="block h-5 w-10 rounded-pill bg-ink/20" aria-hidden="true" />
          </template>
        </span>
      </div>
      <div v-if="fields.summary.state === 'missing'" class="space-y-2 py-1" aria-hidden="true">
        <div :class="PLACEHOLDER" class="w-11/12" />
        <div :class="PLACEHOLDER" class="w-3/4" />
      </div>
      <p v-else class="text-sm leading-relaxed text-ink">
        {{ fields.summary.value }}<span v-if="fields.summary.state === 'streaming'" :class="CARET" aria-hidden="true" />
      </p>
    </section>

    <!-- 2. 建議動作 -->
    <section
      class="py-3.5 first:pt-0 last:pb-0"
      data-field="suggestedActions"
      :data-field-state="fields.suggestedActions.state"
    >
      <h3 class="mb-2" :class="HEADING">建議動作<span class="sr-only">（{{ STATE_TEXT[fields.suggestedActions.state] }}）</span></h3>
      <div v-if="fields.suggestedActions.state === 'missing'" class="space-y-2 py-1" aria-hidden="true">
        <div :class="PLACEHOLDER" class="w-5/6" />
        <div :class="PLACEHOLDER" class="w-2/3" />
      </div>
      <template v-else>
        <SuggestedActionList v-if="fields.suggestedActions.value.length" :actions="fields.suggestedActions.value" />
        <p v-else-if="fields.suggestedActions.state === 'complete'" class="text-sm text-ink-3">無建議動作。</p>
        <span v-if="fields.suggestedActions.state === 'streaming'" :class="CARET" class="mt-1.5" aria-hidden="true" />
      </template>
    </section>

    <!-- 3. 可能原因（最後一項是截斷中的字串，會逐字長出） -->
    <section
      class="py-3.5 first:pt-0 last:pb-0"
      data-field="likelyCauses"
      :data-field-state="fields.likelyCauses.state"
    >
      <h3 class="mb-2" :class="HEADING">可能原因<span class="sr-only">（{{ STATE_TEXT[fields.likelyCauses.state] }}）</span></h3>
      <div v-if="fields.likelyCauses.state === 'missing'" class="space-y-2 py-1" aria-hidden="true">
        <div :class="PLACEHOLDER" class="w-11/12" />
        <div :class="PLACEHOLDER" class="w-2/3" />
      </div>
      <template v-else>
        <ul v-if="fields.likelyCauses.value.length" class="space-y-1.5">
          <li
            v-for="(cause, i) in fields.likelyCauses.value"
            :key="i"
            class="flex gap-2.5 text-sm leading-relaxed text-ink"
          >
            <span class="mt-2.5 h-0.5 w-2.5 shrink-0 bg-ink-3" aria-hidden="true" />
            <span>{{ cause }}<span
              v-if="fields.likelyCauses.state === 'streaming' && i === fields.likelyCauses.value.length - 1"
              :class="CARET"
              aria-hidden="true"
            /></span>
          </li>
        </ul>
        <p v-else-if="fields.likelyCauses.state === 'complete'" class="text-sm text-ink-3">未提供可能原因。</p>
        <span v-else :class="CARET" aria-hidden="true" />
      </template>
    </section>

    <!-- 4. 證據 -->
    <section
      class="py-3.5 first:pt-0 last:pb-0"
      data-field="evidence"
      :data-field-state="fields.evidence.state"
    >
      <h3 class="mb-2" :class="HEADING">證據<span class="sr-only">（{{ STATE_TEXT[fields.evidence.state] }}）</span></h3>
      <div v-if="fields.evidence.state === 'missing'" class="space-y-2 py-1" aria-hidden="true">
        <div :class="PLACEHOLDER" class="w-3/4" />
        <div :class="PLACEHOLDER" class="w-1/2" />
      </div>
      <template v-else>
        <EvidenceRows v-if="evidenceSplit.preview.length" :groups="evidenceSplit.preview" />
        <p v-else-if="fields.evidence.state === 'complete'" class="text-sm text-ink-3">無佐證資料。</p>
        <p v-if="evidenceSplit.rest.length" class="mt-2 text-sm text-ink-3">還有 {{ evidenceSplit.rest.length }} 筆</p>
        <span v-if="fields.evidence.state === 'streaming'" :class="CARET" class="mt-1.5" aria-hidden="true" />
      </template>
    </section>
  </div>
</template>
