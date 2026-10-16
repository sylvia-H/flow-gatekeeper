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

  it("轉回 healthy 記一筆回復事件（013 data-model §10）", () => {
    const store = useMonitoringStore();
    store.applyTelemetryBatch([point("press-02", "critical")]);
    store.applyTelemetryBatch([point("press-02", "healthy")]);
    expect(store.events.length).toBe(2);
    expect(store.events[0]?.severity).toBe("recovered");
    store.applyTelemetryBatch([point("press-02", "healthy")]); // healthy→healthy：不記
    expect(store.events.length).toBe(2);
  });

  it("超過 50 上限：淘汰最舊、長度恆 <= 50（60 台各轉入一次，不觸發合併）", () => {
    const store = useMonitoringStore();
    // 013 起同機台同嚴重度 10 秒內會合併，故改用 60 台不同機台各記一筆，量的是上限本身。
    for (let i = 0; i < 60; i += 1) {
      store.applyTelemetryBatch([point(`m-${i}`, "warning")]);
    }
    expect(store.events.length).toBe(50);
    expect(store.events[0]?.machineId).toBe("m-59"); // 最新在頂
    expect(store.events[49]?.machineId).toBe("m-10"); // m-0…m-9 被淘汰
  });

  it("同一批次同機台多次轉態（不同嚴重度）：事件 id 唯一（v-for key 不碰撞）", () => {
    const store = useMonitoringStore();
    // 單批、同一 payload 時戳：press-02 warning→critical→healthy 產生三種嚴重度各一筆（不合併），
    // ts 與 machineId 全同，id 唯一只能靠單調序號。
    const ts = new Date().toISOString();
    store.applyTelemetryBatch([
      { ...point("press-02", "warning"), timestamp: ts },
      { ...point("press-02", "critical"), timestamp: ts },
      { ...point("press-02", "healthy"), timestamp: ts },
    ]);
    expect(store.events.map((e) => e.severity)).toEqual(["recovered", "critical", "warning"]);
    expect(new Set(store.events.map((e) => e.id)).size).toBe(3);
  });
});

describe("monitoring store — 事件合併（013 T049、data-model §10、FR-029）", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-16T00:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("10 秒內同台同嚴重度合併為一筆（count 累加、移到頂端、id 沿用）；回復事件不阻斷合併", () => {
    const store = useMonitoringStore();
    store.applyTelemetryBatch([point("press-02", "warning")]);
    const firstId = store.events[0]?.id;
    vi.advanceTimersByTime(3_000);
    store.applyTelemetryBatch([point("press-02", "healthy")]); // recovered
    vi.advanceTimersByTime(3_000);
    store.applyTelemetryBatch([point("mixer-01", "critical")]); // 別台插在中間
    vi.advanceTimersByTime(4_000); // 與第一筆 warning 相距恰 10 秒（閉區間）
    store.applyTelemetryBatch([point("press-02", "warning")]);

    expect(store.events.map((e) => [e.machineId, e.severity, e.count])).toEqual([
      ["press-02", "warning", 2],
      ["mixer-01", "critical", 1],
      ["press-02", "recovered", 1],
    ]);
    expect(store.events[0]?.id).toBe(firstId);
    expect(store.events[0]?.ts).toBe(Date.now()); // 時間更新為最近一次發生
    expect(store.events[0]?.message).toBe("壓製機 02 進入警告");
  });

  it("相距超過 10 秒另立一筆", () => {
    const store = useMonitoringStore();
    store.applyTelemetryBatch([point("press-02", "warning")]);
    vi.advanceTimersByTime(5_000);
    store.applyTelemetryBatch([point("press-02", "healthy")]);
    vi.advanceTimersByTime(5_001); // 與第一筆 warning 相距 10 001 ms
    store.applyTelemetryBatch([point("press-02", "warning")]);
    expect(store.events.map((e) => [e.severity, e.count])).toEqual([
      ["warning", 1],
      ["recovered", 1],
      ["warning", 1],
    ]);
  });

  it("同一台交替 warning／critical 且每次間隔 11 秒：不合併，上限 50", () => {
    const store = useMonitoringStore();
    for (let i = 0; i < 60; i += 1) {
      store.applyTelemetryBatch([point("press-02", i % 2 === 0 ? "warning" : "critical")]);
      vi.advanceTimersByTime(11_000);
    }
    expect(store.events.length).toBe(50);
    expect(store.events.every((e) => e.count === 1)).toBe(true);
  });
});

