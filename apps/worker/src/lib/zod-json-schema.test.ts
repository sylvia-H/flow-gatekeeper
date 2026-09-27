import { describe, expect, it } from "vitest";
import { z } from "zod";
import { DIAGNOSIS_RESULT_JSON_SCHEMA, zodToJsonSchema } from "./zod-json-schema.js";

describe("zodToJsonSchema", () => {
  it("DiagnosisResultSchema 轉出必填欄位與 enum", () => {
    const s = DIAGNOSIS_RESULT_JSON_SCHEMA as {
      required: string[];
      properties: Record<string, { enum?: string[]; items?: { required: string[] } }>;
    };
    expect(s.required).toEqual(["summary", "severity", "likelyCauses", "suggestedActions", "evidence"]);
    expect(s.properties.severity?.enum).toEqual(["ok", "warning", "critical"]);
    // optional 欄位（command、id）不進 required
    expect(s.properties.suggestedActions?.items?.required).toEqual(["label", "priority"]);
    expect(s.properties.evidence?.items?.required).toEqual(["source", "excerpt"]);
  });

  it("未支援型別直接 throw，不靜默送出錯 schema", () => {
    expect(() => zodToJsonSchema(z.union([z.string(), z.number()]))).toThrow(/未支援/);
  });
});
