import { describe, expect, it } from "vitest";
import { safeEqualString } from "./safe-equal.js";

describe("safeEqualString", () => {
  it("相同字串 → true", () => {
    expect(safeEqualString("s3cret", "s3cret")).toBe(true);
    expect(safeEqualString("", "")).toBe(true);
    expect(safeEqualString("密鑰", "密鑰")).toBe(true);
  });

  it("內容不同、前綴相同、長度不同皆 → false，且不丟例外", () => {
    expect(safeEqualString("s3cret", "s3creT")).toBe(false);
    expect(safeEqualString("s3cret", "s3cre")).toBe(false);
    expect(safeEqualString("s3cret", "")).toBe(false);
    expect(safeEqualString("", "x".repeat(512))).toBe(false);
  });
});
