import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { effectScope, watchEffect } from "vue";
import type { MachineState, TelemetryPoint } from "@flow-gatekeeper/contracts";
import { AUTH_ERROR_MESSAGE, useMonitoringStore } from "./monitoring.store.js";

function point(machineId: string, state: MachineState): TelemetryPoint {
  return {
    type: "machine/data",
    machineId,
    timestamp: new Date().toISOString(),
    telemetry: { temperature: 60, vibration: 1.2, throughput: 100, errorRate: 0.01 },
    state,
  };
}

function makeBatch(n: number, machinePrefix = "m"): TelemetryPoint[] {
  return Array.from({ length: n }, (_, i) => ({
    type: "machine/data" as const,
    machineId: `${machinePrefix}-${i % 5}`,
    timestamp: new Date().toISOString(),
    telemetry: { temperature: 60, vibration: 1.2, throughput: 100, errorRate: 0.01 },
    state: "healthy" as const,
  }));
}

describe("monitoring store — 背壓批次關係（FR-010 / SC-002）", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("applyTelemetryBatch 呼叫 3 次、每次 N 筆 → received=3N、rendered=3", () => {
    const store = useMonitoringStore();
    const N = 7;

    store.applyTelemetryBatch(makeBatch(N));
    store.applyTelemetryBatch(makeBatch(N));
    store.applyTelemetryBatch(makeBatch(N));

    expect(store.receivedMessages).toBe(3 * N);
    expect(store.renderedBatches).toBe(3);
  });

  it("recordDropped：溢位與格式不符分開計數，兩者都計入 received、不計入 rendered", () => {
    const store = useMonitoringStore();
    store.applyTelemetryBatch(makeBatch(5));
    store.recordDropped({ overflow: 7, invalid: 2 });
    store.recordDropped({ overflow: 0, invalid: 0 }); // 0 筆不動
    expect(store.droppedMessages).toBe(7);
    expect(store.invalidMessages).toBe(2);
    expect(store.receivedMessages).toBe(14);
    expect(store.renderedBatches).toBe(1);
  });

  it("recordDropped：一次呼叫＝一次提交（每個計數 ref 至多觸發一次依賴），0 筆不觸發", () => {
    const store = useMonitoringStore();
    let runs = 0;
    const scope = effectScope();
    scope.run(() => {
      watchEffect(
        () => {
          void store.droppedMessages;
          void store.invalidMessages;
          void store.receivedMessages;
          runs += 1;
        },
        { flush: "sync" },
      );
    });
    expect(runs).toBe(1);
    store.recordDropped({ overflow: 0, invalid: 0 });
    expect(runs).toBe(1);
    store.recordDropped({ overflow: 3, invalid: 0 });
    // droppedMessages + receivedMessages 各寫一次（sync watcher 逐次觸發）；invalid 未動
    expect(runs).toBe(3);
    expect(store.invalidMessages).toBe(0);
    scope.stop();
  });

  it("一批多筆只觸發一次 machines 依賴（shallowRef + triggerRef）", () => {
    const store = useMonitoringStore();
    let runs = 0;
    const scope = effectScope();
    scope.run(() => {
      watchEffect(
        () => {
          void store.machines.get("m-0");
          runs += 1;
        },
        { flush: "sync" },
      );
    });
    expect(runs).toBe(1); // 初次執行
    store.applyTelemetryBatch(makeBatch(10)); // 10 筆、5 台
    expect(runs).toBe(2);
    store.applyTelemetryBatch([]); // 空批次不觸發
    expect(runs).toBe(2);
    scope.stop();
  });

  it("每台只保留最新快照", () => {
    const store = useMonitoringStore();
    store.applyTelemetryBatch([
      {
        type: "machine/data",
        machineId: "press-02",
        timestamp: new Date().toISOString(),
        telemetry: { temperature: 90, vibration: 3, throughput: 10, errorRate: 0.5 },
        state: "critical",
      },
      {
        type: "machine/data",
        machineId: "mixer-01",
        timestamp: new Date().toISOString(),
        telemetry: { temperature: 55, vibration: 1, throughput: 120, errorRate: 0 },
        state: "healthy",
      },
      // 覆寫 press-02
      {
        type: "machine/data",
        machineId: "press-02",
        timestamp: new Date().toISOString(),
        telemetry: { temperature: 70, vibration: 2, throughput: 80, errorRate: 0.1 },
        state: "warning",
      },
    ]);

    expect(store.machines.size).toBe(2);
    expect(store.machines.get("press-02")?.state).toBe("warning");
    expect([...store.machines.keys()].sort()).toEqual(["mixer-01", "press-02"]);
  });

  it("selectMachine 設定 selectedMachine getter", () => {
    const store = useMonitoringStore();
    store.applyTelemetryBatch(makeBatch(1, "sorter"));
    store.selectMachine("sorter-0");
    expect(store.selectedMachineId).toBe("sorter-0");
    expect(store.selectedMachine?.machineId).toBe("sorter-0");
  });
});

