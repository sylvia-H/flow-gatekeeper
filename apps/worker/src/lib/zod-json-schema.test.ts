import { describe, expect, it } from "vitest";
import { z } from "zod";
import { DIAGNOSIS_RESULT_JSON_SCHEMA, toGeminiJsonSchema } from "./zod-json-schema.js";

/**
 * 升級 Zod 4 前由手寫轉換產出的 schema。改用 `z.toJSONSchema()` 後 MUST 逐鍵（含鍵序）相同：
 * 這份 JSON 會以 `JSON.stringify` 嵌進 prompt，字串一變就等於改了 prompt，
 * 必須同步升 `PROMPT_VERSION` 讓舊 cache 失效。
 */
const EXPECTED = {
  type: "object",
  properties: {
    summary: { type: "string" },
    severity: { type: "string", enum: ["ok", "warning", "critical"] },
    likelyCauses: { type: "array", items: { type: "string" } },
    suggestedActions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          label: { type: "string" },
          priority: { type: "string", enum: ["low", "medium", "high"] },
          command: { type: "string" },
        },
        required: ["label", "priority"],
        propertyOrdering: ["label", "priority", "command"],
      },
    },
    evidence: {
      type: "array",
      items: {
        type: "object",
        properties: {
          source: { type: "string", enum: ["telemetry", "errorlog", "maintenance"] },
          id: { type: "string" },
          excerpt: { type: "string" },
        },
        required: ["source", "excerpt"],
        propertyOrdering: ["source", "id", "excerpt"],
      },
    },
  },
  required: ["summary", "severity", "likelyCauses", "suggestedActions", "evidence"],
  propertyOrdering: ["summary", "severity", "likelyCauses", "suggestedActions", "evidence"],
};

describe("toGeminiJsonSchema", () => {
  it("DiagnosisResultSchema 轉出與升級前逐鍵相同（含鍵序，prompt 文字不變）", () => {
    expect(DIAGNOSIS_RESULT_JSON_SCHEMA).toEqual(EXPECTED);
    expect(JSON.stringify(DIAGNOSIS_RESULT_JSON_SCHEMA)).toBe(JSON.stringify(EXPECTED));
  });

  it("不含 Gemini 不接受的 $schema 與 additionalProperties", () => {
    const text = JSON.stringify(DIAGNOSIS_RESULT_JSON_SCHEMA);
    expect(text).not.toContain("$schema");
    expect(text).not.toContain("additionalProperties");
  });

  it.each<[string, z.ZodType]>([
    ["pattern", z.object({ a: z.string().regex(/^x$/) })],
    ["minLength", z.object({ a: z.string().min(1) })],
    ["const", z.object({ a: z.literal("x") })],
  ])("契約出現 Gemini 不支援的鍵（%s）直接 throw，不靜默送出錯 schema", (_key, schema) => {
    expect(() => toGeminiJsonSchema(schema)).toThrow(/不支援/);
  });

  it("Zod 無法表達成 JSON Schema 的型別直接 throw", () => {
    expect(() => toGeminiJsonSchema(z.object({ at: z.date() }))).toThrow();
  });
});
