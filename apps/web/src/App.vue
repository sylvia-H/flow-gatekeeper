<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, useTemplateRef, watch } from "vue";
import AppLayout from "./shared/components/AppLayout.vue";
import TopBar from "./shared/components/TopBar.vue";
import ShortcutHelp from "./shared/components/ShortcutHelp.vue";
import ThemeToggle from "./shared/components/ThemeToggle.vue";
import BackpressureStrip from "./shared/components/BackpressureStrip.vue";
import StageTopology from "./domains/monitoring/components/StageTopology.vue";
import FleetHealth from "./domains/monitoring/components/FleetHealth.vue";
import AnomalySummary from "./domains/monitoring/components/AnomalySummary.vue";
import AnomalyOverlay from "./domains/monitoring/components/AnomalyOverlay.vue";
import EventStrip from "./domains/monitoring/components/EventStrip.vue";
import CopilotDrawer from "./domains/ai-copilot/components/CopilotDrawer.vue";
import { useMonitoringStore } from "./domains/monitoring/stores/monitoring.store.js";
import { useMetricsStore } from "./domains/monitoring/stores/metrics.store.js";
import { useCopilotStore } from "./domains/ai-copilot/stores/copilot.store.js";
import { useHighFrequencyWs } from "./domains/monitoring/composables/useHighFrequencyWs.js";
import { useResizeDrag } from "./shared/composables/useResizeDrag.js";
import { useKeyboardShortcuts } from "./shared/composables/useKeyboardShortcuts.js";
import { BELOW_MD_QUERY, useMediaQuery } from "./shared/composables/useMediaQuery.js";
import { useDiagnoseTrigger } from "./domains/ai-copilot/composables/useDiagnoseTrigger.js";
import {
  EVENT_STRIP_MAX,
  EVENT_STRIP_MIN,
  EVENT_STRIP_STORAGE_KEY,
  eventStripInitialHeight,
} from "./domains/monitoring/lib/event-strip-size.js";
import { MACHINE_IDS } from "@flow-gatekeeper/contracts";
import { Play } from "lucide-vue-next";
import { machineLabel } from "./domains/monitoring/lib/machine-labels.js";
import { diagnosisBadgeText } from "./domains/ai-copilot/lib/diagnosis-badge.js";
import { formatClock } from "./shared/lib/format.js";
import { bannerOf } from "./shared/lib/status-banner.js";
import type { CopilotJobState } from "./domains/ai-copilot/lib/copilot-reducer.js";

/**
 * App 根：組裝監控台外殼並接上即時通道。第一屏即監控台。
 * 005：掛 copilot.store，診斷事件經 004 同一條 WebSocket 分流交 store（憲章 IV）。
 */
const store = useMonitoringStore();
const copilot = useCopilotStore();
// 009 US3：`system/metrics` 的唯一消費者（dev 面板）。低頻，直接寫入不進 rAF buffer。
const metrics = useMetricsStore();

/**
 * 事件流面板高度可拖曳或用鍵盤調整（把手在面板上緣，往上拖增高，故 direction: -1；
 * 聚焦把手後 ArrowUp 增高／ArrowDown 減少 16px，FR-034c）。
 * 未設偏好時的預設依載入當下的視窗高決定（≤ 800px 只留標題＋2 列，見 event-strip-size.ts）。
 */
const {
  size: eventStripHeight,
  startDrag: onEventStripHandleDown,
  onKeydown: onEventStripHandleKeydown,
  handleAttrs: eventStripHandleAttrs,
} = useResizeDrag({
  axis: "y",
  min: EVENT_STRIP_MIN,
  max: EVENT_STRIP_MAX,
  initial: eventStripInitialHeight(typeof window !== "undefined" ? window.innerHeight : Infinity),
  storageKey: EVENT_STRIP_STORAGE_KEY,
  direction: -1,
  label: "調整事件流面板高度",
});

/**
 * Copilot 面板開關與手動收合偏好都在 copilot store（T059、data-model §2、FR-033），這裡只接線：
 * - 選取改變 → `onMachineSelected`（取消選取收合；選台時無偏好才展開）。再次選取同一台不會觸發
 *   watch，另以 `$onAction` 補上：Escape 收合後再點同一張卡片，與選了別台一樣依偏好展開。
 * - 事件分流：drawer 收合鈕 `close` → `collapsePanel`（寫偏好）；drawer `dismiss`（手機 sheet 內 Escape）、
 *   AppLayout `dismiss-panel`（遮罩）與快捷鍵的面板層（桌機 Escape）→ `dismissPanel`（不寫偏好）；
 *   展開窄條／peek 條 `open-panel` → `openPanel`（展開並清除偏好）。觸發診斷由 store 的 `diagnose` 自行展開。
 */
