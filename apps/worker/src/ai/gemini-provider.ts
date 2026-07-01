import { GoogleGenerativeAI } from "@google/generative-ai";
import type { AiProvider } from "./provider.js";

/**
 * Gemini adapter（憲章 V／research D4）——唯一依賴 `@google/generative-ai` 之處。
 *
 * 只負責「串流文字」：逐 chunk 呼叫 `onToken` 並累加回傳全文；以 `AI_TIMEOUT_MS`（預設
 * 30000，FR-020）包一層應用層逾時，逾時 throw（由 worker 轉 `ai/error` 並依重試策略處理）。
 * JSON 解析與 schema 驗證不在此（留在 worker `parseResult`）。
 */
export class GeminiProvider implements AiProvider {
  private readonly genAI: GoogleGenerativeAI;

  constructor(
    apiKey: string,
    private readonly model: string,
    private readonly timeoutMs: number,
  ) {
    this.genAI = new GoogleGenerativeAI(apiKey);
  }

  async streamDiagnosis(prompt: string, onToken: (text: string) => void): Promise<string> {
    const model = this.genAI.getGenerativeModel({ model: this.model });
    const run = (async (): Promise<string> => {
      let full = "";
      const result = await model.generateContentStream(prompt);
      for await (const chunk of result.stream) {
        const text = chunk.text();
        if (text) {
          full += text;
          onToken(text);
        }
      }
      return full;
    })();
    return withTimeout(run, this.timeoutMs);
  }
}

/** 以 timeoutMs 為上限競速；逾時 reject（FR-020）。 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`AI streaming timeout after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
