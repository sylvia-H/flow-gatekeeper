<script setup lang="ts">
import { computed } from "vue";
import type { DiagnosisResult } from "@flow-gatekeeper/contracts";

/**
 * 診斷嚴重度徽章。severity 型別取自契約 `DiagnosisResult`（單一來源）。
 * ⚠️ 與機台健康狀態（healthy/warning/critical）刻意不同：診斷 severity 有 `ok`（見 contracts），
 * 譯為「正常」（research R13）。狀態不只靠顏色——同時有中文文字 label（憲章 II 無障礙）。
 * 徽章一律 `bg-*-bg` + `text-*-fg`（徽章底上的文字對比 ≥ 6:1，兩套主題皆然）。
 */
type Severity = DiagnosisResult["severity"];

const props = defineProps<{ severity: Severity }>();

const STYLES: Record<Severity, { label: string; cls: string }> = {
  ok: { label: "正常", cls: "bg-ok-bg text-ok-fg" },
  warning: { label: "警告", cls: "bg-warn-bg text-warn-fg" },
  critical: { label: "嚴重", cls: "bg-crit-bg text-crit-fg" },
};

const badge = computed(() => STYLES[props.severity]);
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
