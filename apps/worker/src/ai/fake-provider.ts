import type { DiagnosisResult } from "@flow-gatekeeper/contracts";
import { AiProviderError } from "./provider.js";
import type { AiProvider, AiStreamRequest, AiStreamResult } from "./provider.js";

/**
 * 假 LLM provider（**測試替身，僅供 e2e／演練**；review02 §6 Batch D）。
 *
 * 以 `AI_PROVIDER=fake` 啟用（見 `lib/env-schema.ts`、`main.ts` 的 `selectAiProvider`）。它照樣走
 * `AiProvider` interface（CLAUDE.md 硬規則 4）——processor 的取鎖、限流、schema 驗證、快取、
 * Pub/Sub 串流全部是真的，只把「打 Gemini」換成「以固定延遲逐段吐出一份固定的診斷 JSON」。
 * 用途是讓跨 process e2e 不需金鑰、不耗配額、結果可重現，且串流夠長，足以在中途 kill worker。
 *
 * 輸出 MUST 通過 `DiagnosisResultSchema`（硬規則 6）：processor 仍會 `parseResult()` 驗證，
 * 本檔的單元測試另外斷言這一點。
 */

/** fake provider 的模型名（進 cache signature：不會與 gemini 的快取互相命中）。 */
export const FAKE_MODEL = "fake-diagnosis-v1";

export interface FakeProviderOptions {
  /** 相鄰兩段 token 之間的延遲（毫秒）；0＝不延遲。 */
  tokenDelayMs: number;
  /** 把診斷 JSON 切成幾段送出（實際段數不超過 JSON 字元數）。 */
  tokenCount: number;
}

/** 固定的假診斷；`summary` 明示來源，避免被誤認為真實 AI 判讀。 */
export function fakeDiagnosis(): DiagnosisResult {
  return {
    summary: "[fake provider] 測試用假診斷：非真實 AI 判讀，僅供 e2e 與演練。",
    severity: "warning",
    likelyCauses: ["fake-cause：測試替身固定輸出"],
    suggestedActions: [{ label: "此為測試輸出，無需處置", priority: "low" }],
    evidence: [{ source: "telemetry", excerpt: "fake provider 未讀取實際遙測" }],
  };
}

/** 假診斷序列化後的字元數：切段數的實際上限（`FAKE_AI_TOKENS` 超過此值即以此為準）。 */
export const FAKE_DIAGNOSIS_TEXT_LENGTH = JSON.stringify(fakeDiagnosis()).length;

/** 把字串切成至多 `count` 段、長度盡量平均的片段（純函式，可單測）。 */
export function splitIntoChunks(text: string, count: number): string[] {
  const n = Math.max(1, Math.min(Math.floor(count), text.length));
  const chunks: string[] = [];
  for (let i = 0; i < n; i++) {
    const start = Math.floor((i * text.length) / n);
    const end = Math.floor(((i + 1) * text.length) / n);
    chunks.push(text.slice(start, end));
  }
  return chunks;
}

export class FakeAiProvider implements AiProvider {
  readonly id = "fake";
  readonly model = FAKE_MODEL;

  constructor(readonly options: Readonly<FakeProviderOptions>) {}

  async streamDiagnosis(req: AiStreamRequest): Promise<AiStreamResult> {
    const { signal, onToken } = req;
    const text = JSON.stringify(fakeDiagnosis());
    const chunks = splitIntoChunks(text, this.options.tokenCount);
    for (const [i, chunk] of chunks.entries()) {
      if (i > 0 && this.options.tokenDelayMs > 0) await delay(this.options.tokenDelayMs, signal);
      // 與 Gemini adapter 同一語意：abort 後不再往外送 token，並以可重試錯誤結束。
      if (signal.aborted) throw abortedError(signal);
      onToken(chunk);
    }
    // 假 token 數＝實際送出的段數（不是字元數）。
    return { text, finishReason: "stop", usage: { outputTokens: chunks.length } };
  }
}

function abortedError(signal: AbortSignal): AiProviderError {
  return new AiProviderError("fake provider aborted", {
    retryable: true,
    code: "ai_timeout",
    cause: signal.reason,
  });
}

/** 可被 signal 中斷的延遲：abort 時立即 reject，不讓 processor 等到下一段才發現逾時。 */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(abortedError(signal));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortedError(signal));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
