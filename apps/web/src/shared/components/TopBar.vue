<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, useId, watch } from "vue";
import { Search, Stethoscope, Gauge, Pause, ShieldAlert, Keyboard } from "lucide-vue-next";
import MetricsPanel from "./MetricsPanel.vue";
import ThemeToggle from "./ThemeToggle.vue";
import { isImeComposing } from "../lib/shortcuts.js";
import { BELOW_MD_QUERY, useMediaQuery } from "../composables/useMediaQuery.js";
import {
  useMonitoringStore,
  type ConnectionStatus,
} from "../../domains/monitoring/stores/monitoring.store.js";
import { useDiagnoseTrigger } from "../../domains/ai-copilot/composables/useDiagnoseTrigger.js";

/**
 * 工具列（spec FR-034）：四個語意分組，各組可見選項 ≤ 4——
 * 導航（搜尋）／播放控制（暫停切換鈕、Mock 頻率）／系統狀態（連線 chip、未授權 chip、
 * dev 指標面板、手機時的主題切換、快捷鍵說明鈕）／主要動作（診斷）。背壓計量已移出工具列，改為主區頂端常駐的背壓 strip（US2）。
 * 連線 chip 讀 **store.connectionStatus 單一來源**；診斷可用性集中在 `useDiagnoseTrigger`。
 *
 * 三段收合（FR-032、research R10）依「工具列自身的實際寬度」決定（＝中間欄可用空間，隨 rail 寬度、
 * Copilot 面板開合與視窗寬度變化），比視窗斷點準：
 * - `full`（≥ 820px）：全部控制項帶文字。
 * - `icons`（640–819px）：暫停、Mock 頻率、指標、診斷只留圖示（文字留給螢幕閱讀器）。
 * - `compact`（< 640px）：搜尋收成圖示鈕，點擊或 `/` 展開為覆蓋式輸入框；Mock 頻率與指標面板不渲染。
 */
const store = useMonitoringStore();

const props = withDefaults(defineProps<{ /** 快捷鍵說明層是否開著（說明鈕的 `aria-expanded`）。 */ helpOpen?: boolean }>(), {
  helpOpen: false,
});

/**
 * 快捷鍵說明鈕（T073 C：critique H6／H10「快捷鍵沒有可見入口」）：點擊 emit `toggle-help`，
 * 由 App 以與 `?` 快捷鍵同一個開關（`helpOpen`）切換說明層，不另立狀態。
 */
const emit = defineEmits<{ (e: "toggle-help"): void }>();

/** 診斷可用性：有選台、有連線、該台非進行中（去重）——判斷集中在共用入口。 */
const { connectionBlockedReason, canDiagnoseSelected: canDiagnose, diagnose } = useDiagnoseTrigger();

function onDiagnose(): void {
  if (store.selectedMachineId === null) return;
  diagnose(store.selectedMachineId);
}

/** 診斷鈕說明的 id：停用原因（或可用時的動作說明）經 `aria-describedby` 給輔助技術，不只在 `title`。 */
const diagnoseHintId = useId();

/** 停用原因依序：未選台 → 連線未就緒 → 該台診斷進行中（去重）；可用時為動作說明。`title` 與 describedby 共用。 */
const diagnoseHint = computed(() => {
  if (store.selectedMachineId === null) return "先選取機台";
  if (connectionBlockedReason.value !== null) return connectionBlockedReason.value;
  return canDiagnose.value ? "對選取機台執行 AI 診斷" : "該機台診斷進行中";
});

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

// ── 三段收合：量工具列寬度 ───────────────────────────────────────────────

type ToolbarSize = "full" | "icons" | "compact";

/** 工具列寬度門檻（px，research R10）：≥ 820 全部、640–819 只留圖示、< 640 精簡。 */
const FULL_MIN_WIDTH = 820;
const ICONS_MIN_WIDTH = 640;

/**
 * 工具列內容寬；null＝尚未量到（或環境沒有 ResizeObserver）→ 視為 `full`。
 * ResizeObserver 回呼在 layout 之後、paint 之前送達，首幀即為正確段位；只有寬度改變時才寫入（低頻）。
 * 三段切換不會改變工具列自身寬度（`w-full`，寬度由父層決定），不會來回振盪。
 */
