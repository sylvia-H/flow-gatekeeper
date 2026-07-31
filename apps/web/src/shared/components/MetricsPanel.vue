<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref } from "vue";
import { Activity, ChevronDown } from "lucide-vue-next";
import {
  useMetricsStore,
  type MetricsStatus,
} from "../../domains/monitoring/stores/metrics.store.js";

/**
 * dev 指標面板（009 US3／FR-008a）——**唯讀**：只呈現 `system/metrics` 的最新快照，
 * **MUST NOT** 提供任何觸發後端動作的控制項（憲章 II：面板不是操作介面）。
 *
 * 預設收合，展開後顯示四項指標與快照新鮮度。四種樣態 MUST 可區分（contracts/
 * metrics-summary.md §2.1）：`live`／`stale`（ws 連著但後端停更）／`disconnected`
 * （前端沒連上）／`empty`（尚未收到任何快照）——`stale` 與 `disconnected` 的排查方向
 * 完全相反，文案與顏色都必須分得開。
 *
 * 視覺沿用 BackpressureBadge／TopBar chip 的語彙，顏色／圓角／間距一律用 design-spec
 * 具名 token，MUST NOT 散落 hex。
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
  live: { label: "Live", dot: "bg-ok", text: "text-ok-fg", hint: "指標為最新一則週期摘要" },
  stale: {
    label: "Stale",
    dot: "bg-warn",
    text: "text-warn-fg",
    hint: "已連線，但逾兩個週期未收到新摘要——後端指標可能停止廣播",
  },
  disconnected: {
    label: "Offline",
    dot: "bg-crit",
    text: "text-crit-fg",
    hint: "即時通道未連線——顯示的是最後已知數值，與後端是否仍在產指標無關",
  },
  empty: {
    label: "No data",
    dot: "bg-fg-subtle",
    text: "text-fg-subtle",
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

/** 快照年齡（秒）——距上次收訊多久（單一本地時鐘，見 metrics.store 的說明）。 */
const ageText = computed(() =>
  metrics.ageMs === null ? "—" : `${Math.max(0, Math.round(metrics.ageMs / 1000))}s ago`,
);
const windowText = computed(() =>
  snapshot.value ? `${Math.round(snapshot.value.windowMs / 1000)}s window` : "",
);
</script>

<template>
  <div class="relative">
    <button
      ref="triggerRef"
      type="button"
      class="flex h-9 items-center gap-1.5 rounded-control border border-subtle bg-surface px-2.5 text-xs text-fg-muted hover:bg-surface-hover hover:text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      :aria-expanded="open"
      aria-label="Metrics panel"
      :title="meta.hint"
      @click="toggle"
    >
      <Activity class="h-4 w-4" aria-hidden="true" />
      <span class="hidden md:inline">Metrics</span>
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
        class="fixed z-[60] w-72 rounded-card border border-subtle bg-elevated p-3 font-sans shadow-card"
        :style="panelPosition"
        role="status"
      >
        <!-- 樣態列：四態以文案 + 色點雙重編碼，stale 與 disconnected 必須一眼分得開 -->
        <div class="flex items-center justify-between gap-2 border-b border-subtle pb-2">
          <span class="inline-flex items-center gap-1.5 text-xs" :class="meta.text">
            <span class="h-2 w-2 rounded-pill" :class="meta.dot" aria-hidden="true" />
            {{ meta.label }}
          </span>
          <span class="font-mono text-xs text-fg-subtle">
            {{ ageText }}<template v-if="windowText"> · {{ windowText }}</template>
          </span>
        </div>
        <p class="pt-2 text-xs text-fg-subtle">{{ meta.hint }}</p>

        <dl v-if="snapshot" class="mt-2 space-y-1.5 text-xs">
          <div class="flex items-baseline justify-between gap-2">
            <dt class="text-fg-muted">Queue（waiting/active/failed）</dt>
            <dd class="font-mono text-fg">
              {{ num(snapshot.queue.waiting) }}/{{ num(snapshot.queue.active) }}/{{
                num(snapshot.queue.failed)
              }}
            </dd>
          </div>
          <div class="flex items-baseline justify-between gap-2">
            <dt class="text-fg-muted">WS connections</dt>
            <dd class="font-mono text-fg">{{ num(snapshot.wsConnections) }}</dd>
          </div>
          <div class="flex items-baseline justify-between gap-2">
            <dt class="text-fg-muted">LLM latency（avg/p95/max）</dt>
            <dd class="font-mono text-fg">
              {{ ms(snapshot.worker?.llmLatency.avgMs) }}/{{
                ms(snapshot.worker?.llmLatency.p95Ms)
              }}/{{ ms(snapshot.worker?.llmLatency.maxMs) }}
            </dd>
          </div>
          <div class="flex items-baseline justify-between gap-2">
            <dt class="text-fg-muted">Cache hit rate</dt>
            <dd class="font-mono text-fg">
              {{ hitRateText }}
              <span class="text-fg-subtle">
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
          <p v-if="snapshot.worker === null" class="pt-1 text-fg-subtle">
            worker 指標缺席（快照不存在／過期／畸形）——api 側兩項仍為即時值。
          </p>
        </dl>
      </div>
    </Teleport>
  </div>
</template>
