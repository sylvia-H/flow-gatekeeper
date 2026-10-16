<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref } from "vue";
import { Activity, ChevronDown } from "lucide-vue-next";
import {
  useMetricsStore,
  type MetricsStatus,
} from "../../domains/monitoring/stores/metrics.store.js";
import { persistView } from "../../domains/monitoring/lib/metrics-view.js";
import { formatRelative } from "../lib/format.js";

/**
 * dev 指標面板（009 US3／FR-008a）——**唯讀**：只呈現 `system/metrics` 的最新快照，
 * **MUST NOT** 提供任何觸發後端動作的控制項（憲章 II：面板不是操作介面）。
 *
 * 預設收合，展開後顯示四項指標與快照新鮮度。四種樣態 MUST 可區分（contracts/
 * metrics-summary.md §2.1）：`live`／`stale`（ws 連著但後端停更）／`disconnected`
 * （前端沒連上）／`empty`（尚未收到任何快照）——`stale` 與 `disconnected` 的排查方向
 * 完全相反，文案與顏色都必須分得開。
 *
 * 視覺沿用 TopBar 控制項的語彙（觸發鈕為玻璃面、展開層為不透明 `surface-strong`），
 * 顏色／圓角／間距一律用語意 token，MUST NOT 散落 hex；文案繁中、最小字級 12px（FR-005、FR-038）。
 *
 * **展開層必須 `Teleport` 到 body**：AppLayout 的 header 是 `h-14` **且 `overflow-hidden`**
 * （AppLayout.vue），面板往按鈕下方展開約 200px，留在 header 內會被整個裁掉、點了像沒反應。
 * 改 `position: fixed` 也救不了——TopBar 的 `.tb-bar` 設了 `container-type: inline-size`，
 * 它會成為 fixed 子孫的 containing block，於是仍受 header 的 overflow 裁切。Teleport 把節點
 * 移出 header 之外才是可靠解，座標再由觸發按鈕的 `getBoundingClientRect()` 對齊。
 */
const metrics = useMetricsStore();
const open = ref(false); // 預設收合
const triggerRef = ref<HTMLElement | null>(null);
const panelRef = ref<HTMLElement | null>(null);
const panelPosition = ref({ top: "0px", right: "0px" });

/** 以觸發按鈕為錨點對齊展開層（右緣切齊、下方 8px）。 */
function updatePosition(): void {
  const rect = triggerRef.value?.getBoundingClientRect();
  if (!rect) return;
  panelPosition.value = {
    top: `${rect.bottom + 8}px`,
    right: `${Math.max(8, window.innerWidth - rect.right)}px`,
  };
}

function onOutside(event: MouseEvent): void {
  const target = event.target as Node | null;
  if (!target) return;
  if (triggerRef.value?.contains(target) || panelRef.value?.contains(target)) return;
  close();
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") close();
}

function close(): void {
  if (!open.value) return;
  open.value = false;
  window.removeEventListener("resize", updatePosition);
  document.removeEventListener("mousedown", onOutside);
  document.removeEventListener("keydown", onKeydown);
}

function toggle(): void {
  if (open.value) {
    close();
    return;
  }
  open.value = true;
  void nextTick(updatePosition);
  window.addEventListener("resize", updatePosition);
  document.addEventListener("mousedown", onOutside);
  document.addEventListener("keydown", onKeydown);
}

onUnmounted(close);

const STATUS_META: Record<MetricsStatus, { label: string; dot: string; text: string; hint: string }> = {
  live: { label: "即時", dot: "bg-ok", text: "text-ok-fg", hint: "指標為最新一則週期摘要" },
  stale: {
    label: "逾時", // 指標快照過期；刻意不用機台的「停滯」：兩者顏色不同（warn vs stale），同詞不同色會誤導
    dot: "bg-warn",
    text: "text-warn-fg",
    hint: "已連線，但逾兩個週期未收到新摘要——後端指標可能停止廣播",
  },
  disconnected: {
    label: "已斷線",
    dot: "bg-crit",
    text: "text-crit-fg",
    hint: "即時通道未連線——顯示的是最後已知數值，與後端是否仍在產指標無關",
  },
  empty: {
    label: "尚無資料",
    dot: "bg-ink-3",
    text: "text-ink-3",
    // 不寫死秒數：此時還沒有 payload，`windowMs` 無從得知，寫「預設 60 秒」在非預設間隔下會誤導。
    hint: "尚未收到任何指標摘要（每個週期一則）",
  },
};

const meta = computed(() => STATUS_META[metrics.status]);
const snapshot = computed(() => metrics.snapshot);

/** null 代表「本窗無樣本」，與 0 語意不同——一律顯示 `—`，MUST NOT 顯示成 0。 */
function num(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : value.toLocaleString("en-US");
}
function ms(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : `${value.toLocaleString("en-US")}ms`;
}
const hitRateText = computed(() => {
  const rate = snapshot.value?.worker?.cache.hitRate;
  return rate === null || rate === undefined ? "—" : `${Math.round(rate * 100)}%`;
});

