import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type { MachineState, TelemetryPoint } from "@flow-gatekeeper/contracts";
import { useMonitoringStore } from "./monitoring.store.js";

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

  it("applyTelemetryBatch 呼叫 3 次、每次 N 筆 → received=3N、rendered=3、ratio=round(N)", () => {
    const store = useMonitoringStore();
    const N = 7;

    store.applyTelemetryBatch(makeBatch(N));
    store.applyTelemetryBatch(makeBatch(N));
    store.applyTelemetryBatch(makeBatch(N));

    expect(store.receivedMessages).toBe(3 * N);
    expect(store.renderedBatches).toBe(3);
    expect(store.batchRatio).toBe(Math.round(N));
  });

  it("renderedBatches===0 時 batchRatio===0（避免除以零）", () => {
    const store = useMonitoringStore();
    expect(store.renderedBatches).toBe(0);
    expect(store.batchRatio).toBe(0);
  });

  it("每台只保留最新快照；machineList 依 machineId 穩定排序", () => {
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
    expect(store.machineList.map((m) => m.machineId)).toEqual(["mixer-01", "press-02"]);
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
