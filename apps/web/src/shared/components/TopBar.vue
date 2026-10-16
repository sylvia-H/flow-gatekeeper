<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import { Search, Stethoscope, Gauge, Pause, Play } from "lucide-vue-next";
import MetricsPanel from "./MetricsPanel.vue";
import { isImeComposing } from "../lib/shortcuts.js";
import {
  useMonitoringStore,
  type ConnectionStatus,
} from "../../domains/monitoring/stores/monitoring.store.js";
import { useDiagnoseTrigger } from "../../domains/ai-copilot/composables/useDiagnoseTrigger.js";

/**
 * 工具列（spec FR-034）：四個語意分組，各組可見選項 ≤ 4——
 * 導航（搜尋）／播放控制（暫停・恢復、Mock 頻率）／系統狀態（連線 chip、未授權 chip、
 * dev 指標面板）／主要動作（診斷）。背壓計量已移出工具列，改為主區頂端常駐的背壓 strip（US2）。
 * 連線 chip 讀 **store.connectionStatus 單一來源**；診斷可用性集中在 `useDiagnoseTrigger`。
 */
const store = useMonitoringStore();

/** 診斷可用性：有選台、有連線、該台非進行中（去重）——判斷集中在共用入口。 */
const { connectionBlockedReason, canDiagnoseSelected: canDiagnose, diagnose } = useDiagnoseTrigger();

function onDiagnose(): void {
  if (store.selectedMachineId === null) return;
  diagnose(store.selectedMachineId);
}

const diagnoseHint = computed(() =>
  store.selectedMachineId === null
    ? "先選取機台"
    : (connectionBlockedReason.value ?? "對選取機台執行 AI 診斷"),
);

const CONNECTION_LABEL: Record<ConnectionStatus, string> = {
  connected: "已連線",
  reconnecting: "重新連線中",
  disconnected: "已斷線",
};
/** chip 三態：狀態點與邊框用實心色、文字用 *-fg（對桌邊 rim ≥ 4.5:1）。 */
const CONNECTION_CHIP: Record<ConnectionStatus, { dot: string; text: string; border: string }> = {
  connected: { dot: "bg-ok", text: "text-ok-fg", border: "border-ok" },
  reconnecting: { dot: "bg-warn", text: "text-warn-fg", border: "border-warn" },
  disconnected: { dot: "bg-crit", text: "text-crit-fg", border: "border-crit" },
};
const connectionLabel = computed(() => CONNECTION_LABEL[store.connectionStatus]);
const connectionChip = computed(() => CONNECTION_CHIP[store.connectionStatus]);

/** 連線中顯示 RTT（`N ms`）；首個 pong 前（latencyMs===null）顯示 `—`；未連線回 null（不顯示）。 */
const latencyText = computed(() => {
  if (store.connectionStatus !== "connected") return null;
  return store.latencyMs !== null ? `${store.latencyMs} ms` : "—";
});
const connectionAria = computed(() =>
  latencyText.value === null
    ? `連線狀態：${connectionLabel.value}`
    : `連線狀態：${connectionLabel.value}，延遲 ${latencyText.value === "—" ? "尚未量測" : latencyText.value}`,
);

/**
 * 009 US3：dev 指標面板旗標（`VITE_METRICS_PANEL`，dev 預設開、production build 預設關）。
 * 旗標關閉時整個面板 MUST NOT 渲染（FR-012 零回歸）。生效來源是 `apps/web/.env`
 * （Vite 以 `apps/web/` 為 env 根目錄，未設 `envDir`）。未設定時取 `import.meta.env.DEV`。
 */
const showMetricsPanel =
  (import.meta.env.VITE_METRICS_PANEL ?? String(import.meta.env.DEV)) === "true";

/** 搜尋綁定 store.searchQuery（主區卡片過濾）。 */
function onSearchInput(event: Event): void {
  store.setSearchQuery((event.target as HTMLInputElement).value);
}

/**
 * 搜尋框 Enter（FR-034a、data-model §11）：結果恰一台且不在輸入法組字中 → 選取該台，並把焦點移到該台卡片
 * （`.machine-card[data-machine]`），讓後續 `d` 不被輸入欄守門擋下。0 台或多台不動作、不攔截按鍵。
 *
 * 與 App 層 `useKeyboardShortcuts` 的分工：這裡是主處理者，命中時 **同步** `preventDefault()`（在任何 await 之前），
 * 事件冒泡到 App 層時 `defaultPrevented` 已為 true，App 層應略過，避免重複選取與重複移焦。
 * 選取同一台是冪等（`selectMachine` 只寫 id）。
 * T060：手機覆蓋式搜尋落地後，於此一併收回覆蓋層。
 */
async function onSearchEnter(event: KeyboardEvent): Promise<void> {
  // 長按 Enter 的重複事件不處理（App 層同樣略過 repeat）：首發已把焦點移到卡片。
  if (event.repeat || isImeComposing(event)) return;
  const ids = store.visibleMachineIds;
  if (ids.length !== 1) return;
  const id = ids[0]!;
  event.preventDefault();
  store.selectMachine(id);
  // 等選取態渲染後再移焦；卡片不在 DOM（例如版面尚未掛載）時靜默略過。
  await nextTick();
  document.querySelector<HTMLElement>(`.machine-card[data-machine="${id}"]`)?.focus();
}

