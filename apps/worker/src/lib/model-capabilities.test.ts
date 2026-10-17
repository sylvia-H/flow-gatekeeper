import { describe, expect, it } from "vitest";
import { thinkingCapability } from "./model-capabilities.js";

describe("thinkingCapability", () => {
  it.each([
    ["gemini-2.5-flash", "disableable"],
    ["gemini-2.5-flash-lite", "disableable"],
    ["models/gemini-2.5-flash", "disableable"],
    ["gemini-2.5-flash-preview-09-2025", "disableable"],
    ["gemini-2.5-pro", "always-on"],
    ["models/gemini-2.5-pro-preview-06-05", "always-on"],
    ["gemini-3-pro-preview", "always-on"],
    ["gemini-3.5-pro", "always-on"],
    ["gemini-3.1-flash", "leveled"],
    ["gemini-3-flash-preview", "leveled"],
    ["gemini-3.5-flash-lite", "leveled"],
    ["models/gemini-3.5-flash-lite", "leveled"],
    ["gemini-3.5-flashy", "always-on"],
    ["gemini-2.0-flash", "none"],
    ["gemini-1.5-pro", "none"],
    ["gemini-2.5-flashy", "none"],
    ["my-custom-model", "none"],
  ] as const)("%s → %s", (model, expected) => {
    expect(thinkingCapability(model)).toBe(expected);
  });
});
