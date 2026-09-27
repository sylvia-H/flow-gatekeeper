import { defineStore } from "pinia";
import { computed, markRaw, ref, shallowRef, triggerRef } from "vue";
import type { MachineState, TelemetryPoint } from "@flow-gatekeeper/contracts";
import { fleetHealthOf, type FleetHealthSummary } from "../lib/fleet-health.js";
import { KNOWN_MACHINE_IDS } from "../lib/machine-labels.js";
import { deriveTransitionEvent, pushCapped, type DerivedEvent } from "../lib/events.js";
import { filterMachineIds } from "../lib/machine-search.js";
import { staleClock } from "../lib/stale.js";

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
  /**
   * 每台機台最新快照；key 為 machineId，只保留最新值（覆寫）。
   * 用 shallowRef + markRaw 而非深層 ref：批次內逐筆 `set` 不各自觸發依賴，改在迴圈後
   * `triggerRef` 一次，讓「一批＝一次 reactive 提交」在語意上成立，而不只靠 scheduler 合併。
   * 快照物件整筆替換、從不就地修改，所以不需要深層追蹤。
   */
  const machines = shallowRef<Map<string, MachineLive>>(markRaw(new Map()));
  /** 目前選取機台（至多一台）；供 selected 視覺與 005 診斷觸發。 */
  const selectedMachineId = ref<string | null>(null);
  /** 即時通道三態，初始 disconnected。 */
  const connectionStatus = ref<ConnectionStatus>("disconnected");
  /** `system/connected` 派發的連線識別；保存供 005（POST /diagnoses 的 socketId）。 */
  const clientId = ref<string | null>(null);
  /**
   * 累積抵達前端的 telemetry 筆數（背壓分子）。**含**溢位合併丟棄與格式不符剔除的筆數——
   * 它回答的是「網路上收到多少」，若只算套用成功的筆數，背景分頁或 Pause 後比值會偏低且看不出原因。
   */
  const receivedMessages = ref(0);
  /** buffer 溢位時被合併丟棄的筆數（每台保留最新＋轉換點，其餘捨棄）。 */
  const droppedMessages = ref(0);
  /** 未通過入口型別守衛而被剔除的筆數。 */
  const invalidMessages = ref(0);
  /** 累積 rAF 批次提交次數（背壓分母）。 */
  const renderedBatches = ref(0);
  /**
   * 低頻更新的當前時間戳（每秒一次）。恆照走——metrics 面板的新鮮度與診斷 watchdog 依賴它，
   * 不能被 Pause 凍結；卡片／Fleet Health 的 stale 改讀下方 `staleNow`。
   */
  const now = ref(Date.now());
  /** US3 前端衍生事件（最近 50 筆，最新在頂端）；於 applyTelemetryBatch 批次點衍生。 */
  const events = ref<DerivedEvent[]>([]);
  /** US3 事件唯一鍵用單調序號（非 reactive）：保 v-for key 在同批次同機台多筆時仍唯一。 */
  let eventSeq = 0;
  /** US4 即時通道 ping→pong RTT（ms）；null＝尚無量測（首個 pong 前 / 斷線後重置）。 */
  const latencyMs = ref<number | null>(null);
  /** US4 pause 開關；true 時 composable pump 跳過 flush、續存 buffer（畫面凍結）。 */
  const paused = ref(false);
  /** 按下 Pause 的時刻；未暫停為 null。 */
  const pausedAt = ref<number | null>(null);
  /** US4 search 查詢字串；空＝全部。sidebar 清單與主區卡片共用 `visibleMachineIds`。 */
  const searchQuery = ref("");

  // ── Getters ────────────────────────────────────────────────────────
  /** selectedMachineId 對應的快照，供 TopBar／005 使用。 */
  const selectedMachine = computed<MachineLive | null>(() =>
    selectedMachineId.value !== null
      ? (machines.value.get(selectedMachineId.value) ?? null)
      : null,
  );

  /**
   * stale 判斷用時鐘：Pause 且連線中凍結在 `pausedAt`，否則等於 `now`（取捨見 `staleClock`）。
   * 卡片 Stale badge、相對時間與 Fleet Health 共用這一個值，確保三處一致。
   */
  const staleNow = computed(() =>
    staleClock(now.value, pausedAt.value, connectionStatus.value === "connected"),
  );

  /**
   * US2 Fleet Health 四類聚合。委派純函式 `fleetHealthOf`，走固定名冊 KNOWN_MACHINE_IDS
   * （total 穩定＝5）。依賴 `machines` 與 `staleNow`（每秒 tick 重算 stale），屬低頻 reactive，
   * 不逐筆 telemetry 觸發（憲章 IV）。
   */
  const fleetHealth = computed<FleetHealthSummary>(() =>
    fleetHealthOf(machines.value, staleNow.value, KNOWN_MACHINE_IDS),
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
    const map = machines.value;
    for (const point of batch) {
      // US3：覆寫快照**前**讀 prevState，於狀態轉入 warning/critical 時衍生一筆事件（去重、上限 50）。
      // 事件時間用 payload 自身 timestamp（非批次 receivedAt）：pause 後 resume 一次沖出整段
      // buffer 時，各筆仍保留真實發生時序，不會全被壓成同一個 resume 時刻（review 006）。
      // timestamp 解析失敗才退回 receivedAt。id 唯一性另由單調 eventSeq 保證（見 events.ts）。
      const prevState = map.get(point.machineId)?.state;
      const parsedTs = Date.parse(point.timestamp);
      const eventTs = Number.isNaN(parsedTs) ? receivedAt : parsedTs;
      const event = deriveTransitionEvent(prevState, point.state, point.machineId, eventTs, eventSeq);
      if (event) {
        eventSeq += 1;
        pushCapped(events.value, event, EVENT_CAP);
      }
      map.set(point.machineId, markRaw(project(point, receivedAt)));
    }
    if (batch.length > 0) triggerRef(machines);
    receivedMessages.value += batch.length;
    renderedBatches.value += 1;
  }

  /**
   * composable 回報在進 store 前就被捨棄的筆數。兩者都計入 `receivedMessages`（它們確實抵達了），
   * 但不計入 `renderedBatches`（沒有觸發任何提交）。
   */
  function recordDropped(count: number, reason: "overflow" | "invalid"): void {
    if (count <= 0) return;
    if (reason === "overflow") droppedMessages.value += count;
    else invalidMessages.value += count;
    receivedMessages.value += count;
  }

  function selectMachine(machineId: string): void {
    selectedMachineId.value = machineId;
  }

  function setConnectionStatus(status: ConnectionStatus): void {
    // 離開 connected（斷線/重連）即清除延遲量測，避免重連後 chip 沿用上一段連線的過期 RTT；
    // 重連後需等下一個 pong 才重新有值（首個 pong 前顯示 —）。
    if (status !== "connected") latencyMs.value = null;
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
    pausedAt.value = paused.value ? Date.now() : null;
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
    droppedMessages,
    invalidMessages,
    renderedBatches,
    now,
    staleNow,
    events,
    latencyMs,
    paused,
    pausedAt,
    searchQuery,
    selectedMachine,
    fleetHealth,
    visibleMachineIds,
    applyTelemetryBatch,
    recordDropped,
    selectMachine,
    setConnectionStatus,
    setClientId,
    tickNow,
    togglePause,
    setLatency,
    setSearchQuery,
  };
});
