<script setup lang="ts">
import { onMounted, onUnmounted } from "vue";
import { PanelRightOpen } from "lucide-vue-next";
import type { ConnectionStatus } from "../../domains/monitoring/stores/monitoring.store.js";
import { useResizeDrag } from "../composables/useResizeDrag.js";

/**
 * 監控台外殼（design-spec §6/§7.1）：sidebar / top bar / main / drawer slot。
 *
 * `connectionStatus` 僅供版面用途——連線狀態**單一資料來源為 store.connectionStatus**，
 * chip 顏色/label 由 TopBar 直接讀 store（避免雙軌）。
 *
 * Drawer 響應式（R8／FR-002/FR-015）：`md+` 為**可折疊**常駐右欄（`panelOpen` 控制顯示，
 * 收合後露出可展開的細把手、把寬度還給中間欄，修正小螢幕中欄被壓、Diagnose 被裁）；
 * mobile 改 bottom-sheet 覆蓋層（可 Escape 關閉、不遮頂欄）。drawer slot 只渲染一次，
 * 由外層 aside 以響應式 class 切換兩種形態，避免重複掛載 CopilotDrawer 造成雙份副作用。
 */
const props = defineProps<{
  connectionStatus: ConnectionStatus;
  drawerOpen: boolean;
  /** 桌機常駐面板是否展開（收合後由細把手 open-panel 再展開）。 */
  panelOpen: boolean;
}>();

const emit = defineEmits<{
  (e: "close-drawer"): void;
  (e: "open-panel"): void;
}>();

/** 手機 bottom-sheet 開啟時，Escape 關閉（design-spec §10）。桌機常駐不受影響。 */
function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape" && props.drawerOpen) emit("close-drawer");
}
onMounted(() => window.addEventListener("keydown", onKeydown));
onUnmounted(() => window.removeEventListener("keydown", onKeydown));

/** 側欄寬度可拖曳調整（預設 240px＝原 w-60），偏好存 localStorage。 */
const { size: sidebarWidth, startDrag: onSidebarHandleDown } = useResizeDrag({
  axis: "x",
  min: 200,
  max: 420,
  initial: 240,
  storageKey: "flow-gatekeeper:sidebar-width",
});
</script>

<template>
  <!-- App shell：不讓 body scroll，內部各區自行 scroll（design-spec §6.1） -->
  <div class="flex h-screen w-screen overflow-hidden bg-canvas font-sans text-fg">
    <!-- Left sidebar（預設 240px，可拖曳調整寬度；mobile 收起交給 Polish 處理） -->
    <aside
      class="hidden shrink-0 flex-col border-r border-subtle bg-surface md:flex"
      :style="{ width: `${sidebarWidth}px` }"
    >
      <slot name="sidebar" />
    </aside>

    <!-- 側欄寬度拖曳把手（僅桌機；疊在 border-r 上，抓取熱區比 1px 邊線寬） -->
    <div
      class="z-10 hidden w-1.5 shrink-0 -translate-x-px cursor-col-resize touch-none hover:bg-accent/60 md:block"
      role="separator"
      aria-orientation="vertical"
      aria-label="調整側欄寬度"
      @pointerdown="onSidebarHandleDown"
    />

    <!-- Main column：top bar（56px）+ main（fill） -->
    <div class="flex min-w-0 flex-1 flex-col">
      <header
        class="flex h-14 min-w-0 shrink-0 items-center overflow-hidden border-b border-subtle bg-surface px-4"
      >
        <slot name="topbar" />
      </header>
      <main class="min-h-0 flex-1 overflow-auto">
        <slot name="main" />
      </main>
    </div>

    <!-- 手機 bottom-sheet 背景遮罩：起於 top-14 不遮頂欄；點擊關閉（桌機隱藏） -->
    <div
      v-if="drawerOpen"
      class="fixed inset-x-0 bottom-0 top-14 z-40 bg-black/50 md:hidden"
      aria-hidden="true"
      @click="emit('close-drawer')"
    />

    <!-- Right drawer（005 CopilotDrawer）：桌機可折疊常駐右欄；手機 bottom-sheet（70–85vh） -->
    <aside
      :class="[
        drawerOpen ? 'flex' : 'hidden',
        panelOpen ? 'md:flex' : 'md:hidden',
        'fixed inset-x-0 bottom-0 z-50 max-h-[85vh] min-h-[70vh] flex-col rounded-t-card border-t border-subtle bg-elevated shadow-drawer',
        'md:static md:z-auto md:h-auto md:max-h-none md:min-h-0 md:w-[400px] md:shrink-0 md:rounded-none md:border-l md:border-t-0',
      ]"
      aria-label="AI Copilot"
    >
      <slot name="drawer" />
    </aside>

    <!-- 桌機面板收合時的展開把手（細直欄，還寬度給中間欄；手機不適用） -->
    <button
      v-if="!panelOpen"
      type="button"
      class="hidden w-9 shrink-0 flex-col items-center justify-center border-l border-subtle bg-surface text-fg-subtle hover:bg-surface-hover hover:text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent md:flex"
      aria-label="展開 AI Copilot 面板"
      title="展開 AI Copilot 面板"
      @click="emit('open-panel')"
    >
      <PanelRightOpen class="h-4 w-4" aria-hidden="true" />
    </button>
  </div>
</template>
