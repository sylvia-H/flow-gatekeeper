import type { MachineState } from "@flow-gatekeeper/contracts";

/**
 * 異常標記（data-model §5–§6、FR-005/006、SC-009）。每台一份，記住「這次異常」直到回復後 30 秒。
 *
 * 時間一律用客端收到批次的 `receivedAt`（不用 payload 時戳）；可見性以 store 的凍結時鐘 `staleNow`
 * 判定——Pause 時 `staleNow` 停住，所以不倒數；恢復後回到實際時間，依實際經過時間判定
 * （Pause 期間計入，已滿 30 秒者立即消失），不另記 Pause 偏移。
 *
 * 全部為純函式：不就地修改輸入，有變化時回新物件、無變化時回原物件（呼叫端可用 `!==` 判斷是否需觸發）。
 */
export type LatchLevel = "warning" | "critical";

export interface AnomalyLatch {
  machineId: string;
  /** 目前這次異常的等級。 */
  level: LatchLevel;
  /** 進入這次異常的時間（receivedAt）。 */
  enteredAt: number;
  /** 回到 healthy 的時間（receivedAt）；仍異常時為 null。 */
  recoveredAt: number | null;
  /** 操作者確認後為 "user"（劃線）。 */
  clearedBy: "user" | null;
}

export interface AnomalySummaryItem {
  machineId: string;
  label: string;
  level: LatchLevel;
  /** 目前仍處於異常（`recoveredAt === null`）。 */
  active: boolean;
  /** 已由操作者確認（劃線）。 */
  struck: boolean;
  /** 相對時間錨點：仍異常為 `enteredAt`（「進入 N 秒前」），已回復為 `recoveredAt`（「已回復 N 秒前」）。 */
  since: number;
}

/** 回復後仍可見的時間（ms）。 */
export const LATCH_HOLD_MS = 30_000;

/**
 * 狀態轉移 → 新 latch（data-model §5）：
 * - 無 latch 或 latch 已回復時進入 warning／critical：以新異常重建（`level` = 新狀態、`enteredAt = receivedAt`、
 *   `recoveredAt = null`、`clearedBy = null`）。最新異常為準：critical 回復後 30 秒內再進 warning → `level = "warning"`。
 * - 仍在異常中：`warning → critical` 升級並重置 `clearedBy = null`（已劃線者恢復未確認）；
 *   `critical → warning` 維持 critical、`clearedBy` 不變；同等級不變。
 * - 異常中轉 healthy：`recoveredAt = receivedAt`。
 * - 其餘（healthy→healthy、無 latch 且 next 為 healthy、已回復者再收到 healthy）：無變化。
 *
 * 回傳：新 latch；無變化時回原 latch（無 latch 時回 null）。
 *
 * 判定**只看 `latch` 與 `next`**，`prev` 保留在簽章中與 store 既有的 prev→next 判斷處對齊、但不參與判定：
 * 正常情況兩者一致；若 store 修剪過期 latch 或 latch 與 `prev` 不一致，以 latch 為準仍能得到正確結果。
 * `machineId` 為**無 latch 時**建立新 latch 用
 * （data-model 的四參數簽章未涵蓋這個來源，故補在最後一個參數）。
 */
export function applyTransition(
  latch: AnomalyLatch | null | undefined,
  prev: MachineState | undefined,
  next: MachineState,
  receivedAt: number,
  machineId: string,
): AnomalyLatch | null {
  const current = latch ?? null;
  if (next === "healthy") {
    if (current === null || current.recoveredAt !== null) return current;
    return { ...current, recoveredAt: receivedAt };
  }
  // next ∈ {warning, critical}
  if (current === null || current.recoveredAt !== null) {
    return {
      machineId: current?.machineId ?? machineId,
      level: next,
      enteredAt: receivedAt,
      recoveredAt: null,
      clearedBy: null,
    };
  }
  // 仍在異常中
  if (current.level === next) return current;
  if (next === "critical") return { ...current, level: "critical", clearedBy: null };
  return current; // critical → warning：維持 critical
}

/** 可見：仍異常，或回復未滿 `holdMs`（以凍結時鐘 `staleNow` 計）。 */
export function isLatchVisible(latch: AnomalyLatch, staleNow: number, holdMs = LATCH_HOLD_MS): boolean {
  return latch.recoveredAt === null || staleNow - latch.recoveredAt < holdMs;
}

/** 已由操作者確認（劃線）。 */
export function isLatchStruck(latch: AnomalyLatch): boolean {
  return latch.clearedBy === "user";
}

/** 操作者確認：回 `clearedBy = "user"` 的新物件（已確認者回原物件）。可見期不變，期滿與未劃線者一同消失。 */
export function clearLatch(latch: AnomalyLatch): AnomalyLatch {
  return latch.clearedBy === "user" ? latch : { ...latch, clearedBy: "user" };
}

/**
 * 異常摘要列（data-model §6）：過濾可見者，`active` 優先、再依 `enteredAt` 降冪（同時間以 machineId 升冪保穩定）。
 * 全部正常時回空陣列。`labels` 直接傳 `machineLabel`。
 */
export function summarize(
  latches: ReadonlyMap<string, AnomalyLatch>,
  staleNow: number,
  labels: (machineId: string) => string,
): AnomalySummaryItem[] {
  const visible = [...latches.values()].filter((latch) => isLatchVisible(latch, staleNow));
  visible.sort((a, b) => {
    const aActive = a.recoveredAt === null;
    const bActive = b.recoveredAt === null;
    if (aActive !== bActive) return aActive ? -1 : 1;
    if (a.enteredAt !== b.enteredAt) return b.enteredAt - a.enteredAt;
    return a.machineId < b.machineId ? -1 : a.machineId > b.machineId ? 1 : 0;
  });
  return visible.map((latch) => ({
    machineId: latch.machineId,
    label: labels(latch.machineId),
    level: latch.level,
    active: latch.recoveredAt === null,
    struck: isLatchStruck(latch),
    since: latch.recoveredAt ?? latch.enteredAt,
  }));
}
