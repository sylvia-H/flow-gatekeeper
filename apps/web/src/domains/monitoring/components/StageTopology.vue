<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, type Ref } from "vue";
import { useMonitoringStore, type MachineLive } from "../stores/monitoring.store.js";
import { useDiagnoseTrigger } from "../../ai-copilot/composables/useDiagnoseTrigger.js";
import { useCopilotStore } from "../../ai-copilot/stores/copilot.store.js";
import type { DiagnosisBadge } from "../../ai-copilot/lib/diagnosis-badge.js";
import type { AnomalyLatch } from "../lib/anomaly-latch.js";
import { MACHINE_GROUPS } from "../lib/machine-groups.js";
import { assignToStages, type Stage } from "../lib/stage-layout.js";
import { speedFor, throughputSum, widthFor, type FlowSpeed } from "../lib/flow-link.js";
import { isStale } from "../lib/stale.js";
import MachineNodeCard from "./MachineNodeCard.vue";
import StageColumn from "./StageColumn.vue";
import FlowLink from "./FlowLink.vue";

/**
 * 產線 stage 拓樸（research R5、FR-013～FR-017）：前處理 → 成型烘烤 → 包裝分揀 三欄，欄間是流向連線。
 *
 * - 分欄：`assignToStages(store.visibleMachineIds, MACHINE_GROUPS)`（搜尋過濾後的可見機台；空欄保留）。
 * - 連線：第 i 段反映**下游** stage 的產出量，總和以完整分組 `MACHINE_GROUPS[i + 1].machineIds` 計
 *   （不是搜尋過濾後的欄內機台：搜尋只影響卡片顯示，連線不變）。粗細與流速皆為 `machines`／`staleNow`
 *   的 computed 衍生——`machines` 每個 rAF 批次至多 trigger 一次、`staleNow` 每秒一次，
 *   所以每幀至多重算一次，不在任何 handler 裡逐筆寫 reactive。
 * - 版面：容器放得下三欄（3 × 220px + 2 × 24px 溝槽）時為五欄 grid，否則單欄堆疊、連線改為朝下短箭頭
 *   且不流動（FR-016）。以**容器寬度**而非 viewport 判斷：1024px 寬且 Copilot 面板展開時主區只剩約 400px，
 *   用 `md:` 斷點會出現橫向捲動（FR-031）。手機（< 768px）的容器必然窄於門檻，同樣走堆疊。
 * - prefers-reduced-motion 時只保留粗細、不流動（FR-014）。
 * - 卡片的選台與診斷接線同既有作法：`store.selectMachine`、`useDiagnoseTrigger().diagnose`。
 * - 卡片底列（US5）：異常標記只在可見期內傳入（`store.latchVisible`，以 `staleNow` 判定 30 秒期滿），
 *   清除走 `store.clearLatch`（與異常摘要列同一份狀態）；診斷狀態 chip 取 `copilot.badgeFor`。
 *   卡片只讀 props、不直接讀 store。
 */
const store = useMonitoringStore();
const trigger = useDiagnoseTrigger();
const copilot = useCopilotStore();

/**
 * 三欄最小寬 220px 加兩條 24px 溝槽：容器內容寬小於此值即改為單欄堆疊。
 *
 * 220 是卡片數值列的下限，不能再縮：卡片內容寬＝欄寬 − 30（內距＋邊框），2×2 數值每格約 89px，
 * 5 位數值（嚴重時的溫度「108.0」、產能「1,180」）在 24px mono 下約 72px，加間距與刻度要 86px；
 * 縮到 200px 每格只剩約 81px，嚴重卡片最需要看清的溫度會被截斷。
 * 面板展開時：1366×768 主區容器內容寬恰為 708px → 三欄並排；1024×768 只剩約 366px，
 * 三欄各約 106px 怎麼縮都放不下一張完整卡片，維持單欄堆疊（每段一欄滿寬，FR-031 不溢出優先）。
 */
const MIN_ROW_WIDTH = 3 * 220 + 2 * 24;

const hasMatchMedia = typeof window !== "undefined" && typeof window.matchMedia === "function";

/**
 * 媒體查詢狀態：setup 當下同步讀一次，mounted 後掛 change 監聽、unmounted 解除。
 * 環境沒有 `matchMedia`（測試環境或舊瀏覽器）時固定為 false。
 */
function useMediaQuery(query: string): Ref<boolean> {
  const list = hasMatchMedia ? window.matchMedia(query) : null;
  const matches = ref(list?.matches ?? false);
  const onChange = (event: MediaQueryListEvent): void => {
    matches.value = event.matches;
  };
  onMounted(() => {
    if (list && typeof list.addEventListener === "function") list.addEventListener("change", onChange);
  });
  onUnmounted(() => {
    if (list && typeof list.removeEventListener === "function") list.removeEventListener("change", onChange);
  });
  return matches;
}

const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
/** 沒有 ResizeObserver 時的退路：以 Tailwind `md`（768px）以下視為堆疊。 */
const narrowViewport = useMediaQuery("(max-width: 767.98px)");

