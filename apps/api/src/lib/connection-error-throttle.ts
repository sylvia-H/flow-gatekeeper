import { ConnectionErrorThrottle } from "@flow-gatekeeper/shared/logging";

// 轉態節流器 `ConnectionErrorThrottle` 與通用節流窗常數 `ERROR_LOG_THROTTLE_MS` 已收進
// `@flow-gatekeeper/shared/logging`（與 worker 共用同一份實作）；此檔只留 ioredis 事件接線。

/** 可掛 `error`／`ready` 監聽的連線（ioredis `Redis` 即符合）。 */
export type ConnectionEvents = {
  on(event: "error", listener: (err: Error) => void): unknown;
  on(event: "ready", listener: () => void): unknown;
};

export type ThrottledConnectionLog = {
  /** 放行的錯誤；`suppressed` 為上次放行以來壓掉的則數。 */
  error(err: Error, suppressed: number): void;
  /** 故障後恢復。 */
  recovered(suppressed: number): void;
};

/**
 * 把 `ConnectionErrorThrottle` 接到連線的 `error`／`ready` 事件上。`error` 監聽 MUST 存在
 * （沒有監聽者時 EventEmitter 會把 error 當未捕捉例外拋出、行程結束），故此處一律掛上，只是節流輸出。
 */
export function attachThrottledErrorLog(
  connection: ConnectionEvents,
  log: ThrottledConnectionLog,
  opts: { intervalMs?: number; now?: () => number } = {},
): ConnectionErrorThrottle {
  const throttle = new ConnectionErrorThrottle(opts.intervalMs);
  const now = opts.now ?? Date.now;
  connection.on("error", (err) => {
    const decision = throttle.onError(now());
    if (decision.log) log.error(err, decision.suppressed);
  });
  connection.on("ready", () => {
    const decision = throttle.onReady();
    if (decision.log) log.recovered(decision.suppressed);
  });
  return throttle;
}