describe("monitoring store — fleetHealth getter（FR-006/007/008、SC-003）", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("冷啟動（無快照）→ 全數計入 stale，四類和 == 5", () => {
    const store = useMonitoringStore();
    const fh = store.fleetHealth;
    expect(fh).toEqual({ healthy: 0, warning: 0, critical: 0, stale: 5, total: 5 });
  });

  it("依快照 state 計數，未回報者為 stale；四類和恆 == 5", () => {
    const store = useMonitoringStore();
    store.applyTelemetryBatch([
      point("mixer-01", "healthy"),
      point("press-02", "critical"),
      point("pack-03", "warning"),
    ]);
    const fh = store.fleetHealth;
    expect(fh.healthy).toBe(1);
    expect(fh.warning).toBe(1);
    expect(fh.critical).toBe(1);
    expect(fh.stale).toBe(2); // oven-04 / sorter-05 未回報
    expect(fh.healthy + fh.warning + fh.critical + fh.stale).toBe(5);
  });

  it("計數與 machines 快照狀態一致（轉態後即時反映）", () => {
    const store = useMonitoringStore();
    store.applyTelemetryBatch([point("mixer-01", "healthy")]);
    expect(store.fleetHealth.healthy).toBe(1);
    store.applyTelemetryBatch([point("mixer-01", "critical")]);
    expect(store.fleetHealth.healthy).toBe(0);
    expect(store.fleetHealth.critical).toBe(1);
    expect(store.machines.get("mixer-01")?.state).toBe("critical");
  });
});

describe("monitoring store — events 衍生（FR-009/010/011）", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("轉入 warning 記一筆；同態抖動不重複；再轉 critical 記第二筆（最新在頂）", () => {
    const store = useMonitoringStore();
    store.applyTelemetryBatch([point("press-02", "warning")]); // undefined→warning
    expect(store.events.length).toBe(1);
    expect(store.events[0]?.severity).toBe("warning");
    store.applyTelemetryBatch([point("press-02", "warning")]); // warning→warning：不記
    expect(store.events.length).toBe(1);
    store.applyTelemetryBatch([point("press-02", "critical")]); // warning→critical：記
    expect(store.events.length).toBe(2);
    expect(store.events[0]?.severity).toBe("critical");
  });

  it("轉回 healthy 不記恢復事件", () => {
    const store = useMonitoringStore();
    store.applyTelemetryBatch([point("press-02", "critical")]);
    store.applyTelemetryBatch([point("press-02", "healthy")]);
    expect(store.events.length).toBe(1);
  });

  it("超過 50 上限：淘汰最舊、長度恆 <= 50", () => {
    const store = useMonitoringStore();
    for (let i = 0; i < 60; i += 1) {
      store.applyTelemetryBatch([point("press-02", i % 2 === 0 ? "warning" : "critical")]);
    }
    expect(store.events.length).toBe(50);
  });

  it("同一批次同機台多次轉態：事件 id 唯一（v-for key 不碰撞）", () => {
    const store = useMonitoringStore();
    // 單批 = 同一 receivedAt：press-02 warning→critical→warning 產生 3 筆，id 須各異。
    store.applyTelemetryBatch([
      point("press-02", "warning"),
      point("press-02", "critical"),
      point("press-02", "warning"),
    ]);
    expect(store.events.length).toBe(3);
    expect(new Set(store.events.map((e) => e.id)).size).toBe(3);
  });
});

