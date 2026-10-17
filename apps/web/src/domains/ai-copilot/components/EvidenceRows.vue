<script setup lang="ts">
import type { EvidenceGroup, EvidenceSource } from "../lib/evidence-merge.js";

/**
 * 證據列（FR-021）：完成態結果（DiagnosisResultView）與串流骨架（ResultSkeleton）共用。
 * 每列為一筆合併後的證據（`mergeEvidence`）：來源徽章、摘錄，合併多筆時列尾顯示 `×N`；
 * evidence 契約沒有時間欄位，所以不顯示時間。收合／展開由父層決定傳入哪幾列。
 */
defineProps<{ groups: readonly EvidenceGroup[] }>();

/** evidence 來源 → 可讀標籤（狀態不只靠顏色）。 */
const SOURCE_LABEL: Record<EvidenceSource, string> = {
  telemetry: "遙測",
  errorlog: "錯誤紀錄",
  maintenance: "維護紀錄",
};
</script>

<template>
  <ul class="space-y-2.5">
    <li v-for="group in groups" :key="group.key" data-evidence>
      <div class="mb-1 flex items-center gap-2">
        <span class="rounded-pill bg-rim px-2 py-0.5 text-xs font-medium leading-4 text-ink-2">
          {{ SOURCE_LABEL[group.source] }}
        </span>
        <!-- 合併筆數：可見 ×N，螢幕閱讀器讀「共 N 次」 -->
        <span
          v-if="group.count > 1"
          class="ml-auto shrink-0 font-mono text-xs font-medium tabular-nums text-ink-2"
          data-evidence-count
        ><span class="sr-only">共 {{ group.count }} 次</span><span aria-hidden="true">×{{ group.count }}</span></span>
      </div>
      <p class="break-words font-mono text-xs leading-relaxed text-ink-2">{{ group.excerpt }}</p>
    </li>
  </ul>
</template>
