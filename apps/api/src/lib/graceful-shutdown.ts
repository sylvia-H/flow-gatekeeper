import { withDeadline } from "./telemetry-buffer.js";

/**
 * api 關閉流程的總時限（API-12，裁決 5）。compose 的 `stop_grace_period: 15s` 到期會 SIGKILL（137），
 * 非零退出會被 `on-failure` 誤判為崩潰；留 3 秒餘裕給行程退出本身。
 */
export const SHUTDOWN_TOTAL_DEADLINE_MS = 12_000;

/**
 * 第一次訊號後的「同名重送」忽略窗（使用者裁決）：這段時間內再收到**同一種**訊號一律忽略，不算第二次。
 * POSIX dev 環境下按 Ctrl+C，終端機會對整個前景 process group 送 SIGINT，`tsc --watch`／`nest start`
 * 這類 watch 工具轉發時又送一次，兩者常在數十毫秒內先後到達；若照算，優雅關閉就被跳過。
 */
export const DUPLICATE_SIGNAL_WINDOW_MS = 1_000;

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
 *   `app.close()` 卡住，dev 按 Ctrl+C 再多次也停不下來。例外：第一次訊號後
 *   `DUPLICATE_SIGNAL_WINDOW_MS` 內的**同名**訊號視為同一次按鍵的重送，忽略。
 *   不同名的訊號（例如先 SIGTERM 再 SIGINT）不套用忽略窗、立即退出：重送只會是同一種訊號，
 *   不同種類代表另一個來源（監督者 SIGTERM 之後使用者按 Ctrl+C）真的要它立刻停。
 * `exit` 只會被呼叫一次（逾時計時器與第二次訊號不重複退出）。
 */
export function createShutdownHandler(opts: {
  close: () => Promise<void>;
  exit: (code: number) => void;
  log: ShutdownLog;
  deadlineMs?: number;
  duplicateWindowMs?: number;
  now?: () => number;
}): (signal: string) => Promise<void> {
  const duplicateWindowMs = opts.duplicateWindowMs ?? DUPLICATE_SIGNAL_WINDOW_MS;
  const now = opts.now ?? Date.now;
  let first: { signal: string; at: number } | undefined;
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
      if (first && signal === first.signal && now() - first.at < duplicateWindowMs) {
        opts.log.info(`ignoring duplicate ${signal} within ${duplicateWindowMs}ms of the first one`);
        return;
      }
      opts.log.warn(`received ${signal} again during shutdown, exiting immediately`);
      exitOnce();
      return;
    }
    shuttingDown = true;
    first = { signal, at: now() };
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
