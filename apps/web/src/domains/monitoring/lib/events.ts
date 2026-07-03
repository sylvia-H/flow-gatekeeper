import type { MachineState } from "@flow-gatekeeper/contracts";
import { machineLabel } from "./machine-labels.js";

/**
 * US3 前端衍生事件（data-model §1、research R5、FR-009/010/011/012）。
 * 事件僅在機台**狀態轉入 warning/critical** 時產生（天然去重），保留最近 50 筆。
 * 完全前端衍生，不新增 `packages/contracts` event/payload。
 */
export type Severity = "warning" | "critical"; // 只記門檻跨越/錯誤，不記回 healthy

export interface DerivedEvent {
  /**
   * 唯一鍵（`${ts}-${machineId}#${seq}`），供 v-for key。`seq` 為呼叫端傳入的單調序號：
   * 同一批次（共用一個 `receivedAt`）內同機台多次轉態時，`ts`+`machineId` 會相同，
   * 需 `seq` 才能保證 key 唯一（否則 EventStrip 的 v-for 重複 key）。
   */
  id: string;
  /** 產生時間（批次接收時刻 Date.now()）。 */
  ts: number;
  machineId: string;
  /** = 轉入的 nextState。 */
  severity: Severity;
  /** 可讀短訊息，如 "Press 02 entered CRITICAL"。 */
  message: string;
}

/**
 * 僅當 `nextState ∈ {warning, critical}` 且 `nextState !== prevState` 時回一筆，否則 null。
 * `prevState === undefined`（該台首次出現）且轉入 warning/critical → 視為轉入，記一筆。
 * 同態抖動（`X → X`）或轉回 healthy → null（＝去重，FR-010）。
 * `seq` 為呼叫端提供的單調序號，僅用於組成唯一 `id`（見 `DerivedEvent.id`）。
 */
export function deriveTransitionEvent(
  prevState: MachineState | undefined,
  nextState: MachineState,
  machineId: string,
  ts: number,
  seq: number,
): DerivedEvent | null {
  if (nextState !== "warning" && nextState !== "critical") return null;
  if (nextState === prevState) return null;
  return {
    id: `${ts}-${machineId}#${seq}`,
    ts,
    machineId,
    severity: nextState,
    message: `${machineLabel(machineId)} entered ${nextState.toUpperCase()}`,
  };
}

/**
 * 新事件 unshift 到頂端，超過 `max` 筆時裁掉最舊者（FR-011）。就地修改並回傳同一陣列。
 */
export function pushCapped(list: DerivedEvent[], event: DerivedEvent, max = 50): DerivedEvent[] {
  list.unshift(event);
  if (list.length > max) list.length = max;
  return list;
}
