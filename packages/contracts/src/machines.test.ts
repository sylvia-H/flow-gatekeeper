import { describe, expect, it } from "vitest";
import { MACHINE_IDS, isKnownMachineId } from "./index.js";

describe("MACHINE_IDS（跨端機台名冊單一來源）", () => {
  it("為 5 台固定名冊，順序固定且無重複", () => {
    expect(MACHINE_IDS).toEqual(["mixer-01", "press-02", "pack-03", "oven-04", "sorter-05"]);
    expect(new Set(MACHINE_IDS).size).toBe(MACHINE_IDS.length);
  });

  it("isKnownMachineId：名冊內為 true，其餘（含大小寫不同）為 false", () => {
    for (const id of MACHINE_IDS) expect(isKnownMachineId(id)).toBe(true);
    expect(isKnownMachineId("ghost-99")).toBe(false);
    expect(isKnownMachineId("MIXER-01")).toBe(false);
    expect(isKnownMachineId("")).toBe(false);
  });
});
