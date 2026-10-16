<script setup lang="ts">
import type { DiagnosisResult } from "@flow-gatekeeper/contracts";
import SeverityBadge from "../../../shared/components/SeverityBadge.vue";
import SuggestedActionList from "./SuggestedActionList.vue";

/**
 * 結構化診斷結果（FR-006；013 視覺層與繁中文案，research R13）。欄位對齊契約 `DiagnosisResult`
 * （單一來源，後端已 `DiagnosisResultSchema.parse()`；前端不放寬）。四個區段：
 * 摘要（含嚴重度）／可能原因／證據／建議動作，以 `border-edge` 分隔線區隔，不再逐項包框。
 *
 * 這裡直接信任契約型別、不逐欄位防禦：畸形 `ai/done.result` 在 WS 入口（safeParse）與
 * copilot store 入口（`AiDoneSchema.safeParse`，失敗轉 failed）兩道防線就被擋下，進不到這裡。
 *
 * ⚠️ 空陣列（無 evidence／suggestedActions／likelyCauses）以空狀態文字呈現，
 * 不崩潰、不殘留佔位（spec Edge Cases、CHK022、T014）。
 */
defineProps<{ result: DiagnosisResult }>();

/** evidence 來源 → 可讀標籤（狀態不只靠顏色）。 */
const SOURCE_LABEL: Record<DiagnosisResult["evidence"][number]["source"], string> = {
  telemetry: "遙測",
  errorlog: "錯誤紀錄",
  maintenance: "維護紀錄",
};

/** 區段標題：與內文拉開層級，但不用全大寫或字距（中文不適用）。 */
const HEADING = "text-sm font-semibold text-ink-2";
</script>

<template>
  <div class="divide-y divide-edge">
    <!-- 1. 摘要 + 嚴重度 -->
    <section class="py-3.5 first:pt-0 last:pb-0">
      <div class="mb-2 flex items-center justify-between gap-2">
        <h3 :class="HEADING">摘要</h3>
        <SeverityBadge :severity="result.severity" />
      </div>
      <p class="text-sm leading-relaxed text-ink">{{ result.summary }}</p>
    </section>

    <!-- 2. 可能原因 -->
    <section class="py-3.5 first:pt-0 last:pb-0">
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

    <!-- 3. 證據 -->
    <section class="py-3.5 first:pt-0 last:pb-0">
      <h3 class="mb-2" :class="HEADING">證據</h3>
      <ul v-if="result.evidence.length" class="space-y-2.5">
        <li v-for="(ev, i) in result.evidence" :key="i">
          <div class="mb-1 flex items-center gap-2">
            <span class="rounded-pill bg-rim px-2 py-0.5 text-xs font-medium leading-4 text-ink-2">
              {{ SOURCE_LABEL[ev.source] }}
            </span>
            <span v-if="ev.id" class="truncate font-mono text-xs text-ink-3">{{ ev.id }}</span>
          </div>
          <p class="break-words font-mono text-xs leading-relaxed text-ink-2">{{ ev.excerpt }}</p>
        </li>
      </ul>
      <p v-else class="text-sm text-ink-3">無佐證資料。</p>
    </section>

    <!-- 4. 建議動作 -->
    <section class="py-3.5 first:pt-0 last:pb-0">
      <h3 class="mb-2" :class="HEADING">建議動作</h3>
      <SuggestedActionList v-if="result.suggestedActions.length" :actions="result.suggestedActions" />
      <p v-else class="text-sm text-ink-3">無建議動作。</p>
    </section>
  </div>
</template>
