import "dotenv/config";
import { GoogleGenerativeAI } from "@google/generative-ai";

/**
 * LLM 連通性 smoke（FR-017／指南 §8.2）——接入 queue 前的護欄。
 * 用 `.env` 的 `GEMINI_API_KEY`／`GEMINI_MODEL` 呼叫一次 `generateContent` 並印出回覆，
 * 確認 API key、模型名稱與額度可用。執行：`pnpm --filter @flow-gatekeeper/worker smoke:gemini`
 *
 * 一次性 CLI 腳本，依 Feature 009 FR-004／SC-001 範圍界定不納入結構化日誌、維持人類可讀
 * `console.error` 輸出（`specs/009-observability-baseline/contracts/log-fields.md §8`）。
 */
async function main(): Promise<void> {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
  if (!apiKey) {
    console.error("[smoke:gemini] 缺少 GEMINI_API_KEY（請於 apps/worker/.env 設定）");
    process.exit(1);
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const result = await genAI
    .getGenerativeModel({ model })
    .generateContent("用一句話回覆：flow-gatekeeper worker 連線正常。");
  console.log(`[smoke:gemini] model=${model} 回覆：`, result.response.text());
}

void main().catch((err: unknown) => {
  console.error("[smoke:gemini] 失敗：", err instanceof Error ? err.message : err);
  process.exit(1);
});
