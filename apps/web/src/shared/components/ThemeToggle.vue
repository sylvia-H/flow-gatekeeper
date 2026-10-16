<script setup lang="ts">
import { useTheme, type Theme } from "../composables/useTheme.js";

/**
 * 主題切換（spec FR-002／FR-003、ui-contract §1–§3）：兩段式按鈕群「淺色｜深色」。
 * 目前主題的那一段 `aria-pressed="true"`；切換、存偏好與停用過渡都交給 `useTheme().apply`。
 * 桌機掛在 rail 底部；手機（rail 隱藏）時改由 TopBar 系統狀態分組承載（US6）。
 *
 * 焦點環不內縮、外加桌邊色間隙（ring-offset-rim）：按下段是 ink 實心，內縮的環在它上面對比不足。
 * 因此外框不用 overflow-hidden 裁切，圓角與邊框改由兩段按鈕各自承擔。
 */
const { theme, apply } = useTheme();

const OPTIONS: readonly { value: Theme; label: string; shape: string }[] = [
  { value: "light", label: "淺色", shape: "rounded-l-card border" },
  { value: "dark", label: "深色", shape: "rounded-r-card border border-l-0" },
];

function select(next: Theme): void {
  if (theme.value !== next) apply(next);
}
</script>

<template>
  <div
    data-fg="theme-toggle"
    role="group"
    aria-label="主題"
    class="flex items-center gap-2 text-sm"
  >
    <span class="shrink-0 text-xs font-semibold text-ink-2" aria-hidden="true">主題</span>
    <div class="flex min-w-0 flex-1">
      <button
        v-for="option in OPTIONS"
        :key="option.value"
        type="button"
        class="h-8 min-w-0 flex-1 border-edge px-2 transition-colors duration-150 focus:outline-none focus-visible:relative focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-rim"
        :class="[
          option.shape,
          theme === option.value
            ? 'bg-ink font-semibold text-surface-strong'
            : 'bg-surface/72 text-ink-2 hover:bg-surface hover:text-ink',
        ]"
        :aria-pressed="theme === option.value"
        @click="select(option.value)"
      >
        {{ option.label }}
      </button>
    </div>
  </div>
</template>
