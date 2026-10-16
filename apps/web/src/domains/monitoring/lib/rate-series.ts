/**
 * 背壓速率序列（data-model §3、research R4、FR-009/011）。
 *
 * store 每秒（既有 1 Hz `now` 計時器，**不在 rAF 路徑**）把三個累計計數器餵進 `pushSample`，
 * 這裡取「與上一次 tick 的差分」存成一筆 `RateSample`，最多保留最近 `capacity`（預設 60）筆。
 *
 * 設計決定：
 * - **差分不除以實際間隔**：樣本是「這一個 tick 內」的筆數（tick 為 1 Hz，故≈每秒）。這樣
 *   `windowRatio` = Σ訊息 ÷ Σ批次 恰為視窗內的真實筆數比，不會因計時器抖動而偏；
 *   背景分頁計時器被節流時單格會變大，但比值仍正確。
 * - **首筆不產生樣本**：建立後（或解除 stale 後）的第一次 `pushSample` 只記下差分基準、回 false；
 *   從第二次起才有樣本。避免把「建立前的累計量」當成一秒內的量灌進第一格。
 * - **計數器倒退**（例如上游重置歸零）：無法得知重置發生在這一秒的哪個時點，故同樣只重設基準、
 *   不產生樣本，絕不寫入負值。
 * - **stale**：`markStale(series)` 後 `pushSample` 不推入；`markStale(series, false)` 解除時清掉差分基準，
 *   恢復後第一次 tick 重新取基準，斷線期間累積的量不會一次灌進某一格。既有樣本保留（畫面標示 stale）。
 * - **環狀**：`samples` 對外一律**由舊到新**（Sparkline 直接依序畫 points）；滿 `capacity` 時丟最舊一筆。
 *   以 push＋shift 實作——每秒一次、60 筆，成本可忽略，換來讀取端不需處理 head 索引。
 *
 * 本模組為就地修改的純資料操作（不碰 Vue reactive）；store 以 shallowRef／markRaw 持有並在 tick 後觸發一次。
 */

/** store 的三個累計計數器（同名欄位，store 直接傳 `.value` 組成的物件即可）。 */
export interface RateCounters {
  receivedMessages: number;
  renderedBatches: number;
  droppedMessages: number;
}

export interface RateSample {
  /** 取樣時間（epoch ms）。 */
  t: number;
  /** 這一 tick 收到的訊息數（`receivedMessages` 差分）。 */
  msgsPerSec: number;
  /** 這一 tick 提交的批次數（`renderedBatches` 差分）。 */
  batchesPerSec: number;
  /** 這一 tick 捨棄的訊息數（`droppedMessages` 差分）。 */
  droppedPerSec: number;
}

export type RateKey = "msgsPerSec" | "batchesPerSec" | "droppedPerSec";

export interface RateSeries {
  readonly capacity: number;
  /** 由舊到新，長度 ≤ capacity。 */
  readonly samples: RateSample[];
  /** 斷線時為 true，停止推入。 */
  stale: boolean;
  /** 上一次 tick 的計數器（差分基準）；null 表示下一次 tick 只取基準。 */
  baseline: RateCounters | null;
}

export function createRateSeries(capacity = 60): RateSeries {
  return { capacity, samples: [], stale: false, baseline: null };
}

/**
 * 1 Hz tick：以 `counters` 與上一次基準取差分推入一筆。回傳是否真的推入了樣本
 * （stale、首筆或計數器倒退時為 false）。
 */
export function pushSample(series: RateSeries, counters: RateCounters, t: number): boolean {
  if (series.stale) return false;
  const prev = series.baseline;
  series.baseline = { ...counters };
  if (prev === null) return false;
  const msgs = counters.receivedMessages - prev.receivedMessages;
  const batches = counters.renderedBatches - prev.renderedBatches;
  const dropped = counters.droppedMessages - prev.droppedMessages;
  if (msgs < 0 || batches < 0 || dropped < 0) return false;
  series.samples.push({ t, msgsPerSec: msgs, batchesPerSec: batches, droppedPerSec: dropped });
  while (series.samples.length > series.capacity) series.samples.shift();
  return true;
}

/** 視窗內某欄位的最大值（走勢線 y 軸正規化用）；無樣本時為 0。 */
export function maxOf(series: RateSeries, key: RateKey): number {
  let max = 0;
  for (const sample of series.samples) if (sample[key] > max) max = sample[key];
  return max;
}

function sumOf(series: RateSeries, key: RateKey): number {
  let sum = 0;
  for (const sample of series.samples) sum += sample[key];
  return sum;
}

/** 視窗內捨棄總數（FR-011）。 */
export function droppedInWindow(series: RateSeries): number {
  return sumOf(series, "droppedPerSec");
}

/** 視窗比值（FR-009 主顯示）= Σ訊息 ÷ Σ批次；批次總和為 0（含無樣本）時為 null（顯示「—」）。 */
export function windowRatio(series: RateSeries): number | null {
  const batches = sumOf(series, "batchesPerSec");
  if (batches === 0) return null;
  return sumOf(series, "msgsPerSec") / batches;
}

/**
 * 標示／解除 stale（冪等）。只有狀態真的翻轉時才改旗標並清掉差分基準，
 * 使恢復後第一次 tick 只重新取基準（斷線期間的累積量不灌進單一格）。
 * 狀態不變時呼叫不做任何事——呼叫端可以每次 tick 先同步連線狀態再 `pushSample`，不會把基準一直清掉。
 */
export function markStale(series: RateSeries, stale = true): void {
  if (series.stale === stale) return;
  series.stale = stale;
  series.baseline = null;
}
