import { describe, expect, it } from "vitest";
import { isEmptyContext } from "./context-builder.js";
import type { DiagnosisContext } from "./context-builder.js";

const EMPTY: DiagnosisContext = {
  machineId: "ghost-99",
  windowMinutes: 5,
  latestState: "unknown",
  telemetry: null,
  recentErrors: [],
  topErrorCodes: [],
  maintenance: [],
};

describe("isEmptyContext", () => {
  it("四者皆無 → 空", () => {
    expect(isEmptyContext(EMPTY)).toBe(true);
  });

  it("任一來源有資料 → 非空", () => {
    expect(isEmptyContext({ ...EMPTY, latestState: "warning" })).toBe(false);
    expect(isEmptyContext({ ...EMPTY, recentErrors: [{ state: "critical", message: "", timestamp: "" }] })).toBe(false);
    expect(isEmptyContext({ ...EMPTY, maintenance: [{ summary: "x" }] })).toBe(false);
    expect(
      isEmptyContext({
        ...EMPTY,
        telemetry: { count: 1, avgTemperature: 0, maxTemperature: 0, avgVibration: 0, maxVibration: 0, avgErrorRate: 0, maxErrorRate: 0 },
      }),
    ).toBe(false);
  });
});
