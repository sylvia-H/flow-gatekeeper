// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import StageColumn from "./StageColumn.vue";
import type { Stage } from "../lib/stage-layout.js";

/**
 * StageColumn（T039；FR-013、FR-015、FR-038、ui-contract §3）：中文標題不附英文副標、region 名稱、
 * 機台數與空狀態。卡片由 slot 傳入，這裡以簡單元素代替 MachineNodeCard，不需要 store。
 */

function stage(over: Partial<Stage> = {}): Stage {
  return {
    name: "Forming & Baking",
    key: "forming",
    label: "成型烘烤",
    machineIds: ["press-02", "oven-04"],
    order: 1,
    ...over,
  };
}

function mountColumn(s: Stage) {
  return mount(StageColumn, {
    props: { stage: s },
    slots: { default: () => s.machineIds.map((id) => `<${id}>`).join("") },
  });
}

describe("StageColumn 標題與區域（FR-038、ui-contract §3）", () => {
  it("根元素為 region，aria-label 為中文 stage 名，帶 data-fg=stage 與 data-stage 鉤子", () => {
    const root = mountColumn(stage()).get('[role="region"]');
    expect(root.attributes("aria-label")).toBe("成型烘烤");
    expect(root.attributes("data-fg")).toBe("stage");
    expect(root.attributes("data-stage")).toBe("forming");
  });

  it("標題只有中文 stage 名，不附英文副標（標頭內沒有任何拉丁字母）", () => {
    const w = mountColumn(stage());
    expect(w.get("h2").text()).toBe("成型烘烤");
    const header = w.get("header").text();
    expect(header).not.toMatch(/[A-Za-z]/);
    expect(w.text()).not.toContain("Forming");
  });

  it("標題字級：手機 Heading 16px（text-md）、md+ 14px（md:text-sm），字重 600", () => {
    const classes = mountColumn(stage()).get("h2").classes();
    expect(classes).toEqual(expect.arrayContaining(["text-md", "md:text-sm", "font-semibold"]));
    expect(classes).not.toContain("text-sm");
  });

  it("標頭顯示可見機台數「N 台」", () => {
    expect(mountColumn(stage()).get("header").text()).toContain("2 台");
    expect(mountColumn(stage({ machineIds: ["press-02"] })).get("header").text()).toContain("1 台");
  });
});

describe("StageColumn 卡片與空狀態（FR-015）", () => {
  it("有機台時渲染 slot 內容、不顯示空狀態", () => {
    const w = mountColumn(stage());
    expect(w.text()).toContain("<press-02>");
    expect(w.text()).toContain("<oven-04>");
    expect(w.text()).not.toContain("此階段無符合的機台");
  });

  it("搜尋清空本欄時欄位保留：region 與標題仍在、顯示「此階段無符合的機台」與「0 台」、不渲染 slot", () => {
    const w = mountColumn(stage({ machineIds: [] }));
    expect(w.find('[role="region"][aria-label="成型烘烤"]').exists()).toBe(true);
    expect(w.get("h2").text()).toBe("成型烘烤");
    expect(w.get("header").text()).toContain("0 台");
    expect(w.text()).toContain("此階段無符合的機台");
    expect(w.text()).not.toContain("<");
  });

  it("空狀態框保留一張卡片的最小高度（148px），空欄不塌陷", () => {
    const empty = mountColumn(stage({ machineIds: [] }))
      .findAll("p")
      .find((p) => p.text() === "此階段無符合的機台")!;
    expect(empty.classes()).toContain("min-h-[148px]");
    expect(empty.classes()).toContain("text-xs");
  });
});
