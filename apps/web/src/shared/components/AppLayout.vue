<script setup lang="ts">
import { onMounted, onUnmounted } from "vue";
import type { ConnectionStatus } from "../../domains/monitoring/stores/monitoring.store.js";

/**
 * 監控台外殼（design-spec §6/§7.1）：sidebar / top bar / main / drawer slot。
 *
 * `connectionStatus` 僅供版面用途——連線狀態**單一資料來源為 store.connectionStatus**，
 * chip 顏色/label 由 TopBar 直接讀 store（避免雙軌）。
 *
 * Drawer 響應式（R8／FR-002/FR-015）：`md+` 常駐右欄（版面固定欄、idle 也顯示）；
 * mobile 改 bottom-sheet 覆蓋層（可 Escape 關閉、不遮頂欄）。drawer slot 只渲染一次，
 * 由外層 aside 以響應式 class 切換兩種形態，避免重複掛載 CopilotDrawer 造成雙份副作用。
 */
const props = defineProps<{
  connectionStatus: ConnectionStatus;
  drawerOpen: boolean;
}>();

const emit = defineEmits<{ (e: "close-drawer"): void }>();

/** 手機 bottom-sheet 開啟時，Escape 關閉（design-spec §10）。桌機常駐不受影響。 */
function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape" && props.drawerOpen) emit("close-drawer");
}
onMounted(() => window.addEventListener("keydown", onKeydown));
onUnmounted(() => window.removeEventListener("keydown", onKeydown));
</script>

<template>
  <!-- App shell：不讓 body scroll，內部各區自行 scroll（design-spec §6.1） -->
  <div class="flex h-screen w-screen overflow-hidden bg-base font-sans text-fg">
    <!-- Left sidebar（240px，mobile 收起交給 Polish 處理） -->
    <aside
      class="hidden w-60 shrink-0 flex-col border-r border-subtle bg-surface md:flex"
    >
      <slot name="sidebar" />
    </aside>

    <!-- Main column：top bar（56px）+ main（fill） -->
    <div class="flex min-w-0 flex-1 flex-col">
      <header
        class="flex h-14 shrink-0 items-center border-b border-subtle bg-surface px-4"
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

    <!-- Right drawer（005 CopilotDrawer）：桌機常駐右欄；手機 bottom-sheet（70–85vh） -->
    <aside
      :class="[
        drawerOpen ? 'flex' : 'hidden',
        'fixed inset-x-0 bottom-0 z-50 max-h-[85vh] min-h-[70vh] flex-col rounded-t-card border-t border-subtle bg-elevated shadow-drawer',
        'md:static md:z-auto md:h-auto md:max-h-none md:min-h-0 md:w-[400px] md:shrink-0 md:flex md:rounded-none md:border-l md:border-t-0',
      ]"
      aria-label="AI Copilot"
    >
      <slot name="drawer" />
    </aside>
  </div>
</template>
