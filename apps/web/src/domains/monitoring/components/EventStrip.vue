<script setup lang="ts">
import type { DerivedEvent } from "../lib/events.js";
import { formatClock } from "../../../shared/lib/format.js";
import { STATE_STYLE } from "../../../shared/lib/state-style.js";

/**
 * 事件流面板：列出最近的狀態轉移事件（進入警告／嚴重、回復正常）。本身是一片玻璃面板。
 * 純呈現，資料由 `store.events`（前端衍生、最近 50 筆）餵入（FR-009）；高度由外層拖曳把手調整（預設 150px）。
 * 每列左側一道 16×2px 的蝕刻短線依嚴重度上色（獨立小元素，不是整列的左邊框）；
 * 嚴重度另有中文文字，不只靠顏色（FR-004）。時間為 24 小時制 mono（FR-022）。
 * 每列是一顆滿寬按鈕，點擊選取對應機台（FR-029）；可讀名稱即列上的可見文字，不另加 aria-label。
 * 面板容器 `overflow-hidden`，焦點環用 `ring-inset` 畫在列內，避免被裁切。分隔線畫在按鈕上（border-box），列高維持 32px。
 * 選取中的列另加 1px 內框 `ring-1 ring-inset ring-accent` 並把訊息文字加深為 `text-ink`：深色主題下 accent-wash
 * 與玻璃亮度相近，靠內框與文字辨識；內框是 box-shadow 不改尺寸，鍵盤聚焦時由 `focus-visible:ring-2 ring-focus` 覆蓋。
 */
withDefaults(defineProps<{ events: DerivedEvent[]; height: number; selectedId?: string | null }>(), {
  selectedId: null,
});

const emit = defineEmits<{ select: [machineId: string] }>();

// 顏色 token 取自共用 STATE_STYLE；回復事件用中性的蝕刻色，不借用任一狀態色。
const SEVERITY: Record<DerivedEvent["severity"], { label: string; text: string; tick: string }> = {
  warning: { label: STATE_STYLE.warning.label, text: STATE_STYLE.warning.badgeText, tick: STATE_STYLE.warning.dot },
  critical: { label: STATE_STYLE.critical.label, text: STATE_STYLE.critical.badgeText, tick: STATE_STYLE.critical.dot },
  recovered: { label: "回復", text: "text-ink-2", tick: "bg-etch" },
};
</script>

<template>
  <section
    class="flex flex-col overflow-hidden rounded-card border border-edge bg-surface/72 shadow-glass"
    :style="{ height: `${height}px` }"
    aria-label="事件流"
  >
    <!-- 標題列固定 34px（含 1px 底線）：外框 2＋34＋每列 32 × n，100／164px 正好整列（event-strip-size.ts） -->
    <div class="flex h-[34px] shrink-0 items-baseline justify-between gap-2 border-b border-edge px-3.5 py-1.5">
      <span class="text-sm font-semibold text-ink-2">事件流</span>
      <span class="font-mono text-xs text-ink-3">{{ events.length }}/50</span>
    </div>

    <!-- 空狀態 -->
    <div
      v-if="events.length === 0"
      class="flex flex-1 items-center justify-center px-3.5 text-center text-xs text-ink-3"
    >
      尚無事件，機台進入警告或嚴重時會列在這裡
    </div>

    <!-- 事件列項（最新在頂端；overflow 自捲） -->
    <ul v-else class="min-h-0 flex-1 overflow-auto">
      <li v-for="event in events" :key="event.id" class="group">
        <button
          type="button"
          data-fg="event"
          :data-machine="event.machineId"
          :data-severity="event.severity"
          :data-count="event.count"
          :aria-current="event.machineId === selectedId ? 'true' : undefined"
          class="flex min-h-8 w-full items-center gap-3 border-b border-edge/60 px-3.5 py-1 text-left group-last:border-b-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus"
          :class="event.machineId === selectedId ? 'bg-accent-wash ring-1 ring-inset ring-accent' : 'hover:bg-surface'"
          @click="emit('select', event.machineId)"
        >
          <span class="h-0.5 w-4 shrink-0" :class="SEVERITY[event.severity].tick" aria-hidden="true" />
          <span class="shrink-0 font-mono text-xs tabular-nums text-ink-3">{{ formatClock(event.ts) }}</span>
          <span class="w-8 shrink-0 text-xs font-semibold" :class="SEVERITY[event.severity].text">
            {{ SEVERITY[event.severity].label }}
          </span>
          <span
            class="min-w-0 flex-1 truncate text-sm"
            :class="event.machineId === selectedId ? 'text-ink' : 'text-ink-2'"
          >
            {{ event.message }}
          </span>
          <span v-if="event.count > 1" class="shrink-0 font-mono text-xs text-ink-3">
            <span aria-hidden="true">×{{ event.count }}</span>
            <span class="sr-only">共 {{ event.count }} 次</span>
          </span>
        </button>
      </li>
    </ul>
  </section>
</template>
