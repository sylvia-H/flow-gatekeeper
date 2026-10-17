<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { ChevronUp, PanelRightOpen } from "lucide-vue-next";
import { useResizeDrag } from "../composables/useResizeDrag.js";
import { DESK_QUERY, hasMatchMedia, matchesMedia } from "../composables/useMediaQuery.js";

/**
 * 監控台外殼：rail（sidebar slot）／工具列（topbar slot）／主區桌面（main slot）／
 * Copilot 面板（drawer slot）。
 *
 * - rail 與工具列是桌邊（`bg-rim`）；主區是帶 24px 格線的桌面（`bg-bench bg-bench-grid-lines`），
 *   其上的面板一律用同一組玻璃 class（`bg-surface/72 border border-edge shadow-glass rounded-card`）。
 * - Copilot 面板只有一個開關 `panelOpen`（所有寬度共用；由 App 傳入 copilot store 的 `panelOpen`，
 *   預設收合與手動收合偏好都在 store，spec FR-033、data-model §2）：
 *   `desk+`（≥ 1366px，tailwind.config 自訂 screen）是主區右側 348px 的玻璃片，收合時把寬度還給主區、右緣留「展開 AI 診斷」窄條；
 *   `< desk` 是 bottom-sheet（抓取把手、`shadow-sheet`，接手焦點時才有遮罩——`sheetEngaged`；高度依內容、最高 85vh），任何收合
 *   （收合鈕、Escape 或遮罩）後若仍有選取機台（`peekLabel` 非 null）退為 32px peek 條，點擊即展開；
 *   無選取時完全不渲染。768–1365px 雖仍顯示 rail，面板也走 sheet：768–1023 時 rail 240 + 面板 348 並排會把
 *   卡片欄擠到約 110px、文字全被截斷；1024–1365 時拓樸內容寬不足 708（1024 約 372、1280 約 622）堆成單欄
 *   （013 critique 第一輪 P1；T073 使用者裁決推擠門檻由 `lg`／1024 提到自訂 `desk`／1366——開面板後拓樸約 720，含傳統捲軸 10px 仍 710 ≥ 708 可三欄；T077 面板由 360 縮為 348）。斷點須與 `useModalSheet` 的 MOBILE_QUERY 一致
 *   （sheet 形態才掛 dialog 語意與焦點陷阱）。
 * - drawer slot 只渲染一次，由外層 aside 以響應式 class 切換兩種形態，避免重複掛載
 *   CopilotDrawer 造成雙份副作用。
 * - 事件分流：`open-panel`（展開窄條、peek 條）＝展開把手，App 接 store `openPanel`（展開並清除偏好）；
 *   `dismiss-panel` 只來自 sheet 遮罩點擊，App 接 `dismissPanel`（不寫偏好）；面板上的收合鈕由 drawer
 *   自己 emit `close`，App 接 `collapsePanel`（寫偏好）。本元件不監聽 Escape：桌機由 App 層
 *   `useKeyboardShortcuts` 依分層順序處理（FR-034a），手機 sheet 內由 drawer 的 `useModalSheet` 處理。
 * - 本元件在 `shared/`，不讀任何 domain store：peek 條的診斷狀態由 App 轉成文字（`peekStatus`）傳入。
 */
const props = defineProps<{
  /** Copilot 面板是否展開。 */
  panelOpen: boolean;
  /** 選取機台的顯示名稱；null＝無選取（peek 條不渲染）。 */
  peekLabel: string | null;
  /** peek 條上的診斷狀態 chip 文字（如「診斷中 60%」）；null／未傳＝無診斷，不顯示 chip。 */
  peekStatus?: string | null;
  /**
   * sheet 是否已接手焦點（drawer 的 `update:engaged`：`aria-modal="true"` 時為 true）。
   * 只有 true 時才渲染遮罩；閒置的非 modal sheet（單列約 51px）不蓋住、不調暗選取卡，點其他卡片就是改選。
   * 同時決定主區底部留白是否凍結（見 `bottomReserve`）。
   * 未傳視為 false（桌機推擠式恆 false）。
   */
  sheetEngaged?: boolean;
  /**
   * sheet 目前是否為閒置單列（已選機台且該台診斷狀態為 idle；App 由 store 同步算出）。只有此時才採用 ResizeObserver
   * 量到的 sheet 高度作底部留白；其餘（進行中／完成／失敗、空狀態）一律保留前值。不能只靠 `sheetEngaged`：
   * 它來自 drawer 的 IntersectionObserver，比 ResizeObserver 晚到，一打開就是 modal 的 sheet 會先被量成整個高度。未傳視為 false。
   */
  sheetCompact?: boolean;
}>();

