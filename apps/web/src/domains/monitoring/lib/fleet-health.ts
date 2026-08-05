import type { MachineLive } from "../stores/monitoring.store.js";
import { isStale } from "./stale.js";

/**
 * US2 Fleet Health 四類聚合（data-model §2、research R4）。前端衍生，不新增契約。
 * stale 沿用既有 `isStale`（design-spec §8.3，>10s），與 US1 卡片 Stale 共用同一判斷。
 */
export interface FleetHealthSummary {
  healthy: number;
  warning: number;
  critical: number;
  /** 含 never-reported（無快照）與 isStale(>10s)。 */
  stale: number;
  /** = roster.length（固定名冊，穩定分母）。 */
  total: number;
}

/**
 * 逐一走 `roster`（**非** machines）確保 `total` 穩定＝名冊長度：
 * 無快照 → stale；`isStale` → stale；否則依快照 `state`。
 * 不變量：`healthy + warning + critical + stale === total`（SC-003）。
 */
export function fleetHealthOf(
  machines: Map<string, MachineLive>,
  now: number,
  roster: readonly string[],
): FleetHealthSummary {
  const summary: FleetHealthSummary = {
    healthy: 0,
    warning: 0,
    critical: 0,
    stale: 0,
    total: roster.length,
  };
  for (const id of roster) {
    const m = machines.get(id);
    if (!m || isStale(m.lastUpdated, now)) {
      summary.stale += 1;
      continue;
    }
    switch (m.state) {
      case "healthy":
        summary.healthy += 1;
        break;
      case "warning":
        summary.warning += 1;
        break;
      case "critical":
        summary.critical += 1;
        break;
    }
  }
  return summary;
}
