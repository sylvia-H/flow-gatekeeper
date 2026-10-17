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

  it("舊英文名寫法：空白當成 -（Press 02）、去掉 - 的 id（press02）都命中（合併門第 1 輪 low）", () => {
    expect(filterMachineIds(MACHINE_IDS, "Press 02")).toEqual(["press-02"]);
    expect(filterMachineIds(MACHINE_IDS, "  sorter   05 ")).toEqual(["sorter-05"]);
    expect(filterMachineIds(MACHINE_IDS, "press02")).toEqual(["press-02"]);
    expect(filterMachineIds(MACHINE_IDS, "OVEN04")).toEqual(["oven-04"]);
    // 中文名仍以原查詢（含空白）比對
    expect(filterMachineIds(MACHINE_IDS, "壓製機 02")).toEqual(["press-02"]);
    expect(filterMachineIds(MACHINE_IDS, "press 03")).toEqual([]);
  });

  it("繁中名少打或多打空白也命中（合併門第 2 輪 low）", () => {
    expect(filterMachineIds(MACHINE_IDS, "壓製機02")).toEqual(["press-02"]);
    expect(filterMachineIds(MACHINE_IDS, "壓製機  02")).toEqual(["press-02"]);
    expect(filterMachineIds(MACHINE_IDS, " 壓製機 0 2 ")).toEqual(["press-02"]);
    // 去掉空白後仍不相符的不誤中
    expect(filterMachineIds(MACHINE_IDS, "壓製機03")).toEqual([]);
  });

  it("查無相符回空陣列", () => {
    expect(filterMachineIds(MACHINE_IDS, "zzz")).toEqual([]);
  });

  it("片段命中多台", () => {
    expect(filterMachineIds(MACHINE_IDS, "0")).toEqual([...MACHINE_IDS]);
  });
});
