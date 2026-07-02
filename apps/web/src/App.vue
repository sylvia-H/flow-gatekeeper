<script setup lang="ts">
import { Activity, Boxes } from "lucide-vue-next";
import AppLayout from "./shared/components/AppLayout.vue";
import TopBar from "./shared/components/TopBar.vue";
import TopologyCanvas from "./domains/monitoring/components/TopologyCanvas.vue";
import { useMonitoringStore } from "./domains/monitoring/stores/monitoring.store.js";
import { useHighFrequencyWs } from "./domains/monitoring/composables/useHighFrequencyWs.js";
import { KNOWN_MACHINE_IDS, machineLabel } from "./domains/monitoring/lib/machine-labels.js";

/**
 * App 根：組裝監控台外殼並接上即時通道。第一屏即監控台（design-spec §1/§6）。
 * TopBar 於 US2（T019）填入；連線韌性 UI 於 US3（T023）補上。
 */
const store = useMonitoringStore();

// 同源 /ws（dev 由 Vite proxy 轉發到 :3000）——不把後端位址塞進 bundle（research R2）。
const wsProto = location.protocol === "https:" ? "wss" : "ws";
const wsUrl = `${wsProto}://${location.host}/ws`;

const handle = useHighFrequencyWs({
  url: wsUrl,
  onBatch: store.applyTelemetryBatch,
  onStatus: store.setConnectionStatus,
  // 每次（重）連線都會觸發：保存 clientId（供 005）並用單一名冊訂閱 5 台（dev 送空 token）。
  onConnected: (clientId: string) => {
    store.setClientId(clientId);
    handle.send({
      type: "machine/subscribe",
      token: "",
      machineIds: [...KNOWN_MACHINE_IDS],
    });
  },
});
</script>

<template>
  <AppLayout :connection-status="store.connectionStatus" :drawer-open="false">
    <template #sidebar>
      <div class="flex items-center gap-2 border-b border-subtle px-4 py-3">
        <Activity class="h-5 w-5 text-accent" aria-hidden="true" />
        <div class="min-w-0">
          <div class="truncate text-sm font-semibold text-fg">flow-gatekeeper</div>
          <div class="text-xs text-fg-subtle">development</div>
        </div>
      </div>
      <nav class="px-3 py-4">
        <div class="px-1 pb-2 text-xs font-medium uppercase tracking-wide text-fg-subtle">
          Machines
        </div>
        <ul class="space-y-0.5">
          <li v-for="id in KNOWN_MACHINE_IDS" :key="id">
            <button
              type="button"
              class="flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-left text-sm text-fg-muted hover:bg-surface-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              :class="store.selectedMachineId === id ? 'bg-accent-bg text-fg' : ''"
              @click="store.selectMachine(id)"
            >
              <Boxes class="h-4 w-4 shrink-0 text-fg-subtle" aria-hidden="true" />
              <span class="truncate">{{ machineLabel(id) }}</span>
            </button>
          </li>
        </ul>
      </nav>
    </template>

    <template #topbar>
      <TopBar />
    </template>

    <template #main>
      <TopologyCanvas />
    </template>
  </AppLayout>
</template>