const bar = ref<HTMLElement | null>(null);
const barWidth = ref<number | null>(null);
let observer: ResizeObserver | null = null;

onMounted(() => {
  if (typeof ResizeObserver !== "function" || bar.value === null) return;
  observer = new ResizeObserver((entries) => {
    const entry = entries[entries.length - 1];
    if (entry) barWidth.value = entry.contentRect.width;
  });
  observer.observe(bar.value);
});

const size = computed<ToolbarSize>(() => {
  const width = barWidth.value;
  if (width === null || width >= FULL_MIN_WIDTH) return "full";
  return width >= ICONS_MIN_WIDTH ? "icons" : "compact";
});
const compact = computed(() => size.value === "compact");
/** 控制項文字只在 `full` 可見；其餘段位改為 `sr-only`，可讀名稱不變。 */
const labelClass = computed(() => (size.value === "full" ? "" : "sr-only"));

/**
 * 主題切換位置（FR-033a）：rail 只在 `md`（768px）以上顯示，手機寬度時主題切換改由系統狀態分組承載。
 * 以 **視窗** 斷點判斷而不是工具列段位——工具列在桌機也可能因 Copilot 面板展開而 < 640px，
 * 那時 rail 仍在、不可重複；反之 640–767px 視窗 rail 已隱藏、工具列卻仍是 `icons`，不可漏掉。
 */
const railHidden = useMediaQuery(BELOW_MD_QUERY);

/**
 * dev 指標面板只在桌機寬度（rail 在）且非 compact 時放進工具列：手機寬度時系統狀態組多了主題切換，
 * 再加指標鈕會把搜尋框擠到只剩約 58px、截斷 placeholder。
 */
const showMetricsInBar = computed(() => showMetricsPanel && !compact.value && !railHidden.value);

/**
 * 快捷鍵說明鈕：≥ md（rail 在）恆常駐。手機寬度（< md）的 compact 工具列另有主題切換，390px 寬時約剩 78px
 * 餘裕（「重新連線中」再吃 28px 仍放得下 38px 鈕＋8px 間距）；未授權 chip 出現時只剩約 36px 放不下，
 * 故只有「compact＋rail 隱藏＋未授權」這個組合不渲染（`?` 快捷鍵恆可用；觸控裝置本就少有實體鍵盤）。
 */
const showHelpButton = computed(() => !(compact.value && railHidden.value && store.authError !== null));

onUnmounted(() => {
  observer?.disconnect();
  observer = null;
});

// ── 搜尋：一般輸入框與 compact 的覆蓋式輸入框是同一個 <input> ──────────────────

/**
 * 搜尋框元素：App 層 `useKeyboardShortcuts` 以它判斷「搜尋框內的 Enter」、`/` 聚焦搜尋時使用。
 * 父層經 template ref 取 `topBar.value?.searchInput`（expose 的 ref 會自動解包成元素）。
 * compact 且覆蓋收回時輸入框不渲染，此時為 null。
 */
const searchInput = ref<HTMLInputElement | null>(null);
/** compact 的搜尋圖示鈕（覆蓋收回時焦點回到這裡）。 */
const searchToggle = ref<HTMLButtonElement | null>(null);
/** 覆蓋式輸入框的外框（判斷失焦是否仍在覆蓋內）。 */
const searchShell = ref<HTMLElement | null>(null);
const overlayOpen = ref(false);
const overlayId = useId();

/** 覆蓋式搜尋實際開著（只在 compact 有意義）。 */
const isSearchOverlayOpen = computed(() => compact.value && overlayOpen.value);

/**
 * 段位切換：離開 compact 時覆蓋自動收回（輸入框回到一般位置，同一元素、焦點不丟）；
 * 進入 compact 時若焦點正在搜尋框，改為展開覆蓋，避免輸入到一半框被收掉。
 * watch 在重新渲染前執行，所以輸入框元素在整個過程中不會被卸載。
 */
watch(compact, (isCompact) => {
  if (!isCompact) overlayOpen.value = false;
  else if (searchInput.value !== null && document.activeElement === searchInput.value) overlayOpen.value = true;
});

