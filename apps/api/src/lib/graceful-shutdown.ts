import { withDeadline } from "./telemetry-buffer.js";

/**
 * api 關閉流程的總時限（API-12，裁決 5）。compose 的 `stop_grace_period: 15s` 到期會 SIGKILL（137），
 * 非零退出會被 `on-failure` 誤判為崩潰；留 3 秒餘裕給行程退出本身。
 */
export const SHUTDOWN_TOTAL_DEADLINE_MS = 12_000;

export type ShutdownLog = {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
};

/**
 * 建立訊號 handler（SIGTERM／SIGINT 共用）：
 * - 第一次訊號：執行 `close`（停 producer → flush → `app.close()`），至多等 `deadlineMs`；
 *   如期完成、拋錯或逾時都以 exit(0) 收場（收尾失敗不是崩潰，見 contracts §3）。逾時記 warn。
 * - 關閉中再收到訊號：立即 exit(0)。原本的重入防護直接吞掉第二次訊號，Redis 不可達時
 *   `app.close()` 卡住，dev 按 Ctrl+C 再多次也停不下來。
 * `exit` 只會被呼叫一次（逾時計時器與第二次訊號不重複退出）。
 */
export function createShutdownHandler(opts: {
  close: () => Promise<void>;
  exit: (code: number) => void;
  log: ShutdownLog;
  deadlineMs?: number;
}): (signal: string) => Promise<void> {
  const deadlineMs = opts.deadlineMs ?? SHUTDOWN_TOTAL_DEADLINE_MS;
  let shuttingDown = false;
  let exited = false;
  const exitOnce = (): void => {
    if (exited) return;
    exited = true;
    opts.exit(0);
  };

  return async (signal: string): Promise<void> => {
    if (shuttingDown) {
      opts.log.warn(`received ${signal} again during shutdown, exiting immediately`);
      exitOnce();
      return;
    }
    shuttingDown = true;
    opts.log.info(`received ${signal}, shutting down api...`);
    const work = opts.close().catch((err: unknown) => {
      opts.log.error(`shutdown error: ${err instanceof Error ? err.message : String(err)}`);
    });
    if (!(await withDeadline(work, deadlineMs))) {
      opts.log.warn(`shutdown did not finish within ${deadlineMs}ms, exiting anyway`);
    }
    exitOnce();
  };
}
