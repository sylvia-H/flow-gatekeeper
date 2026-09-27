/** 同一條連線持續故障時，兩則錯誤日誌之間的最短間隔。與 HistoryService 的寫入錯誤節流同量級。 */
export const CONNECTION_ERROR_LOG_THROTTLE_MS = 30_000;

/** 節流器對單一事件的判定：`log` 表示該輸出、`suppressed` 為上次輸出以來被壓掉的則數。 */
export type ThrottleDecision = { log: true; suppressed: number } | { log: false };

/**
 * 連線錯誤日誌的**轉態節流**。
 *
 * ioredis 斷線（含 AUTH 失敗）時每 100–270 ms 重連一次、每次都發 `error`，直接記錄會洗版。
 * 本類別只在「轉態」與「持續故障的每 `intervalMs`」放行：
 * - 健康 → 故障的第一則錯誤：立即放行（讓故障一開始就可見）；
 * - 故障持續中：每 `intervalMs` 至多放行一則，並回報期間被壓掉的則數；
 * - 故障 → 恢復（`ready`）：回報一次恢復（含壓掉的則數），並重置——下一次故障的第一則照樣立即可見。
 *
 * **每條連線一個狀態機、不依錯誤訊息分流**：節流的單位是「這條連線是否在故障中」，不以
 * 錯誤訊息當 key。訊息常帶變動內容（位址、埠、重試次數、節點名），以訊息分 key 會讓 key
 * 集合隨故障期間無上限成長，也會讓同一次故障因訊息略有差異而重複放行；故障期間訊息改變
 * （如 ECONNREFUSED → WRONGPASS）時，下一則放行的日誌仍會帶出最新的那則錯誤。
 *
 * 純狀態機：不看時鐘、不記日誌，時間由呼叫端傳入，輸出由呼叫端決定。
 */
export class ConnectionErrorThrottle {
  private failing = false;
  private lastLoggedAt = 0;
  private suppressed = 0;

  constructor(private readonly intervalMs: number = CONNECTION_ERROR_LOG_THROTTLE_MS) {}

  onError(now: number): ThrottleDecision {
    if (!this.failing || now - this.lastLoggedAt >= this.intervalMs) {
      const suppressed = this.suppressed;
      this.failing = true;
      this.lastLoggedAt = now;
      this.suppressed = 0;
      return { log: true, suppressed };
    }
    this.suppressed += 1;
    return { log: false };
  }

  /** 連線恢復。先前不在故障中則不需輸出（`log: false`）。 */
  onReady(): ThrottleDecision {
    if (!this.failing) return { log: false };
    const suppressed = this.suppressed;
    this.failing = false;
    this.suppressed = 0;
    return { log: true, suppressed };
  }
}

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
