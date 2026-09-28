import { LogThrottle } from "@flow-gatekeeper/shared/logging";

export interface ThrottledErrorReporter {
  /** 記一則連線錯誤：放行時才呼叫 `log`，參數為自上次放行以來被壓掉的次數。 */
  error(conn: string, log: (suppressed: number) => void): void;
  /** 連線恢復：先前有錯誤紀錄時呼叫 `log`（參數為尚未回報的被壓次數）並清掉該連線狀態。 */
  recovered(conn: string, log: (suppressed: number) => void): void;
}

/**
 * 以連線名分組的錯誤轉態節流（main.ts 的 Redis／BullMQ 連線錯誤共用一份）。節流器本體為
 * `@flow-gatekeeper/shared/logging` 的 `LogThrottle`（與 api 共用同一份實作）。
 *
 * 存在理由：Redis 不可達或認證失敗時，ioredis 每 100–270 ms 重連一次、每條連線各自 emit
 * `error`；不節流就是每秒數行 warn，把 docker json-file log 與日誌收集端灌爆。
 *
 * 語意與 api 的 `ConnectionErrorThrottle`（`@flow-gatekeeper/shared/logging`，由
 * `apps/api/src/lib/connection-error-throttle.ts` 接到 ioredis 事件）相同：健康→故障的第一則立即
 * 放行、故障中每窗一則並附被壓次數、恢復時回報被壓次數並重置。差別只在分組方式——api 每條連線
 * 一個實例；worker 多條連線共用一個 `LogThrottle`、以連線名為 key。
 *
 * key **只用連線名、不看錯誤訊息**（因此 `error` 不收錯誤物件，由呼叫端的 `log` 自行帶出）：
 * 若把訊息納入 key，帶 jobId 之類變動內容的錯誤（例如 BullMQ lock 續租失敗）每則都是新 key——
 * 節流形同失效，Map 也只在 `ready` 時才清、會無上限成長。代價是窗內換了另一種錯誤也會被壓，
 * 但被壓次數會在下一則放行時一併回報，第一則的內容已足以定位故障。
 */
export function createThrottledErrorReporter(
  intervalMs: number,
  now: () => number = Date.now,
): ThrottledErrorReporter {
  const throttle = new LogThrottle(intervalMs);
  return {
    error(conn, log) {
      const pass = throttle.hit(conn, now());
      if (pass) log(pass.suppressed);
    },
    recovered(conn, log) {
      const r = throttle.reset(conn);
      if (r) log(r.suppressed);
    },
  };
}
