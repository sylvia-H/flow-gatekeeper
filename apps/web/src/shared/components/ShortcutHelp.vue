<script setup lang="ts">
import { ref } from "vue";
import { X } from "lucide-vue-next";
import {
  SHORTCUTS,
  SHORTCUT_FOOTNOTE,
  SHORTCUT_HELP_TITLE,
  type ShortcutGroup,
} from "../lib/shortcuts.js";
import { useFocusTrap } from "../composables/useFocusTrap.js";

/**
 * 鍵盤快捷鍵說明層（spec FR-034b、ui-contract §3–§4、data-model §11）。
 *
 * 內容只由 `SHORTCUTS` 常數渲染，不另寫清單，與 `useKeyboardShortcuts` 共用同一份來源。
 * 版面：遮罩與面板都起於 `top-14`（工具列 56px 之下），所以工具列永遠不被蓋住；
 * 面板不透明（`bg-surface-strong`），手機滿寬、md 以上靠右 420px，內容過長時面板內捲動。
 *
 * 行為：開啟時把焦點移進面板並記下原本的焦點，Tab／Shift+Tab 在面板內循環，Escape 只關閉
 * 這一層（攔下冒泡，App 層 window 上的 Escape 不會再關第二層），關閉後焦點還給開啟前的元素。
 */
const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();

const GROUP_ORDER: readonly ShortcutGroup[] = ["全域", "搜尋", "機台卡片", "版面"];

const groups = GROUP_ORDER.map((name) => ({
  name,
  entries: SHORTCUTS.filter((entry) => entry.group === name),
}));

const TITLE_ID = "shortcut-help-title";

const panelRef = ref<HTMLElement | null>(null);
const trap = useFocusTrap(panelRef, () => props.open);

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    event.stopPropagation();
    event.preventDefault();
    emit("close");
    return;
  }
  trap.onKeydown(event);
}
</script>

<template>
  <div v-if="open" class="fixed inset-x-0 bottom-0 top-14 z-[70]">
    <!-- 遮罩：起於工具列下緣；點擊關閉 -->
    <div class="absolute inset-0 bg-scrim/50" aria-hidden="true" @click="emit('close')" />

    <div
      ref="panelRef"
      data-fg="shortcut-help"
      role="dialog"
      aria-modal="true"
      :aria-labelledby="TITLE_ID"
      tabindex="-1"
      class="absolute inset-x-3 top-3 flex max-h-[calc(100%-1.5rem)] flex-col overflow-hidden rounded-card border border-edge bg-surface-strong text-ink shadow-panel focus:outline-none md:left-auto md:right-3 md:w-[420px]"
      @keydown="onKeydown"
    >
      <div class="flex shrink-0 items-center justify-between gap-3 border-b border-edge py-2 pl-4 pr-2">
        <h2 :id="TITLE_ID" class="text-md font-semibold text-ink">{{ SHORTCUT_HELP_TITLE }}</h2>
        <button
          type="button"
          class="flex h-8 w-8 shrink-0 items-center justify-center rounded-control text-ink-2 transition-colors duration-150 hover:bg-rim hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          aria-label="關閉快捷鍵說明"
          @click="emit('close')"
        >
          <X class="h-4 w-4" aria-hidden="true" />
        </button>
      </div>

      <!-- 可捲動區可用鍵盤聚焦，內容過長時鍵盤使用者也能捲動 -->
      <div
        class="min-h-0 flex-1 overflow-y-auto px-4 pb-4 pt-3 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus"
        tabindex="0"
        role="region"
        aria-label="快捷鍵清單"
      >
        <section
          v-for="group in groups"
          :key="group.name"
          class="mt-5 first:mt-0"
        >
          <h3 class="mb-2 text-xs font-semibold text-ink-2">{{ group.name }}</h3>
          <dl class="divide-y divide-edge border-y border-edge">
            <div
              v-for="entry in group.entries"
              :key="entry.id"
              :data-shortcut="entry.id"
              class="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 py-2"
            >
              <dt class="flex flex-wrap content-start gap-1">
                <kbd
                  v-for="(key, keyIndex) in entry.keys"
                  :key="keyIndex"
                  class="min-w-[1.5rem] rounded-control border border-edge bg-rim px-1.5 text-center font-mono text-xs leading-5 text-ink"
                  v-text="key"
                />
              </dt>
              <dd class="min-w-0">
                <p class="text-sm text-ink">{{ entry.action }}</p>
                <p class="mt-0.5 text-xs text-ink-3">{{ entry.scope }}</p>
              </dd>
            </div>
          </dl>
        </section>

        <p class="mt-4 text-xs text-ink-3">{{ SHORTCUT_FOOTNOTE }}</p>
      </div>
    </div>
  </div>
</template>
