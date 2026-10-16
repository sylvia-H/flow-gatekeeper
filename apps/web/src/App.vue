<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import AppLayout from "./shared/components/AppLayout.vue";
import TopBar from "./shared/components/TopBar.vue";
import ThemeToggle from "./shared/components/ThemeToggle.vue";
import BackpressureStrip from "./shared/components/BackpressureStrip.vue";
import StageTopology from "./domains/monitoring/components/StageTopology.vue";
import FleetHealth from "./domains/monitoring/components/FleetHealth.vue";
import AnomalySummary from "./domains/monitoring/components/AnomalySummary.vue";
import EventStrip from "./domains/monitoring/components/EventStrip.vue";
import CopilotDrawer from "./domains/ai-copilot/components/CopilotDrawer.vue";
import { useMonitoringStore } from "./domains/monitoring/stores/monitoring.store.js";
import { useMetricsStore } from "./domains/monitoring/stores/metrics.store.js";
import { useCopilotStore } from "./domains/ai-copilot/stores/copilot.store.js";
import { useHighFrequencyWs } from "./domains/monitoring/composables/useHighFrequencyWs.js";
import { useResizeDrag } from "./shared/composables/useResizeDrag.js";
import { useDiagnoseTrigger } from "./domains/ai-copilot/composables/useDiagnoseTrigger.js";
import { MACHINE_IDS } from "@flow-gatekeeper/contracts";
import { machineLabel } from "./domains/monitoring/lib/machine-labels.js";
import type { CopilotJobState } from "./domains/ai-copilot/lib/copilot-reducer.js";

/**
 * App 根：組裝監控台外殼並接上即時通道。第一屏即監控台。
 * 005：掛 copilot.store，診斷事件經 004 同一條 WebSocket 分流交 store（憲章 IV）。
 */
const store = useMonitoringStore();
const copilot = useCopilotStore();
// 009 US3：`system/metrics` 的唯一消費者（dev 面板）。低頻，直接寫入不進 rAF buffer。
const metrics = useMetricsStore();

/** 事件流面板高度可拖曳調整（把手在面板上緣，往上拖增高，故 direction: -1）。 */
const { size: eventStripHeight, startDrag: onEventStripHandleDown } = useResizeDrag({
  axis: "y",
  min: 100,
  max: 360,
  initial: 150,
  storageKey: "flow-gatekeeper:event-strip-height",
  direction: -1,
});

/**
 * Copilot 面板開關（所有寬度共用；spec FR-033）：預設收合；選台 → 展開；取消選取 → 收合；
 * 面板收合鈕、Escape、手機遮罩 → 收合。手動收合偏好（`fg.copilot-panel`）於 US6 T059 接線，
 * 屆時 `onClosePanel`（收合鈕）與 `onDismissPanel`（Escape／遮罩）的語意才會分開。
 */
const panelOpen = ref(false);
watch(
  () => store.selectedMachineId,
  (id) => {
    panelOpen.value = id !== null;
  },
);

/** 面板上的收合鈕（手動收合）。 */
function onClosePanel(): void {
  panelOpen.value = false;
}
/** Escape（AppLayout 的 window 監聽或手機 sheet 內的 drawer `dismiss`）／手機遮罩點擊（只影響當次）。 */
function onDismissPanel(): void {
  panelOpen.value = false;
}

/** drawer 恆依 selectedMachineId 取對應那一份狀態（未選取→idle 空殼，由 machineId=null 走空狀態）。 */
const selectedState = computed<CopilotJobState>(() =>
  store.selectedMachineId !== null
    ? copilot.stateFor(store.selectedMachineId)
    : { status: "idle", machineId: "" },
);
const selectedLabel = computed(() =>
  store.selectedMachineId !== null ? machineLabel(store.selectedMachineId) : "",
);
/** 手機 peek 條的機台名稱；無選取時為 null（peek 條不渲染）。 */
const peekLabel = computed(() => (store.selectedMachineId !== null ? selectedLabel.value : null));

// 診斷觸發走共用入口（TopBar／卡片 icon／drawer 同一份邏輯），clientId 只從 monitoring store 讀。
const trigger = useDiagnoseTrigger();
const { canDiagnoseSelected: canDiagnose, connectionBlockedReason } = trigger;

function onDiagnose(): void {
  if (store.selectedMachineId !== null) trigger.diagnose(store.selectedMachineId);
}
function onRetry(): void {
  if (store.selectedMachineId !== null) trigger.retry(store.selectedMachineId);
}
/** 中止：放棄該台目前診斷（→ idle，可立即重新診斷）。 */
function onCancel(): void {
  if (store.selectedMachineId !== null) {
    copilot.cancel(store.selectedMachineId);
  }
}

// 主區標題「機群總覽 · N 台」（N＝固定名冊長度）：畫面上由背壓 strip 取代，只留給輔助技術（R13）。
const machineCount = computed(() => MACHINE_IDS.length);

/**
 * 連線／授權橫幅：連上前顯示「連線中」，之後依三態提示；不清空資料。
 * 連線正常但訂閱未授權時改顯示未授權說明（沿用 store 的 AUTH_ERROR_MESSAGE，本身已含「未授權」）。
 * 橫幅不設 live region：連線三態由 TopBar 連線 chip（role=status）、未授權由未授權 chip
 * （role=alert）朗讀，避免同一件事念兩次。
 */
