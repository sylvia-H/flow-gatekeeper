import { describe, expect, it } from "vitest";
import { KNOWN_MACHINE_IDS } from "./machine-labels.js";
import { filterMachineIds } from "./machine-search.js";

describe("filterMachineIds（FR-015、SC-006）", () => {
  it("空 query（含純空白）回全部", () => {
    expect(filterMachineIds(KNOWN_MACHINE_IDS, "")).toEqual([...KNOWN_MACHINE_IDS]);
    expect(filterMachineIds(KNOWN_MACHINE_IDS, "   ")).toEqual([...KNOWN_MACHINE_IDS]);
  });

  it("比對 machineId（片段、大小寫不敏感）", () => {
    expect(filterMachineIds(KNOWN_MACHINE_IDS, "press")).toEqual(["press-02"]);
    expect(filterMachineIds(KNOWN_MACHINE_IDS, "PRESS-02")).toEqual(["press-02"]);
  });

  it("比對顯示名稱（machineLabel）", () => {
    expect(filterMachineIds(KNOWN_MACHINE_IDS, "Oven")).toEqual(["oven-04"]);
  });

  it("查無相符回空陣列", () => {
    expect(filterMachineIds(KNOWN_MACHINE_IDS, "zzz")).toEqual([]);
  });

  it("片段命中多台", () => {
    expect(filterMachineIds(KNOWN_MACHINE_IDS, "0")).toEqual([...KNOWN_MACHINE_IDS]);
  });
});
