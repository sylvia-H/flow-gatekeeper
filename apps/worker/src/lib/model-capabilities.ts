/**
 * Gemini 模型能力判定（純函式、不依賴 SDK）——`env-schema` 的啟動警告與 `GeminiProvider` 的
 * thinking 設定共用同一份判準，避免兩邊對「哪些模型能關 thinking」各寫一套而漂移。
 */

/**
 * - `disableable`：有 thinking、可用 `thinkingBudget: 0` 關閉（`gemini-2.5-flash`、`-flash-lite` 與其 preview 變體）。
 * - `always-on`：有 thinking 且無法關閉（`gemini-2.5-pro`；3.x 以後改用 `thinkingLevel` 語意，最低仍會思考）。
 * - `none`：沒有 thinking（2.0 以前）或無法辨識的名稱——不送任何 thinking 設定、也不警告。
 */
export type ThinkingCapability = "disableable" | "always-on" | "none";

/** 不能關 thinking 的模型，`AI_MAX_OUTPUT_TOKENS` 低於此值時啟動即警告（thinking token 也計入上限）。 */
export const MIN_OUTPUT_TOKENS_WITH_THINKING = 8192;

export function thinkingCapability(model: string): ThinkingCapability {
  const name = model.replace(/^models\//, "");
  if (/^gemini-2\.5-flash(?:$|-)/.test(name)) return "disableable";
  if (/^gemini-2\.5-pro(?:$|-)/.test(name)) return "always-on";
  const major = /^gemini-(\d+)(?:\.\d+)?(?:$|-)/.exec(name)?.[1];
  if (major !== undefined && Number(major) >= 3) return "always-on";
  return "none";
}

/** 該模型可否以 `thinkingBudget: 0` 關閉 thinking。 */
export function canDisableThinking(model: string): boolean {
  return thinkingCapability(model) === "disableable";
}
