/**
 * api／worker 共用的日誌節流器（純邏輯、不碰計時器也不記日誌，時間由呼叫端傳入）。
 *
 * 收進 shared 的理由：兩端原本各抄一份逐字相同的 `LogThrottle` 與 `30_000` 常數，
 * 一邊修了另一邊不會跟著改，節流語意就會悄悄漂移。
 */

/**
 * 同類錯誤／warn 日誌持續發生時，兩則之間的最短間隔（通用節流窗）。
 * api 的 Redis／BullMQ 連線錯誤、Mongo 寫入錯誤（HistoryService）、Gateway 的同類 warn、
 * 診斷請求拒絕（JobsService）與 worker 的連線錯誤共用此值；需要不同間隔者（如 metrics 自檢的
 * 5 分鐘）自帶具名常數。
 */
export const ERROR_LOG_THROTTLE_MS = 30_000;

/**
 * 以 key 分組的日誌節流：同一個 key 在 `intervalMs` 內只放行一則，其餘累計次數，
 * 下一則放行時一併回報被壓掉幾次。
 *
 * 存在理由：Mongo 故障時每次 flush 都失敗、ioredis 每 100–270 ms 重連一次並各自 emit `error`——
 * 不節流就是每秒數行日誌，把 docker json-file log 與收集端灌爆；完全吞掉又看不出故障仍在持續，
 * 所以放行時附上累計數。
 *
 * key 集合由呼叫端負責有界（用固定的事件種類或連線名，不要把帶變動內容的錯誤訊息當 key）。
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

  /**
   * 「轉態」：清掉 `key` 的狀態（供連線恢復時呼叫），讓「故障 → 恢復」各留一行、恢復後再故障的
   * 第一則立即放行。回傳 `null` 表示先前沒有紀錄（不需要記「恢復」）；否則回傳尚未回報的被壓次數。
   */
  reset(key: string): { suppressed: number } | null {
    const entry = this.state.get(key);
    if (!entry) return null;
    this.state.delete(key);
    return { suppressed: entry.suppressed };
  }
}

/** 節流器對單一事件的判定：`log` 表示該輸出、`suppressed` 為上次輸出以來被壓掉的則數。 */
export type ThrottleDecision = { log: true; suppressed: number } | { log: false };

/** 以單一 key 驅動 `LogThrottle`：一個實例＝一條連線的故障狀態機。 */
const CONNECTION_KEY = "connection";

/**
 * 單一連線錯誤日誌的**轉態節流**（`LogThrottle` 的 hit／reset 以固定 key 包成狀態機）：
 * - 健康 → 故障的第一則錯誤：立即放行（讓故障一開始就可見）；
 * - 故障持續中：每 `intervalMs` 至多放行一則，並回報期間被壓掉的則數；
 * - 故障 → 恢復（`ready`）：回報一次恢復（含壓掉的則數），並重置——下一次故障的第一則照樣立即可見。
 *
 * **每條連線一個狀態機、不依錯誤訊息分流**：訊息常帶變動內容（位址、埠、重試次數、jobId），
 * 以訊息分 key 會讓 key 集合在故障期間無上限成長，也會讓同一次故障因訊息略異而重複放行。
 * 需要多條連線共用一個節流器時，直接用 `LogThrottle` 以連線名為 key（worker 即如此），語意相同。
 */
export class ConnectionErrorThrottle {
  private readonly throttle: LogThrottle;

  constructor(intervalMs: number = ERROR_LOG_THROTTLE_MS) {
    this.throttle = new LogThrottle(intervalMs);
  }

  onError(now: number): ThrottleDecision {
    const pass = this.throttle.hit(CONNECTION_KEY, now);
    return pass ? { log: true, suppressed: pass.suppressed } : { log: false };
  }

  /** 連線恢復。先前不在故障中則不需輸出（`log: false`）。 */
  onReady(): ThrottleDecision {
    const r = this.throttle.reset(CONNECTION_KEY);
    return r ? { log: true, suppressed: r.suppressed } : { log: false };
  }
}
