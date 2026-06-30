import type { TelemetryPoint } from "@flow-gatekeeper/contracts";

/**
 * 依訂閱集合過濾遙測：只回傳訂閱機台的點。
 *
 * 抽成純函式以利單元測試（FR-016/SC-001），不需啟動 ws/Mongo。
 * 空訂閱集合回傳空陣列（FR-004：未訂閱者不收任何遙測）。
 */
export function filterPointsForSubscription(
  points: readonly TelemetryPoint[],
  machineIds: ReadonlySet<string>,
): TelemetryPoint[] {
  if (machineIds.size === 0) return [];
  return points.filter((point) => machineIds.has(point.machineId));
}
