import { describe, expect, it } from "vitest";
import { isProductionEnv } from "./env.js";

describe("isProductionEnv（三端共用的 production 判準）", () => {
  it.each<[string | undefined, boolean]>([
    ["production", true],
    ["Production", true],
    ["PRODUCTION ", true],
    [" production\t", true],
    ["development", false],
    ["test", false],
    ["", false],
    ["   ", false],
    [undefined, false],
    ["prod", false],
  ])("NODE_ENV=%j → %s", (value, expected) => {
    expect(isProductionEnv(value)).toBe(expected);
  });
});
