import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MACHINE_IDS } from "@flow-gatekeeper/contracts";
import { MACHINE_GROUPS } from "./machine-groups.js";
import { assignToStages, resetStageWarnings } from "./stage-layout.js";

beforeEach(() => {
  resetStageWarnings();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("assignToStages（data-model §4）", () => {
  it("5 台依分組歸屬三欄，欄內順序依分組定義、欄序 0／1／2", () => {
    // visibleIds 順序刻意打亂：欄內順序仍依 MACHINE_GROUPS
    const stages = assignToStages(["sorter-05", "oven-04", "pack-03", "press-02", "mixer-01"], MACHINE_GROUPS);
    expect(stages.map((s) => [s.key, s.label, s.order, s.machineIds])).toEqual([
      ["prep", "前處理", 0, ["mixer-01"]],
      ["forming", "成型烘烤", 1, ["press-02", "oven-04"]],
      ["fulfilment", "包裝分揀", 2, ["pack-03", "sorter-05"]],
    ]);
    expect(stages.map((s) => s.name)).toEqual(["Prep", "Forming & Baking", "Fulfilment"]);
  });

  it("搜尋後某欄為空仍回三欄（空欄為空陣列）", () => {
    const stages = assignToStages(["oven-04"], MACHINE_GROUPS);
    expect(stages.length).toBe(3);
    expect(stages.map((s) => s.machineIds)).toEqual([[], ["oven-04"], []]);
  });

  it("全部濾掉仍回三個空欄", () => {
    expect(assignToStages([], MACHINE_GROUPS).map((s) => s.machineIds)).toEqual([[], [], []]);
  });

  it("不改動 MACHINE_GROUPS 本身", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    assignToStages([...MACHINE_IDS, "ghost-a"], MACHINE_GROUPS);
    expect(MACHINE_GROUPS[2]?.machineIds).toEqual(["pack-03", "sorter-05"]);
  });

  it("未分組 id 歸最後一欄末尾，且每個未知 id 只警告一次", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const ids = ["mixer-01", "ghost-99", "pack-03"];
    const first = assignToStages(ids, MACHINE_GROUPS);
    expect(first[2]?.machineIds).toEqual(["pack-03", "ghost-99"]);
    // computed 每幀重算：同一未知 id 不再警告
    assignToStages(ids, MACHINE_GROUPS);
    assignToStages(ids, MACHINE_GROUPS);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("ghost-99");
  });

  it("已分組的機台不觸發警告", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    assignToStages([...MACHINE_IDS], MACHINE_GROUPS);
    expect(warn).not.toHaveBeenCalled();
  });
});