watch(
  () => store.selectedMachineId,
  (id) => copilot.onMachineSelected(id),
);
store.$onAction(({ name, args }) => {
  if (name === "selectMachine" && args[0] === store.selectedMachineId) copilot.onMachineSelected(args[0]);
});

/**
 * sheet 是否接手焦點（drawer `update:engaged`；< desk 的 sheet 為 modal 時 true，閒置非 modal 與桌機推擠式為 false）。
 * 交給 AppLayout 決定遮罩：只有 true 才蓋遮罩，閒置 sheet 不調暗選取卡、點其他卡片就是改選。
 */
const sheetEngaged = ref(false);

/** drawer 恆依 selectedMachineId 取對應那一份狀態（未選取→idle 空殼，由 machineId=null 走空狀態）。 */
const selectedState = computed<CopilotJobState>(() =>
  store.selectedMachineId !== null
    ? copilot.stateFor(store.selectedMachineId)
    : { status: "idle", machineId: "" },
);
/**
 * sheet 是否為閒置單列（已選機台且該台診斷狀態為 idle；與 drawer 的 `compactIdle` 同條件，斷點由 AppLayout 自己判斷）。
 * 同步算出交給 AppLayout：只有閒置單列時才以量到的 sheet 高度當主區底部留白（第四輪交叉審查 high）。
 */
const sheetCompact = computed(() => store.selectedMachineId !== null && selectedState.value.status === "idle");
const selectedLabel = computed(() =>
  store.selectedMachineId !== null ? machineLabel(store.selectedMachineId) : "",
);
/** 手機 peek 條的機台名稱；無選取時為 null（peek 條不渲染）。 */
const peekLabel = computed(() => (store.selectedMachineId !== null ? selectedLabel.value : null));
/** 手機 peek 條的診斷狀態 chip 文字（同卡片 chip 的 `diagnosisBadgeText`）；無選取或無診斷為 null。 */
const peekStatus = computed(() =>
  store.selectedMachineId !== null ? diagnosisBadgeText(copilot.badgeFor(store.selectedMachineId)) : null,
);

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

/** 取消選取（Escape 最後一層）：store 沒有專屬 action，直接寫回 null；面板隨上方 watch 收合（偏好不變）。 */
function clearSelection(): void {
  store.selectedMachineId = null;
}

/** 鍵盤快捷鍵說明層（`?` 與工具列說明鈕共用同一個開關；FR-034b、T073 C）。 */
const helpOpen = ref(false);
function toggleHelp(): void {
  helpOpen.value = !helpOpen.value;
}

/** 工具列（`focusSearch`、搜尋覆蓋開關與暫停鈕焦點經 expose 取得）。 */
const topBar = useTemplateRef<InstanceType<typeof TopBar>>("topBar");

/**
 * 手機寬度（< md，rail 隱藏；斷點同 AppLayout 的 `md:` 與 TopBar 的主題切換位置）。
 * mounted 後才掛 change 監聽；環境沒有 `matchMedia` 時視為桌機（見 `shared/composables/useMediaQuery`）。
 */
const isMobile = useMediaQuery(BELOW_MD_QUERY);

/**
 * 手機異常清單覆蓋層（T061、FR-033a）：主區頂端的機群健康摘要條點擊開關。
 * 只在手機寬度渲染；寬度回到 ≥ md 時一併歸零，否則看不見的層仍佔著 Escape 分層、吃掉一次 Escape。
 */
const anomalyOverlayOpen = ref(false);
watch(isMobile, (mobile) => {
  if (!mobile) anomalyOverlayOpen.value = false;
});

/**
 * App 層鍵盤快捷鍵（T054；FR-034a～FR-034d）。composable 位於 shared/，store 與診斷入口一律由這裡注入。
 * - `d` 與卡片診斷圖示同一條路：一律交 `useDiagnoseTrigger`，copilot store 的 `diagnose()` 先展開面板，
 *   再由前置條件與去重把關（斷線或診斷中不送 POST），所以被擋下時面板仍展開並顯示停用原因。
 * - 搜尋框 Enter 只由 TopBar 的 `onSearchEnter` 處理（三種工具列形態共用同一個 input）；搜尋框是輸入情境，App 層一律略過。
 * - `/`：交給 TopBar 的 `focusSearch`——工具列 compact（< 640px）時展開覆蓋式搜尋再聚焦，其餘直接聚焦搜尋框。
 * - Escape 分層：搜尋覆蓋讀 TopBar expose 的 `isSearchOverlayOpen`、手機異常覆蓋層讀 `anomalyOverlayOpen`。
 *   焦點在覆蓋內時由元件自己攔下 Escape；手機 bottom-sheet 內的 Escape 由 drawer 的 `useModalSheet`
 *   攔下並 emit `dismiss`，都不會到這裡。
 */
