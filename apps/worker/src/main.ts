import type { Processor } from "bullmq";
import type { AiStreamEvent } from "@flow-gatekeeper/contracts";

/**
 * apps/worker entry — Feature 001 僅為可編譯的最小骨架（FR-013）。
 *
 * MUST NOT 在本 feature 連線 Redis 或啟動 BullMQ Worker；完整的 job 處理、
 * AiProvider interface、cache/lock 與 Redis Pub/Sub（`ai-stream:<jobId>`）行為
 * 留待 Feature 003。本 module 保持 side-effect-free 以利 entry smoke 測試。
 */

/** 佔位 processor 型別樣板（type-only），證明 worker 端能對齊 BullMQ 與契約型別。 */
export type DiagnosisProcessor = Processor<{ jobId: string }, AiStreamEvent>;

export function bootstrap(): void {
  // 002/003 將在此建立 BullMQ Worker 與 Redis 連線（連線分離見憲章 Principle IV）。
  console.log("flow-gatekeeper worker skeleton (001) — job 處理留待 003");
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  bootstrap();
}
