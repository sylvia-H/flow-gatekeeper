<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { ChevronUp, PanelRightOpen } from "lucide-vue-next";
import { useResizeDrag } from "../composables/useResizeDrag.js";

/**
 * 監控台外殼：rail（sidebar slot）／工具列（topbar slot）／主區桌面（main slot）／
 * Copilot 面板（drawer slot）。
 *
 * - rail 與工具列是桌邊（`bg-rim`）；主區是帶 24px 格線的桌面（`bg-bench bg-bench-grid-lines`），
 *   其上的面板一律用同一組玻璃 class（`bg-surface/72 border border-edge shadow-glass rounded-card`）。
 * - Copilot 面板只有一個開關 `panelOpen`（所有寬度共用，預設收合由 App 決定；spec FR-033）：
 *   `lg+`（≥ 1024px）是主區右側 360px 的玻璃片，收合時把寬度還給主區、右緣留「展開 AI 診斷」窄條；
 *   `< lg` 是 bottom-sheet（抓取把手、遮罩、`shadow-sheet`），收合後若仍有選取機台（`peekLabel`
 *   非 null）退為 32px peek 條，點擊即展開；無選取時完全不渲染。768–1023px 雖仍顯示 rail，
 *   面板也走 sheet：rail 240 + 面板 360 並排會把卡片欄擠到約 110px、文字全被截斷。
 *   斷點須與 `useModalSheet` 的 MOBILE_QUERY 一致（sheet 形態才掛 dialog 語意與焦點陷阱）。
 * - drawer slot 只渲染一次，由外層 aside 以響應式 class 切換兩種形態，避免重複掛載
 *   CopilotDrawer 造成雙份副作用。
 * - `dismiss-panel` 只來自 sheet 遮罩點擊（不算手動收合）；面板上的收合鈕由 drawer
 *   自己 emit，App 據此區分兩者（偏好語意於 US6 接線）。本元件不監聽 Escape：桌機由 App 層
 *   `useKeyboardShortcuts` 依分層順序處理（FR-034a），手機 sheet 內由 drawer 的 `useModalSheet` 處理。
 */
const props = defineProps<{
  /** Copilot 面板是否展開。 */
  panelOpen: boolean;
  /** 選取機台的顯示名稱；null＝無選取（peek 條不渲染）。 */
  peekLabel: string | null;
}>();

const emit = defineEmits<{
  (e: "open-panel"): void;
  (e: "dismiss-panel"): void;
}>();

/** peek 條是否渲染：sheet 收合且仍有選取機台（lg+ 由 class 隱藏）。 */
const peekVisible = computed(() => !props.panelOpen && props.peekLabel !== null);

/**
 * 寬螢幕（lg+）收合／展開時，若焦點原本在即將消失的那一側（面板內的收合鈕、或展開窄條），
 * 把焦點接到另一側，避免掉回 body。焦點不在其中（例如點選卡片自動展開）則不搬動，
 * 以免打斷卡片間的鍵盤操作。bottom-sheet（< lg）的焦點由 drawer 的 useModalSheet 負責。
 */
const panelRef = ref<HTMLElement | null>(null);
const expandRef = ref<HTMLButtonElement | null>(null);
const DESKTOP_QUERY = "(min-width: 1024px)";
watch(
  () => props.panelOpen,
  (open) => {
    const active = document.activeElement;
    const leaving = open ? expandRef.value : panelRef.value;
    if (!leaving || !(active instanceof Node) || !leaving.contains(active)) return;
    if (typeof window.matchMedia === "function" && !window.matchMedia(DESKTOP_QUERY).matches) return;
    void nextTick(() => (open ? panelRef.value : expandRef.value)?.focus());
  },
);

/**
 * 側欄寬度可拖曳或用鍵盤調整（預設 240px，200–420；聚焦把手後 ArrowRight 加寬／ArrowLeft 減寬 16px，
 * FR-034c），偏好存 localStorage。
 */
const {
  size: sidebarWidth,
  startDrag: onSidebarHandleDown,
  onKeydown: onSidebarHandleKeydown,
  handleAttrs: sidebarHandleAttrs,
} = useResizeDrag({
  axis: "x",
  min: 200,
  max: 420,
  initial: 240,
  storageKey: "flow-gatekeeper:sidebar-width",
  label: "調整側欄寬度",
});
</script>

