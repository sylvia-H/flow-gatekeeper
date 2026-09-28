<script setup lang="ts">
import { Wrench } from "lucide-vue-next";
import type { DiagnosisResult } from "@flow-gatekeeper/contracts";

/**
 * 建議動作清單（design-spec §7.7、FR-006）。型別取自契約 `DiagnosisResult`（單一來源）。
 * 每項可多行；`priority: high` 以 warn/crit 標示，但**不整排紅底**（僅左緣與 pill 上色）。
 * 空陣列由父層（DiagnosisResultView）以空狀態呈現，此元件僅負責渲染非空清單。
 *
 * `command` 是 LLM 生成、看起來像可照抄執行的指令；prompt injection 可藉此做社交工程，
 * 所以每個指令下方都標示「AI 建議，執行前請審閱」，不讓它看起來像系統核可的操作。
 */
type SuggestedAction = DiagnosisResult["suggestedActions"][number];

defineProps<{ actions: SuggestedAction[] }>();

/** priority → 左緣色與 pill 樣式（high 突顯但不整排紅底）。 */
const PRIORITY: Record<SuggestedAction["priority"], { edge: string; pill: string; label: string }> = {
  high: { edge: "border-l-crit", pill: "text-crit-fg bg-crit-bg", label: "High" },
  medium: { edge: "border-l-warn", pill: "text-warn-fg bg-warn-bg", label: "Medium" },
  low: { edge: "border-l-strong", pill: "text-fg-subtle bg-elevated", label: "Low" },
};
</script>

<template>
  <ul class="space-y-1.5">
    <li
      v-for="(action, i) in actions"
      :key="i"
      class="flex items-start gap-2 rounded-control border border-subtle border-l-2 bg-surface px-2.5 py-2"
      :class="PRIORITY[action.priority].edge"
    >
      <Wrench class="mt-0.5 h-3.5 w-3.5 shrink-0 text-fg-subtle" aria-hidden="true" />
      <div class="min-w-0 flex-1">
        <div class="flex items-start justify-between gap-2">
          <span class="text-sm text-fg">{{ action.label }}</span>
          <span
            class="shrink-0 rounded-pill px-1.5 py-0.5 text-2xs font-medium uppercase leading-none"
            :class="PRIORITY[action.priority].pill"
          >{{ PRIORITY[action.priority].label }}</span>
        </div>
        <template v-if="action.command">
          <code class="mt-1 block break-words font-mono text-xs text-fg-muted">{{ action.command }}</code>
          <p class="mt-0.5 text-xs text-fg-muted">AI 建議，執行前請審閱</p>
        </template>
      </div>
    </li>
  </ul>
</template>
