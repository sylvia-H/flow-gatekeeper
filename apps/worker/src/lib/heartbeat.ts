/**
 * 存活訊號 heartbeat（007 US5；research D5、data-model E2）。
 *
 * worker ready 後每 10s 寫 `worker:heartbeat`（值＝ISO timestamp、TTL 30s）。
 * 由 `setInterval` 驅動——事件迴圈被卡死（活鎖）時 timer 不觸發、key 過期、
 * healthcheck 連續失敗轉 unhealthy，補「行程活著但不做事」的偵測盲點。
 * 另可傳入 `isAlive`（見 `lib/liveness.ts`）：事件迴圈正常但所有 concurrency 槽都卡住時
 * 停止刷新，讓 healthcheck 也能看見「行程活著、timer 在跳，但一筆 job 都消化不了」的情況。
 * 單實例假設：key 不帶實例後綴（多實例明確 out of scope，ADR-002 §6）。
 *
 * 生命週期：優雅關閉時 `stopHeartbeat()` 清 timer；致命退出（let it crash）不清，
 * key 於 TTL 內自然過期——「訊號消失」本身就是語意。
 */

export const HEARTBEAT_KEY = "worker:heartbeat";
export const HEARTBEAT_INTERVAL_MS = 10_000;
export const HEARTBEAT_TTL_SECONDS = 30;

/** 純函式：以 Redis PTTL 回覆判定新鮮度——`PTTL > 0` 才算存活（-2＝無 key、-1＝無 TTL 異常、0＝剛過期）。 */
export function isHeartbeatFresh(pttl: number): boolean {
  return pttl > 0;
}

/** 最小結構相依：只需要 `SET key value EX seconds`（掛既有 `cache` 連線，不佔 subscriber）。 */
export interface HeartbeatRedis {
  set(key: string, value: string, mode: "EX", seconds: number): Promise<unknown>;
}

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * 啟動心跳（冪等：BullMQ `ready` 於連線重建時會重複觸發，重入只重設 timer）。
 * 寫入失敗記 warn 不拋出——單次心跳失敗不該變成浮空 rejection 觸發致命守門；
 * 持續失敗的結果就是 key 過期 → unhealthy，正好是此機制要呈現的語意。
 */
export function startHeartbeat(
  redis: HeartbeatRedis,
  warn: (msg: string) => void,
  isAlive: () => boolean = () => true,
): void {
  stopHeartbeat();
  let stalled = false;
  const beat = (): void => {
    if (!isAlive()) {
      // 只在轉態時 warn 一次，避免每 10s 洗版；不寫 key → TTL 到期 → healthcheck 轉 unhealthy。
      if (!stalled) warn("所有處理槽長時間無進度，暫停刷新 heartbeat");
      stalled = true;
      return;
    }
    if (stalled) warn("處理槽恢復進度，恢復刷新 heartbeat");
    stalled = false;
    void redis
      .set(HEARTBEAT_KEY, new Date().toISOString(), "EX", HEARTBEAT_TTL_SECONDS)
      .catch((err: unknown) => {
        warn(`heartbeat 寫入失敗：${err instanceof Error ? err.message : String(err)}`);
      });
  };
  beat(); // ready 當下先寫一拍，健康視窗從此刻起算
  timer = setInterval(beat, HEARTBEAT_INTERVAL_MS);
}

/** 清除心跳 timer（優雅關閉路徑；致命路徑不呼叫、靠 TTL 過期）。 */
export function stopHeartbeat(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
