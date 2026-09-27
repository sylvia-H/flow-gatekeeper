import { z } from "zod";
import { DiagnosisResultSchema } from "@flow-gatekeeper/contracts";

/**
 * 從 Zod schema 推導 Gemini `responseJsonSchema` 可接受的 JSON Schema，讓 provider 的原生
 * structured output 與 prompt 內的結構說明都出自 `DiagnosisResultSchema` 這個單一來源，
 * 而不是再手寫一份平行定義。
 *
 * 轉換本身交給 Zod 4 內建的 `z.toJSONSchema()`（升級前是手寫的 `_def.typeName` 分派），這裡只做
 * Gemini 端的整形：
 * - `io: "input"`：描述 `DiagnosisResultSchema.parse()` 會接受的形狀（模型輸出正是 parse 的輸入）；
 *   z.object 預設 strip，input 模式不輸出 `additionalProperties`。
 * - 移除 `$schema`（Gemini 不接受）。
 * - 每個物件補上非標準的 `propertyOrdering`：Gemini 依此順序產生欄位，讓串流中的 JSON
 *   可讀性穩定（summary 先出現）。
 * - 只允許 `@google/genai` 2.24 `GenerateContentConfig.responseJsonSchema` 型別註解列出的鍵；
 *   契約若加了 Gemini 不支援的限制（如 `pattern`、`minLength`、`const`），模組載入當下
 *   （及單元測試）就 throw，不會靜默送出會被 API 拒絕或被忽略的 schema。
 */
type JsonSchema = Record<string, unknown>;

/** `@google/genai` 2.24 `responseJsonSchema` 文件列出的支援鍵（外加非標準的 `propertyOrdering`）。 */
const GEMINI_SUPPORTED_KEYS: ReadonlySet<string> = new Set([
  "$id",
  "$defs",
  "$ref",
  "$anchor",
  "type",
  "format",
  "title",
  "description",
  "enum",
  "items",
  "prefixItems",
  "minItems",
  "maxItems",
  "minimum",
  "maximum",
  "anyOf",
  "oneOf",
  "properties",
  "additionalProperties",
  "required",
  "propertyOrdering",
]);

function isObject(value: unknown): value is JsonSchema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 遞迴整形：驗證鍵皆受支援、為物件補 `propertyOrdering`。 */
function toGeminiNode(node: unknown, path: string): unknown {
  if (Array.isArray(node)) return node.map((item, i) => toGeminiNode(item, `${path}[${i}]`));
  if (!isObject(node)) return node;
  const out: JsonSchema = {};
  for (const [key, value] of Object.entries(node)) {
    if (!GEMINI_SUPPORTED_KEYS.has(key)) {
      throw new Error(`toGeminiJsonSchema: Gemini responseJsonSchema 不支援 ${path}.${key}`);
    }
    if ((key === "properties" || key === "$defs") && isObject(value)) {
      const props: JsonSchema = {};
      for (const [name, sub] of Object.entries(value)) {
        props[name] = toGeminiNode(sub, `${path}.${key}.${name}`);
      }
      out[key] = props;
    } else {
      // 其餘鍵（含 enum／required 等純值陣列）走通用遞迴：原始值原樣返回、陣列逐項複製，輸出與直通相同
      out[key] = toGeminiNode(value, `${path}.${key}`);
    }
  }
  if (isObject(out.properties) && out.propertyOrdering === undefined) {
    out.propertyOrdering = Object.keys(out.properties);
  }
  return out;
}

export function toGeminiJsonSchema(schema: z.ZodType): JsonSchema {
  const raw = z.toJSONSchema(schema, { io: "input", unrepresentable: "throw", cycles: "throw" }) as JsonSchema;
  const { $schema: _ignored, ...rest } = raw;
  return toGeminiNode(rest, "$") as JsonSchema;
}

/** 診斷結果的 JSON Schema（模組載入時產生一次）。 */
export const DIAGNOSIS_RESULT_JSON_SCHEMA: JsonSchema = toGeminiJsonSchema(DiagnosisResultSchema);
