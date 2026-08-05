import { DiagnosisResultSchema } from "@flow-gatekeeper/contracts";
import type { DiagnosisResult } from "@flow-gatekeeper/contracts";

/**
 * 從串流文字抽出診斷 JSON 並驗證（純函式，FR-012／FR-018，可單測）。
 *
 * LLM 常在 JSON 前後夾雜文字或 ```json 圍欄——取**第一個 `{` 到最後一個 `}`**的子字串再
 * `JSON.parse`，最後以 `DiagnosisResultSchema.parse()` 驗證。無 JSON、JSON 壞掉或 schema
 * 不合法一律 throw（由 worker 轉 `ai/error`，MUST NOT 把未驗證物件當結果）。
 */
export function parseResult(text: string): DiagnosisResult {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("parseResult: no JSON object found in AI output");
  }
  const json = text.slice(start, end + 1);
  const parsed: unknown = JSON.parse(json); // 壞 JSON → SyntaxError
  return DiagnosisResultSchema.parse(parsed); // 缺欄位／型別錯 → ZodError
}
