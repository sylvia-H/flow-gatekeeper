<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { Activity, Boxes } from "lucide-vue-next";
import AppLayout from "./shared/components/AppLayout.vue";
import TopBar from "./shared/components/TopBar.vue";
import TopologyCanvas from "./domains/monitoring/components/TopologyCanvas.vue";
import CopilotDrawer from "./domains/ai-copilot/components/CopilotDrawer.vue";
import { useMonitoringStore } from "./domains/monitoring/stores/monitoring.store.js";
import { useCopilotStore } from "./domains/ai-copilot/stores/copilot.store.js";
import { useHighFrequencyWs } from "./domains/monitoring/composables/useHighFrequencyWs.js";
import { KNOWN_MACHINE_IDS, machineLabel } from "./domains/monitoring/lib/machine-labels.js";
import type { CopilotJobState } from "./domains/ai-copilot/lib/copilot-reducer.js";

/**
 * App 根：組裝監控台外殼並接上即時通道。第一屏即監控台（design-spec §1/§6）。
 * 005：掛 copilot.store，診斷事件經 004 同一條 WebSocket 分流交 store（憲章 IV）。
 */
const store = useMonitoringStore();
const copilot = useCopilotStore();

// 手機 bottom-sheet 開關；桌機（md+）drawer 常駐、無視此值（R8）。選台即開啟手機 sheet。
const drawerOpen = ref(false);
watch(
  () => store.selectedMachineId,
  (id) => {
    if (id !== null) drawerOpen.value = true;
  },
);

/** drawer 恆依 selectedMachineId 取對應那一份狀態（未選取→idle 空殼，由 machineId=null 走空狀態）。 */
const selectedState = computed<CopilotJobState>(() =>
  store.selectedMachineId !== null
    ? copilot.stateFor(store.selectedMachineId)
    : { status: "idle", machineId: "" },
);
const selectedLabel = computed(() =>
  store.selectedMachineId !== null ? machineLabel(store.selectedMachineId) : "",
);
const canDiagnose = computed(() =>
  copilot.canDiagnose(store.selectedMachineId, store.clientId !== null),
);

function onDiagnose(): void {
  if (store.selectedMachineId !== null) {
    void copilot.diagnose(store.selectedMachineId, store.clientId);
  }
}
function onRetry(): void {
  if (store.selectedMachineId !== null) {
    void copilot.retry(store.selectedMachineId, store.clientId);
  }
}

// 冷啟動/斷線橫幅（design-spec §8.2）：連上前顯示 Connecting，之後依三態提示；不清空資料。
const banner = computed(() => {
  switch (store.connectionStatus) {
    case "connected":
      return null;
    case "reconnecting":
      return {
        text: "Reconnecting… 顯示最後已知資料",
        cls: "border-warn-border bg-warn-bg text-warn-fg",
      };
    case "disconnected":
      return store.clientId === null
        ? { text: "Connecting…", cls: "border-subtle bg-elevated text-fg-muted" }
        : {
            text: "Disconnected — 顯示最後已知資料，資料可能過時",
            cls: "border-crit-border bg-crit-bg text-crit-fg",
          };
  }
  return null;
});

// 每秒 tick 驅動 stale 重算（低頻，不需高頻；research R7）。
let tickTimer: ReturnType<typeof setInterval> | null = null;
onMounted(() => {
  tickTimer = setInterval(() => store.tickNow(), 1000);
});
onUnmounted(() => {
  if (tickTimer !== null) clearInterval(tickTimer);
});

// 同源 /ws（dev 由 Vite proxy 轉發到 :3000）——不把後端位址塞進 bundle（research R2）。
const wsProto = location.protocol === "https:" ? "wss" : "ws";
const wsUrl = `${wsProto}://${location.host}/ws`;

const handle = useHighFrequencyWs({
  url: wsUrl,
  onBatch: store.applyTelemetryBatch,
  onStatus: store.setConnectionStatus,
  // 診斷事件分流交 copilot.store（憲章 IV／FR-017：不進遙測 buffer）。
  onDiagnosisEvent: copilot.applyEvent,
  // 每次（重）連線都會觸發：保存 clientId（供 005）並用單一名冊訂閱 5 台（dev 送空 token）。
  onConnected: (clientId: string) => {
    store.setClientId(clientId);
    // 005：重連（新 clientId）使舊綁定失效——把仍 active 的台標中斷＋可 Retry（FR-012／R7）。
    copilot.onReconnect(clientId);
    handle.send({
      type: "machine/subscribe",
      token: "",
      machineIds: [...KNOWN_MACHINE_IDS],
    });
  },
});
</script>

<template>
  <AppLayout
    :connection-status="store.connectionStatus"
    :drawer-open="drawerOpen"
    @close-drawer="drawerOpen = false"
  >
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
      <div class="flex h-full flex-col">
        <div
          v-if="banner"
          class="shrink-0 border-b px-4 py-2 text-sm"
          :class="banner.cls"
          role="status"
        >
          {{ banner.text }}
        </div>
        <div class="min-h-0 flex-1">
          <TopologyCanvas />
        </div>
      </div>
    </template>

    <template #drawer>
      <CopilotDrawer
        :state="selectedState"
        :machine-id="store.selectedMachineId"
        :machine-label="selectedLabel"
        :summary="store.selectedMachine"
        :can-diagnose="canDiagnose"
        :has-client="store.clientId !== null"
        @diagnose="onDiagnose"
        @retry="onRetry"
        @close="drawerOpen = false"
      />
    </template>
  </AppLayout>
</template>