const banner = computed(() => {
  switch (store.connectionStatus) {
    case "reconnecting":
      return {
        text: "重新連線中…（畫面保留最後已知資料）",
        cls: "border-warn bg-warn-bg text-warn-fg",
      };
    case "disconnected":
      return !store.everConnected
        ? { text: "連線中…", cls: "border-edge bg-surface/72 text-ink-2" }
        : {
            text: "已斷線，畫面保留最後已知資料，可能已過時",
            cls: "border-crit bg-crit-bg text-crit-fg",
          };
    case "connected":
      return store.authError !== null
        ? { text: store.authError, cls: "border-crit bg-crit-bg text-crit-fg" }
        : null;
  }
  return null;
});

// 每秒 tick 驅動 stale 重算（低頻，不需高頻；research R7）。`store.now` 恆照走——Pause 的
// 凍結只作用在 `store.staleNow`（卡片／機群健康），watchdog 與 metrics 面板仍用真實時間。
// 同一個 tick 順帶跑診斷逾時 watchdog：active 任務逾 STALL_TIMEOUT_MS 無進展即自動收尾為
// failed（可重試），避免後端卡住時面板永遠停在進行中（門檻取 worker AI_TIMEOUT 30s + 餘裕）。
const STALL_TIMEOUT_MS = 45_000;
let tickTimer: ReturnType<typeof setInterval> | null = null;
onMounted(() => {
  tickTimer = setInterval(() => {
    store.tickNow();
    copilot.checkStalls(Date.now(), STALL_TIMEOUT_MS);
  }, 1000);
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
  // US4：pause 時 pump 跳過 flush（續存 buffer）；pong RTT 回報 store.latencyMs。
  isPaused: () => store.paused,
  onLatency: store.setLatency,
  // 訂閱授權結果（system/unauthorized 不再靜默忽略，TopBar 顯示未授權 chip）。
  onAuthResult: store.setAuthorized,
  // 溢位合併與入口剔除的筆數計入背壓計量（背壓 strip 另列近 60 秒的丟棄數）。
  onDrop: store.recordDropped,
  // 診斷事件分流交 copilot.store（憲章 IV／FR-017：不進遙測 buffer）。
  onDiagnosisEvent: copilot.applyEvent,
  // 009：指標摘要（低頻）直接交 metrics.store，同樣不進遙測 buffer。
  onMetrics: metrics.applyMetrics,
  // 每次（重）連線都會觸發：保存 clientId（單一來源為 monitoring store）並用單一名冊訂閱 5 台
  // （dev 送空 token）。
  onConnected: (clientId: string) => {
    store.setClientId(clientId);
    // 005：重連（新 clientId）使舊綁定失效——把仍 active 的台標中斷＋可重試（FR-012／R7）。
    copilot.onReconnect(clientId);
    handle.send({
      type: "machine/subscribe",
      token: "",
      machineIds: [...MACHINE_IDS],
    });
  },
});
</script>

<template>
  <AppLayout
    :panel-open="panelOpen"
    :peek-label="peekLabel"
    @open-panel="panelOpen = true"
    @dismiss-panel="onDismissPanel"
  >
    <template #sidebar>
      <div class="flex min-h-full flex-col gap-3 p-4">
        <!-- 品牌列：產品名＋環境 -->
        <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span class="min-w-0 truncate text-lg font-bold text-ink">flow-gatekeeper</span>
          <span
            class="shrink-0 rounded-pill border border-edge px-2 text-xs font-semibold text-ink-2"
          >
            <span class="sr-only">環境：</span>開發
          </span>
        </div>

        <!-- 機群健康：四計數＋比例條，隨遙測即時更新（玻璃片外觀由元件自帶） -->
        <FleetHealth :summary="store.fleetHealth" />

        <!-- 最近異常摘要（US5 T050 接線） -->
        <AnomalySummary />

        <!-- 主題切換：rail 底部 -->
        <div class="mt-auto pt-2">
          <ThemeToggle />
        </div>
      </div>
    </template>

    <template #topbar>
      <TopBar />
    </template>

    <template #main>
      <div class="flex h-full min-h-0 flex-col gap-3">
        <h1 class="sr-only">機群總覽 · {{ machineCount }} 台</h1>
        <!-- 背壓 strip：工具列正下方常駐（FR-009）；在橫幅之上，斷線時橫幅出現也不把它往下推 -->
        <BackpressureStrip
          class="shrink-0"
          :samples="store.rateSamples"
          :peak="store.ratePeak"
          :window-ratio="store.windowRatio"
          :cumulative-ratio="store.cumulativeRatio"
          :dropped="store.droppedInWindow"
          :stale="store.rateStale"
          :msgs-per-sec="store.latestRate?.msgsPerSec ?? null"
          :batches-per-sec="store.latestRate?.batchesPerSec ?? null"
        />
        <div
          v-if="banner"
          class="shrink-0 rounded-card border px-3.5 py-2 text-sm shadow-glass"
          :class="banner.cls"
        >
          {{ banner.text }}
        </div>
        <div class="min-h-0 flex-1 overflow-hidden rounded-card">
          <StageTopology />
        </div>
        <!-- 事件流：上方 12px 間隙即高度拖曳把手（往上拖增高） -->
        <div class="flex shrink-0 flex-col">
          <div
            class="group -mt-3 flex h-3 shrink-0 cursor-row-resize touch-none items-center"
            role="separator"
            aria-orientation="horizontal"
            aria-label="調整事件流面板高度"
            @pointerdown="onEventStripHandleDown"
          >
            <span class="h-0.5 w-full rounded-control bg-transparent group-hover:bg-accent/60" />
          </div>
          <EventStrip :events="store.events" :height="eventStripHeight" />
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
        :connection-blocked-reason="connectionBlockedReason"
        @diagnose="onDiagnose"
        @retry="onRetry"
        @cancel="onCancel"
        @close="onClosePanel"
        @dismiss="onDismissPanel"
      />
    </template>
  </AppLayout>
</template>
