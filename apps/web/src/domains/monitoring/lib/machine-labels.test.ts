import { describe, expect, it } from "vitest";
import { KNOWN_MACHINE_IDS, machineLabel } from "./machine-labels.js";

describe("machine-labels（FR-006a）", () => {
  it("KNOWN_MACHINE_IDS 為 5 台固定名冊", () => {
    expect(KNOWN_MACHINE_IDS).toEqual([
      "mixer-01",
      "press-02",
      "pack-03",
      "oven-04",
      "sorter-05",
    ]);
  });

  it("已知 machineId 回傳對照顯示名稱", () => {
    expect(machineLabel("press-02")).toBe("Press 02");
    expect(machineLabel("oven-04")).toBe("Oven 04");
  });

  it("缺項 fallback 回 machineId 本身", () => {
    expect(machineLabel("unknown-99")).toBe("unknown-99");
    expect(machineLabel("")).toBe("");
  });
});
