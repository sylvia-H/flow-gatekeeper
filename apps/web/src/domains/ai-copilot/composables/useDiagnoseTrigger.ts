import { computed, type ComputedRef } from "vue";
import { UNAUTHORIZED_DIAGNOSE_MESSAGE } from "../lib/diagnose-api.js";
import { useMonitoringStore } from "../../monitoring/stores/monitoring.store.js";
import { useCopilotStore } from "../stores/copilot.store.js";

/** 連線尚未就緒（斷線、重連中或尚未完成訂閱）時的停用說明。 */
export const CONNECTION_NOT_READY_MESSAGE = "連線未就緒（斷線、重連或訂閱中），請待連線後再試";

export interface DiagnoseTrigger {
  /**
   * 即時通道是否「真的活著」且已授權（monitoring store `isLive`：收到本次連線的
   * `system/connected` 與 `machine/subscribed`、未斷線／心跳未逾時，且無 `authError`）。
   * 只有這時 POST /diagnoses 帶的 socketId 才對應現役、已授權的連線。
   */
  hasClient: ComputedRef<boolean>;
  /** 連線面不可診斷的原因（Diagnose／Retry 停用時的 tooltip）；可診斷時為 null。 */
  connectionBlockedReason: ComputedRef<string | null>;
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
 * 收斂後 clientId 只從 monitoring store（由 WS `system/connected` 寫入、斷線即清空的單一來源）
 * 讀取，可否送出看「連線活著」（`isLive`）而不是「曾拿到過 clientId」；
 * 去重與 in-flight 判斷仍由 copilot store 的公開方法負責。
 */
export function useDiagnoseTrigger(): DiagnoseTrigger {
  const monitoring = useMonitoringStore();
  const copilot = useCopilotStore();

  const options = { authError: () => monitoring.authError };
  // 連線把關條件只寫這一處；`hasClient` 由它推導，兩者不會各自改條件而漂移。
  const connectionBlockedReason = computed<string | null>(() => {
    if (monitoring.authError !== null) return UNAUTHORIZED_DIAGNOSE_MESSAGE;
    if (!monitoring.isLive) return CONNECTION_NOT_READY_MESSAGE;
    return null;
  });
  const hasClient = computed(() => connectionBlockedReason.value === null);
  const canDiagnoseSelected = computed(() =>
    copilot.canDiagnose(monitoring.selectedMachineId, hasClient.value),
  );

  /**
   * 送出用的 socketId 一律經同一道閘門：連線未活著或未授權時給 null，copilot store 即不送 POST。
   * 不能直接交 `monitoring.clientId`——它在 `system/connected` 後、`machine/subscribed` 前，
   * 以及 `system/unauthorized` 期間都仍有值，卡片 icon 這類不看 `canDiagnoseSelected` 的入口會照送而必得 409。
   */
  const socketId = (): string | null => (hasClient.value ? monitoring.clientId : null);

  function diagnose(machineId: string): void {
    // 仍先選台：被閘門擋下時 drawer 會顯示該台與停用原因。
    monitoring.selectMachine(machineId);
    void copilot.diagnose(machineId, socketId(), options);
  }

  function retry(machineId: string): void {
    void copilot.retry(machineId, socketId(), options);
  }

  return { hasClient, connectionBlockedReason, canDiagnoseSelected, diagnose, retry };
}
