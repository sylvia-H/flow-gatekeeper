import { withDeadline } from "../../lib/telemetry-buffer.js";

/**
 * 兩支 relay 關閉各自 Redis 連線（`QueueEvents.close()`／subscriber `quit()`）的時限（API-12）。
 *
 * Redis 正常時 close 只要數十毫秒；Redis 不可達或密碼錯時 `quit()` 排在 offline queue、`QueueEvents.close()`
 * 等底層連線 ready，兩者都可能永不 resolve，讓 `app.close()` 卡到 compose `stop_grace_period`（15 s）
 * 被 SIGKILL。3 s 給慢網路留餘裕，同時只吃掉 api 關閉總時限（12 s，main.ts）的一小段——兩支 relay
 * 在同一模組的 destroy 階段並行關閉，其餘時間留給遙測 flush 與 Mongo 關閉。
 */
export const RELAY_CLOSE_DEADLINE_MS = 3_000;

/**
 * 在 `ms` 內等 `close()` 結束；逾時呼叫 `onTimeout` 並以 `disconnect()` 強制斷線（best-effort，不等它、
 * 不拋出——bullmq 的 `disconnect()` 同樣會等底層連線 ready，Redis 不可達時也可能不 resolve）。
 * close 本身的錯誤一律吞掉：關閉流程只關心「有沒有在時限內結束」。回傳 true 表示如期關閉。
 */
export async function closeWithDeadline(
  close: () => Promise<unknown>,
  disconnect: () => unknown,
  onTimeout: (ms: number) => void,
  ms: number = RELAY_CLOSE_DEADLINE_MS,
): Promise<boolean> {
  // 包成 promise 再交給 withDeadline：同步拋出的 close 也算「已結束」，不讓例外中斷關閉流程。
  const closing = Promise.resolve().then(close);
  const closed = await withDeadline(closing, ms);
  if (closed) return true;
  onTimeout(ms);
  try {
    const result = disconnect();
    if (result instanceof Promise) result.catch(() => undefined);
  } catch {
    // 強制斷線失敗也不影響關閉流程：行程終究由 main.ts 的總時限收尾。
  }
  return false;
}
