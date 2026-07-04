import { describe, expect, it } from "vitest";
import { KNOWN_MACHINE_IDS } from "./machine-labels.js";
import { MACHINE_GROUPS, machineGroup } from "./machine-groups.js";

describe("machine-groups（FR-017）", () => {
  it("三組對照，成員如 clarify 決議", () => {
    expect(MACHINE_GROUPS.map((g) => g.name)).toEqual(["Prep", "Forming & Baking", "Fulfilment"]);
    expect(machineGroup("mixer-01")).toBe("Prep");
    expect(machineGroup("press-02")).toBe("Forming & Baking");
    expect(machineGroup("oven-04")).toBe("Forming & Baking");
    expect(machineGroup("pack-03")).toBe("Fulfilment");
    expect(machineGroup("sorter-05")).toBe("Fulfilment");
  });

  it("每台 roster 機台恰屬一組（涵蓋全部 5 台、無重複）", () => {
    const assigned = MACHINE_GROUPS.flatMap((g) => g.machineIds);
    expect([...assigned].sort()).toEqual([...KNOWN_MACHINE_IDS].sort());
    expect(new Set(assigned).size).toBe(assigned.length);
  });

  it("缺項落 fallback Ungrouped", () => {
    expect(machineGroup("unknown-99")).toBe("Ungrouped");
  });
});
