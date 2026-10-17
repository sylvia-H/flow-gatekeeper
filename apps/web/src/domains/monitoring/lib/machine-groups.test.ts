import { describe, expect, it } from "vitest";
import { MACHINE_IDS } from "@flow-gatekeeper/contracts";
import { MACHINE_GROUPS } from "./machine-groups.js";

const groupOf = (id: string): string | undefined => MACHINE_GROUPS.find((g) => g.machineIds.includes(id))?.name;

describe("machine-groups（FR-017）", () => {
  it("三組對照，成員如 clarify 決議", () => {
    expect(MACHINE_GROUPS.map((g) => g.name)).toEqual(["Prep", "Forming & Baking", "Fulfilment"]);
    expect(groupOf("mixer-01")).toBe("Prep");
    expect(groupOf("press-02")).toBe("Forming & Baking");
    expect(groupOf("oven-04")).toBe("Forming & Baking");
    expect(groupOf("pack-03")).toBe("Fulfilment");
    expect(groupOf("sorter-05")).toBe("Fulfilment");
  });

  it("stage 繁中名與 data-stage key 依序對應（013 T021、ui-contract §3）", () => {
    expect(MACHINE_GROUPS.map((g) => g.label)).toEqual(["前處理", "成型烘烤", "包裝分揀"]);
    expect(MACHINE_GROUPS.map((g) => g.key)).toEqual(["prep", "forming", "fulfilment"]);
  });

  it("每台 roster 機台恰屬一組（涵蓋全部 5 台、無重複）", () => {
    const assigned = MACHINE_GROUPS.flatMap((g) => g.machineIds);
    expect([...assigned].sort()).toEqual([...MACHINE_IDS].sort());
    expect(new Set(assigned).size).toBe(assigned.length);
  });
});