describe("monitoring store — 異常標記 latch（013 T049、data-model §5／§6、FR-026／FR-027）", () => {
  const T0 = new Date("2026-10-16T00:00:00.000Z").getTime();

  beforeEach(() => {
    setActivePinia(createPinia());
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** 已連線的 store（staleNow 的 Pause 凍結只在連線中生效）。 */
  function connectedStore(): ReturnType<typeof useMonitoringStore> {
    const store = useMonitoringStore();
    store.setConnectionStatus("connected");
    store.setClientId("c1");
    store.setAuthorized(true);
    return store;
  }

  /** 推進時間並跑一次 1 Hz tick（staleNow 由 tick 推進）。 */
  function advance(ms: number, store: ReturnType<typeof useMonitoringStore>): void {
    vi.advanceTimersByTime(ms);
    store.tickNow();
  }

  it("首次 healthy 不建 latch；進入 warning 建 latch，enteredAt 為批次 receivedAt（不用 payload 時戳）", () => {
    const store = connectedStore();
    store.applyTelemetryBatch([point("press-02", "healthy")]);
    expect(store.latchFor("press-02")).toBeUndefined();
    expect(store.latchVisible("press-02")).toBe(false);

    vi.advanceTimersByTime(2_000);
    // payload 時戳刻意偏離客端時間 1 分鐘：latch 仍以 receivedAt 記
    store.applyTelemetryBatch([
      { ...point("press-02", "warning"), timestamp: new Date(T0 - 60_000).toISOString() },
    ]);
    expect(store.latchFor("press-02")).toEqual({
      machineId: "press-02",
      level: "warning",
      enteredAt: T0 + 2_000,
      recoveredAt: null,
      clearedBy: null,
    });
    expect(store.latchVisible("press-02")).toBe(true);
    // 事件 ts 則仍用 payload 時戳
    expect(store.events[0]?.ts).toBe(T0 - 60_000);
  });

  it("仍異常中 warning→critical 升級並重置確認；critical→warning 維持 critical", () => {
    const store = connectedStore();
    store.applyTelemetryBatch([point("press-02", "warning")]);
    store.clearLatch("press-02");
    expect(store.latchFor("press-02")?.clearedBy).toBe("user");

    vi.advanceTimersByTime(1_000);
    store.applyTelemetryBatch([point("press-02", "critical")]);
    expect(store.latchFor("press-02")).toMatchObject({
      level: "critical",
      enteredAt: T0, // 同一次異常：進入時間不變
      clearedBy: null, // 已劃線者恢復未確認
    });

    store.clearLatch("press-02");
    vi.advanceTimersByTime(1_000);
    store.applyTelemetryBatch([point("press-02", "warning")]);
    expect(store.latchFor("press-02")).toMatchObject({ level: "critical", clearedBy: "user" });
  });

  it("回復後記 recoveredAt；30 秒內可見，滿 30 秒不可見且摘要不含", () => {
    const store = connectedStore();
    store.applyTelemetryBatch([point("oven-04", "critical")]);
    vi.advanceTimersByTime(5_000);
    store.applyTelemetryBatch([point("oven-04", "healthy")]);
    expect(store.latchFor("oven-04")?.recoveredAt).toBe(T0 + 5_000);

    advance(29_000, store); // 回復後 29 秒
    expect(store.latchVisible("oven-04")).toBe(true);
    expect(store.anomalySummary).toEqual([
      {
        machineId: "oven-04",
        label: "烤爐 04",
        level: "critical",
        active: false,
        struck: false,
        since: T0 + 5_000, // 已回復：錨定 recoveredAt
      },
    ]);

    advance(1_000, store); // 回復後恰 30 秒
    expect(store.latchVisible("oven-04")).toBe(false);
    expect(store.anomalySummary).toEqual([]);
  });

  it("Pause 期間凍結不倒數；恢復後依實際經過時間判定（Pause 期間計入，已滿 30 秒立即消失）", () => {
    const store = connectedStore();
    store.applyTelemetryBatch([point("press-02", "critical")]);
    vi.advanceTimersByTime(1_000);
    store.applyTelemetryBatch([point("press-02", "healthy")]); // recoveredAt = T0+1s
    advance(10_000, store);

    store.togglePause(); // 凍結在 T0+11s（回復後 10 秒）
    advance(40_000, store); // 實際已過回復後 50 秒
    expect(store.staleNow).toBe(T0 + 11_000);
    expect(store.latchVisible("press-02")).toBe(true);
    expect(store.anomalySummary.map((item) => item.machineId)).toEqual(["press-02"]);
    store.clearLatch("press-02"); // Pause 中仍可確認（以凍結時鐘判定可見）
    expect(store.anomalySummary[0]?.struck).toBe(true);

    store.togglePause(); // 恢復：staleNow 回到 T0+51s
    expect(store.latchVisible("press-02")).toBe(false);
    expect(store.anomalySummary).toEqual([]);
  });

  it("Pause 恢復後尚未滿 30 秒者繼續倒數到期滿", () => {
    const store = connectedStore();
    store.applyTelemetryBatch([point("press-02", "warning")]);
    store.applyTelemetryBatch([point("press-02", "healthy")]); // recoveredAt = T0
    store.togglePause();
    advance(20_000, store);
    store.togglePause(); // 實際已過 20 秒
    expect(store.latchVisible("press-02")).toBe(true);
    advance(9_000, store);
    expect(store.latchVisible("press-02")).toBe(true);
    advance(1_000, store);
    expect(store.latchVisible("press-02")).toBe(false);
  });

  it("clearLatch 後劃線（struck）並保留至期滿才消失；有效清除觸發一次，無 latch／已確認者不觸發", () => {
    const store = connectedStore();
    let runs = 0;
    const scope = effectScope();
    scope.run(() => {
      watchEffect(
        () => {
          void store.latches;
          runs += 1;
        },
        { flush: "sync" },
      );
    });
    expect(runs).toBe(1);

    store.clearLatch("press-02"); // 無 latch：不拋錯、不觸發
    expect(store.latchFor("press-02")).toBeUndefined();
    expect(runs).toBe(1);

    store.applyTelemetryBatch([point("press-02", "critical")]); // 建 latch：批次觸發一次
    expect(runs).toBe(2);
    store.clearLatch("press-02"); // 有效清除：觸發一次
    expect(runs).toBe(3);
    expect(store.anomalySummary[0]).toMatchObject({ machineId: "press-02", active: true, struck: true });
    const confirmed = store.latchFor("press-02");
    store.clearLatch("press-02"); // 已確認者再清除：不寫回、不觸發
    expect(runs).toBe(3);
    expect(store.latchFor("press-02")).toBe(confirmed);

    vi.advanceTimersByTime(2_000);
    store.applyTelemetryBatch([point("press-02", "healthy")]);
    advance(29_000, store);
    expect(store.latchVisible("press-02")).toBe(true);
    expect(store.anomalySummary[0]).toMatchObject({ active: false, struck: true });
    advance(1_000, store);
    expect(store.anomalySummary).toEqual([]);
    scope.stop();
  });

  it("未確認就期滿的 latch：clearLatch 被可見性守門擋下（不劃線、不觸發）", () => {
    const store = connectedStore();
    store.applyTelemetryBatch([point("oven-04", "critical")]);
    vi.advanceTimersByTime(1_000);
    store.applyTelemetryBatch([point("oven-04", "healthy")]);
    advance(30_000, store); // 回復後恰 30 秒：期滿、不可見
    expect(store.latchVisible("oven-04")).toBe(false);

    let runs = 0;
    const scope = effectScope();
    scope.run(() => {
      watchEffect(
        () => {
          void store.latches;
          runs += 1;
        },
        { flush: "sync" },
      );
    });
    const expired = store.latchFor("oven-04");
    store.clearLatch("oven-04");
    expect(store.latchFor("oven-04")?.clearedBy).toBeNull();
    expect(store.latchFor("oven-04")).toBe(expired);
    expect(runs).toBe(1);
    scope.stop();
  });

  it("回復後 30 秒內再進 warning：以最新異常重置為 warning、未確認", () => {
    const store = connectedStore();
    store.applyTelemetryBatch([point("press-02", "critical")]);
    store.clearLatch("press-02");
    vi.advanceTimersByTime(1_000);
    store.applyTelemetryBatch([point("press-02", "healthy")]);
    vi.advanceTimersByTime(10_000);
    store.applyTelemetryBatch([point("press-02", "warning")]);
    expect(store.latchFor("press-02")).toEqual({
      machineId: "press-02",
      level: "warning",
      enteredAt: T0 + 11_000,
      recoveredAt: null,
      clearedBy: null,
    });
  });

  it("anomalySummary：active 優先、再依 enteredAt 降冪；label 為繁中機台名；since 錨點依是否回復", () => {
    const store = connectedStore();
    store.applyTelemetryBatch([point("mixer-01", "warning")]); // T0
    vi.advanceTimersByTime(1_000);
    store.applyTelemetryBatch([point("press-02", "critical")]); // T0+1s
    vi.advanceTimersByTime(1_000);
    store.applyTelemetryBatch([point("oven-04", "critical")]); // T0+2s
    vi.advanceTimersByTime(1_000);
    store.applyTelemetryBatch([point("oven-04", "healthy"), point("sorter-05", "healthy")]); // oven 回復 T0+3s
    advance(1_000, store);

    expect(
      store.anomalySummary.map((item) => [item.label, item.level, item.active, item.since]),
    ).toEqual([
      ["壓製機 02", "critical", true, T0 + 1_000],
      ["攪拌機 01", "warning", true, T0],
      ["烤爐 04", "critical", false, T0 + 3_000],
    ]);
  });

  it("一批內多台 latch 變化只 triggerRef 一次；無 latch 變化的批次不觸發", () => {
    const store = connectedStore();
    let runs = 0;
    const scope = effectScope();
    scope.run(() => {
      watchEffect(
        () => {
          void store.latches;
          runs += 1;
        },
        { flush: "sync" },
      );
    });
    expect(runs).toBe(1);

    store.applyTelemetryBatch([
      point("mixer-01", "warning"),
      point("press-02", "critical"),
      point("oven-04", "warning"),
      point("oven-04", "critical"),
    ]);
    expect(runs).toBe(2);
    expect(store.latches.size).toBe(3);

    // 全部 healthy 機台、或異常機台同態抖動：latch 無變化，不觸發
    store.applyTelemetryBatch([
      point("pack-03", "healthy"),
      point("mixer-01", "warning"),
      point("press-02", "critical"),
    ]);
    store.applyTelemetryBatch([]);
    expect(runs).toBe(2);
    scope.stop();
  });

  it("anomalySummary 不隨每幀批次重算：無 latch 變化的批次不觸發", () => {
    const store = connectedStore();
    store.applyTelemetryBatch([point("press-02", "critical")]);
    let runs = 0;
    const scope = effectScope();
    scope.run(() => {
      watchEffect(
        () => {
          void store.anomalySummary;
          runs += 1;
        },
        { flush: "sync" },
      );
    });
    expect(runs).toBe(1);
    for (let i = 0; i < 30; i += 1) store.applyTelemetryBatch([point("press-02", "critical")]);
    expect(runs).toBe(1);
    scope.stop();
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

  it("未經 reconnecting 就換到新 clientId → subscribed 清空，isLive 須等新連線訂閱", () => {
    const store = useMonitoringStore();
    store.setConnectionStatus("connected");
    store.setClientId("c1");
    store.setAuthorized(true);
    store.setClientId("c1"); // 同一 id 重複派發不影響
    expect(store.isLive).toBe(true);
    store.setClientId("c2");
    expect(store.subscribed).toBe(false);
    expect(store.isLive).toBe(false);
    store.setAuthorized(true);
    expect(store.isLive).toBe(true);
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

describe("monitoring store — 背壓速率序列（013 T032、FR-009／FR-011、憲章 IV）", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-16T00:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** 已連線的 store，並先 tick 一次取差分基準（首筆不產生樣本）。 */
  function connectedStore(): ReturnType<typeof useMonitoringStore> {
    const store = useMonitoringStore();
    store.setConnectionStatus("connected");
    store.setClientId("c1");
    store.tickNow();
    return store;
  }

  it("首次 tick 只取基準；之後每次 tick 推入一筆差分，getter 由序列衍生", () => {
    const store = connectedStore();
    expect(store.rateSamples).toHaveLength(0);
    expect(store.windowRatio).toBeNull();
    expect(store.latestRate).toBeNull();

    // 第 1 秒：3 批、每批 4 筆 → 12 訊息 / 3 批次
    for (let i = 0; i < 3; i++) store.applyTelemetryBatch(makeBatch(4));
    vi.advanceTimersByTime(1000);
    store.tickNow();
    // 第 2 秒：2 批、每批 10 筆 → 20 訊息 / 2 批次
    for (let i = 0; i < 2; i++) store.applyTelemetryBatch(makeBatch(10));
    vi.advanceTimersByTime(1000);
    store.tickNow();

    expect(store.rateSamples.map((s) => [s.msgsPerSec, s.batchesPerSec])).toEqual([
      [12, 3],
      [20, 2],
    ]);
    expect(store.latestRate).toMatchObject({ msgsPerSec: 20, batchesPerSec: 2 });
    expect(store.windowRatio).toBeCloseTo(32 / 5); // 視窗 Σ訊息 ÷ Σ批次，不是逐秒比值的平均
    expect(store.ratePeak).toBe(20);
    expect(store.cumulativeRatio).toBe(Math.round(32 / 5)); // 累計比值（tooltip）沿用 backpressureRatio
  });

  it("溢位丟棄計入視窗丟棄數；超出 60 秒視窗後歸零", () => {
    const store = connectedStore();
    store.recordDropped({ overflow: 7, invalid: 0 });
    store.applyTelemetryBatch(makeBatch(1));
    vi.advanceTimersByTime(1000);
    store.tickNow();
    expect(store.droppedInWindow).toBe(7);

    for (let i = 0; i < 60; i++) {
      store.applyTelemetryBatch(makeBatch(1));
      vi.advanceTimersByTime(1000);
      store.tickNow();
    }
    expect(store.rateSamples).toHaveLength(60);
    expect(store.droppedInWindow).toBe(0);
  });

  it("斷線即停止推入並標示中斷；重連清空舊樣本、第一次 tick 只重取基準，斷線期間的量不灌進單一格", () => {
    const store = connectedStore();
    store.applyTelemetryBatch(makeBatch(5));
    vi.advanceTimersByTime(1000);
    store.tickNow();
    expect(store.rateSamples).toHaveLength(1);

    store.setConnectionStatus("reconnecting");
    store.applyTelemetryBatch(makeBatch(50)); // 斷線前已在 buffer 的殘量
    vi.advanceTimersByTime(1000);
    store.tickNow();
    expect(store.rateStale).toBe(true);
    expect(store.rateSamples).toHaveLength(1); // 既有樣本保留、不再推入

    store.setConnectionStatus("connected");
    vi.advanceTimersByTime(1000);
    store.tickNow(); // 清空斷線前的樣本、只取基準
    expect(store.rateStale).toBe(false);
    expect(store.rateSamples).toHaveLength(0);
    expect(store.windowRatio).toBeNull();

    store.applyTelemetryBatch(makeBatch(2));
    vi.advanceTimersByTime(1000);
    store.tickNow();
    expect(store.rateSamples.map((s) => s.msgsPerSec)).toEqual([2]); // 視窗不混入斷線前的 5
  });

  it("尚無任何批次時累計比值為 null（顯示「—」而非 0:1）", () => {
    const store = connectedStore();
    expect(store.cumulativeRatio).toBeNull();
    store.applyTelemetryBatch(makeBatch(3));
    vi.advanceTimersByTime(1000);
    store.tickNow();
    expect(store.cumulativeRatio).toBe(3);
  });

  it("首次連線前序列同樣停推，但不標示「連線中斷」", () => {
    const store = useMonitoringStore();
    store.tickNow();
    expect(store.rateSeries.stale).toBe(true);
    expect(store.rateStale).toBe(false);
  });

  it("Pause 期間照常推入（計數不是畫面內容）", () => {
    const store = connectedStore();
    store.togglePause();
    store.applyTelemetryBatch(makeBatch(3));
    vi.advanceTimersByTime(1000);
    store.tickNow();
    expect(store.rateSamples).toHaveLength(1);
  });

  it("每幀批次提交不觸發序列 getter；只有 1 Hz tick 會（憲章 IV）", () => {
    const store = connectedStore();
    let runs = 0;
    const scope = effectScope();
    scope.run(() => {
      watchEffect(
        () => {
          // strip 讀的全部 getter
          void store.rateSeries;
          void store.rateSamples;
          void store.latestRate;
          void store.ratePeak;
          void store.windowRatio;
          void store.droppedInWindow;
          void store.rateStale;
          void store.cumulativeRatio;
          runs += 1;
        },
        { flush: "sync" },
      );
    });
    expect(runs).toBe(1);

    for (let i = 0; i < 30; i++) store.applyTelemetryBatch(makeBatch(5));
    store.recordDropped({ overflow: 2, invalid: 1 });
    expect(runs).toBe(1);

    const before = store.rateSamples;
    vi.advanceTimersByTime(1000);
    store.tickNow();
    // sync flush 下序列與累計比值各觸發一次；重點是次數與幀數無關
    expect(runs).toBeGreaterThan(1);
    expect(runs).toBeLessThanOrEqual(3);
    expect(store.rateSamples).not.toBe(before); // 新參照：子元件 prop 比對才看得到變化
    scope.stop();
  });
});
