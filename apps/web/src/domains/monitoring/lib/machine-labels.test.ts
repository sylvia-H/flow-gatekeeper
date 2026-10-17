import { describe, expect, it } from "vitest";
import { MACHINE_IDS } from "@flow-gatekeeper/contracts";
import { machineLabel } from "./machine-labels.js";

describe("machine-labels（FR-006a）", () => {
  it("MACHINE_IDS 為 5 台固定名冊", () => {
    expect(MACHINE_IDS).toEqual([
      "mixer-01",
      "press-02",
      "pack-03",
      "oven-04",
      "sorter-05",
    ]);
  });

  it("已知 machineId 回傳繁中顯示名稱（013 T021：中文名為唯一來源）", () => {
    expect(MACHINE_IDS.map((id) => machineLabel(id))).toEqual([
      "攪拌機 01",
      "壓製機 02",
      "包裝機 03",
      "烤爐 04",
      "分揀機 05",
    ]);
  });

  it("缺項 fallback 回 machineId 本身", () => {
    expect(machineLabel("unknown-99")).toBe("unknown-99");
    expect(machineLabel("")).toBe("");
  });
});