useKeyboardShortcuts({
  handlers: {
    focusSearch: () => {
      topBar.value?.focusSearch();
    },
    selectMachine: store.selectMachine,
    clearSelection,
    diagnose: onDiagnose,
    clearLatch: store.clearLatch,
    isLatchVisible: store.latchVisible,
    toggleHelp,
    getSelectedId: () => store.selectedMachineId,
    layers: {
      help: {
        isOpen: () => helpOpen.value,
        close: () => {
          helpOpen.value = false;
        },
      },
      "search-overlay": {
        isOpen: () => topBar.value?.isSearchOverlayOpen === true,
        close: () => {
          topBar.value?.closeSearchOverlay();
        },
      },
      "anomaly-overlay": {
        isOpen: () => anomalyOverlayOpen.value,
        close: () => {
          anomalyOverlayOpen.value = false;
        },
      },
      // 只關當次，不寫手動收合偏好（Escape 不算手動收合，FR-034a）。
      "copilot-panel": { isOpen: () => copilot.panelOpen, close: copilot.dismissPanel },
      selection: { isOpen: () => store.selectedMachineId !== null, close: clearSelection },
    },
  },
});

// 主區標題「機群總覽 · N 台」（N＝固定名冊長度）：畫面上由背壓 strip 取代，只留給輔助技術（R13）。
const machineCount = computed(() => MACHINE_IDS.length);

/**
 * 連線／授權／暫停橫幅（同一位置、同一元件形態）：決策與優先序（斷線 ＞ 未授權 ＞ 暫停）在 `bannerOf`；不清空資料。
 * 暫停橫幅回應 critique 2026-10-17 P1（暫停後卡片停在「剛剛」、連線 chip 仍「已連線」，凍結畫面看起來像即時）。
 * 橫幅不設 live region：連線三態由 TopBar 連線 chip（role=status）、未授權由未授權 chip
 * （role=alert）、暫停由暫停鈕的 aria-pressed 朗讀，避免同一件事念兩次。
 */
const banner = computed(() =>
  bannerOf(store.connectionStatus, store.everConnected, store.authError, store.paused, store.pausedAt),
);

