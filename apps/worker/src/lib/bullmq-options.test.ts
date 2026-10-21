import { describe, expect, it } from "vitest";
import {
  KEEPALIVE_INTERVAL_MS,
  LOCK_DURATION_MS,
  MAX_STALLED_COUNT,
  STALLED_INTERVAL_MS,
  WORKER_LOCK_OPTIONS,
} from "./bullmq-options.js";

/** web 端 job watchdog 門檻（`copilot.store.ts`；ADR-003 D4）。兩端各持一份數字，調整任一方都要回來看這條不變量。 */
const WEB_WATCHDOG_MS = 45_000;

describe("BullMQ lock／stalled 參數（ADR-003 D4）", () => {
  it("定案值：lock 15 s、stalled 5 s、maxStalled 2、keepalive 10 s", () => {
    expect(LOCK_DURATION_MS).toBe(15_000);
    expect(STALLED_INTERVAL_MS).toBe(5_000);
    expect(MAX_STALLED_COUNT).toBe(2);
    expect(KEEPALIVE_INTERVAL_MS).toBe(10_000);
  });

  it("最長無事件上界 K + L + 2S ≤ 35 s，且嚴格小於 45 s watchdog", () => {
    const bound = KEEPALIVE_INTERVAL_MS + LOCK_DURATION_MS + 2 * STALLED_INTERVAL_MS;
    expect(bound).toBeLessThanOrEqual(35_000);
    expect(bound).toBeLessThan(WEB_WATCHDOG_MS);
  });

  it("WORKER_LOCK_OPTIONS 只帶三個值、不設 lockRenewTime（維持 BullMQ 預設 L/2）", () => {
    expect(WORKER_LOCK_OPTIONS).toEqual({ lockDuration: 15_000, stalledInterval: 5_000, maxStalledCount: 2 });
    expect(WORKER_LOCK_OPTIONS).not.toHaveProperty("lockRenewTime");
  });
});
