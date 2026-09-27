/**
 * 錯誤 log 轉態節流（純邏輯、不碰計時器，呼叫端傳入 `now`）。
 *
 * 存在理由：Redis 不可達或認證失敗時，ioredis 每 100–270 ms 重連一次、每條連線各自 emit
 * `error`；不節流就是每秒數行 warn，把 docker json-file log 與日誌收集端灌爆，真正的其他訊息
 * 反而被淹沒。語意與 api 的 `LogThrottle`（`apps/api/src/lib/telemetry-buffer.ts`）一致：
 * 同一個 key 在 `intervalMs` 內只放行一則，其餘累計次數，下一則放行時一併回報。
 *
 * 「轉態」：`reset(key)` 供連線恢復（`ready`）時呼叫——清掉該 key 的節流狀態並回報期間被壓掉
 * 的次數，讓「故障 → 恢復」各留一行；恢復後若再次故障，第一則會立刻放行。
 */
export class LogThrottle {
  private readonly state = new Map<string, { lastAt: number; suppressed: number }>();

  constructor(private readonly intervalMs: number) {}

  /** 回傳 `null` 表示本次應壓掉；否則回傳自上次放行以來被壓掉的次數（首次為 0）。 */
  hit(key: string, now: number): { suppressed: number } | null {
    const entry = this.state.get(key);
    if (!entry) {
      this.state.set(key, { lastAt: now, suppressed: 0 });
      return { suppressed: 0 };
    }
    if (now - entry.lastAt < this.intervalMs) {
      entry.suppressed += 1;
      return null;
    }
    const suppressed = entry.suppressed;
    entry.lastAt = now;
    entry.suppressed = 0;
    return { suppressed };
  }

  /** 清掉 `key` 的狀態。回傳 `null` 表示先前沒有紀錄（不需要記「恢復」）；否則回傳尚未回報的被壓次數。 */
  reset(key: string): { suppressed: number } | null {
    const entry = this.state.get(key);
    if (!entry) return null;
    this.state.delete(key);
    return { suppressed: entry.suppressed };
  }
}

export interface ThrottledErrorReporter {
  /** 記一則連線錯誤：放行時才呼叫 `log`，參數為自上次放行以來被壓掉的次數。 */
  error(conn: string, err: unknown, log: (suppressed: number) => void): void;
  /** 連線恢復：先前有錯誤紀錄時呼叫 `log`（參數為尚未回報的被壓次數）並清掉該連線狀態。 */
  recovered(conn: string, log: (suppressed: number) => void): void;
}

/**
 * 以連線名分組的錯誤節流（main.ts 的 Redis／BullMQ 連線錯誤共用一份）。
 *
 * key **只用連線名、不看錯誤訊息**：每條連線一個狀態機（與 api 的連線錯誤節流同一語意）。
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
    error(conn, _err, log) {
      const pass = throttle.hit(conn, now());
      if (pass) log(pass.suppressed);
    },
    recovered(conn, log) {
      const r = throttle.reset(conn);
      if (r) log(r.suppressed);
    },
  };
}
