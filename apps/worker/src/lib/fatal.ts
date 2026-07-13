import { writeSync } from "node:fs";

/**
 * 致命事件（007 let it crash）——訊息格式化與立即退出。
 *
 * 運維層契約（contracts/supervision-runtime.md §5、data-model E4）：
 *   `[worker] <kind>（致命，worker 將結束交由監督者重啟）：<detail>`
 * `detail`＝Error 取 `stack ?? message`、非 Error 值一律 `String(value)`（FR-003 一致處理）。
 *
 * `fatal()` 記錄後**立即以非零碼結束行程**、不嘗試關閉任何連線（research D7）：
 * 致命後行程狀態未定義，任何「盡力收尾」都可能卡住或二次拋錯；殘留連線與鎖由
 * TCP 斷線、BullMQ lock 過期與 ai-lock TTL 自然回收，重建交由監督者重啟後的乾淨行程。
 * exit code 即監督語意：`1` → `restart: on-failure` 自動重啟；優雅關閉 `exit(0)` 不重啟。
 *
 * 致命訊息**必須**用同步 `writeSync(fd 2)` 寫出、不用 `console.error`：POSIX 上寫到 pipe 的
 * stderr 是非同步的（Docker 內 container stderr 即 pipe），`console.error` 之後緊接
 * `process.exit(1)` 會在緩衝區 flush 前中止行程、丟失致命日誌——而這正是 §5 觀測契約與
 * quickstart 崩潰演練唯一要看到的那一行。`writeSync` 保證退出前落地。
 */

export type FatalKind = "uncaughtException" | "unhandledRejection";

/** 純函式：組致命訊息（不含 `[worker] ` 前綴，前綴由 log 層統一）。 */
export function formatFatal(kind: FatalKind, value: unknown): string {
  const detail = value instanceof Error ? (value.stack ?? value.message) : String(value);
  return `${kind}（致命，worker 將結束交由監督者重啟）：${detail}`;
}

/** 記錄致命訊息後立即以非零碼結束行程，交由監督者重啟。 */
export function fatal(kind: FatalKind, value: unknown): never {
  // 同步寫 stderr（fd 2）：保證致命日誌在 process.exit 前落地，不被非同步 pipe 緩衝丟失。
  writeSync(2, `[worker] ${formatFatal(kind, value)}\n`);
  process.exit(1);
}
