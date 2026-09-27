import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type { SystemMetrics } from "@flow-gatekeeper/contracts";
import { STALE_WINDOW_MULTIPLIER, useMetricsStore } from "./metrics.store.js";
import { useMonitoringStore } from "./monitoring.store.js";

/**
 * TQ-8：`metrics.store` 四態判定（empty／disconnected／stale／live）。時鐘一律走 monitoring store
 * 的 `now`（由 `tickNow()` 推進），收訊時刻由 `applyMetrics` 以 `Date.now()` 記錄——兩者皆以
 * fake timers 控制。
 */

const T0 = new Date("2026-09-27T00:00:00Z").getTime();
const WINDOW_MS = 60_000;
const THRESHOLD_MS = STALE_WINDOW_MULTIPLIER * WINDOW_MS;

function metrics(overrides: Partial<SystemMetrics> = {}): SystemMetrics {
  return {
    type: "system/metrics",
    windowMs: WINDOW_MS,
    // 刻意給一個與本地時鐘差很遠的伺服器時間：判定 MUST NOT 依賴 collectedAt。
    collectedAt: "2020-01-01T00:00:00Z",
    queue: { waiting: 0, active: 0, failed: 0 },
    wsConnections: 1,
    worker: null,
    ...overrides,
  };
}

/** 推進本地時鐘並讓 monitoring store 的 `now` 跟上（等同 App 的每秒 tick）。 */
function advanceTo(ms: number): void {
  vi.setSystemTime(ms);
  useMonitoringStore().tickNow();
}

describe("metrics store 四態判定（TQ-8）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    setActivePinia(createPinia());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("尚未收到快照 → empty，且 empty 優先於連線狀態（連線中、斷線都一樣），ageMs 為 null", () => {
    const monitoring = useMonitoringStore();
    const store = useMetricsStore();
    expect(store.status).toBe("empty");
    expect(store.ageMs).toBeNull();

    monitoring.setConnectionStatus("connected");
    advanceTo(T0 + THRESHOLD_MS * 10); // 時間再久也不會變成 stale
    expect(store.status).toBe("empty");
    monitoring.setConnectionStatus("reconnecting");
    expect(store.status).toBe("empty");
  });

  it("有快照但未連線 → disconnected，即使快照仍在新鮮期內（與 stale 可區分）", () => {
    const monitoring = useMonitoringStore();
    const store = useMetricsStore();
    monitoring.setConnectionStatus("connected");
    store.applyMetrics(metrics());
    expect(store.status).toBe("live");

    monitoring.setConnectionStatus("reconnecting");
    expect(store.status).toBe("disconnected");
    monitoring.setConnectionStatus("disconnected");
    expect(store.status).toBe("disconnected");

    // 斷線且早已過期：仍報 disconnected（排查方向是前端連線，不是後端停播）。
    advanceTo(T0 + THRESHOLD_MS * 3);
    expect(store.status).toBe("disconnected");
  });

  it("連線中：ageMs 恰等於 2×windowMs 仍是 live，多 1 ms 才是 stale", () => {
    const monitoring = useMonitoringStore();
    const store = useMetricsStore();
    monitoring.setConnectionStatus("connected");
    store.applyMetrics(metrics());

    advanceTo(T0 + THRESHOLD_MS);
    expect(store.ageMs).toBe(THRESHOLD_MS);
    expect(store.status).toBe("live");

    advanceTo(T0 + THRESHOLD_MS + 1);
    expect(store.status).toBe("stale");
  });

  it("門檻由 payload 的 windowMs 推導，不硬編 60 秒：windowMs=5000 時 10 秒內 live、超過即 stale", () => {
    const monitoring = useMonitoringStore();
    const store = useMetricsStore();
    monitoring.setConnectionStatus("connected");
    store.applyMetrics(metrics({ windowMs: 5_000 }));

    advanceTo(T0 + 10_000);
    expect(store.status).toBe("live");
    advanceTo(T0 + 10_001);
    expect(store.status).toBe("stale");

    // 收到新一則（仍以本地收訊時刻為準）→ 回到 live。
    store.applyMetrics(metrics({ windowMs: 5_000 }));
    expect(store.receivedAt).toBe(T0 + 10_001);
    expect(store.status).toBe("live");
  });

  it("ageMs 以本地收訊時刻計，now 略早於 receivedAt（每秒 tick 尚未追上）時夾在 0、仍為 live", () => {
    const monitoring = useMonitoringStore();
    const store = useMetricsStore();
    monitoring.setConnectionStatus("connected");
    monitoring.tickNow(); // now = T0
    vi.setSystemTime(T0 + 800); // 收訊時刻比 now 晚 800 ms
    store.applyMetrics(metrics());
    expect(store.receivedAt).toBe(T0 + 800);
    expect(store.ageMs).toBe(0);
    expect(store.status).toBe("live");
  });

  it("有快照卻缺收訊時刻（無法證明新鮮）→ stale，不謊報 live", () => {
    const monitoring = useMonitoringStore();
    const store = useMetricsStore();
    monitoring.setConnectionStatus("connected");
    store.applyMetrics(metrics());
    store.receivedAt = null;
    expect(store.ageMs).toBeNull();
    expect(store.status).toBe("stale");
  });
});