const emit = defineEmits<{
  (e: "open-panel"): void;
  (e: "dismiss-panel"): void;
}>();

/** peek 條是否渲染：sheet 收合且仍有選取機台（desk+ 由 class 隱藏）。 */
const peekVisible = computed(() => !props.panelOpen && props.peekLabel !== null);

/**
 * peek 條是 `<button aria-label>`：aria-label 會蓋掉按鈕內的文字，所以診斷狀態要併進可讀名稱；
 * 依可見文字的順序（AI 診斷 → 機台名 → 狀態）組句，語音操作念看得到的字也點得到（WCAG 2.5.3）。
 */
const peekAriaLabel = computed(() => {
  const status = props.peekStatus ? `，診斷：${props.peekStatus}` : "";
  return `展開 AI 診斷：${props.peekLabel ?? ""}${status}`;
});

/** peek 條高度（`h-8`）。 */
const PEEK_HEIGHT = 32;

/**
 * 主區與 rail 的底部留白（px，< desk 才生效；desk+ 由 `desk:pb-0` 蓋掉）：讓固定在底部的 peek 條／bottom-sheet
 * 不蓋住事件流（critique 第三輪 P1：原本只有 peek 條給 `pb-8`，閒置 sheet 展開時事件流只剩標題或全被蓋住）。
 * - 收合：有 peek 條 32px，否則 0；
 * - 展開且為閒置單列（`sheetCompact`）、未接手焦點：sheet 外框的實際高度（ResizeObserver 量 `[data-fg="copilot"]`，約 51px）；
 * - 其餘展開情形（進行中／完成／失敗、空狀態、或已接手焦點的 modal）**保留前值**，不跟著 sheet 長高——否則串流讓 sheet
 *   長到 85vh 時主區會被擠成一條、收合時再彈回，遮罩下也看得到大幅跳動；一打開就是 modal（從 peek 重開已有結果的機台、
 *   改選有結果的機台）時也維持開啟前的值（第四輪交叉審查 high：`sheetEngaged` 比 ResizeObserver 晚到，曾先寫入 653px）。
 *   狀態轉移（閒置 → 進行中 → 完成）主區完全不動，只在收合時重排一次。
 * - desk+（≥ 1366px，推擠式側欄）恆 0，不把側欄高度寫進 ref。
 * 高度只寫進非 reactive 變數；留白值有變化才寫入 ref，串流期間不觸發任何 reactive 更新。
 */
const bottomReserve = ref(0);
let sheetHeight = 0;
/** 推擠式側欄門檻（Tailwind 自訂 `desk`，`DESK_QUERY`），與 `useModalSheet` 的 MOBILE_QUERY（`BELOW_DESK_QUERY`）互補；事件當下即時讀。 */
function isDesktop(): boolean {
  return matchesMedia(DESK_QUERY);
}
function syncBottomReserve(): void {
  let next: number;
  if (isDesktop()) next = 0;
  else if (!props.panelOpen) next = peekVisible.value ? PEEK_HEIGHT : 0;
  // 剛展開、尚未量到（隱藏時量得 0）也保留前值，不先寫 0 再跳回
  else if (props.sheetCompact && !props.sheetEngaged && sheetHeight > 0) next = sheetHeight;
  else return;
  if (bottomReserve.value !== next) bottomReserve.value = next;
}
watch(
  [() => props.panelOpen, () => props.sheetEngaged, () => props.sheetCompact, peekVisible],
  syncBottomReserve,
  { immediate: true },
);

let sheetObserver: ResizeObserver | null = null;
onMounted(() => {
  if (typeof ResizeObserver !== "function" || panelRef.value === null) return;
  sheetObserver = new ResizeObserver((entries) => {
    const entry = entries[entries.length - 1];
    if (!entry) return;
    const box = entry.borderBoxSize?.[0];
    sheetHeight = Math.round(box ? box.blockSize : entry.target.getBoundingClientRect().height);
    syncBottomReserve();
  });
  sheetObserver.observe(panelRef.value);
});
onUnmounted(() => sheetObserver?.disconnect());

