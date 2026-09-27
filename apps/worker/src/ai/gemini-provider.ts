import { ApiError, FinishReason, GoogleGenAI } from "@google/genai";
import type { GenerateContentConfig, ThinkingConfig } from "@google/genai";
import { AiProviderError } from "./provider.js";
import type { AiFinishReason, AiProvider, AiStreamRequest, AiStreamResult, AiUsage } from "./provider.js";

/**
 * Gemini adapter（憲章 V／research D4）——唯一依賴 `@google/genai` 之處。
 *
 * 從已 EOL 的 `@google/generative-ai` 遷移而來，換來三件舊 SDK 做不到的事：
 * - `config.abortSignal`：核心的逾時訊號直接中止底層 HTTP 串流（舊版只能 `Promise.race`，
 *   逾時後串流仍在背景跑、繼續 publish token）。
 * - `responseMimeType`＋`responseJsonSchema`：原生 structured output，`parseResult` 退為最後防線。
 * - 正式的 `thinkingConfig` 型別，不必再手動擴充 GenerationConfig。
 * 舊版還需要 `result.response.catch()` 吞掉背景彙總 promise 的 rejection；新 SDK 的串流是單一
 * AsyncGenerator，錯誤只會從 for-await 拋出，該 workaround 已不需要。
 *
 * 不設 SDK 內建重試（`httpOptions.retryOptions` 預設即關閉）：重試由 BullMQ attempts 統一負責，
 * 兩層重試疊加會讓一次失敗放大成 attempts × SDK 重試次數的 LLM 呼叫。
 */
/** 缺金鑰時的錯誤訊息（匯出供測試比對）。 */
export const MISSING_API_KEY_MESSAGE =
  "GEMINI_API_KEY 未設定（apps/worker/.env）：API key not valid or missing";

export class GeminiProvider implements AiProvider {
  readonly id = "gemini";
  // SDK client 延遲到第一次呼叫才建：空金鑰時 `new GoogleGenAI()` 會直接 console.warn，
  // 繞過 pino 結構化日誌；而缺金鑰本來就由 streamDiagnosis 開頭以明確錯誤處理。
  private client: GoogleGenAI | undefined;

  constructor(
    private readonly apiKey: string,
    readonly model: string,
  ) {}

  async streamDiagnosis(req: AiStreamRequest): Promise<AiStreamResult> {
    const { prompt, signal, onToken, responseJsonSchema } = req;
    if (!this.apiKey) {
      // 缺金鑰重試幾次都一樣：不可重試 → 核心轉 UnrecoverableError，第一次嘗試就通知前端。
      // 訊息刻意含「API key not valid」：前端 humanizeError 的金鑰分支比對的是這個片語（單純
      // "api key" 不會命中），命中後顯示「請確認 apps/worker/.env 的 GEMINI_API_KEY」友善句。
      throw new AiProviderError(MISSING_API_KEY_MESSAGE, {
        retryable: false,
        code: "provider_error",
      });
    }
    this.client ??= new GoogleGenAI({ apiKey: this.apiKey });
    const ai = this.client;
    const config: GenerateContentConfig = {
      abortSignal: signal,
      responseMimeType: "application/json",
      ...(responseJsonSchema ? { responseJsonSchema } : {}),
    };
    const thinkingConfig = thinkingConfigFor(this.model);
    if (thinkingConfig) config.thinkingConfig = thinkingConfig;

    let text = "";
    let finishReason: AiFinishReason = "other";
    let usage: AiUsage | undefined;
    try {
      const stream = await ai.models.generateContentStream({ model: this.model, contents: prompt, config });
      for await (const chunk of stream) {
        // 雙保險：即使 SDK 在 abort 後仍吐出已緩衝的 chunk，也不再往外送 token。
        if (signal.aborted) break;
        const piece = chunk.text; // 新 SDK 是 getter，不是方法
        if (piece) {
          text += piece;
          onToken(piece);
        }
        if (chunk.promptFeedback?.blockReason) finishReason = "safety";
        const reason = chunk.candidates?.[0]?.finishReason;
        if (reason) finishReason = mapFinishReason(reason);
        if (chunk.usageMetadata) {
          usage = {
            inputTokens: chunk.usageMetadata.promptTokenCount,
            outputTokens: chunk.usageMetadata.candidatesTokenCount,
            totalTokens: chunk.usageMetadata.totalTokenCount,
          };
        }
      }
    } catch (err) {
      throw classifyGeminiError(err, signal);
    }
    if (signal.aborted) throw classifyGeminiError(signal.reason, signal);
    return { text, finishReason, usage };
  }
}

/**
 * 依模型名決定 thinking 設定（純函式，可單測）。
 *
 * gemini-2.5 系列預設開啟 thinking，首個 token 前會先「思考」數秒～十數秒，拖垮「首 token ≤ 5s」
 * 的回應性目標；診斷輸出是結構化 JSON、不需長推理鏈，所以能關就關。但 `thinkingBudget: 0`
 * 並非所有模型都接受：
 * - `gemini-2.5-flash`、`gemini-2.5-flash-lite`（含其 preview 變體）：接受 0＝關閉 → 送。
 * - `gemini-2.5-pro`：thinking 不可關閉，送 0 會被拒 → 不送（沿用模型預設）。
 * - 2.0 以前的模型沒有 thinking；3.x 以後改用 `thinkingLevel` 語意 → 都不送，避免送出模型
 *   不認得的設定而整批 400。要調整新系列時，在這裡依名稱加分支。
 */
export function thinkingConfigFor(model: string): ThinkingConfig | undefined {
  const name = model.replace(/^models\//, "");
  if (/^gemini-2\.5-flash(?:$|-)/.test(name)) return { thinkingBudget: 0 };
  return undefined;
}

function mapFinishReason(reason: FinishReason): AiFinishReason {
  switch (reason) {
    case FinishReason.STOP:
      return "stop";
    case FinishReason.MAX_TOKENS:
      return "max_tokens";
    case FinishReason.SAFETY:
    case FinishReason.BLOCKLIST:
    case FinishReason.PROHIBITED_CONTENT:
    case FinishReason.SPII:
      return "safety";
    default:
      return "other";
  }
}

/** 這些 HTTP 狀態重試幾次都一樣（金鑰／權限／請求形狀／模型名錯）→ 不可重試。 */
const NON_RETRYABLE_STATUS = new Set([400, 401, 403, 404]);

/**
 * 把 SDK 錯誤翻成 `AiProviderError`（純函式，可單測）。訊息保留供應商原文：前端的
 * `humanizeError` 靠原文裡的關鍵字（API key not valid／unregistered／429…）對應友善句。
 */
export function classifyGeminiError(err: unknown, signal?: AbortSignal): AiProviderError {
  if (err instanceof AiProviderError) return err;
  if (signal?.aborted) {
    return new AiProviderError("AI streaming timeout（已中止串流）", {
      retryable: true,
      code: "ai_timeout",
      cause: err,
    });
  }
  if (err instanceof ApiError) {
    return new AiProviderError(err.message, {
      retryable: !NON_RETRYABLE_STATUS.has(err.status),
      code: "provider_error",
      status: err.status,
      cause: err,
    });
  }
  const message = err instanceof Error ? err.message : String(err);
  // 網路層錯誤（ECONNRESET、DNS…）通常是暫時性的 → 可重試。
  return new AiProviderError(message, { retryable: true, code: "provider_error", cause: err });
}