<template>
  <!-- App shell：不讓 body scroll，內部各區自行 scroll -->
  <div class="flex h-screen w-screen overflow-hidden bg-bench font-sans text-ink">
    <!-- rail：桌邊鋼灰，滿版高；手機隱藏（機群健康改由主區摘要條承載，US6）。
         768–1023px 時 peek 條橫跨整個底部，rail 同樣讓出 32px，底部的主題切換才不被蓋住。 -->
    <aside
      class="hidden shrink-0 flex-col overflow-y-auto border-r border-edge bg-rim md:flex"
      :class="peekVisible ? 'pb-8 lg:pb-0' : ''"
      :style="{ width: `${sidebarWidth}px` }"
      aria-label="側欄"
    >
      <slot name="sidebar" />
    </aside>

    <!-- 側欄寬度把手（僅桌機；疊在 border-r 上，抓取熱區比 1px 邊線寬）。可 Tab 聚焦、方向鍵調整；
         把手只有 6px 寬，聚焦時連同底色一起亮起才看得見。Tab 順序落在 rail 之後、主區之前。 -->
    <div
      v-bind="sidebarHandleAttrs"
      class="z-10 hidden w-1.5 shrink-0 -translate-x-px cursor-col-resize touch-none hover:bg-accent/60 focus:outline-none focus-visible:bg-accent/60 focus-visible:ring-2 focus-visible:ring-focus md:block"
      @pointerdown="onSidebarHandleDown"
      @keydown="onSidebarHandleKeydown"
    />

    <div class="flex min-w-0 flex-1 flex-col">
      <!-- 工具列：56px 桌邊 -->
      <header
        class="flex h-14 min-w-0 shrink-0 items-center overflow-hidden border-b border-edge bg-rim px-3"
      >
        <slot name="topbar" />
      </header>

      <!-- 主區桌面：格線底；主內容與 lg+ 的 Copilot 玻璃片並排 -->
      <div
        class="flex min-h-0 flex-1 bg-bench bg-bench-grid-lines"
        :class="peekVisible ? 'pb-8 lg:pb-0' : ''"
      >
        <main class="min-h-0 min-w-0 flex-1 overflow-auto p-3">
          <slot name="main" />
        </main>

        <!-- bottom-sheet（小於 lg）背景遮罩：起於 top-14 不遮工具列；點擊收合 -->
        <div
          v-if="panelOpen"
          class="fixed inset-x-0 bottom-0 top-14 z-40 bg-scrim/50 lg:hidden"
          aria-hidden="true"
          @click="emit('dismiss-panel')"
        />

        <!-- Copilot 面板：lg+ 為 360px 玻璃片；小於 lg 為 bottom-sheet（70–85vh，不透明以蓋住下方內容） -->
        <aside
          ref="panelRef"
          tabindex="-1"
          data-fg="copilot"
          :data-open="panelOpen ? 'true' : 'false'"
          :class="[
            panelOpen ? 'flex' : 'hidden',
            'fixed inset-x-0 bottom-0 z-50 max-h-[85vh] min-h-[70vh] flex-col overflow-hidden focus:outline-none rounded-t-card border-t border-edge bg-surface-strong shadow-sheet',
            'lg:static lg:z-auto lg:my-3 lg:mr-3 lg:max-h-none lg:min-h-0 lg:w-[360px] lg:shrink-0 lg:rounded-card lg:border lg:bg-surface/72 lg:shadow-glass',
          ]"
          aria-label="AI 診斷"
        >
          <!-- 抓取把手（裝飾；面板名稱由 aside 的 aria-label 提供） -->
          <div class="flex shrink-0 justify-center pb-1 pt-2 lg:hidden" aria-hidden="true">
            <span class="h-1 w-10 rounded-control bg-ink-3" />
          </div>
          <slot name="drawer" />
        </aside>

        <!-- lg+ 收合時的展開窄條：還寬度給主區，仍可一眼找到 -->
        <button
          v-if="!panelOpen"
          ref="expandRef"
          type="button"
          class="my-3 mr-3 hidden w-9 shrink-0 flex-col items-center gap-2 rounded-card border border-edge bg-surface/72 py-3 text-ink-2 shadow-glass transition-colors duration-150 hover:bg-surface hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-focus lg:flex"
          aria-label="展開 AI 診斷"
          title="展開 AI 診斷"
          @click="emit('open-panel')"
        >
          <PanelRightOpen class="h-4 w-4 shrink-0" aria-hidden="true" />
          <span class="text-xs font-semibold [writing-mode:vertical-rl]" aria-hidden="true">
            AI 診斷
          </span>
        </button>
      </div>
    </div>

    <!-- peek 條（小於 lg）：sheet 收合但仍有選取機台時常駐底部 32px；點擊展開 -->
    <button
      v-if="peekVisible"
      type="button"
      data-fg="copilot-peek"
      class="fixed inset-x-0 bottom-0 z-40 flex h-8 items-center gap-2 border-t border-edge bg-surface-strong px-4 text-sm text-ink shadow-sheet focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus lg:hidden"
      :aria-label="`展開 AI 診斷：${peekLabel}`"
      @click="emit('open-panel')"
    >
      <ChevronUp class="h-4 w-4 shrink-0 text-ink-3" aria-hidden="true" />
      <span class="shrink-0 text-xs font-semibold text-ink-2">AI 診斷</span>
      <span class="min-w-0 truncate">{{ peekLabel }}</span>
      <!-- 診斷狀態 chip 的位置（US5 T051 接線） -->
      <span class="ml-auto flex shrink-0 items-center">
        <slot name="peek-status" />
      </span>
    </button>
  </div>
</template>
