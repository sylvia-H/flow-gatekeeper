<script setup lang="ts">
import { computed } from "vue";
import { severityLabel, type DiagnosisSeverity } from "../lib/severity-label.js";

/**
 * 診斷嚴重度徽章。severity 型別取自契約 `DiagnosisResult`（單一來源）。
 * ⚠️ 與機台健康狀態（healthy/warning/critical）刻意不同：診斷 severity 有 `ok`（見 contracts），
 * 譯為「正常」（research R13；譯名唯一來源 `severity-label.ts`）。狀態不只靠顏色——同時有中文文字 label（憲章 II 無障礙）。
 * 徽章一律 `bg-*-bg` + `text-*-fg`（徽章底上的文字對比 ≥ 6:1，兩套主題皆然）。
 */
type Severity = DiagnosisSeverity;

const props = defineProps<{ severity: Severity }>();

const STYLES: Record<Severity, string> = {
  ok: "bg-ok-bg text-ok-fg",
  warning: "bg-warn-bg text-warn-fg",
  critical: "bg-crit-bg text-crit-fg",
};

const badge = computed(() => ({ label: severityLabel(props.severity), cls: STYLES[props.severity] }));
</script>

<template>
  <!-- 可讀名稱以視覺隱藏前綴提供（generic <span> 不可用 aria-label），螢幕閱讀器讀「嚴重度：嚴重」 -->
  <span
    class="inline-flex items-center rounded-pill px-2 py-0.5 text-xs font-semibold leading-4"
    :class="badge.cls"
  >
    <span class="sr-only">嚴重度：</span>{{ badge.label }}
  </span>
</template>