/** 遙測落地累計（api 啟動以來）；舊版 api 不帶 `persist` 時兩格皆為「—」。 */
const persist = computed(() => persistView(snapshot.value));

/**
 * 快照年齡——距上次收訊多久（單一本地時鐘，見 metrics.store 的說明），格式統一由 `formatRelative`
 * 提供（≤ 2 秒「剛剛」、「N 秒前」、「N 分鐘前」，FR-022）。`formatRelative` 只看兩時刻的差值，
 * 而 `ageMs` 已是差值，故以 0 為起點換算，不必為了湊出時間點再匯入 monitoring store。
 */
const ageText = computed(() => (metrics.ageMs === null ? "—" : formatRelative(0, metrics.ageMs)));
const windowText = computed(() =>
  snapshot.value ? `週期 ${Math.round(snapshot.value.windowMs / 1000)} 秒` : "",
);
</script>

<template>
  <div class="relative">
    <button
      ref="triggerRef"
      type="button"
      class="flex h-9 items-center gap-1.5 rounded-control border border-edge bg-surface/72 px-2.5 text-xs text-ink-2 shadow-glass hover:bg-surface-strong hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      :aria-expanded="open"
      aria-label="指標面板"
      :title="meta.hint"
      @click="toggle"
    >
      <Activity class="h-4 w-4" aria-hidden="true" />
      <span class="hidden md:inline">指標</span>
      <span class="h-2 w-2 rounded-pill" :class="meta.dot" aria-hidden="true" />
      <ChevronDown
        class="h-3.5 w-3.5 transition-transform"
        :class="open ? 'rotate-180' : ''"
        aria-hidden="true"
      />
    </button>

    <!-- Teleport 出 header：header 為 h-14 + overflow-hidden，留在原地會被整個裁掉（見上方註解） -->
    <Teleport to="body">
      <div
        v-if="open"
        ref="panelRef"
        class="fixed z-[60] w-72 rounded-card border border-edge bg-surface-strong p-3 font-sans shadow-glass"
        :style="panelPosition"
        role="status"
      >
        <!-- 樣態列：四態以文案 + 色點雙重編碼，stale 與 disconnected 必須一眼分得開 -->
        <div class="flex items-center justify-between gap-2 border-b border-edge pb-2">
          <span class="inline-flex items-center gap-1.5 text-xs" :class="meta.text">
            <span class="h-2 w-2 rounded-pill" :class="meta.dot" aria-hidden="true" />
            {{ meta.label }}
          </span>
          <span class="font-mono text-xs text-ink-3">
            {{ ageText }}<template v-if="windowText"> · {{ windowText }}</template>
          </span>
        </div>
        <p class="pt-2 text-xs text-ink-3">{{ meta.hint }}</p>

        <dl v-if="snapshot" class="mt-2 space-y-1.5 text-xs">
          <div class="flex items-baseline justify-between gap-2">
            <dt class="text-ink-2">佇列（等待/執行中/失敗）</dt>
            <dd class="font-mono text-ink">
              {{ num(snapshot.queue.waiting) }}/{{ num(snapshot.queue.active) }}/{{
                num(snapshot.queue.failed)
              }}
            </dd>
          </div>
          <div class="flex items-baseline justify-between gap-2">
            <dt class="text-ink-2">WS 連線數</dt>
            <dd class="font-mono text-ink">{{ num(snapshot.wsConnections) }}</dd>
          </div>
          <div class="flex items-baseline justify-between gap-2">
            <dt class="text-ink-2">LLM 延遲（平均/p95/最大）</dt>
            <dd class="font-mono text-ink">
              {{ ms(snapshot.worker?.llmLatency.avgMs) }}/{{
                ms(snapshot.worker?.llmLatency.p95Ms)
              }}/{{ ms(snapshot.worker?.llmLatency.maxMs) }}
            </dd>
          </div>
          <div class="flex items-baseline justify-between gap-2">
            <dt class="text-ink-2">快取命中率</dt>
            <dd class="font-mono text-ink">
              {{ hitRateText }}
              <span class="text-ink-3">
                （{{ num(snapshot.worker?.cache.hits) }}/{{
                  num(
                    snapshot.worker
                      ? snapshot.worker.cache.hits + snapshot.worker.cache.misses
                      : null,
                  )
                }}）
              </span>
            </dd>
          </div>
          <div class="flex items-baseline justify-between gap-2">
            <dt class="text-ink-2">遙測寫入（遺失/失敗）</dt>
            <dd class="font-mono text-ink">{{ persist.dropped }}/{{ persist.failed }}</dd>
          </div>
          <p v-if="snapshot.worker === null" class="pt-1 text-ink-3">
            背景工作程序的指標缺席（快照不存在／過期／畸形）——API 端兩項仍為即時值。
          </p>
        </dl>
      </div>
    </Teleport>
  </div>
</template>