/**
 * 搜尋框元素：App 層 `useKeyboardShortcuts` 以它判斷「搜尋框內的 Enter」、`/` 聚焦搜尋時呼叫 `focus()`。
 * 父層經 template ref 取 `topBar.value?.searchInput`（expose 的 ref 會自動解包成元素）。
 */
const searchInput = ref<HTMLInputElement | null>(null);
defineExpose({ searchInput });

/** 工具列次要按鈕的共用外觀：桌邊上的玻璃小鈕。 */
const TOOL_BUTTON =
  "flex h-9 items-center gap-1.5 rounded-control border border-edge bg-surface/72 px-2.5 text-sm text-ink-2 shadow-glass focus:outline-none focus-visible:ring-2 focus-visible:ring-focus";
</script>

<template>
  <div class="tb-bar flex w-full min-w-0 items-center gap-3">
    <!-- 導航：搜尋可隨可用寬度收縮（min-w-0 flex-1），最寬到 xs -->
    <div role="group" aria-label="導航" class="flex min-w-0 max-w-xs flex-1 items-center">
      <div class="relative w-full min-w-0">
        <Search
          class="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3"
          aria-hidden="true"
        />
        <input
          ref="searchInput"
          type="search"
          placeholder="搜尋機台"
          aria-label="搜尋機台"
          :value="store.searchQuery"
          class="h-9 w-full rounded-control border border-edge bg-surface/72 pl-8 pr-3 text-sm text-ink shadow-glass placeholder:text-ink-3 focus:border-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          @input="onSearchInput"
          @keydown.enter="onSearchEnter"
        />
      </div>
    </div>

    <!-- 播放控制：暫停期間續收 buffer、恢復跳到最新 -->
    <div role="group" aria-label="播放控制" class="flex shrink-0 items-center gap-2">
      <button
        type="button"
        :class="[TOOL_BUTTON, 'transition-colors duration-150 hover:bg-surface hover:text-ink']"
        :title="store.paused ? '恢復畫面更新' : '暫停畫面更新（續收資料）'"
        @click="store.togglePause()"
      >
        <component :is="store.paused ? Play : Pause" class="h-4 w-4 shrink-0" aria-hidden="true" />
        <span class="sr-only md:not-sr-only">{{ store.paused ? "恢復" : "暫停" }}</span>
      </button>

      <!-- Mock 頻率（disabled 佔位，FR-027）：工具列變窄時先讓位給「診斷」 -->
      <button
        type="button"
        disabled
        title="Mock 頻率（後續啟用）"
        class="tb-optional flex h-9 cursor-not-allowed items-center gap-1.5 rounded-control border border-dashed border-edge px-2.5 text-sm text-ink-3"
      >
        <Gauge class="h-4 w-4 shrink-0" aria-hidden="true" />
        <span class="sr-only md:not-sr-only">Mock 頻率</span>
      </button>
    </div>

    <!-- 系統狀態：靠右；次要項（指標面板）在工具列變窄時先讓位 -->
    <div role="group" aria-label="系統狀態" class="ml-auto flex shrink-0 items-center gap-2">
      <div v-if="showMetricsPanel" class="tb-optional">
        <MetricsPanel />
      </div>

      <!-- 連線 chip：顏色＋文字＋可讀名稱三重編碼（FR-004） -->
      <span
        data-fg="connection-chip"
        class="inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-pill border px-3 text-sm font-semibold"
        :class="[connectionChip.text, connectionChip.border]"
        role="status"
        :aria-label="connectionAria"
      >
        <span class="h-2 w-2 shrink-0 rounded-pill" :class="connectionChip.dot" aria-hidden="true" />
        <span>{{ connectionLabel }}</span>
        <span v-if="latencyText" class="font-mono font-medium tabular-nums" aria-hidden="true">
          · {{ latencyText }}
        </span>
      </span>

      <!-- 訂閱授權失敗（system/unauthorized）：完整說明放 title 與可讀名稱 -->
      <span
        v-if="store.authError"
        data-fg="auth-chip"
        class="inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-pill border border-crit bg-crit-bg px-3 text-sm font-semibold text-crit-fg"
        role="alert"
        :title="store.authError"
        :aria-label="store.authError"
      >
        <span class="h-2 w-2 shrink-0 rounded-pill bg-crit" aria-hidden="true" />
        未授權
      </span>
    </div>

    <!-- 主要動作：作用於選取機台；無選取／無連線／該台進行中時 disabled -->
    <div role="group" aria-label="主要動作" class="flex shrink-0 items-center">
      <button
        type="button"
        :disabled="!canDiagnose"
        :title="diagnoseHint"
        class="flex h-9 shrink-0 items-center gap-1.5 rounded-control border border-accent-strong bg-accent px-4 text-sm font-semibold text-surface-strong transition-colors duration-150 hover:bg-accent-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-rim disabled:cursor-not-allowed disabled:border-edge disabled:bg-surface/72 disabled:text-ink-3"
        @click="onDiagnose"
      >
        <Stethoscope class="h-4 w-4 shrink-0" aria-hidden="true" />
        <span>診斷</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
/*
 * 依「工具列自身的實際寬度」（＝中間欄可用空間，隨 Copilot 面板開合與視窗寬度變化）決定
 * 是否隱藏次要項——比視窗斷點更準：面板展開壓縮中間欄時，即使視窗很寬也會讓位給「診斷」，
 * 避免工具列溢出；面板收合、空間變寬時自動恢復顯示。三段收合於 US6 T060 改寫。
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