describe("monitoring store — latency 重置（US4 重連）", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("離開 connected 即清除 latencyMs，避免重連沿用過期 RTT", () => {
    const store = useMonitoringStore();
    store.setConnectionStatus("connected");
    store.setLatency(42);
    expect(store.latencyMs).toBe(42);
    store.setConnectionStatus("reconnecting"); // 斷線/重連
    expect(store.latencyMs).toBeNull();
    store.setConnectionStatus("connected"); // 重連上但尚無 pong
    expect(store.latencyMs).toBeNull();
  });
});

describe("monitoring store — Pause 期間凍結 stale 時鐘", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-27T00:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("暫停 60 秒後 Fleet Health 不把有資料的機台算 stale；恢復後照常判斷", () => {
    const store = useMonitoringStore();
    store.setConnectionStatus("connected");
    store.applyTelemetryBatch([point("mixer-01", "healthy")]);
    store.togglePause();
    expect(store.pausedAt).not.toBeNull();

    vi.advanceTimersByTime(60_000);
    store.tickNow();
    expect(store.now - store.staleNow).toBe(60_000); // now 照走、staleNow 凍結
    expect(store.fleetHealth.healthy).toBe(1);

    store.togglePause(); // resume：凍結解除（實際畫面會在下一幀收到 buffer 沖出的新資料）
    expect(store.pausedAt).toBeNull();
    expect(store.staleNow).toBe(store.now);
    expect(store.fleetHealth.healthy).toBe(0);
  });

  it("暫停中斷線 → 不凍結，照常標 stale", () => {
    const store = useMonitoringStore();
    store.setConnectionStatus("connected");
    store.applyTelemetryBatch([point("mixer-01", "healthy")]);
    store.togglePause();
    vi.advanceTimersByTime(30_000);
    store.tickNow();
    store.setConnectionStatus("reconnecting");
    expect(store.fleetHealth.healthy).toBe(0);
  });
});

describe("monitoring store — 連線真的活著（WEB-3）與授權錯誤（AR-S7）", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("isLive：open→system/connected→machine/subscribed 三者齊備才為 true", () => {
    const store = useMonitoringStore();
    expect(store.isLive).toBe(false);
    store.setConnectionStatus("connected");
    expect(store.isLive).toBe(false);
    store.setClientId("c1");
    expect(store.isLive).toBe(false); // connected 後、subscribed 前（約 1 RTT 空窗）
    expect(store.everConnected).toBe(true);
    store.setAuthorized(true);
    expect(store.isLive).toBe(true);
  });

  it("收到 system/unauthorized → isLive=false 並記錄 authError", () => {
    const store = useMonitoringStore();
    store.setConnectionStatus("connected");
    store.setClientId("c1");
    store.setAuthorized(false);
    expect(store.isLive).toBe(false);
    expect(store.subscribed).toBe(false);
    expect(store.authError).toBe(AUTH_ERROR_MESSAGE);
  });

  it.each(["reconnecting", "disconnected"] as const)(
    "離開 connected（%s）即清空 clientId、isLive=false；everConnected 保留供橫幅判斷",
    (status) => {
      const store = useMonitoringStore();
      store.setConnectionStatus("connected");
      store.setClientId("c1");
      store.setAuthorized(true);
      store.setConnectionStatus(status);
      expect(store.clientId).toBeNull();
      expect(store.subscribed).toBe(false);
      expect(store.isLive).toBe(false);
      expect(store.everConnected).toBe(true);
    },
  );

  it("重連後收到新的 system/connected → isLive 恢復且 clientId 為新值", () => {
    const store = useMonitoringStore();
    store.setConnectionStatus("connected");
    store.setClientId("c1");
    store.setAuthorized(true);
    store.setConnectionStatus("reconnecting");
    store.setConnectionStatus("connected");
    expect(store.isLive).toBe(false); // 新 socket open 但尚未派發 clientId
    store.setClientId("c2");
    expect(store.isLive).toBe(false); // 新連線尚未重新訂閱
    store.setAuthorized(true);
    expect(store.isLive).toBe(true);
    expect(store.clientId).toBe("c2");
  });

  it("setAuthorized(false) 記錄可顯示的授權錯誤；setAuthorized(true) 清除", () => {
    const store = useMonitoringStore();
    expect(store.authError).toBeNull();
    store.setAuthorized(false);
    expect(store.authError).toBe(AUTH_ERROR_MESSAGE);
    store.setAuthorized(true);
    expect(store.authError).toBeNull();
  });
});
