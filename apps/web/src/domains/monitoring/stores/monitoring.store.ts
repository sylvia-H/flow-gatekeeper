import { defineStore } from "pinia";
import { computed, ref } from "vue";
import type { MachineState, TelemetryPoint } from "@flow-gatekeeper/contracts";
import { fleetHealthOf, type FleetHealthSummary } from "../lib/fleet-health.js";
import { KNOWN_MACHINE_IDS } from "../lib/machine-labels.js";
import { deriveTransitionEvent, pushCapped, type DerivedEvent } from "../lib/events.js";
import { filterMachineIds } from "../lib/machine-search.js";

/** US3 事件保留上限（FR-011）。 */
const EVENT_CAP = 50;

/**
 * 連線三態（design-spec §8.2）。單一資料來源為本 store 的 `connectionStatus`，
 * 元件（AppLayout / TopBar chip）一律讀它，不另立平行狀態。
 */
export type ConnectionStatus = "connected" | "reconnecting" | "disconnected";

/**
 * `MachineLive` —— 前端投影，衍生自契約 `TelemetryPoint`（非契約新增）。
 * 只保留每台機台「最新一筆」快照 + 收到時的 `lastUpdated`（供 stale 判斷）。
 */
export type MachineLive = {
  machineId: string;
  state: MachineState;
  telemetry: TelemetryPoint["telemetry"];
  lastUpdated: number;
};

function project(point: TelemetryPoint, receivedAt: number): MachineLive {
  return {
    machineId: point.machineId,
    state: point.state,
    telemetry: { ...point.telemetry },
    lastUpdated: receivedAt,
  };
}

export const useMonitoringStore = defineStore("monitoring", () => {
  // ── State ──────────────────────────────────────────────────────────
  /** 每台機台最新快照；key 為 machineId，只保留最新值（覆寫）。 */
  const machines = ref<Map<string, MachineLive>>(new Map());
  /** 目前選取機台（至多一台）；供 selected 視覺與 005 診斷觸發。 */
  const selectedMachineId = ref<string | null>(null);
  /** 即時通道三態，初始 disconnected。 */
  const connectionStatus = ref<ConnectionStatus>("disconnected");
  /** `system/connected` 派發的連線識別；保存供 005（POST /diagnoses 的 socketId）。 */
  const clientId = ref<string | null>(null);
  /** 累積收到的 telemetry 筆數（背壓分子）。 */
  const receivedMessages = ref(0);
  /** 累積 rAF 批次提交次數（背壓分母）。 */
  const renderedBatches = ref(0);
  /** 低頻更新的當前時間戳，驅動 stale 重算（每秒一次）。 */
  const now = ref(Date.now());
  /** US3 前端衍生事件（最近 50 筆，最新在頂端）；於 applyTelemetryBatch 批次點衍生。 */
  const events = ref<DerivedEvent[]>([]);
  /** US4 即時通道 ping→pong RTT（ms）；null＝尚無量測（首個 pong 前）。 */
  const latencyMs = ref<number | null>(null);
  /** US4 pause 開關；true 時 composable pump 跳過 flush、續存 buffer（畫面凍結）。 */
  const paused = ref(false);
  /** US4 search 查詢字串；空＝全部。sidebar 清單與主區卡片共用 `visibleMachineIds`。 */
  const searchQuery = ref("");

  // ── Getters ────────────────────────────────────────────────────────
  /** 背壓比值：renderedBatches>0 ? round(received/rendered) : 0（design-spec §7.2.1）。 */
  const batchRatio = computed(() =>
    renderedBatches.value > 0
      ? Math.round(receivedMessages.value / renderedBatches.value)
      : 0,
  );

  /**
   * 依 machineId 穩定排序、僅含已收到遙測者。
   * ⚠️ 卡片渲染 MUST NOT 只依此 getter（冷啟動 Map 空無法顯示 placeholder）；
   * 渲染來源為固定名冊 KNOWN_MACHINE_IDS，逐台向 machines 查快照。
   */
  const machineList = computed<MachineLive[]>(() =>
    Array.from(machines.value.values()).sort((a, b) =>
      a.machineId.localeCompare(b.machineId),
    ),
  );

  /** selectedMachineId 對應的快照，供 TopBar／005 使用。 */
  const selectedMachine = computed<MachineLive | null>(() =>
    selectedMachineId.value !== null
      ? (machines.value.get(selectedMachineId.value) ?? null)
      : null,
  );

  /**
   * US2 Fleet Health 四類聚合（FR-006/007/008）。委派純函式 `fleetHealthOf`，
   * 走固定名冊 KNOWN_MACHINE_IDS（total 穩定＝5）。依賴 `machines` 與 `now`（每秒 tick
   * 重算 stale），屬低頻 reactive，不逐筆 telemetry 觸發（憲章 IV）。
   */
  const fleetHealth = computed<FleetHealthSummary>(() =>
    fleetHealthOf(machines.value, now.value, KNOWN_MACHINE_IDS),
  );

  /**
   * US4 search 結果——sidebar 清單與主區卡片**共用**此單一 computed（FR-015、SC-006），
   * 確保兩處過濾一致。空查詢回全部名冊。
   */
  const visibleMachineIds = computed<string[]>(() =>
    filterMachineIds(KNOWN_MACHINE_IDS, searchQuery.value),
  );

  // ── Actions ────────────────────────────────────────────────────────
  /**
   * 每次呼叫 = 一個 rAF 幀 = 一次批次（不論 batch 幾筆）：
   * 逐筆覆寫該台最新快照，received += batch.length，rendered += 1。
   */
  function applyTelemetryBatch(batch: TelemetryPoint[]): void {
    const receivedAt = Date.now();
    for (const point of batch) {
      // US3：覆寫快照**前**讀 prevState，於狀態轉入 warning/critical 時衍生一筆事件（去重、上限 50）。
      const prevState = machines.value.get(point.machineId)?.state;
      const event = deriveTransitionEvent(prevState, point.state, point.machineId, receivedAt);
      if (event) pushCapped(events.value, event, EVENT_CAP);
      machines.value.set(point.machineId, project(point, receivedAt));
    }
    receivedMessages.value += batch.length;
    renderedBatches.value += 1;
  }

  function selectMachine(machineId: string): void {
    selectedMachineId.value = machineId;
  }

  function setConnectionStatus(status: ConnectionStatus): void {
    connectionStatus.value = status;
  }

  function setClientId(id: string): void {
    clientId.value = id;
  }

  function tickNow(): void {
    now.value = Date.now();
  }

  /** US4：切換 pause（畫面凍結／恢復）。 */
  function togglePause(): void {
    paused.value = !paused.value;
  }

  /** US4：由 composable `onLatency` 餵入 ping/pong RTT。 */
  function setLatency(ms: number): void {
    latencyMs.value = ms;
  }

  /** US4：更新 search 查詢字串（TopBar 綁定）。 */
  function setSearchQuery(query: string): void {
    searchQuery.value = query;
  }

  return {
    machines,
    selectedMachineId,
    connectionStatus,
    clientId,
    receivedMessages,
    renderedBatches,
    now,
    events,
    latencyMs,
    paused,
    searchQuery,
    batchRatio,
    machineList,
    selectedMachine,
    fleetHealth,
    visibleMachineIds,
    applyTelemetryBatch,
    selectMachine,
    setConnectionStatus,
    setClientId,
    tickNow,
    togglePause,
    setLatency,
    setSearchQuery,
  };
});
