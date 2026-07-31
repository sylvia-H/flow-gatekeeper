import { defineStore } from "pinia";
import { computed, ref } from "vue";
import type { SystemMetrics } from "@flow-gatekeeper/contracts";
import { useMonitoringStore } from "./monitoring.store.js";

/**
 * 面板樣態（009 FR-008a、contracts/metrics-summary.md §2.1）。四態 MUST 可區分——
 * `stale`（後端停止廣播）與 `disconnected`（前端沒連上）的排查方向完全相反，
 * 混為一態會讓面板的判讀價值歸零。
 */
export type MetricsStatus = "empty" | "live" | "stale" | "disconnected";

/** 過期門檻＝2 × `windowMs`：漏收單一則屬正常（at-most-once、不補發），連兩則才代表真的停更。 */
export const STALE_WINDOW_MULTIPLIER = 2;

/**
 * `system/metrics` 最新快照（009 US3 dev 面板的唯一資料來源）。
 *
 * **低頻（預設 60s 一則）**：直接寫入 reactive state，不進 `machine/data` 的 rAF buffer
 * （憲章 IV 的邊界，見 `ws-message.ts` 的分派註解）。
 *
 * 新鮮度一律以 payload 的 `collectedAt`（api 結算時間）為基準、門檻由 payload 的 `windowMs`
 * 推導——`METRICS_INTERVAL_MS` 是後端環境變數，前端無從讀取，**MUST NOT 硬編 60000**。
 * 這與 `metrics:worker` 的 3× TTL 是**不同層**的問題（那是後端快照存活期，決定 `worker`
 * 是否降級為 null），MUST NOT 互相對齊。
 */
export const useMetricsStore = defineStore("metrics", () => {
  /** 最新一則快照；null＝尚未收到任何一則。 */
  const snapshot = ref<SystemMetrics | null>(null);
  /** 本地收訊時刻（僅供除錯顯示；新鮮度判定一律用 payload 的 collectedAt）。 */
  const receivedAt = ref<number | null>(null);

  // 時鐘與連線狀態複用 monitoring store：`now` 已由 App 每秒 tick 一次（低頻，足夠驅動
  // 過期判定），不另起第二個 timer；`connectionStatus` 是連線三態的單一來源，
  // MUST NOT 在此另立平行狀態。
  const monitoring = useMonitoringStore();

  /** 距 `collectedAt` 的毫秒數；無快照或時間戳無法解析時為 null。 */
  const ageMs = computed<number | null>(() => {
    if (snapshot.value === null) return null;
    const collectedAt = Date.parse(snapshot.value.collectedAt);
    if (!Number.isFinite(collectedAt)) return null;
    return monitoring.now - collectedAt;
  });

  /**
   * 四態判定。`empty` 優先於一切——尚未收到任何快照時既沒有 `collectedAt` 也沒有
   * `windowMs`，無從計算門檻，**MUST NOT 判為過期**。
   */
  const status = computed<MetricsStatus>(() => {
    const snap = snapshot.value;
    if (snap === null) return "empty";
    if (monitoring.connectionStatus !== "connected") return "disconnected";
    // 時間戳無法解析＝無法證明新鮮 → 一律當作過期，不謊報即時。
    if (ageMs.value === null) return "stale";
    return ageMs.value > STALE_WINDOW_MULTIPLIER * snap.windowMs ? "stale" : "live";
  });

  /** 由 ws 分派直接呼叫（低頻，直接 reactive 寫入無虞）。 */
  function applyMetrics(payload: SystemMetrics): void {
    snapshot.value = payload;
    receivedAt.value = Date.now();
  }

  return { snapshot, receivedAt, ageMs, status, applyMetrics };
});