/** 暫停橫幅的「恢復」：走工具列同一個 `togglePause`；橫幅隨即消失，焦點交回工具列暫停鈕。 */
function onBannerResume(): void {
  if (!store.paused) return;
  store.togglePause();
  void nextTick(() => {
    topBar.value?.focusPauseToggle();
  });
}

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
    :panel-open="copilot.panelOpen"
    :peek-label="peekLabel"
    :peek-status="peekStatus"
    :sheet-engaged="sheetEngaged"
    :sheet-compact="sheetCompact"
    @open-panel="copilot.openPanel"
    @dismiss-panel="copilot.dismissPanel"
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

        <!-- 最近異常摘要：清單資料、選台與清除皆接 store（卡片標記與這裡操作同一份 latch） -->
        <AnomalySummary
          :items="store.anomalySummary"
          :now="store.staleNow"
          :selected-id="store.selectedMachineId"
          @select="store.selectMachine"
          @clear="store.clearLatch"
        />

        <!-- 主題切換：rail 底部 -->
        <div class="mt-auto pt-2">
          <ThemeToggle />
        </div>
      </div>
    </template>

    <template #topbar>
      <TopBar ref="topBar" :help-open="helpOpen" @toggle-help="toggleHelp" />
    </template>

    <template #main>
      <!-- 主區欄是 <main>（flex 直欄）的 flex-1 子項：高度由 flex 分配、不靠 h-full 百分比，事件列下緣與 12px 桌面留邊恆在視窗內 -->
      <div class="flex min-h-0 flex-1 flex-col gap-3">
        <h1 class="sr-only">機群總覽 · {{ machineCount }} 台</h1>
        <!-- 手機（rail 隱藏）：機群健康摘要條在最上方（44px），比值仍落在首屏；點擊開異常清單覆蓋層，不推擠拓樸 -->
        <FleetHealth
          v-if="isMobile"
          class="shrink-0"
          compact
          :summary="store.fleetHealth"
          :expanded="anomalyOverlayOpen"
          @toggle="anomalyOverlayOpen = !anomalyOverlayOpen"
        />
        <!-- 背壓 strip：工具列正下方常駐（FR-009）；在橫幅之上，斷線時橫幅出現也不把它往下推 -->
        <BackpressureStrip
          class="shrink-0"
          :samples="store.rateSamples"
          :window-ratio="store.windowRatio"
          :cumulative-ratio="store.cumulativeRatio"
          :dropped="store.droppedInWindow"
          :stale="store.rateStale"
          :connection="store.connectionStatus"
          :paused="store.paused"
          :msgs-per-sec="store.latestRate?.msgsPerSec ?? null"
          :batches-per-sec="store.latestRate?.batchesPerSec ?? null"
        />
        <div
          v-if="banner"
          :data-fg="banner.pausedAt !== undefined ? 'pause-banner' : undefined"
          class="flex shrink-0 items-center gap-3 rounded-card border px-3.5 py-2 text-sm shadow-glass"
          :class="banner.cls"
        >
          <span class="min-w-0 flex-1">
            <template v-if="banner.pausedAt !== undefined">
              <span class="font-semibold">{{ banner.text }}</span>
              <span class="text-ink-2"> · 暫停於 </span>
              <span class="font-mono tabular-nums text-ink-2">{{ formatClock(banner.pausedAt) }}</span>
            </template>
            <template v-else>{{ banner.text }}</template>
          </span>
          <!-- 暫停橫幅內嵌次要鈕：-my-1 抵掉多出的高度，橫幅與連線橫幅同高 -->
          <button
            v-if="banner.pausedAt !== undefined"
            type="button"
            data-fg="banner-resume"
            class="-my-1 flex h-7 shrink-0 items-center gap-1.5 rounded-control border border-edge bg-surface-strong px-2.5 text-sm font-semibold text-ink transition-colors duration-150 hover:border-etch hover:bg-surface focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            title="恢復畫面更新，跳到最新資料"
            @click="onBannerResume"
          >
            <Play class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            恢復
          </button>
        </div>
        <!-- 拓樸捲動區：下緣一道蝕刻邊是捲動邊界（邊在捲動容器外層、不隨內容捲），
             卡片被捲動區截斷時讀成「沒入刻線之下」，不與下方事件列玻璃讀成重疊 -->
        <div class="min-h-0 flex-1 overflow-hidden border-b border-edge">
          <StageTopology />
        </div>
        <!-- 事件流：上方 12px 間隙即高度把手（往上拖增高；可 Tab 聚焦、方向鍵調整，Tab 順序在拓樸之後） -->
        <div class="flex shrink-0 flex-col">
          <div
            v-bind="eventStripHandleAttrs"
            class="group -mt-3 flex h-3 shrink-0 cursor-row-resize touch-none items-center rounded-control focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            @pointerdown="onEventStripHandleDown"
            @keydown="onEventStripHandleKeydown"
          >
            <span
              class="h-0.5 w-full rounded-control bg-transparent group-hover:bg-accent/60 group-focus-visible:bg-accent/60"
            />
          </div>
          <!-- US5 T052：事件列項可點擊選台，選取中機台的列以 selectedId 標示 -->
          <EventStrip
            :events="store.events"
            :height="eventStripHeight"
            :selected-id="store.selectedMachineId"
            @select="store.selectMachine"
          />
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
        @close="copilot.collapsePanel"
        @dismiss="copilot.dismissPanel"
        @update:engaged="sheetEngaged = $event"
      />
    </template>
  </AppLayout>
  <!-- 說明層掛在 AppLayout 之外（根層），fixed 定位不受任何祖先 transform 影響；起於 top-14 不遮工具列 -->
  <ShortcutHelp :open="helpOpen" @close="helpOpen = false" />
  <!-- 手機異常清單覆蓋層（z-[60]）：起於 top-14 不遮工具列，蓋過 peek 條（z-40）與 bottom-sheet（z-50），
       在說明層（z-[70]）之下；選一台後元件自己 emit close -->
  <AnomalyOverlay
    v-if="isMobile"
    :open="anomalyOverlayOpen"
    :items="store.anomalySummary"
    :now="store.staleNow"
    :selected-id="store.selectedMachineId"
    @close="anomalyOverlayOpen = false"
    @select="store.selectMachine"
    @clear="store.clearLatch"
  />
</template>
