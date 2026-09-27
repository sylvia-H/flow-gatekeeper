/**
 * 處理迴圈活性追蹤（補 heartbeat 的 false negative）。
 *
 * 原本的 heartbeat 只證明「事件迴圈沒卡死」：若兩個 concurrency 槽都卡在無逾時的 I/O
 * （例如 Mongo 查詢掛住），timer 照跳、heartbeat 照寫，healthcheck 永遠 healthy，但 worker
 * 已經一筆 job 都消化不了。這裡改記「每個槽最近一次有進度的時間」：processor 進入、
 * 每個階段、每個 token、dedupe 等待的每一輪都 touch；只有當**所有槽都被佔住且全部超過
 * `stallMs` 沒進度**時才判定不活——只要還有空槽，worker 就還能接新 job，閒置本身是健康的。
 */
export interface LivenessTracker {
  begin(id: string): void;
  touch(id: string): void;
  end(id: string): void;
  isAlive(): boolean;
}

export function createLivenessTracker(opts: {
  slots: number;
  stallMs: number;
  now?: () => number;
}): LivenessTracker {
  const now = opts.now ?? Date.now;
  const lastProgress = new Map<string, number>();
  return {
    begin: (id) => void lastProgress.set(id, now()),
    touch: (id) => {
      if (lastProgress.has(id)) lastProgress.set(id, now());
    },
    end: (id) => void lastProgress.delete(id),
    isAlive: () => {
      if (lastProgress.size < opts.slots) return true;
      const t = now();
      for (const last of lastProgress.values()) {
        if (t - last <= opts.stallMs) return true;
      }
      return false;
    },
  };
}