/** 展開覆蓋式搜尋並聚焦；非 compact 時直接聚焦一般搜尋框。 */
async function openSearchOverlay(): Promise<void> {
  if (!compact.value) {
    searchInput.value?.focus();
    return;
  }
  overlayOpen.value = true;
  await nextTick();
  searchInput.value?.focus();
}

/**
 * 收回覆蓋式搜尋（搜尋字串保留在 store，不清除）。
 * 焦點若還在覆蓋內（Escape、收回鈕、App 層 Escape）就交回搜尋圖示鈕，避免焦點掉到 body；
 * Enter 選取時另行把焦點移到卡片，故以 `restoreFocus: false` 略過。
 */
function closeSearchOverlay(options: { restoreFocus?: boolean } = {}): void {
  if (!overlayOpen.value) return;
  const focusInside = searchShell.value?.contains(document.activeElement) ?? false;
  overlayOpen.value = false;
  if ((options.restoreFocus ?? true) && focusInside) searchToggle.value?.focus();
}

/** `/` 快捷鍵的進入點：compact 展開覆蓋，其餘聚焦一般搜尋框。 */
function focusSearch(): void {
  void openSearchOverlay();
}

/** 失焦收回：焦點移到覆蓋外（或離開頁面元素）才收；在覆蓋內移動（輸入框 ↔ 收回鈕）不收。 */
function onShellFocusout(event: FocusEvent): void {
  if (!isSearchOverlayOpen.value) return;
  const next = event.relatedTarget as Node | null;
  if (next !== null && searchShell.value?.contains(next)) return;
  closeSearchOverlay({ restoreFocus: false });
}

/**
 * 覆蓋內的 Escape：自己收回並吃掉事件（preventDefault 也阻止瀏覽器清空 search 欄位；
 * stopPropagation 讓 App 層不會再關下一層）。輸入法組字中的 Escape 留給輸入法取消選字。
 */
function onShellEscape(event: KeyboardEvent): void {
  if (!isSearchOverlayOpen.value || isImeComposing(event)) return;
  event.preventDefault();
  event.stopPropagation();
  closeSearchOverlay();
}

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
 * 選取同一台是冪等（`selectMachine` 只寫 id）。手機覆蓋式搜尋於選取時一併收回。
 */
async function onSearchEnter(event: KeyboardEvent): Promise<void> {
  // 長按 Enter 的重複事件不處理（App 層同樣略過 repeat）：首發已把焦點移到卡片。
  if (event.repeat || isImeComposing(event)) return;
  const ids = store.visibleMachineIds;
  if (ids.length !== 1) return;
  const id = ids[0]!;
  event.preventDefault();
  store.selectMachine(id);
  closeSearchOverlay({ restoreFocus: false });
  // 等選取態渲染後再移焦；卡片不在 DOM（例如版面尚未掛載）時靜默略過。
  await nextTick();
  document.querySelector<HTMLElement>(`.machine-card[data-machine="${id}"]`)?.focus();
}

/**
 * 暫停切換鈕：主區暫停橫幅的「恢復」按下後橫幅消失，App 把焦點交回這顆鈕（焦點不掉到 body，
 * 鍵盤使用者原地就能再暫停）。
 */
const pauseToggle = ref<HTMLButtonElement | null>(null);
function focusPauseToggle(): void {
  pauseToggle.value?.focus();
}

defineExpose({
  searchInput,
  size,
  isSearchOverlayOpen,
  openSearchOverlay,
  closeSearchOverlay,
  focusSearch,
  focusPauseToggle,
});

/** 工具列次要按鈕的共用外觀：桌邊上的玻璃小鈕。 */
const TOOL_BUTTON =
  "flex h-9 items-center gap-1.5 rounded-control border border-edge bg-surface/72 px-2.5 text-sm text-ink-2 shadow-glass focus:outline-none focus-visible:ring-2 focus-visible:ring-focus";

/** 暫停鈕兩態：未按下同一般工具鈕；按下比照 segmented 選中段（`bg-ink text-surface-strong font-semibold`）。 */
const PAUSE_BASE =
  "flex h-9 items-center gap-1.5 rounded-control border px-2.5 text-sm transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-rim";
const PAUSE_IDLE = `${PAUSE_BASE} border-edge bg-surface/72 text-ink-2 shadow-glass hover:bg-surface hover:text-ink`;
const PAUSE_PRESSED = `${PAUSE_BASE} border-ink bg-ink font-semibold text-surface-strong`;
</script>

