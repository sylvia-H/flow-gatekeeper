<script setup lang="ts">
import type { DerivedEvent } from "../lib/events.js";
import { STATE_STYLE } from "../../../shared/lib/state-style.js";

/**
 * US3 Event Stream（design-spec §7.8 `EventStrip`）：列出最近門檻跨越/錯誤事件。
 * 純呈現，資料由 `store.events`（前端衍生、最近 50 筆）餵入（FR-009）。
 * row 32–40px、timestamp 用 mono（design-spec §7.8）；高度由外層拖曳把手調整（預設 150px）。
 */
defineProps<{ events: DerivedEvent[]; height: number }>();

// 顏色 token 取自共用 STATE_STYLE；僅縮寫 label 為呈現層自理。
const SEVERITY: Record<DerivedEvent["severity"], { label: string; cls: string; dot: string }> = {
  warning: { label: "WARN", cls: STATE_STYLE.warning.badgeText, dot: STATE_STYLE.warning.dot },
  critical: { label: "CRIT", cls: STATE_STYLE.critical.badgeText, dot: STATE_STYLE.critical.dot },
};

function clockLabel(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}
</script>

<template>
  <section class="flex flex-col bg-surface" :style="{ height: `${height}px` }" aria-label="Event stream">
    <div class="flex shrink-0 items-center justify-between border-b border-subtle px-4 py-1.5">
      <span class="text-xs font-medium uppercase tracking-wide text-fg-subtle">Event Stream</span>
      <span class="font-mono text-2xs text-fg-subtle">{{ events.length }}/50</span>
    </div>

    <!-- 空狀態 -->
    <div
      v-if="events.length === 0"
      class="flex flex-1 items-center justify-center text-xs text-fg-subtle"
    >
      無事件——機台狀態轉入 warning/critical 時於此顯示。
    </div>

    <!-- 事件列（最新在頂端；overflow 自捲） -->
    <ul v-else class="min-h-0 flex-1 overflow-auto">
      <li
        v-for="event in events"
        :key="event.id"
        class="flex min-h-[34px] items-center gap-3 border-b border-subtle/60 px-4 py-1 text-xs"
      >
        <span class="shrink-0 font-mono text-fg-subtle">{{ clockLabel(event.ts) }}</span>
        <span class="flex shrink-0 items-center gap-1.5" :class="SEVERITY[event.severity].cls">
          <span class="h-1.5 w-1.5 rounded-pill" :class="SEVERITY[event.severity].dot" aria-hidden="true" />
          {{ SEVERITY[event.severity].label }}
        </span>
        <span class="truncate text-fg-muted">{{ event.message }}</span>
      </li>
    </ul>
  </section>
</template>
