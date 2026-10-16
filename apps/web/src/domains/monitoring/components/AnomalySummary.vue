<script setup lang="ts">
import { useId } from "vue";
import { X } from "lucide-vue-next";
import StatusLight from "../../../shared/components/StatusLight.vue";
import { STATE_STYLE } from "../../../shared/lib/state-style.js";
import { formatRelative } from "../../../shared/lib/format.js";
import type { AnomalySummaryItem } from "../lib/anomaly-latch.js";

/**
 * 側欄「最近異常」摘要（spec FR-026、FR-027）。純呈現：只收 props、只 emit，不碰 store——
 * 側欄與手機覆蓋層共用同一元件，由呼叫端接 `store.anomalySummary`／`selectMachine`／`clearLatch`。
 *
 * - 列序即 `items` 的順序（排序由 store 的 `summarize` 負責：進行中優先、進入時間新到舊）。
 * - 相對時間：進行中錨定進入時間「進入 N 秒前」，回復後錨定回復時間「已回復 N 秒前」；
 *   2 秒內 `formatRelative` 回「剛剛」，改寫成「剛進入」／「剛回復」以免出現「進入 剛剛」。
 * - 已確認（struck）：名稱與時間劃線並轉淡，清除鈕移除（同尺寸佔位保留，列高不變），保留到期滿由 store 移出清單。
 *   劃線本身不會被讀屏念出，所以選取鈕名稱另帶隱藏的「已確認」。
 */
const props = defineProps<{
  items: readonly AnomalySummaryItem[];
  /** 相對時間的基準（store 的 `staleNow`，1 Hz）。 */
  now: number;
  selectedId: string | null;
}>();

const emit = defineEmits<{
  select: [machineId: string];
  clear: [machineId: string];
}>();

const headingId = useId();

function timeText(item: AnomalySummaryItem): string {
  const rel = formatRelative(item.since, props.now);
  if (item.active) return rel === "剛剛" ? "剛進入" : `進入 ${rel}`;
  return rel === "剛剛" ? "剛回復" : `已回復 ${rel}`;
}

/**
 * 清除後清除鈕會隨 struck 消失；先把焦點交給同列的選取鈕，鍵盤操作者不會掉回頁首。
 */
function onClear(machineId: string, event: MouseEvent): void {
  const row = (event.currentTarget as HTMLElement | null)?.closest("li");
  row?.querySelector<HTMLButtonElement>('[data-fg="anomaly-select"]')?.focus();
  emit("clear", machineId);
}
</script>

<template>
  <section
    data-fg="anomaly-summary"
    :aria-labelledby="headingId"
    class="rounded-card border border-edge bg-surface/72 p-3.5 shadow-glass"
  >
    <h2 :id="headingId" class="text-sm font-semibold text-ink-2">最近異常</h2>

    <ul v-if="items.length > 0" role="list" class="mt-2 flex flex-col gap-0.5">
      <li
        v-for="item in items"
        :key="item.machineId"
        :data-machine="item.machineId"
        :data-level="item.level"
        :data-active="item.active ? '' : undefined"
        :data-struck="item.struck ? '' : undefined"
        class="flex min-h-9 items-center gap-1 rounded-control transition-colors duration-150"
        :class="item.machineId === selectedId ? 'bg-accent-wash ring-1 ring-inset ring-accent' : 'hover:bg-surface'"
      >
        <button
          type="button"
          data-fg="anomaly-select"
          class="flex min-w-0 flex-1 items-center gap-2 rounded-control px-1.5 py-1 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          :aria-current="item.machineId === selectedId ? 'true' : undefined"
          @click="emit('select', item.machineId)"
        >
          <!-- 等級已有可見文字，燈號只作視覺，不重複念出 -->
          <StatusLight :state="item.level" aria-hidden="true" />
          <span class="flex min-w-0 flex-col">
            <span
              class="truncate text-sm"
              :class="item.struck ? 'text-ink-3 line-through' : 'text-ink'"
            >{{ item.label }}</span>
            <span
              class="truncate text-xs text-ink-3"
              :class="item.struck ? 'line-through' : ''"
            >{{ STATE_STYLE[item.level].label }} · {{ timeText(item) }}</span>
          </span>
          <span v-if="item.struck" class="sr-only">（已確認）</span>
        </button>

        <button
          v-if="!item.struck"
          type="button"
          data-fg="anomaly-clear"
          class="flex h-7 w-7 shrink-0 items-center justify-center rounded-control text-ink-3 transition-colors duration-150 hover:text-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          :aria-label="`清除 ${item.label} 的異常標記`"
          @click="onClear(item.machineId, $event)"
        >
          <X class="h-4 w-4" aria-hidden="true" />
        </button>
        <!-- 已確認：清除鈕移除，留同尺寸佔位，劃線不改列寬 -->
        <span v-else class="h-7 w-7 shrink-0" aria-hidden="true" />
      </li>
    </ul>

    <p v-else class="mt-2 text-xs text-ink-3">目前沒有異常</p>
  </section>
</template>