/**
 * 寬螢幕（desk+）收合／展開時，若焦點原本在即將消失的那一側（面板內的收合鈕、或展開窄條），
 * 把焦點接到另一側，避免掉回 body。焦點不在其中（例如點選卡片自動展開）則不搬動，
 * 以免打斷卡片間的鍵盤操作。bottom-sheet（< desk）的焦點由 drawer 的 useModalSheet 負責。
 */
const panelRef = ref<HTMLElement | null>(null);
const expandRef = ref<HTMLButtonElement | null>(null);
watch(
  () => props.panelOpen,
  (open) => {
    const active = document.activeElement;
    const leaving = open ? expandRef.value : panelRef.value;
    if (!leaving || !(active instanceof Node) || !leaving.contains(active)) return;
    if (hasMatchMedia() && !matchesMedia(DESK_QUERY)) return;
    void nextTick(() => (open ? panelRef.value : expandRef.value)?.focus());
  },
);

/**
 * 側欄寬度可拖曳或用鍵盤調整（預設 240px，200–420；聚焦把手後 ArrowRight 加寬／ArrowLeft 減寬 16px，
 * FR-034c），偏好存 localStorage。
 */
const {
  size: sidebarWidth,
  startDrag: onSidebarHandleDown,
  onKeydown: onSidebarHandleKeydown,
  handleAttrs: sidebarHandleAttrs,
} = useResizeDrag({
  axis: "x",
  min: 200,
  max: 420,
  initial: 240,
  storageKey: "flow-gatekeeper:sidebar-width",
  label: "調整側欄寬度",
});
</script>

