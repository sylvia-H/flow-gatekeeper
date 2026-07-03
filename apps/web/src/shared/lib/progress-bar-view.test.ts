import { describe, expect, it } from "vitest";
import { progressBarView } from "./progress-bar-view.js";

describe("progressBarView — 進度條呈現不變量（design-spec §7.5、FR-004）", () => {
  it("failed 無 value：非 indeterminate、走靜態 crit 條、aria 不讀「處理中」（迴歸：review finding）", () => {
    const v = progressBarView("failed");
    expect(v.indeterminate).toBe(false);
    expect(v.barClass).toBe("bg-crit");
    expect(v.widthPct).toBe(0);
    expect(v.ariaLabel).toBe("診斷進度：0%");
  });

  it("failed 帶最後已知值：保留該值於 crit 條", () => {
    const v = progressBarView("failed", 70);
    expect(v.indeterminate).toBe(false);
    expect(v.barClass).toBe("bg-crit");
    expect(v.widthPct).toBe(70);
  });

  it("completed 無 value：視為 100%、ok 收尾色、非 indeterminate", () => {
    const v = progressBarView("completed");
    expect(v).toEqual({
      indeterminate: false,
      barClass: "bg-ok",
      widthPct: 100,
      ariaLabel: "診斷進度：100%",
    });
  });

  it("active 無數值：indeterminate（accent 動畫）、aria 讀處理中", () => {
    const v = progressBarView("active", null);
    expect(v.indeterminate).toBe(true);
    expect(v.barClass).toBe("bg-accent");
    expect(v.ariaLabel).toBe("診斷進度：處理中…");
  });

  it("active 有數值：非 indeterminate、accent 填色寬度反映百分比", () => {
    const v = progressBarView("active", 40);
    expect(v.indeterminate).toBe(false);
    expect(v.barClass).toBe("bg-accent");
    expect(v.widthPct).toBe(40);
    expect(v.ariaLabel).toBe("診斷進度：40%");
  });

  it("waiting 無數值：indeterminate", () => {
    expect(progressBarView("waiting").indeterminate).toBe(true);
  });

  it("value=0 視為有數值（非 indeterminate，避免 falsy-zero 誤判）", () => {
    const v = progressBarView("active", 0);
    expect(v.indeterminate).toBe(false);
    expect(v.widthPct).toBe(0);
  });
});