/**
 * 捲動容器的內容寬（px）；null＝尚未量到（或環境沒有 ResizeObserver）。
 * ResizeObserver 回呼在 layout 之後、paint 之前送達，首幀即為正確版面；只有容器尺寸改變時才寫入（低頻）。
 */
const container = ref<HTMLElement | null>(null);
const containerWidth = ref<number | null>(null);
let observer: ResizeObserver | null = null;

onMounted(() => {
  if (typeof ResizeObserver !== "function" || container.value === null) return;
  observer = new ResizeObserver((entries) => {
    const entry = entries[entries.length - 1];
    if (entry) containerWidth.value = entry.contentRect.width;
  });
  observer.observe(container.value);
});

onUnmounted(() => {
  observer?.disconnect();
  observer = null;
});

/** 單欄堆疊（含手機）：連線改為垂直短箭頭、不流動。 */
const stacked = computed(() =>
  containerWidth.value === null ? narrowViewport.value : containerWidth.value < MIN_ROW_WIDTH,
);

const stages = computed(() => assignToStages(store.visibleMachineIds, MACHINE_GROUPS));

interface LinkView {
  width: number;
  speed: FlowSpeed;
}

/** 兩段連線：stage i → stage i+1，依下游完整分組的 throughput 總和決定粗細與流速等級。 */
const links = computed<LinkView[]>(() =>
  MACHINE_GROUPS.slice(1).map((downstream) => {
    const sum = throughputSum(downstream.machineIds, store.machines, store.staleNow);
    return { width: widthFor(sum), speed: speedFor(sum, reducedMotion.value, stacked.value) };
  }),
);

interface CardView {
  id: string;
  machine: MachineLive | null;
  selected: boolean;
  stale: boolean;
  /** 可見期內的異常標記；不可見（含從未異常、已期滿）為 null。 */
  latch: AnomalyLatch | null;
  badge: DiagnosisBadge;
}

interface ColumnView {
  stage: Stage;
  cards: CardView[];
  /** 本欄之後的連線；最後一欄為 null。 */
  link: LinkView | null;
}

/**
 * 每欄的卡片衍生值（快照、選取、停滯）與其後的連線。machine 尚無資料時為 null，卡片顯示 placeholder
 * （冷啟動即顯示，FR-024）；stale 與相對時間依 store.staleNow（每秒 tick；Pause 且連線中時凍結）。
 */
const columns = computed<ColumnView[]>(() =>
  stages.value.map((stage, index) => ({
    stage,
    cards: stage.machineIds.map((id) => {
      const machine = store.machines.get(id) ?? null;
      return {
        id,
        machine,
        selected: store.selectedMachineId === id,
        stale: machine ? isStale(machine.lastUpdated, store.staleNow) : false,
        latch: store.latchVisible(id) ? (store.latchFor(id) ?? null) : null,
        badge: copilot.badgeFor(id),
      };
    }),
    link: links.value[index] ?? null,
  })),
);

/** 五欄 grid：三欄 `minmax(220px,1fr)` 夾兩條 24px 溝槽（溝槽放連線）。 */
const ROW_CLASS = "grid-cols-[minmax(220px,1fr)_24px_minmax(220px,1fr)_24px_minmax(220px,1fr)]";

function onSelect(machineId: string): void {
  store.selectMachine(machineId);
}

/** 卡片診斷圖示：選取該台並觸發診斷（去重／連線把關在共用入口與 copilot store）。 */
function onDiagnose(machineId: string): void {
  trigger.diagnose(machineId);
}

/** 卡片異常標記的清除鈕：確認（劃線），期滿才消失（FR-026）。 */
function onClearLatch(machineId: string): void {
  store.clearLatch(machineId);
}
</script>

<template>
  <!-- 桌面底色與 24px 格線由 AppLayout 的主區容器提供，這裡不另畫，避免兩套格線原點錯位。
       捲動容器保留 8px 內距：卡片焦點環（2px 寬＋2px offset）外延 4px，超出 padding box，貼邊會被外層 overflow 裁掉 -->
  <div ref="container" class="h-full overflow-auto p-2">
    <div
      class="grid"
      :class="stacked ? 'grid-cols-1 gap-y-1' : ROW_CLASS"
      data-fg="stage-topology"
      :data-layout="stacked ? 'stacked' : 'row'"
    >
      <template v-for="column in columns" :key="column.stage.key">
        <StageColumn :stage="column.stage">
          <MachineNodeCard
            v-for="card in column.cards"
            :key="card.id"
            :machine-id="card.id"
            :machine="card.machine"
            :selected="card.selected"
            :stale="card.stale"
            :now="store.staleNow"
            :latch="card.latch"
            :badge="card.badge"
            @select="onSelect"
            @diagnose="onDiagnose"
            @clear-latch="onClearLatch"
          />
        </StageColumn>
        <!-- 溝槽：並排時為欄間 24px、箭頭垂直置中；堆疊時為兩段之間 24px 高的朝下短箭頭 -->
        <div v-if="column.link" class="flex items-center justify-center" aria-hidden="true">
          <FlowLink
            :width="column.link.width"
            :speed="column.link.speed"
            :orientation="stacked ? 'vertical' : 'horizontal'"
          />
        </div>
      </template>
    </div>
  </div>
</template>
