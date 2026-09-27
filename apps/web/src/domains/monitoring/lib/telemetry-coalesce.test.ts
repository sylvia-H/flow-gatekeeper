import { describe, expect, it } from "vitest";
import type { MachineState, TelemetryPoint } from "@flow-gatekeeper/contracts";
import { coalesceTelemetry } from "./telemetry-coalesce.js";

function pt(machineId: string, state: MachineState, temperature = 60): TelemetryPoint {
  return {
    type: "machine/data",
    machineId,
    timestamp: "2026-09-27T00:00:00.000Z",
    telemetry: { temperature, vibration: 1, throughput: 100, errorRate: 0 },
    state,
  };
}

describe("coalesceTelemetry — 溢位合併", () => {
  it("每台保留第一筆、轉換點與最新一筆；中間同態點被丟並計數", () => {
    const input = [
      pt("a", "healthy", 1),
      pt("a", "healthy", 2),
      pt("a", "warning", 3), // 轉換點
      pt("a", "warning", 4),
      pt("a", "warning", 5), // 最新
      pt("b", "healthy", 6),
      pt("b", "healthy", 7), // 最新
    ];
    const { kept, dropped } = coalesceTelemetry(input, 10);
    expect(kept.map((p) => p.telemetry.temperature)).toEqual([1, 3, 5, 6, 7]);
    expect(dropped).toBe(2);
  });

  it("state 序列（去連續重複）與原序列一致——事件衍生不受影響", () => {
    const states: MachineState[] = ["healthy", "healthy", "critical", "critical", "healthy", "warning", "warning"];
    const { kept } = coalesceTelemetry(states.map((s) => pt("a", s)), 100);
    const collapse = (xs: MachineState[]) => xs.filter((s, i) => i === 0 || xs[i - 1] !== s);
    expect(collapse(kept.map((p) => p.state))).toEqual(collapse(states));
  });

  it("合併後仍超過上限：丟最舊的非最新點、降到 lowWater，但每台最新一筆必保留", () => {
    // a 抖動 20 次（每筆都是轉換點），b 只在最前面送過一筆
    const input = [pt("b", "healthy", 999)];
    for (let i = 0; i < 20; i += 1) input.push(pt("a", i % 2 === 0 ? "warning" : "critical", i));
    const { kept, dropped } = coalesceTelemetry(input, 10, 5);
    expect(kept.length).toBe(5);
    expect(dropped).toBe(16);
    expect(kept.some((p) => p.machineId === "b")).toBe(true);
    expect(kept.at(-1)?.telemetry.temperature).toBe(19);
  });
});
