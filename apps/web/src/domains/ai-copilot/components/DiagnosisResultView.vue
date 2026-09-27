<script setup lang="ts">
import type { DiagnosisResult } from "@flow-gatekeeper/contracts";
import SeverityBadge from "../../../shared/components/SeverityBadge.vue";
import SuggestedActionList from "./SuggestedActionList.vue";

/**
 * 結構化診斷結果（design-spec §7.7、FR-006）。欄位對齊契約 `DiagnosisResult`（單一來源，
 * 後端已 `DiagnosisResultSchema.parse()`；前端不放寬）。五區塊：
 * summary／severity／likelyCauses／evidence／suggestedActions。
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
  telemetry: "Telemetry",
  errorlog: "Error log",
  maintenance: "Maintenance",
};
</script>

<template>
  <div class="space-y-4">
    <!-- 1. Summary + severity -->
    <section>
      <div class="mb-1.5 flex items-center justify-between gap-2">
        <h3 class="text-xs font-medium uppercase tracking-wide text-fg-subtle">Summary</h3>
        <SeverityBadge :severity="result.severity" />
      </div>
      <p class="text-sm leading-relaxed text-fg">{{ result.summary }}</p>
    </section>

    <!-- 2. Likely causes -->
    <section>
      <h3 class="mb-1.5 text-xs font-medium uppercase tracking-wide text-fg-subtle">Likely causes</h3>
      <ul v-if="result.likelyCauses.length" class="space-y-1">
        <li
          v-for="(cause, i) in result.likelyCauses"
          :key="i"
          class="flex gap-2 text-sm text-fg-muted"
        >
          <span class="mt-1.5 h-1 w-1 shrink-0 rounded-pill bg-fg-subtle" aria-hidden="true" />
          <span>{{ cause }}</span>
        </li>
      </ul>
      <p v-else class="text-sm text-fg-subtle">未提供可能原因。</p>
    </section>

    <!-- 3. Evidence -->
    <section>
      <h3 class="mb-1.5 text-xs font-medium uppercase tracking-wide text-fg-subtle">Evidence</h3>
      <ul v-if="result.evidence.length" class="space-y-1.5">
        <li
          v-for="(ev, i) in result.evidence"
          :key="i"
          class="rounded-control border border-subtle bg-surface px-2.5 py-2"
        >
          <div class="mb-0.5 flex items-center gap-2">
            <span class="rounded-pill bg-elevated px-1.5 py-0.5 text-2xs font-medium uppercase leading-none text-fg-subtle">
              {{ SOURCE_LABEL[ev.source] }}
            </span>
            <span v-if="ev.id" class="font-mono text-xs text-fg-subtle">{{ ev.id }}</span>
          </div>
          <p class="break-words font-mono text-xs text-fg-muted">{{ ev.excerpt }}</p>
        </li>
      </ul>
      <p v-else class="text-sm text-fg-subtle">無佐證資料。</p>
    </section>

    <!-- 4. Suggested actions -->
    <section>
      <h3 class="mb-1.5 text-xs font-medium uppercase tracking-wide text-fg-subtle">Suggested actions</h3>
      <SuggestedActionList v-if="result.suggestedActions.length" :actions="result.suggestedActions" />
      <p v-else class="text-sm text-fg-subtle">無建議動作。</p>
    </section>
  </div>
</template>
