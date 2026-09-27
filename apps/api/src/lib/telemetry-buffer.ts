/**
 * telemetry 寫入路徑的純邏輯（不碰 Mongo、不碰計時器），抽出來是為了能單測「滿了丟誰」
 * 「log 何時放行」這類一旦寫錯就只會在 Mongo 故障時才現形的行為。
 */

/**
 * 有上限的 FIFO buffer：滿了丟**最舊**的。
 *
 * 丟最舊而不是拒收最新：即時監控的價值在最近的資料，Mongo 故障恢復後先寫進去的應是
 * 最接近現在的點；舊點本來就是 ADR-002 §6.4 接受可丟失的那一段。
 */
export class BoundedBuffer<T> {
  private items: T[] = [];

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError(`BoundedBuffer capacity 必須是正整數，收到 ${capacity}`);
    }
  }

  get size(): number {
    return this.items.length;
  }

  /** 放入一批；回傳因超出容量而被丟棄的（最舊）筆數。 */
  push(batch: readonly T[]): number {
    if (batch.length === 0) return 0;
    this.items.push(...batch);
    const overflow = this.items.length - this.capacity;
    if (overflow <= 0) return 0;
    this.items.splice(0, overflow);
    return overflow;
  }

  /**
   * 把一批放回**隊首**（寫入失敗要重試的資料比 buffer 內任何一筆都舊）；
   * 超出容量時一樣丟最舊，因此放回的資料會最先被犧牲。回傳丟棄筆數。
   */
  unshift(batch: readonly T[]): number {
    if (batch.length === 0) return 0;
    this.items = [...batch, ...this.items];
    const overflow = this.items.length - this.capacity;
    if (overflow <= 0) return 0;
    this.items.splice(0, overflow);
    return overflow;
  }

  /** 取出並清空全部（依放入順序）。 */
  drain(): T[] {
    const out = this.items;
    this.items = [];
    return out;
  }
}

/**
 * 錯誤 log 節流：同一個 key 在 `intervalMs` 內只放行一則，其餘累計次數，
 * 下一則放行時一併回報被壓掉幾次。
 *
 * 存在理由：Mongo 故障時每次 flush 都會失敗，不節流就是每秒一行 error、json-file 不輪替
 * 的情況下會把磁碟吃掉；但完全吞掉又會讓人不知道故障仍在持續，所以附上累計數。
 */
export class LogThrottle {
  private readonly state = new Map<string, { lastAt: number; suppressed: number }>();

  constructor(private readonly intervalMs: number) {}

  /**
   * 回傳 `null` 表示本次應壓掉；否則回傳自上次放行以來被壓掉的次數（首次為 0）。
   */
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
}

/**
 * 單一 in-flight 的非同步執行閘：同時只允許一個 `run` 在跑；正在跑時再呼叫會直接回傳
 * 那一個進行中的 promise，不排隊、不併發。
 *
 * 目的：Mongo 卡在 server selection 時，每秒的 flush 不會疊出成百上千個各持一批資料的
 * promise（舊寫法每 50ms 一個 insertMany，故障 30 秒就是約 600 個）。
 */
export class SingleFlight {
  private current?: Promise<void>;

  get busy(): boolean {
    return this.current !== undefined;
  }

  run(task: () => Promise<void>): Promise<void> {
    if (this.current) return this.current;
    // task 一律延到微任務執行：若 task 同步 throw，finally 會在 current 被賦值「之前」就同步
    // 清空，接著 current 才被設成那個 rejected promise、從此永遠不會被清掉而卡死。
    const p: Promise<void> = Promise.resolve()
      .then(task)
      .finally(() => {
        if (this.current === p) this.current = undefined;
      });
    this.current = p;
    return p;
  }

  /** 等目前進行中的那一個結束（沒有則立即 resolve）。不會拋出。 */
  async idle(): Promise<void> {
    try {
      await this.current;
    } catch {
      // run() 的呼叫端各自處理錯誤；這裡只關心「結束了沒」。
    }
  }
}

/**
 * 等 `promise` 至多 `ms` 毫秒：如期完成回 `true`，逾時回 `false`（原 promise 繼續在背景跑）。
 * 永不拋出——呼叫端是關閉流程，只需要知道「有沒有在時限內結束」。
 */
export async function withDeadline(promise: Promise<unknown>, ms: number): Promise<boolean> {
  if (ms <= 0) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  const settled = promise.then(
    () => true,
    () => true,
  );
  try {
    return await Promise.race([settled, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
