/**
 * 閒置 keepalive 計時器（012 FR-019；ADR-003 D2；research R8／P12）。
 *
 * processor 每次執行建一個：任何對外事件（`updateProgress`、`ai/token` 發布）呼叫 `touch()` 重設；閒置滿 `intervalMs`
 * 就呼叫 `onIdle`（processor 端為 `job.updateProgress({ value: 目前里程碑, … })`），然後重新排程——連續閒置時每
 * `intervalMs` 觸發一次（固定節拍：下一拍在觸發當下就排定，不等 `onIdle` settle）。worker 活著就保證每 `intervalMs`
 * 至少一則事件，D4 的 35 s 上界即以此為前提。**保證成立的前提是 Redis 可寫**；寫入卡住時同一時間最多一筆在途（略過本輪），
 * 恢復後該筆落地、下一拍續送。
 *
 * 失敗處理（P12）：`onIdle` 同步拋錯或回傳的 promise reject 都吞掉、不中斷排程（keepalive 不該決定 job 成敗；Redis
 * 斷線時其他指令會拋錯走既有失敗路徑）。每個實例至多回報一次 `onError`，由呼叫端決定是否 warn——逐次記會在故障
 * 期間每 10 s 每 job 一行。成功的 keepalive 不回報、不記日誌（FR-047）。
 *
 * 上一次 `onIdle` 尚未 settle 時，該輪略過呼叫但照常排下一輪：Redis 卡住時不堆積未完成的寫入。
 * `stop()` 後不再觸發（冪等；之後的 `touch()` 為 no-op）；processor 於 `finally` 呼叫。
 */

/**
 * 可注入的計時器（預設用全域 `setTimeout`／`clearTimeout`，故 `vi.useFakeTimers` 直接生效）。
 * 預設實作會 `unref()` Node timer，避免殘留的 keepalive 擋住行程關閉；注入時不強求。
 */
export interface KeepaliveTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface KeepaliveOptions {
  intervalMs: number;
  onIdle: () => void | Promise<void>;
  /** `onIdle` 第一次失敗時呼叫（每個實例至多一次）；省略則靜默吞掉。 */
  onError?: (err: unknown) => void;
  timers?: KeepaliveTimers;
}

export interface Keepalive {
  /** 剛送出一則對外事件：重設閒置計時。 */
  touch(): void;
  /** 停止計時器；之後不再觸發。 */
  stop(): void;
}

const defaultTimers: KeepaliveTimers = {
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    // fake timer 或非 Node 環境的回傳值未必有 unref。
    if (typeof handle === "object" && typeof handle.unref === "function") handle.unref();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createKeepalive({ intervalMs, onIdle, onError, timers = defaultTimers }: KeepaliveOptions): Keepalive {
  let handle: unknown = null;
  let stopped = false;
  let inFlight = false;
  let reported = false;

  const report = (err: unknown): void => {
    if (reported) return;
    reported = true;
    try {
      onError?.(err);
    } catch {
      // 回報本身失敗也不能打斷排程。
    }
  };

  const fire = (): void => {
    handle = null;
    if (stopped) return;
    schedule();
    if (inFlight) return;
    inFlight = true;
    let pending: unknown;
    try {
      pending = onIdle();
    } catch (err) {
      inFlight = false;
      report(err);
      return;
    }
    Promise.resolve(pending).then(
      () => {
        inFlight = false;
      },
      (err: unknown) => {
        inFlight = false;
        report(err);
      },
    );
  };

  const schedule = (): void => {
    if (handle !== null) timers.clearTimeout(handle);
    handle = timers.setTimeout(fire, intervalMs);
  };

  schedule();

  return {
    touch(): void {
      if (stopped) return;
      schedule();
    },
    stop(): void {
      stopped = true;
      if (handle !== null) {
        timers.clearTimeout(handle);
        handle = null;
      }
    },
  };
}
