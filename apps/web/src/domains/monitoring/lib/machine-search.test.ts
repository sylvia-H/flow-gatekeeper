import { describe, expect, it } from "vitest";
import { MACHINE_IDS } from "@flow-gatekeeper/contracts";
import { filterMachineIds } from "./machine-search.js";

describe("filterMachineIds（FR-015、SC-006）", () => {
  it("空 query（含純空白）回全部", () => {
    expect(filterMachineIds(MACHINE_IDS, "")).toEqual([...MACHINE_IDS]);
    expect(filterMachineIds(MACHINE_IDS, "   ")).toEqual([...MACHINE_IDS]);
  });

  it("比對 machineId（片段、大小寫不敏感）", () => {
    expect(filterMachineIds(MACHINE_IDS, "press")).toEqual(["press-02"]);
    expect(filterMachineIds(MACHINE_IDS, "PRESS-02")).toEqual(["press-02"]);
  });

  it("比對顯示名稱（machineLabel，013 起為繁中名）", () => {
    expect(filterMachineIds(MACHINE_IDS, "烤爐")).toEqual(["oven-04"]);
    expect(filterMachineIds(MACHINE_IDS, "壓製機 02")).toEqual(["press-02"]);
    // id 片段仍可搜（英文 id 與中文名並存）
    expect(filterMachineIds(MACHINE_IDS, "Oven")).toEqual(["oven-04"]);
  });

  it("查無相符回空陣列", () => {
    expect(filterMachineIds(MACHINE_IDS, "zzz")).toEqual([]);
  });

  it("片段命中多台", () => {
    expect(filterMachineIds(MACHINE_IDS, "0")).toEqual([...MACHINE_IDS]);
  });
});
