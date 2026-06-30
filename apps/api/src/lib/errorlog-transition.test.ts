import { describe, expect, it } from "vitest";
import type { MachineState, TelemetryPoint } from "@flow-gatekeeper/contracts";
import { detectErrorTransitions } from "./errorlog-transition.js";

function point(machineId: string, state: MachineState): TelemetryPoint {
  return {
    type: "machine/data",
    machineId,
    timestamp: new Date(0).toISOString(),
    telemetry: { temperature: 80, vibration: 1, throughput: 100, errorRate: 0.05 },
    state,
  };
}

describe("detectErrorTransitions", () => {
  it("轉入 warning 記一筆並更新 lastState", () => {
    const { errors, nextState } = detectErrorTransitions(
      [point("press-02", "warning")],
      new Map(),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]?.state).toBe("warning");
    expect(nextState.get("press-02")).toBe("warning");
  });

  it("連續維持同一異常狀態不重複記錄（FR-011/SC-003 去重）", () => {
    const last = new Map<string, MachineState>([["press-02", "critical"]]);
    const { errors } = detectErrorTransitions([point("press-02", "critical")], last);
    expect(errors).toHaveLength(0);
  });

  it("轉回/維持 healthy 不記錄", () => {
    const last = new Map<string, MachineState>([["press-02", "warning"]]);
    const { errors, nextState } = detectErrorTransitions([point("press-02", "healthy")], last);
    expect(errors).toHaveLength(0);
    expect(nextState.get("press-02")).toBe("healthy");
  });

  it("warning→critical 視為新轉換，記一筆", () => {
    const last = new Map<string, MachineState>([["press-02", "warning"]]);
    const { errors } = detectErrorTransitions([point("press-02", "critical")], last);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.state).toBe("critical");
  });
});
