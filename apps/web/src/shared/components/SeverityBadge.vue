<script setup lang="ts">
import { computed } from "vue";
import type { DiagnosisResult } from "@flow-gatekeeper/contracts";

/**
 * 診斷嚴重度徽章（design-spec §7.6）。severity 型別取自契約 `DiagnosisResult`（單一來源）。
 * ⚠️ 與機台健康狀態（healthy/warning/critical）刻意不同：診斷 severity 有 `ok`（見 contracts）。
 * 狀態不只靠顏色——同時有文字 label（憲章 II 無障礙）。
 */
type Severity = DiagnosisResult["severity"];

const props = defineProps<{ severity: Severity }>();

const STYLES: Record<Severity, { label: string; cls: string }> = {
  ok: { label: "OK", cls: "text-ok-fg bg-ok-bg border-ok-border" },
  warning: { label: "Warning", cls: "text-warn-fg bg-warn-bg border-warn-border" },
  critical: { label: "Critical", cls: "text-crit-fg bg-crit-bg border-crit-border" },
};

const badge = computed(() => STYLES[props.severity]);
</script>

<template>
  <span
    class="inline-flex items-center rounded-pill border px-2 py-1 text-xs font-medium"
    :class="badge.cls"
    :aria-label="`Severity: ${badge.label}`"
  >
    {{ badge.label }}
  </span>
</template>
