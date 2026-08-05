import { describe, expect, it } from "vitest";
import { jobSteps } from "./job-steps.js";

function statuses(progress: number | null | undefined): string[] {
  return jobSteps(progress).map((s) => s.status);
}

describe("jobSteps（US7、FR-019）", () => {
  it("固定 6 個里程碑 0/20/40/60/80/100", () => {
    expect(jobSteps(0).map((s) => s.milestone)).toEqual([0, 20, 40, 60, 80, 100]);
  });

  it("indeterminate（null/undefined）→ 首步 active、其餘 todo", () => {
    expect(statuses(null)).toEqual(["active", "todo", "todo", "todo", "todo", "todo"]);
    expect(statuses(undefined)).toEqual(["active", "todo", "todo", "todo", "todo", "todo"]);
  });

  it("progress 命中里程碑 60：<60 done、60 active、>60 todo", () => {
    expect(statuses(60)).toEqual(["done", "done", "done", "active", "todo", "todo"]);
  });

  it("progress 介於里程碑（50）：<50 done、往上最近（60）active", () => {
    expect(statuses(50)).toEqual(["done", "done", "done", "active", "todo", "todo"]);
  });

  it("progress 0：首步 active、其餘 todo", () => {
    expect(statuses(0)).toEqual(["active", "todo", "todo", "todo", "todo", "todo"]);
  });

  it("progress 100：前五步 done、末步 active", () => {
    expect(statuses(100)).toEqual(["done", "done", "done", "done", "done", "active"]);
  });
});
