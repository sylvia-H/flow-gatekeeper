import { computed, type ComputedRef } from "vue";
import { useMonitoringStore } from "../../domains/monitoring/stores/monitoring.store.js";
import { useCopilotStore } from "../../domains/ai-copilot/stores/copilot.store.js";

export interface DiagnoseTrigger {
  /** 是否已取得 clientId（＝即時通道已派發連線識別，POST /diagnoses 才有 socketId 可帶）。 */
  hasClient: ComputedRef<boolean>;
  /** 目前選取機台可否送出診斷（有選台、有連線、該台非進行中）。 */
  canDiagnoseSelected: ComputedRef<boolean>;
  /** 對指定機台送出診斷；會一併選取該台，讓 drawer 顯示對應任務。 */
  diagnose: (machineId: string) => void;
  /** 對指定機台重試。 */
  retry: (machineId: string) => void;
}

/**
 * 診斷觸發的唯一入口：TopBar、卡片 icon、drawer 三處都走這裡。
 *
 * 之前三處各自讀 `store.clientId` 再呼叫 copilot store，連線把關與選台行為容易漂移；
 * 收斂後 clientId 只從 monitoring store（由 WS `system/connected` 寫入的單一來源）讀取，
 * 去重與 in-flight 判斷仍由 copilot store 的公開方法負責。
 */
export function useDiagnoseTrigger(): DiagnoseTrigger {
  const monitoring = useMonitoringStore();
  const copilot = useCopilotStore();

  const hasClient = computed(() => monitoring.clientId !== null);
  const canDiagnoseSelected = computed(() =>
    copilot.canDiagnose(monitoring.selectedMachineId, hasClient.value),
  );

  function diagnose(machineId: string): void {
    monitoring.selectMachine(machineId);
    void copilot.diagnose(machineId, monitoring.clientId);
  }

  function retry(machineId: string): void {
    void copilot.retry(machineId, monitoring.clientId);
  }

  return { hasClient, canDiagnoseSelected, diagnose, retry };
}
