<script setup lang="ts">
import type { ConnectionStatus } from "../../domains/monitoring/stores/monitoring.store.js";

/**
 * 監控台外殼（design-spec §6/§7.1）：sidebar / top bar / main / drawer slot。
 *
 * `connectionStatus` 僅供版面用途——連線狀態**單一資料來源為 store.connectionStatus**，
 * chip 顏色/label 由 TopBar 直接讀 store（避免雙軌）。004 的 drawer slot 先留空（005 填 CopilotDrawer）。
 */
defineProps<{
  connectionStatus: ConnectionStatus;
  drawerOpen: boolean;
}>();
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

    <!-- Right drawer（005 CopilotDrawer）；開啟時 main 重新排版不遮 top bar -->
    <aside
      v-if="drawerOpen"
      class="w-[400px] shrink-0 border-l border-subtle bg-elevated shadow-drawer"
    >
      <slot name="drawer" />
    </aside>
  </div>
</template>
