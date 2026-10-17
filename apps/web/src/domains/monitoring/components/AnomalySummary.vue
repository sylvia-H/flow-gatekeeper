<script setup lang="ts">
import { useId } from "vue";
import { Check } from "lucide-vue-next";
import StatusLight from "../../../shared/components/StatusLight.vue";
import { latchText, type AnomalySummaryItem } from "../lib/anomaly-latch.js";

/**
 * 側欄「最近異常」摘要（spec FR-026、FR-027）。純呈現：只收 props、只 emit，不碰 store——
 * 側欄與手機覆蓋層共用同一元件，由呼叫端接 `store.anomalySummary`／`selectMachine`／`clearLatch`。
 *
 * - 列序即 `items` 的順序（排序由 store 的 `summarize` 負責：進行中優先、進入時間新到舊）。
 * - 文案取自 `latchText`（與卡片底列標記同一套）：進行中錨定進入時間「嚴重 · 進入 N 秒前」（現在式），
 *   回復後錨定回復時間、以「曾」起頭寫成過去式「曾嚴重 · N 秒前回復」；2 秒內寫成「剛進入」／「剛回復」。
 * - 確認鈕（T073 第三輪起用「確認」語意：lucide `Check`、可讀名稱「確認 … 的異常標記」）：警報系統的通用語彙是「確認」，
 *   結果是劃線保留、不是刪除，舊的 X／「清除」會被讀成「移除這筆」。卡片上的標記不可點，確認只走這裡、鍵盤 `x` 與手機覆蓋層。
 * - 已確認（struck）：名稱與時間劃線並轉淡，確認鈕移除（同尺寸佔位保留，列高不變），保留到期滿由 store 移出清單。
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

function markText(item: AnomalySummaryItem): string {
  return latchText(item, props.now);
}

/**
 * 確認後確認鈕會隨 struck 消失；先把焦點交給同列的選取鈕，鍵盤操作者不會掉回頁首。
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
            >{{ markText(item) }}</span>
          </span>
          <span v-if="item.struck" class="sr-only">（已確認）</span>
        </button>

        <button
          v-if="!item.struck"
          type="button"
          data-fg="anomaly-clear"
          class="flex h-7 w-7 shrink-0 items-center justify-center rounded-control text-ink-3 transition-colors duration-150 hover:text-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          :aria-label="`確認 ${item.label} 的異常標記`"
          title="確認此異常（劃線保留至回復後 30 秒）"
          @click="onClear(item.machineId, $event)"
        >
          <Check class="h-4 w-4" aria-hidden="true" />
        </button>
        <!-- 已確認：確認鈕移除，留同尺寸佔位，劃線不改列寬 -->
        <span v-else class="h-7 w-7 shrink-0" aria-hidden="true" />
      </li>
    </ul>

    <p v-else class="mt-2 text-xs text-ink-3">目前沒有異常</p>
  </section>
</template>
