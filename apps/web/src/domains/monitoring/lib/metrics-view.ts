import type { SystemMetrics } from "@flow-gatekeeper/contracts";

export interface PersistView {
  /** 遺失（未能落地）的遙測紀錄數，api 啟動以來累計。 */
  dropped: string;
  /** insertMany 失敗批數，api 啟動以來累計。 */
  failed: string;
}

const ABSENT = "—";

/**
 * `system/metrics.persist` → 面板顯示字串。`persist` 在契約中為 optional（舊版 api 不帶），
 * 缺席時顯示「—」而不是 0：0 代表「確認沒有遺失」，缺席代表「不知道」，兩者語意不同。
 */
export function persistView(snapshot: SystemMetrics | null): PersistView {
  const persist = snapshot?.persist;
  if (!persist) return { dropped: ABSENT, failed: ABSENT };
  return {
    dropped: persist.dropped.toLocaleString("en-US"),
    failed: persist.failed.toLocaleString("en-US"),
  };
}