<template>
  <div
    ref="bar"
    class="tb-bar relative flex w-full min-w-0 items-center"
    :class="compact ? 'gap-2' : 'gap-3'"
    :data-tb-size="size"
  >
    <!-- 導航：一般搜尋框可隨可用寬度收縮（min-w-0 flex-1），最寬到 xs；compact 收成圖示鈕 -->
    <div
      role="group"
      aria-label="導航"
      class="flex min-w-0 items-center"
      :class="compact ? 'shrink-0' : 'max-w-xs flex-1'"
    >
      <button
        v-if="compact"
        ref="searchToggle"
        type="button"
        data-fg="search-toggle"
        aria-label="搜尋機台"
        title="搜尋機台（/）"
        :aria-expanded="isSearchOverlayOpen"
        :aria-controls="overlayId"
        :class="[TOOL_BUTTON, 'transition-colors duration-150 hover:bg-surface hover:text-ink']"
        @click="openSearchOverlay"
      >
        <Search class="h-4 w-4 shrink-0" aria-hidden="true" />
      </button>

      <!--
        同一個外框兩種形態：一般段位以 `contents` 退出版面（等同只有輸入框那層）；
        compact 展開時改為覆蓋整條工具列的桌邊色橫條（絕對定位，不推擠下方控制項）。
      -->
      <div
        v-if="!compact || overlayOpen"
        :id="overlayId"
        ref="searchShell"
        :data-fg="compact ? 'search-overlay' : undefined"
        :class="compact ? 'absolute inset-0 z-30 flex items-center gap-2 bg-rim' : 'contents'"
        @focusout="onShellFocusout"
        @keydown.esc="onShellEscape"
      >
        <div class="relative w-full min-w-0 flex-1">
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
        <!-- 觸控沒有 Escape：給一顆收回鈕；mousedown 不搶焦點，避免先觸發失焦收回 -->
        <button
          v-if="compact"
          type="button"
          aria-label="收回搜尋"
          title="收回搜尋（Escape）"
          :class="[TOOL_BUTTON, 'shrink-0 transition-colors duration-150 hover:bg-surface hover:text-ink']"
          @mousedown.prevent
          @click="closeSearchOverlay()"
        >
          收回
        </button>
      </div>
    </div>

    <!-- 播放控制：暫停期間續收 buffer、恢復跳到最新。暫停鈕是切換鈕：名稱恆為「暫停」、按下態以
         aria-pressed 與 segmented 選中段同款的墨色實底表達（只剩圖示的段位也看得出按下）；
         恢復可再按一次，或用主區暫停橫幅內的「恢復」 -->
    <div role="group" aria-label="播放控制" class="flex shrink-0 items-center gap-2">
      <button
        ref="pauseToggle"
        type="button"
        data-fg="pause-toggle"
        :class="store.paused ? PAUSE_PRESSED : PAUSE_IDLE"
        aria-label="暫停"
        :aria-pressed="store.paused ? 'true' : 'false'"
        :title="store.paused ? '已暫停畫面更新（續收資料）；再按一次恢復' : '暫停畫面更新（續收資料）'"
        @click="store.togglePause()"
      >
        <Pause class="h-4 w-4 shrink-0" :class="store.paused ? 'fill-current' : ''" aria-hidden="true" />
        <span :class="labelClass">暫停</span>
      </button>

      <!-- Mock 頻率（disabled 佔位，FR-027）：compact 不渲染 -->
      <button
        v-if="!compact"
        type="button"
        disabled
        aria-label="Mock 頻率"
        title="Mock 頻率（後續啟用）"
        class="flex h-9 cursor-not-allowed items-center gap-1.5 rounded-control border border-dashed border-edge px-2.5 text-sm text-ink-3"
      >
        <Gauge class="h-4 w-4 shrink-0" aria-hidden="true" />
        <span :class="labelClass">Mock 頻率</span>
      </button>
    </div>

    <!-- 系統狀態：靠右 -->
    <div role="group" aria-label="系統狀態" class="ml-auto flex shrink-0 items-center gap-2">
      <div v-if="showMetricsInBar" class="tb-metrics">
        <MetricsPanel />
      </div>

      <!-- 連線 chip：顏色＋文字＋可讀名稱三重編碼（FR-004）；compact 省略 RTT 數字（可讀名稱仍帶） -->
      <span
        data-fg="connection-chip"
        class="inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-pill border text-sm font-semibold"
        :class="[connectionChip.text, connectionChip.border, compact ? 'px-2.5' : 'px-3']"
        role="status"
        :aria-label="connectionAria"
      >
        <span class="h-2 w-2 shrink-0 rounded-pill" :class="connectionChip.dot" aria-hidden="true" />
        <span>{{ connectionLabel }}</span>
        <span v-if="latencyText && !compact" class="font-mono font-medium tabular-nums" aria-hidden="true">
          · {{ latencyText }}
        </span>
      </span>

      <!-- 訂閱授權失敗（system/unauthorized）：完整說明放 title 與可讀名稱；compact 收成圖示 -->
      <span
        v-if="store.authError"
        data-fg="auth-chip"
        class="inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-pill border border-crit bg-crit-bg text-sm font-semibold text-crit-fg"
        :class="compact ? 'px-2' : 'px-3'"
        role="alert"
        :title="store.authError"
        :aria-label="store.authError"
      >
        <ShieldAlert v-if="compact" class="h-4 w-4 shrink-0" aria-hidden="true" />
        <span v-else class="h-2 w-2 shrink-0 rounded-pill bg-crit" aria-hidden="true" />
        <span :class="compact ? 'sr-only' : ''">未授權</span>
      </span>

      <!-- 手機寬度（rail 隱藏）時主題切換移到這裡（FR-033a）；工具列內一律用單一圖示鈕（rail 仍是兩段式） -->
      <ThemeToggle v-if="railHidden" variant="icon" />

      <!-- 快捷鍵說明（與 `?` 同一個開關）：所有段位都只留圖示，可讀名稱在 aria-label、快捷鍵在 title -->
      <button
        v-if="showHelpButton"
        type="button"
        data-fg="shortcut-help-toggle"
        aria-label="快捷鍵說明"
        title="快捷鍵說明（?）"
        aria-haspopup="dialog"
        aria-keyshortcuts="?"
        :aria-expanded="props.helpOpen ? 'true' : 'false'"
        :class="[TOOL_BUTTON, 'transition-colors duration-150 hover:bg-surface hover:text-ink']"
        @click="emit('toggle-help')"
      >
        <Keyboard class="h-4 w-4 shrink-0" aria-hidden="true" />
      </button>
    </div>

    <!-- 主要動作：作用於選取機台；無選取／無連線／該台進行中時 disabled -->
    <div role="group" aria-label="主要動作" class="flex shrink-0 items-center">
      <button
        type="button"
        :disabled="!canDiagnose"
        aria-label="診斷"
        :title="diagnoseHint"
        :aria-describedby="diagnoseHintId"
        class="flex h-9 shrink-0 items-center gap-1.5 rounded-control border border-accent-strong bg-accent text-sm font-semibold text-surface-strong transition-colors duration-150 hover:bg-accent-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-rim disabled:cursor-not-allowed disabled:border-edge disabled:bg-surface/72 disabled:text-ink-3"
        :class="size === 'full' ? 'px-4' : 'px-2.5'"
        @click="onDiagnose"
      >
        <Stethoscope class="h-4 w-4 shrink-0" aria-hidden="true" />
        <span :class="labelClass">診斷</span>
      </button>
      <!-- 停用原因／動作說明：鍵盤與螢幕閱讀器可讀（不改視覺） -->
      <span :id="diagnoseHintId" class="sr-only">{{ diagnoseHint }}</span>
    </div>
  </div>
</template>

<style scoped>
/*
 * icons 段的指標鈕只留圖示與狀態點：MetricsPanel 是共用元件，不為工具列加 prop，改由這裡隱藏其
 * 視覺標籤（標籤是觸發鈕內唯一未標 aria-hidden 的 span；可讀名稱在按鈕的 aria-label 上，不受影響）。
 */
.tb-bar[data-tb-size="icons"] :deep(.tb-metrics button > span:not([aria-hidden="true"])) {
  display: none;
}
</style>
