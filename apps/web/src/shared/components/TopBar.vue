<script setup lang="ts">
import { computed } from "vue";
import { Search, Stethoscope, Gauge } from "lucide-vue-next";
import BackpressureBadge from "./BackpressureBadge.vue";
import {
  useMonitoringStore,
  type ConnectionStatus,
} from "../../domains/monitoring/stores/monitoring.store.js";

/**
 * TopBar（design-spec §7.2）：search（外觀）、connection chip、BackpressureBadge、
 * diagnose 佔位（→005）、mock-frequency 佔位（FR-027）。
 * connection chip 讀 **store.connectionStatus 單一來源**；上色於 US3（T023）補上。
 */
const store = useMonitoringStore();

const CONNECTION_LABEL: Record<ConnectionStatus, string> = {
  connected: "Connected",
  reconnecting: "Reconnecting",
  disconnected: "Disconnected",
};
/** chip 上色（design-spec §7.1/§8.2，connected→ok / reconnecting→warn / disconnected→crit）。 */
const CONNECTION_CHIP: Record<ConnectionStatus, { dot: string; text: string }> = {
  connected: { dot: "bg-ok", text: "text-ok-fg" },
  reconnecting: { dot: "bg-warn", text: "text-warn-fg" },
  disconnected: { dot: "bg-crit", text: "text-crit-fg" },
};
const connectionLabel = computed(() => CONNECTION_LABEL[store.connectionStatus]);
const connectionChip = computed(() => CONNECTION_CHIP[store.connectionStatus]);
const chipPulse = computed(() => store.connectionStatus === "disconnected");
</script>

<template>
  <div class="flex w-full items-center gap-3">
    <!-- Search（外觀，邏輯留待後續） -->
    <div class="relative w-full max-w-xs">
      <Search
        class="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-subtle"
        aria-hidden="true"
      />
      <input
        type="search"
        placeholder="Search machines"
        aria-label="Search machines"
        class="h-9 w-full rounded-control border border-subtle bg-inset pl-8 pr-3 text-sm text-fg placeholder:text-fg-subtle focus:border-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      />
    </div>

    <div class="ml-auto flex items-center gap-3">
      <!-- Mock frequency 控制（disabled 佔位，FR-027） -->
      <button
        type="button"
        disabled
        title="Mock telemetry frequency（後續啟用）"
        class="flex h-9 cursor-not-allowed items-center gap-1.5 rounded-control border border-subtle bg-surface px-2.5 text-xs text-fg-subtle opacity-60"
      >
        <Gauge class="h-4 w-4" aria-hidden="true" />
        <span class="hidden md:inline">Mock Hz</span>
      </button>

      <!-- 背壓計量 -->
      <BackpressureBadge
        :received-messages="store.receivedMessages"
        :rendered-batches="store.renderedBatches"
      />

      <!-- Connection status chip（讀 store.connectionStatus 單一來源，依三態上色） -->
      <span
        class="inline-flex items-center gap-1.5 rounded-pill bg-elevated px-2.5 py-1 text-xs"
        :class="connectionChip.text"
        role="status"
        :aria-label="`Connection: ${connectionLabel}`"
      >
        <span
          class="h-2 w-2 rounded-pill"
          :class="[connectionChip.dot, chipPulse ? 'animate-critical-pulse' : '']"
        />
        {{ connectionLabel }}
      </span>

      <!-- Diagnose（disabled 佔位，實際觸發屬 005） -->
      <button
        type="button"
        disabled
        title="Run AI diagnosis（005 啟用）"
        class="flex h-9 cursor-not-allowed items-center gap-1.5 rounded-control bg-accent px-3 text-sm font-medium text-base opacity-50"
      >
        <Stethoscope class="h-4 w-4" aria-hidden="true" />
        <span class="hidden md:inline">Diagnose</span>
      </button>
    </div>
  </div>
</template>
