/**
 * LLM provider 抽象（憲章 V、research D4）。
 *
 * worker 主邏輯只依賴此 interface，替換 provider 只需更換 adapter。provider 只負責
 * 「串流文字」——JSON 解析與 `DiagnosisResultSchema` 驗證**不在** provider 內，留在
 * worker（見 `lib/parse-result.ts`）。
 */
export interface AiProvider {
  /**
   * 以串流方式取得診斷文字：每段 chunk 呼叫 `onToken`，並回傳累加後的全文。
   * 逾時／provider 錯誤 MUST throw（由 worker 轉 `ai/error` 並依重試策略處理）。
   */
  streamDiagnosis(prompt: string, onToken: (text: string) => void): Promise<string>;
}
