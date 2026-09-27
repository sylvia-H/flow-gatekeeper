import type { z } from "zod";
import { DiagnosisResultSchema } from "@flow-gatekeeper/contracts";

/**
 * 從 Zod schema 推導 JSON Schema（最小子集），讓 provider 的原生 structured output 與 prompt
 * 內的結構說明都出自 `DiagnosisResultSchema` 這個單一來源，而不是再手寫一份平行定義。
 *
 * 為什麼不用 `zod-to-json-schema`：它只裝在 contracts 的 devDependencies，worker 執行期拿不到；
 * 而 DiagnosisResultSchema 只用到 object／string／enum／array／optional 這幾種型別，
 * 手寫轉換足夠且沒有額外相依。遇到未支援的型別直接 throw——契約若加了新型別，模組載入
 * 當下（及單元測試）就會失敗，不會靜默送出錯的 schema。
 *
 * 以 `_def.typeName` 判斷而非 `instanceof`：避免 worker 與 contracts 解析到不同 zod 實例時誤判。
 */
type JsonSchema = Record<string, unknown>;

interface ZodDefLike {
  typeName?: string;
}

export function zodToJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  const def = schema._def as ZodDefLike;
  switch (def.typeName) {
    case "ZodString":
      return { type: "string" };
    case "ZodNumber":
      return { type: "number" };
    case "ZodBoolean":
      return { type: "boolean" };
    case "ZodEnum":
      return { type: "string", enum: [...(schema as z.ZodEnum<[string, ...string[]]>).options] };
    case "ZodArray":
      return { type: "array", items: zodToJsonSchema((schema as z.ZodArray<z.ZodTypeAny>).element) };
    case "ZodObject": {
      const shape = (schema as z.ZodObject<z.ZodRawShape>).shape;
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        const field = value as z.ZodTypeAny;
        const fieldDef = field._def as ZodDefLike;
        if (fieldDef.typeName === "ZodOptional") {
          properties[key] = zodToJsonSchema((field as z.ZodOptional<z.ZodTypeAny>).unwrap());
        } else {
          properties[key] = zodToJsonSchema(field);
          required.push(key);
        }
      }
      return {
        type: "object",
        properties,
        required,
        // Gemini 依此順序產生欄位，讓串流中的 JSON 可讀性穩定（summary 先出現）。
        propertyOrdering: Object.keys(shape),
      };
    }
    default:
      throw new Error(`zodToJsonSchema: 未支援的 Zod 型別 ${def.typeName ?? "(unknown)"}`);
  }
}

/** 診斷結果的 JSON Schema（模組載入時產生一次）。 */
export const DIAGNOSIS_RESULT_JSON_SCHEMA: JsonSchema = zodToJsonSchema(DiagnosisResultSchema);
