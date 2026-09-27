/**
 * LLM provider 抽象（憲章 V、research D4）。
 *
 * worker 主邏輯只依賴此 interface，替換 provider 只需更換 adapter。provider 只負責
 * 「串流文字」與「把供應商的錯誤／終止原因翻成共同語彙」——JSON 解析與
 * `DiagnosisResultSchema` 驗證**不在** provider 內，留在 worker（見 `lib/parse-result.ts`）。
 *
 * 形狀刻意涵蓋第二家 provider（例如 Anthropic）也需要的東西：取消（signal）、終止原因
 * （偵測截斷／安全攔截）、用量，以及可重試與否的錯誤分類——少了任一項，換 provider 時
 * 就得回頭改 worker 核心。
 */

/** 正規化後的終止原因；各 adapter 自行把供應商的列舉對應過來。 */
export type AiFinishReason = "stop" | "max_tokens" | "safety" | "other";

export interface AiUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface AiStreamRequest {
  prompt: string;
  /**
   * 取消訊號（核心以 `AbortSignal.timeout(AI_TIMEOUT_MS)` 建立）。adapter MUST 把它交給
   * 底層 SDK，使逾時真的中止 HTTP 串流——否則背景仍有殭屍串流在呼叫 onToken。
   */
  signal: AbortSignal;
  /** 期望的輸出 JSON Schema（由 `DiagnosisResultSchema` 產生）；adapter 可用原生 structured output。 */
  responseJsonSchema?: Record<string, unknown>;
  onToken: (text: string) => void;
}

export interface AiStreamResult {
  text: string;
  finishReason: AiFinishReason;
  usage?: AiUsage;
}

export interface AiProvider {
  /** 供應商識別（進 cache signature：換供應商不共用快取）。 */
  readonly id: string;
  /** 實際使用的模型名（進 cache signature）。 */
  readonly model: string;
  /** 逾時／供應商錯誤 MUST throw `AiProviderError`（其他錯誤型別一律視為可重試）。 */
  streamDiagnosis(req: AiStreamRequest): Promise<AiStreamResult>;
}

/**
 * provider 錯誤。`retryable=false`（金鑰無效、權限不足、請求格式錯）時 worker 轉為 BullMQ
 * `UnrecoverableError`——這類錯誤重試幾次結果都一樣，退避重試只會延後使用者看到失敗。
 */
export class AiProviderError extends Error {
  readonly retryable: boolean;
  readonly code: string;
  readonly status?: number;

  constructor(message: string, opts: { retryable: boolean; code: string; status?: number; cause?: unknown }) {
    super(message, { cause: opts.cause });
    this.name = "AiProviderError";
    this.retryable = opts.retryable;
    this.code = opts.code;
    this.status = opts.status;
  }
}
