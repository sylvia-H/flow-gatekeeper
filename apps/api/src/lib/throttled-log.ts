import type { LogThrottle } from "@flow-gatekeeper/shared/logging";

/**
 * 節流記錄的共用樣板：同 key 在 `LogThrottle` 的窗內只放行一則；放行時把期間被壓掉的則數以
 * `suppressed` 欄位帶出（為 0 時不加欄位，維持既有日誌形狀）。回傳 `null` 表示本次應壓掉。
 *
 * 與等級無關（呼叫端自行決定 warn／error），Gateway、JobsService、MetricsService 共用，避免同一段
 * 「hit → suppressed>0 才附欄位」邏輯散在三處而語意漂移。
 */
export function throttledFields<T extends Record<string, unknown>>(
  throttle: LogThrottle,
  key: string,
  fields: T,
  now: number = Date.now(),
): (T & { suppressed?: number }) | null {
  const hit = throttle.hit(key, now);
  if (!hit) return null;
  return hit.suppressed > 0 ? { ...fields, suppressed: hit.suppressed } : fields;
}
