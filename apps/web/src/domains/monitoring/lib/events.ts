import type { MachineState } from "@flow-gatekeeper/contracts";
import { machineLabel } from "./machine-labels.js";

/**
 * US3 前端衍生事件（data-model §1、research R5、FR-009/010/011/012）。
 * 事件在機台**狀態轉入 warning/critical** 時產生（天然去重）；013 起另記**回復正常**
 * （warning/critical → healthy，data-model §10）。保留最近 50 筆。
 * 完全前端衍生，不新增 `packages/contracts` event/payload。
 */
export type Severity = "warning" | "critical" | "recovered";

export interface DerivedEvent {
  /**
   * 唯一鍵（`${ts}-${machineId}#${seq}`），供 v-for key。`seq` 為呼叫端傳入的單調序號：
   * 同機台多次轉態若落在同一 `ts`（同 payload 時戳或同批次），`ts`+`machineId` 會相同，
   * 需 `seq` 才能保證 key 唯一（否則 EventStrip 的 v-for 重複 key）。
   * 合併（`mergeEvent`）時沿用被合併那筆的 id，列表項只移動、不重掛載。
   */
  id: string;
  /**
   * 事件對應遙測的來源時間（payload timestamp 之 epoch ms）；保序不受 pause/resume 批次沖出影響。
   * 合併後為該組最近一次發生的時間。
   */
  ts: number;
  machineId: string;
  /** 轉入 warning/critical 時 = nextState；轉回 healthy 時為 `"recovered"`。 */
  severity: Severity;
  /** 繁中短訊息，如「壓製機 02 進入嚴重」「烤爐 04 回復正常」。 */
  message: string;
  /** 合併次數（≥ 1）：同機台同嚴重度在合併視窗內重複發生時累加（data-model §10）。 */
  count: number;
}

const SEVERITY_TEXT: Readonly<Record<Severity, string>> = {
  warning: "進入警告",
  critical: "進入嚴重",
  recovered: "回復正常",
};

function isAnomalous(state: MachineState | undefined): state is "warning" | "critical" {
  return state === "warning" || state === "critical";
}

/**
 * 狀態轉移 → 事件（同態抖動一律不記＝去重，FR-010）：
 * - `nextState ∈ {warning, critical}` 且 `nextState !== prevState` → 記一筆該嚴重度；
 *   `prevState === undefined`（該台首次出現）視為轉入。
 * - `prevState ∈ {warning, critical}` 且 `nextState === "healthy"` → 記一筆 `"recovered"`。
 * - 其餘（同態、`undefined → healthy`、`healthy → healthy`）→ null。
 * `seq` 為呼叫端提供的單調序號，僅用於組成唯一 `id`（見 `DerivedEvent.id`）。
 */
export function deriveTransitionEvent(
  prevState: MachineState | undefined,
  nextState: MachineState,
  machineId: string,
  ts: number,
  seq: number,
): DerivedEvent | null {
  if (nextState === prevState) return null;
  let severity: Severity;
  if (isAnomalous(nextState)) severity = nextState;
  else if (nextState === "healthy" && isAnomalous(prevState)) severity = "recovered";
  else return null;
  return {
    id: `${ts}-${machineId}#${seq}`,
    ts,
    machineId,
    severity,
    message: `${machineLabel(machineId)} ${SEVERITY_TEXT[severity]}`,
    count: 1,
  };
}

/**
 * 新事件 unshift 到頂端，超過 `max` 筆時裁掉最舊者（FR-011）。就地修改並回傳同一陣列。
 * 013 起事件列改走 `mergeEvent`（store 已於 T049 改接，不再呼叫本函式）；此函式保留匯出與單測。
 */
export function pushCapped(list: DerivedEvent[], event: DerivedEvent, max = 50): DerivedEvent[] {
  list.unshift(event);
  if (list.length > max) list.length = max;
  return list;
}

/**
 * 事件合併（data-model §10、FR-012）。就地修改並回傳同一陣列（比照 `pushCapped`）：
 * - 在清單中找**同機台、同嚴重度的最近一筆**（自頂端往下第一筆相符者，不限頂端）；
 * - 若 `|event.ts - 該筆.ts| ≤ windowMs`（閉區間，含 10 000 ms 邊界）→ 該筆 `count + 1`、`ts` 更新為最近
 *   發生時間並移到頂端（以新物件替換，id 沿用）；
 * - 否則新事件（`count` 視為 1）放頂端；超過 `max` 筆裁掉最舊。
 * 不同嚴重度的事件（含 `recovered`）不阻斷合併：warning、recovered、warning 交錯時兩筆 warning 仍合併。
 * 取絕對值：亂序抵達（event 比既有那筆早）時差值為負，若只比 `≤ windowMs` 會無限期合併；
 * 比既有事件早超過視窗的亂序事件因此另立一筆。
 * `ts` 取 `max(該筆.ts, event.ts)`：同機台事件正常情況下時間遞增，取 max 只為防亂序時把時間倒退。
 */
export function mergeEvent(
  list: DerivedEvent[],
  event: DerivedEvent,
  windowMs = 10_000,
  max = 50,
): DerivedEvent[] {
  const index = list.findIndex(
    (item) => item.machineId === event.machineId && item.severity === event.severity,
  );
  const match = index >= 0 ? list[index] : undefined;
  if (match !== undefined && Math.abs(event.ts - match.ts) <= windowMs) {
    list.splice(index, 1);
    list.unshift({ ...match, count: match.count + 1, ts: Math.max(match.ts, event.ts) });
    return list;
  }
  list.unshift({ ...event, count: 1 });
  if (list.length > max) list.length = max;
  return list;
}
