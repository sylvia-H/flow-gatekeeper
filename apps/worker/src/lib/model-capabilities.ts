/**
 * Gemini 模型能力判定（純函式、不依賴 SDK）——`env-schema` 的啟動警告與 `GeminiProvider` 的
 * thinking 設定共用同一份判準，避免兩邊對「哪些模型能關 thinking」各寫一套而漂移。
 */

/**
 * - `disableable`：有 thinking、可用 `thinkingBudget: 0` 關閉（`gemini-2.5-flash`、`-flash-lite` 與其 preview 變體）。
 * - `leveled`：有 thinking、以 `thinkingLevel` 指定等級（3.x 以後的 `flash`／`flash-lite` 與其 preview 變體）；
 *   送 `thinkingBudget: 0` 會 400，改送 `THINKING_LEVEL`。
 * - `always-on`：有 thinking 且不送任何設定（`gemini-2.5-pro`；3.x 以後的 pro 等其他變體，最低等級仍會思考）。
 * - `none`：沒有 thinking（2.0 以前）或無法辨識的名稱——不送任何 thinking 設定、也不警告。
 */
export type ThinkingCapability = "disableable" | "leveled" | "always-on" | "none";

/**
 * `leveled` 模型送出的 thinking 等級（2026-10 使用者裁決：MEDIUM）。
 * 實測 `gemini-3.5-flash-lite` 短 prompt：MEDIUM 首 token 約 2 秒、thoughts 約 450 token；
 * HIGH 約 2.5 秒／600 token；LOW、MINIMAL 不到 1 秒但幾乎不思考。值與 SDK `ThinkingLevel` 列舉字串相同。
 */
export const THINKING_LEVEL = "MEDIUM";

/** 不能關 thinking 的模型，`AI_MAX_OUTPUT_TOKENS` 低於此值時啟動即警告（thinking token 也計入上限）。 */
export const MIN_OUTPUT_TOKENS_WITH_THINKING = 8192;

/**
 * `leveled` 模型的同類警告門檻：`THINKING_LEVEL` 下真實診斷 prompt 實測 thoughts 約 1000＋結果約 250，
 * 4096 留約 3 倍餘裕（亦為 `AI_MAX_OUTPUT_TOKENS` 預設值）。
 */
export const MIN_OUTPUT_TOKENS_WITH_THINKING_LEVEL = 4096;

/**
 * 只依名稱判定：`gemini-flash-lite-latest` 這類別名、或大小寫不同的名稱判為 `none`（不送設定、不警告），請在 env 寫完整模型名。
 * 3.x 的 `flash-*` 一律歸 `leveled`，含 image／live 等非文字變體——診斷不使用這類模型，若改用需另行確認是否接受 `thinkingLevel`。
 */
export function thinkingCapability(model: string): ThinkingCapability {
  const name = model.replace(/^models\//, "");
  if (/^gemini-2\.5-flash(?:$|-)/.test(name)) return "disableable";
  if (/^gemini-2\.5-pro(?:$|-)/.test(name)) return "always-on";
  const match = /^gemini-(\d+)(?:\.\d+)?(?:$|-(.*))/.exec(name);
  if (match === null || Number(match[1]) < 3) return "none";
  return /^flash(?:$|-)/.test(match[2] ?? "") ? "leveled" : "always-on";
}
