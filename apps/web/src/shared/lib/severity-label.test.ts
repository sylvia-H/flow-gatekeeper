import { describe, expect, it } from "vitest";
import { severityLabel } from "./severity-label.js";

describe("severityLabel（research R13）", () => {
  it("ok → 正常、warning → 警告、critical → 嚴重", () => {
    expect(severityLabel("ok")).toBe("正常");
    expect(severityLabel("warning")).toBe("警告");
    expect(severityLabel("critical")).toBe("嚴重");
  });
});