<template>
  <!-- App shell：不讓 body scroll，內部各區自行 scroll。`--fg-bottom-reserve`＝peek 條／閒置 sheet 的高度（見 bottomReserve） -->
  <div
    class="flex h-screen w-screen overflow-hidden bg-bench font-sans text-ink"
    :style="{ '--fg-bottom-reserve': `${bottomReserve}px` }"
  >
    <!-- rail：桌邊鋼灰，滿版高；手機隱藏（機群健康改由主區摘要條承載，US6）。
         768–1365px 時 peek 條與 sheet 橫跨整個底部，rail 同樣讓出等高，底部的主題切換才不被蓋住。 -->
    <aside
      class="hidden shrink-0 flex-col overflow-y-auto border-r border-edge bg-rim pb-[var(--fg-bottom-reserve)] md:flex desk:pb-0"
      :style="{ width: `${sidebarWidth}px` }"
      aria-label="側欄"
    >
      <slot name="sidebar" />
    </aside>

    <!-- 側欄寬度把手（僅桌機；疊在 border-r 上，抓取熱區比 1px 邊線寬）。可 Tab 聚焦、方向鍵調整；
         把手只有 6px 寬，聚焦時連同底色一起亮起才看得見。Tab 順序落在 rail 之後、主區之前。 -->
    <div
      v-bind="sidebarHandleAttrs"
      class="z-10 hidden w-1.5 shrink-0 -translate-x-px cursor-col-resize touch-none hover:bg-accent/60 focus:outline-none focus-visible:bg-accent/60 focus-visible:ring-2 focus-visible:ring-focus md:block"
      @pointerdown="onSidebarHandleDown"
      @keydown="onSidebarHandleKeydown"
    />

    <div class="flex min-w-0 flex-1 flex-col">
      <!-- 工具列：56px 桌邊 -->
      <header
        class="flex h-14 min-w-0 shrink-0 items-center overflow-hidden border-b border-edge bg-rim px-3"
      >
        <slot name="topbar" />
      </header>

      <!-- 主區桌面：格線底；主內容與 desk+ 的 Copilot 玻璃片並排。< desk 底部讓出 peek 條／閒置 sheet 的實際高度 -->
      <div class="flex min-h-0 flex-1 bg-bench bg-bench-grid-lines pb-[var(--fg-bottom-reserve)] desk:pb-0">
        <!-- flex 直欄：main slot 的根以 flex-1 填滿內容高（扣掉 p-3），不以 h-full 百分比取高；
             內容放不下時才由這裡捲動（正常情況各區自行捲動，這層不出現捲軸） -->
        <main class="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto p-3">
          <slot name="main" />
        </main>

        <!-- bottom-sheet（小於 desk）背景遮罩：只在 sheet 接手焦點（modal）時渲染；起於 top-14 不遮工具列；點擊收合。
             閒置的非 modal sheet 不渲染遮罩、不攔截點擊（點其他卡片＝改選；Escape 仍由 App 分層收合） -->
        <div
          v-if="panelOpen && sheetEngaged"
          class="fixed inset-x-0 bottom-0 top-14 z-40 bg-scrim/50 desk:hidden"
          aria-hidden="true"
          @click="emit('dismiss-panel')"
        />

        <!-- Copilot 面板：desk+ 為 348px 玻璃片；小於 desk 為 bottom-sheet（不透明以蓋住下方內容）。
             sheet 高度依內容、最高 85vh：閒置（尚未診斷）只有把手＋一列（約 51px），不留大片空白；
             結果變長時由 drawer 內容區自行捲動 -->
        <aside
          ref="panelRef"
          tabindex="-1"
          data-fg="copilot"
          :data-open="panelOpen ? 'true' : 'false'"
          :class="[
            panelOpen ? 'flex' : 'hidden',
            'fixed inset-x-0 bottom-0 z-50 max-h-[85vh] flex-col overflow-hidden focus:outline-none rounded-t-card border-t border-edge bg-surface-strong shadow-sheet',
            'desk:static desk:z-auto desk:my-3 desk:mr-3 desk:max-h-none desk:w-[348px] desk:shrink-0 desk:rounded-card desk:border desk:bg-surface/72 desk:shadow-glass',
          ]"
          aria-label="AI 診斷"
        >
          <!-- 抓取把手（裝飾；面板名稱由 aside 的 aria-label 提供） -->
          <div class="flex shrink-0 justify-center pb-1 pt-1.5 desk:hidden" aria-hidden="true">
            <span class="h-1 w-10 rounded-control bg-ink-3" />
          </div>
          <slot name="drawer" />
        </aside>

        <!-- desk+ 收合時的展開窄條：還寬度給主區，仍可一眼找到 -->
        <button
          v-if="!panelOpen"
          ref="expandRef"
          type="button"
          class="my-3 mr-3 hidden w-9 shrink-0 flex-col items-center gap-2 rounded-card border border-edge bg-surface/72 py-3 text-ink-2 shadow-glass transition-colors duration-150 hover:bg-surface hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-focus desk:flex"
          aria-label="展開 AI 診斷"
          title="展開 AI 診斷"
          @click="emit('open-panel')"
        >
          <PanelRightOpen class="h-4 w-4 shrink-0" aria-hidden="true" />
          <span class="text-xs font-semibold [writing-mode:vertical-rl]" aria-hidden="true">
            AI 診斷
          </span>
        </button>
      </div>
    </div>

    <!-- peek 條（小於 desk）：sheet 任何收合後仍有選取機台時常駐底部 32px；點擊＝展開把手。
         按鈕內一律非互動元素；名稱與狀態已併進 aria-label，chip 不另被念出 -->
    <button
      v-if="peekVisible"
      type="button"
      data-fg="copilot-peek"
      class="fixed inset-x-0 bottom-0 z-40 flex h-8 items-center gap-2 border-t border-edge bg-surface-strong px-4 text-sm text-ink shadow-sheet transition-colors duration-150 hover:bg-surface focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus desk:hidden"
      :aria-label="peekAriaLabel"
      @click="emit('open-panel')"
    >
      <ChevronUp class="h-4 w-4 shrink-0 text-ink-3" aria-hidden="true" />
      <!-- 「AI 診斷」只給輔助技術：chip 文字已是「AI：…」，可見再寫一次會重複；可讀名稱另由 aria-label 提供 -->
      <span class="sr-only">AI 診斷</span>
      <span class="min-w-0 truncate">{{ peekLabel }}</span>
      <!-- 診斷狀態 chip：只顯示文字，空間不足時機台名稱先截斷、chip 不縮 -->
      <span
        v-if="peekStatus"
        class="ml-auto shrink-0 rounded-pill border border-edge bg-surface px-2 py-px text-xs font-semibold leading-4 text-ink-2"
      >{{ peekStatus }}</span>
    </button>
  </div>
</template>
