<script setup lang="ts">
import { Wrench } from "lucide-vue-next";
import type { DiagnosisResult } from "@flow-gatekeeper/contracts";

/**
 * 建議動作清單（FR-006；013 視覺層與繁中文案）。型別取自契約 `DiagnosisResult`（單一來源）。
 * 每項可多行；優先度只以文字徽章（高／中／低）與其語意色表達，不用左緣色條、不整排上色。
 * 空陣列由父層（DiagnosisResultView）以空狀態呈現，此元件僅負責渲染非空清單。
 *
 * `command` 是 LLM 生成、看起來像可照抄執行的指令；prompt injection 可藉此做社交工程，
 * 所以每個指令下方都標示「AI 建議，執行前請審閱」，不讓它看起來像系統核可的操作。
 */
type SuggestedAction = DiagnosisResult["suggestedActions"][number];

defineProps<{ actions: SuggestedAction[] }>();

/** priority → 徽章樣式與文字（high 突顯但不整排紅底）。 */
const PRIORITY: Record<SuggestedAction["priority"], { pill: string; label: string }> = {
  high: { pill: "bg-crit-bg text-crit-fg", label: "高" },
  medium: { pill: "bg-warn-bg text-warn-fg", label: "中" },
  low: { pill: "bg-rim text-ink-2", label: "低" },
};
</script>

<template>
  <ul class="divide-y divide-edge">
    <li
      v-for="(action, i) in actions"
      :key="i"
      class="flex items-start gap-2.5 py-2.5 first:pt-0 last:pb-0"
    >
      <Wrench class="mt-0.5 h-4 w-4 shrink-0 text-ink-3" aria-hidden="true" />
      <div class="min-w-0 flex-1">
        <div class="flex items-start justify-between gap-2">
          <span class="text-sm leading-relaxed text-ink">{{ action.label }}</span>
          <span
            class="shrink-0 rounded-pill px-2 py-0.5 text-xs font-semibold leading-4"
            :class="PRIORITY[action.priority].pill"
          ><span class="sr-only">優先度：</span>{{ PRIORITY[action.priority].label }}</span>
        </div>
        <template v-if="action.command">
          <code
            class="mt-1.5 block break-words rounded-control border border-edge bg-bench px-2 py-1.5 font-mono text-xs text-ink-2"
          >{{ action.command }}</code>
          <p class="mt-1 text-xs text-ink-2">AI 建議，執行前請審閱</p>
        </template>
      </div>
    </li>
  </ul>
</template>
