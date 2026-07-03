import { defineStore } from "pinia";
import { computed, ref } from "vue";
import type { MachineState, TelemetryPoint } from "@flow-gatekeeper/contracts";
import { fleetHealthOf, type FleetHealthSummary } from "../lib/fleet-health.js";
import { KNOWN_MACHINE_IDS } from "../lib/machine-labels.js";

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

  // ── Actions ────────────────────────────────────────────────────────
  /**
   * 每次呼叫 = 一個 rAF 幀 = 一次批次（不論 batch 幾筆）：
   * 逐筆覆寫該台最新快照，received += batch.length，rendered += 1。
   */
  function applyTelemetryBatch(batch: TelemetryPoint[]): void {
    const receivedAt = Date.now();
    for (const point of batch) {
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

  return {
    machines,
    selectedMachineId,
    connectionStatus,
    clientId,
    receivedMessages,
    renderedBatches,
    now,
    batchRatio,
    machineList,
    selectedMachine,
    fleetHealth,
    applyTelemetryBatch,
    selectMachine,
    setConnectionStatus,
    setClientId,
    tickNow,
  };
});
