<script setup lang="ts">
import { computed } from "vue";
import { Search, Stethoscope, Gauge, Pause, Play } from "lucide-vue-next";
import BackpressureBadge from "./BackpressureBadge.vue";
import MetricsPanel from "./MetricsPanel.vue";
import {
  useMonitoringStore,
  type ConnectionStatus,
} from "../../domains/monitoring/stores/monitoring.store.js";
import { useDiagnoseTrigger } from "../../domains/ai-copilot/composables/useDiagnoseTrigger.js";

/**
 * TopBar（design-spec §7.2）：search（外觀）、connection chip、BackpressureBadge、
 * diagnose（作用於 selectedMachineId）、mock-frequency 佔位（FR-027）。
 * connection chip 讀 **store.connectionStatus 單一來源**。
 */
const store = useMonitoringStore();

/** diagnose 可用性：有選台、有連線、該台非進行中（去重）——判斷集中在共用入口。 */
const { connectionBlockedReason, canDiagnoseSelected: canDiagnose, diagnose } = useDiagnoseTrigger();

function onDiagnose(): void {
  if (store.selectedMachineId === null) return;
  diagnose(store.selectedMachineId);
}

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

/** US4：連線中顯示 RTT ms；首個 pong 前（latencyMs===null）顯示 `—`；未連線回 null（不顯示）。 */
const latencyText = computed(() => {
  if (store.connectionStatus !== "connected") return null;
  return store.latencyMs !== null ? `${store.latencyMs}ms` : "—";
});

/**
 * 009 US3：dev 指標面板旗標（`VITE_METRICS_PANEL`，dev 預設開、production build 預設關）。
 * 旗標關閉時整個面板 MUST NOT 渲染，使首屏與改動前逐項一致（FR-012 零回歸）。
 * 生效來源是 `apps/web/.env`（Vite 以 `apps/web/` 為 env 根目錄，未設 `envDir`），
 * 放 repo 根的 `.env` 讀不到。未設定時取 `import.meta.env.DEV` 作為預設。
 */
const showMetricsPanel =
  (import.meta.env.VITE_METRICS_PANEL ?? String(import.meta.env.DEV)) === "true";

/** US4 search：綁定 store.searchQuery（sidebar 清單與主區卡片共用）。 */
function onSearchInput(event: Event): void {
  store.setSearchQuery((event.target as HTMLInputElement).value);
}
</script>

<template>
  <div class="tb-bar flex w-full items-center gap-3">
    <!-- Search：可隨中間欄寬度收縮（min-w-0 flex-1），最寬到 xs；空間不足時先讓它讓位 -->
    <div class="relative min-w-0 flex-1 max-w-xs">
      <Search
        class="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-subtle"
        aria-hidden="true"
      />
      <input
        type="search"
        placeholder="Search machines"
        aria-label="Search machines"
        :value="store.searchQuery"
        class="h-9 w-full rounded-control border border-subtle bg-surface-inset pl-8 pr-3 text-sm text-fg placeholder:text-fg-subtle focus:border-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        @input="onSearchInput"
      />
    </div>

    <!-- 右側工具群組：整體 shrink-0 並固定在右緣；空間不足時先隱藏次要項（見下），
         確保 Diagnose 永遠完整可見、不被中間欄壓縮而裁切。 -->
    <div class="flex shrink-0 items-center gap-2 sm:gap-3">
      <!-- Pause/Resume：凍結/恢復畫面更新（US4）；暫停期間續收 buffer、resume 跳最新 -->
      <button
        type="button"
        class="flex h-9 items-center gap-1.5 rounded-control border border-subtle bg-surface px-2.5 text-xs text-fg-muted hover:bg-surface-hover hover:text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        :aria-pressed="store.paused"
        :aria-label="store.paused ? 'Resume telemetry' : 'Pause telemetry'"
        :title="store.paused ? '恢復畫面更新' : '暫停畫面更新（續收 buffer）'"
        @click="store.togglePause()"
      >
        <component :is="store.paused ? Play : Pause" class="h-4 w-4" aria-hidden="true" />
        <span class="hidden md:inline">{{ store.paused ? "Resume" : "Pause" }}</span>
      </button>

      <!-- Mock frequency 控制（disabled 佔位，FR-027）：次要項；工具列自身變窄時（容器查詢）
           先隱藏以把空間留給 Diagnose，避免溢出遮住右側 Copilot 面板。 -->
      <button
        type="button"
        disabled
        title="Mock telemetry frequency（後續啟用）"
        aria-label="Mock telemetry frequency"
        class="tb-optional flex h-9 cursor-not-allowed items-center gap-1.5 rounded-control border border-subtle bg-surface px-2.5 text-xs text-fg-subtle opacity-60"
      >
        <Gauge class="h-4 w-4" aria-hidden="true" />
        <span class="hidden md:inline">Mock Hz</span>
      </button>

      <!-- 009 dev 指標面板（唯讀、預設收合）：次要項，與背壓計量同層讓位 -->
      <div v-if="showMetricsPanel" class="tb-optional">
        <MetricsPanel />
      </div>

      <!-- 背壓計量：次要項，工具列變窄時先讓位（寬螢幕/收合面板時仍完整呈現） -->
      <div class="tb-optional">
        <BackpressureBadge
          :received-messages="store.receivedMessages"
          :rendered-batches="store.renderedBatches"
          :dropped-messages="store.droppedMessages"
          :invalid-messages="store.invalidMessages"
        />
      </div>

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
        <span v-if="latencyText" class="font-mono text-fg-muted">· {{ latencyText }}</span>
      </span>

      <!-- 訂閱授權失敗（system/unauthorized）：沿用 crit token 的小 chip，完整說明放 title -->
      <span
        v-if="store.authError"
        class="inline-flex items-center rounded-pill bg-crit-bg px-2.5 py-1 text-xs text-crit-fg"
        role="alert"
        :title="store.authError"
        :aria-label="store.authError"
      >
        未授權
      </span>

      <!-- Diagnose：作用於 selectedMachineId；無選取／無連線／該台 active 時 disabled -->
      <button
        type="button"
        :disabled="!canDiagnose"
        :title="
          store.selectedMachineId === null
            ? '先選取機台'
            : (connectionBlockedReason ?? 'Run AI diagnosis')
        "
        aria-label="Run AI diagnosis"
        class="flex h-9 shrink-0 items-center gap-1.5 rounded-control bg-accent px-3 text-sm font-medium text-canvas hover:bg-accent-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50"
        @click="onDiagnose"
      >
        <Stethoscope class="h-4 w-4" aria-hidden="true" />
        <span class="hidden md:inline">Diagnose</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
/*
 * 依「工具列自身的實際寬度」（＝中間欄可用空間，會隨 Copilot 面板開合與視窗寬度變化）決定
 * 是否隱藏次要項——比視窗斷點更準：面板開啟壓縮中間欄時，即使視窗很寬也會讓位給 Diagnose，
 * 避免工具列溢出遮住右側面板；面板收合、空間變寬時自動恢復顯示。
 */
.tb-bar {
  container-type: inline-size;
}
@container (max-width: 820px) {
  .tb-optional {
    display: none;
  }
}
</style>
