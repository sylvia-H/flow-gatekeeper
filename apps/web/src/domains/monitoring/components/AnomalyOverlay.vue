<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from "vue";
import { X } from "lucide-vue-next";
import AnomalySummary from "./AnomalySummary.vue";
import type { AnomalySummaryItem } from "../lib/anomaly-latch.js";

/**
 * 手機異常清單覆蓋層（spec FR-033a、FR-034a、tasks T061）。
 *
 * 機群健康摘要條（`FleetHealth compact`）點開後的覆蓋層；內容就是側欄那份 `AnomalySummary`
 * （同一份資料與行為），本元件只負責容器：純 props／emit，不碰 store，開關由呼叫端持有。
 *
 * 版面：遮罩起於 `top-14`（工具列 56px 之下），工具列不被蓋住；遮罩蓋住摘要條（變暗仍可見），
 * 面板則從摘要條下緣開始（`top-16` = 主區內距 12 + 摘要條 44 + 間隔 8），在摘要條原位再點一次
 * 點到的是遮罩，即「再點收合」。面板不透明（`bg-surface-strong`），內容過長時清單區捲動；
 * `fixed` 疊在拓樸之上，不推擠下方版面。
 * `AnomalySummary` 自帶的玻璃外框在這裡去掉（邊框、底色、陰影交給面板），避免框中框。
 *
 * 行為：
 * - 選一台：轉發 `select` 後再 emit `close`，呼叫端選台並收合覆蓋層。
 * - 清除標記：只轉發 `clear`，覆蓋層維持開著。
 * - Escape：攔下冒泡與預設行為後 emit `close`，App 層的 Escape 不會再關下一層；
 *   焦點不在面板內時，由 App 的快捷鍵層（`layers["anomaly-overlay"]`）關閉。
 * - 點遮罩 emit `close`。
 * - 焦點：開啟時移進面板並記下原焦點（摘要條按鈕），Tab／Shift+Tab 在面板內循環，
 *   關閉後還給開啟前的元素。
 */
const props = withDefaults(
  defineProps<{
    open: boolean;
    items: readonly AnomalySummaryItem[];
    /** 相對時間的基準（store 的 `staleNow`，1 Hz）。 */
    now: number;
    selectedId: string | null;
    /** 面板 id；摘要條的 `aria-controls` 指向它（FleetHealth 的 `controls` 預設同值）。 */
    panelId?: string;
  }>(),
  { panelId: "anomaly-overlay-panel" },
);

const emit = defineEmits<{
  close: [];
  select: [machineId: string];
  clear: [machineId: string];
}>();

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

const panelRef = ref<HTMLElement | null>(null);
let restoreTo: HTMLElement | null = null;

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) =>
      !el.hidden &&
      el.getAttribute("aria-hidden") !== "true" &&
      (typeof el.checkVisibility === "function" ? el.checkVisibility() : true),
  );
}

/**
 * 只在焦點仍在面板內、或已掉到 body／null 時才還焦點；使用者若已點了面板外的元素
 * （例如工具列），就不搶走他的焦點。
 */
function restoreFocus(): void {
  const target = restoreTo;
  restoreTo = null;
  if (!target || !target.isConnected) return;
  const active = document.activeElement;
  const panel = panelRef.value;
  const focusInPanel = panel !== null && active !== null && panel.contains(active);
  if (active === null || active === document.body || focusInPanel) target.focus();
}

watch(
  () => props.open,
  (open) => {
    if (open) {
      const active = typeof document !== "undefined" ? document.activeElement : null;
      restoreTo = active instanceof HTMLElement && active !== document.body ? active : null;
      void nextTick(() => panelRef.value?.focus());
    } else {
      restoreFocus();
    }
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  if (props.open) restoreFocus();
});

function onSelect(machineId: string): void {
  emit("select", machineId);
  emit("close");
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    event.stopPropagation();
    event.preventDefault();
    emit("close");
    return;
  }
  if (event.key !== "Tab") return;

  const root = panelRef.value;
  if (!root) return;
  const items = focusables(root);
  if (items.length === 0) {
    event.preventDefault();
    root.focus();
    return;
  }
  const first = items[0] as HTMLElement;
  const last = items[items.length - 1] as HTMLElement;
  const active = document.activeElement as HTMLElement | null;
  const index = active ? items.indexOf(active) : -1;

  // 焦點在面板本身（或不在清單內）時拉回邊界；在頭尾時循環到另一端；其餘交給瀏覽器。
  let target: HTMLElement | null = null;
  if (index === -1) target = event.shiftKey ? last : first;
  else if (event.shiftKey && index === 0) target = last;
  else if (!event.shiftKey && index === items.length - 1) target = first;

  if (target) {
    event.preventDefault();
    target.focus();
  }
}
</script>

<template>
  <div v-if="open" class="fixed inset-x-0 bottom-0 top-14 z-[60]">
    <!-- 遮罩：起於工具列下緣；點擊收合 -->
    <div
      data-fg="anomaly-overlay-scrim"
      class="absolute inset-0 bg-scrim/50"
      aria-hidden="true"
      @click="emit('close')"
    />

    <div
      :id="panelId"
      ref="panelRef"
      data-fg="anomaly-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="異常清單"
      tabindex="-1"
      class="absolute inset-x-3 top-16 flex max-h-[calc(100%-4.5rem)] flex-col overflow-hidden rounded-card border border-edge bg-surface-strong text-ink shadow-sheet focus:outline-none"
      @keydown="onKeydown"
    >
      <!--
        標題列不捲動：清單捲動時列不會滑到關閉鈕底下，清除鈕不會被誤觸成關閉。
        可見標題只作視覺（aria-hidden），讀屏仍由 AnomalySummary 的 h2（轉為 sr-only）命名清單。
        關閉鈕在 DOM 最前（Tab 第一站），與每列清除鈕同一欄。
      -->
      <div class="flex h-10 shrink-0 items-center justify-between gap-3 pl-3.5 pr-3">
        <span class="text-sm font-semibold text-ink-2" aria-hidden="true">最近異常</span>
        <button
          type="button"
          class="relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-control text-ink-2 transition-colors duration-150 hover:bg-rim hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          aria-label="關閉異常清單"
          @click="emit('close')"
        >
          <X class="h-4 w-4" aria-hidden="true" />
        </button>
      </div>

      <!-- 摘要列的玻璃外框交給面板；它的標題改由上方標題列顯示 -->
      <div
        data-fg="anomaly-overlay-scroll"
        class="min-h-0 flex-1 overflow-y-auto [&>section]:rounded-none [&>section]:border-0 [&>section]:bg-transparent [&>section]:pt-0 [&>section]:shadow-none [&>section>h2]:sr-only"
      >
        <AnomalySummary
          :items="items"
          :now="now"
          :selected-id="selectedId"
          @select="onSelect"
          @clear="emit('clear', $event)"
        />
      </div>
    </div>
  </div>
</template>
