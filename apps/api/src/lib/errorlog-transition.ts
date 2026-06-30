import type { MachineState, TelemetryPoint } from "@flow-gatekeeper/contracts";

/** errorlog 文件形狀（內部持久化型別，非通訊契約）。 */
export type ErrorLogDoc = {
  machineId: string;
  state: "warning" | "critical";
  message: string;
  telemetry: TelemetryPoint["telemetry"];
  timestamp: Date;
};

/**
 * 偵測「轉入 warning/critical」的狀態轉換——僅這些情形產生 errorlog（FR-011 去重）。
 *
 * 純函式（FR-016/SC-003 可單測）：給定本批 points 與「上一個 state」map，回傳要寫的
 * errorlog 與**更新後的** lastState（不可變：回傳新 Map，不修改傳入者）。
 * 連續維持同一異常狀態不重複記錄；轉入／維持 healthy 不記錄。
 */
export function detectErrorTransitions(
  points: readonly TelemetryPoint[],
  lastState: ReadonlyMap<string, MachineState>,
  now: Date = new Date(),
): { errors: ErrorLogDoc[]; nextState: Map<string, MachineState> } {
  const errors: ErrorLogDoc[] = [];
  const nextState = new Map(lastState);

  for (const point of points) {
    const prev = nextState.get(point.machineId);
    if (point.state !== prev && point.state !== "healthy") {
      errors.push({
        machineId: point.machineId,
        state: point.state,
        message: `${point.machineId} ${prev ?? "unknown"} -> ${point.state}`,
        telemetry: point.telemetry,
        timestamp: now,
      });
    }
    nextState.set(point.machineId, point.state);
  }

  return { errors, nextState };
}
