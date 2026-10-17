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
 *   恢復後第一次 tick 重新取基準，斷線期間累積的量不會一次灌進某一格。斷線期間既有樣本保留（畫面標示
 *   stale）；重連時由呼叫端以 `clearSamples` 清空，視窗從重連後重新累積。
 * - **無效樣本**（013 critique 第三輪交叉審查）：暫停期間 pump 不 flush（該秒批次為 0 或只有部分），恢復那一幀
 *   把整個 buffer 當成 1 批交出——這些秒的訊息 ÷ 批次是操作造成的離群值（實測合併比 5.9 時單秒衝到 18.5），
 *   會拉高最高水位、把走勢線其餘 59 秒壓成平線。呼叫端以 `invalidateNext(series, n)` 把接下來 n 筆推入的
 *   樣本標 `invalid: true`；樣本照樣保留（丟棄數仍是真的），但**合併比相關的計算一律排除**：`windowRatio`、
 *   `averageOf`、`totalOf`、`peakRatio`，以及走勢線（在該秒斷線）。`droppedInWindow` 仍計入全部樣本。
 * - **環狀**：`samples` 對外一律**由舊到新**（Sparkline 直接依序畫 points）；滿 `capacity` 時丟最舊一筆。
 *   以 push＋shift 實作——每秒一次、60 筆，成本可忽略，換來讀取端不需處理 head 索引。
 *
 * 本模組為就地修改的純資料操作（不碰 Vue reactive）；store 以 shallowRef／markRaw 持有並在 tick 後觸發一次。
 */

/** store 的四個累計計數器（同名欄位，store 直接傳 `.value` 組成的物件即可）。 */
export interface RateCounters {
  receivedMessages: number;
  renderedBatches: number;
  /** 溢位合併丟棄。 */
  droppedMessages: number;
  /** 格式不符剔除（入口型別守衛）。與溢位丟棄合計為樣本的丟棄數。 */
  invalidMessages: number;
}

/** 丟棄數的累計量：溢位合併丟棄＋格式不符剔除（背壓 strip tooltip「溢位合併或格式不符被剔除」）。 */
function discardedOf(counters: RateCounters): number {
  return counters.droppedMessages + counters.invalidMessages;
}

export interface RateSample {
  /** 取樣時間（epoch ms）。 */
  t: number;
  /** 這一 tick 收到的訊息數（`receivedMessages` 差分）。 */
  msgsPerSec: number;
  /** 這一 tick 提交的批次數（`renderedBatches` 差分）。 */
  batchesPerSec: number;
  /** 這一 tick 捨棄的訊息數（`droppedMessages + invalidMessages` 的差分：溢位合併丟棄＋格式不符剔除）。 */
  droppedPerSec: number;
  /** 暫停期間或恢復當下的樣本：訊息 ÷ 批次是操作造成的離群值，合併比相關計算一律排除。未設＝有效。 */
  invalid?: true;
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
  /** 接下來還要標 `invalid` 的推入筆數（`invalidateNext` 設定，每推入一筆減一）。 */
  invalidPushes: number;
}

export function createRateSeries(capacity = 60): RateSeries {
  return { capacity, samples: [], stale: false, baseline: null, invalidPushes: 0 };
}

/**
 * 把接下來 `count` 筆推入的樣本標為無效（取已排定與新值的較大者，不會縮短既有排程）。
 * 只在真的推入樣本時遞減——只取基準或 stale 而沒推入的 tick 不消耗。
 */
export function invalidateNext(series: RateSeries, count = 1): void {
  series.invalidPushes = Math.max(series.invalidPushes, count);
}

/** 合併比相關計算用的有效樣本（排除 `invalid`）。 */
export function validSamples(samples: readonly RateSample[]): readonly RateSample[] {
  return samples.some((s) => s.invalid === true) ? samples.filter((s) => s.invalid !== true) : samples;
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
  const dropped = discardedOf(counters) - discardedOf(prev);
  if (msgs < 0 || batches < 0 || dropped < 0) return false;
  const sample: RateSample = { t, msgsPerSec: msgs, batchesPerSec: batches, droppedPerSec: dropped };
  if (series.invalidPushes > 0) {
    sample.invalid = true;
    series.invalidPushes -= 1;
  }
  series.samples.push(sample);
  while (series.samples.length > series.capacity) series.samples.shift();
  return true;
}

/** 視窗內捨棄總數（FR-011）：含無效樣本——暫停期間的溢位丟棄是真的丟了。 */
export function droppedInWindow(series: RateSeries): number {
  let sum = 0;
  for (const sample of series.samples) sum += sample.droppedPerSec;
  return sum;
}

/** 視窗比值（FR-009 主顯示）= 有效樣本的 Σ訊息 ÷ Σ批次；批次總和為 0（含無樣本）時為 null（顯示「—」）。 */
export function windowRatio(series: RateSeries): number | null {
  const batches = totalOf(series.samples, "batchesPerSec");
  if (batches === 0) return null;
  return totalOf(series.samples, "msgsPerSec") / batches;
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

/**
 * 清掉所有樣本（stale 旗標與差分基準不動）。store 在 stale 由 true 翻回 false（重連）時呼叫：
 * 斷線期間的樣本只供畫面標示斷線（「已斷線」／「重新連線中」）時保留，重連後若留著，60 秒視窗比值與走勢線會把
 * 斷線前的舊樣本當成「最近 60 秒」，而走勢線依序靠右排列、看不出中間的空檔。
 */
export function clearSamples(series: RateSeries): void {
  series.samples.length = 0;
}

/**
 * 視窗內某欄位的平均每 tick 量（背壓 strip 的「每秒訊息／每秒批次 · 近 60 秒」讀數）；無樣本時為 null。
 *
 * 與 `windowRatio` 用同一組樣本：平均訊息 ÷ 平均批次 = Σ訊息 ÷ Σ批次 = 視窗比值，三個讀數的箭頭鏈
 * 因此算得通（critique 2026-10-16 P1：前兩數若取最近 1 秒、比值取 60 秒，畫面上相除對不攏）。
 * 收 `readonly RateSample[]` 而非 `RateSeries`：strip 只拿得到 store 給的樣本複本。
 */
export function averageOf(samples: readonly RateSample[], key: RateKey): number | null {
  const valid = validSamples(samples);
  if (valid.length === 0) return null;
  return totalOf(valid, key) / valid.length;
}

/** 視窗內某欄位的有效樣本總和（tooltip 的「近 60 秒共 N 則」；無效樣本不計）。 */
export function totalOf(samples: readonly RateSample[], key: RateKey): number {
  let sum = 0;
  for (const sample of samples) if (sample.invalid !== true) sum += sample[key];
  return sum;
}

/**
 * 單一 tick 的合併比（訊息 ÷ 批次）：該 tick 批次為 0（除以 0 無意義）或樣本無效時為 null。
 * `peakRatio` 與走勢線（`Sparkline`）共用，單秒比值的定義只有這一份。
 */
export function sampleRatio(sample: RateSample): number | null {
  if (sample.invalid === true || sample.batchesPerSec === 0) return null;
  return sample.msgsPerSec / sample.batchesPerSec;
}

/**
 * 近 60 秒最高水位（比值刻度上的 high-water mark）：視窗內單一 tick 比值（訊息 ÷ 批次）的最大值，
 * 且不低於整個視窗的比值；視窗內沒有任何批次時為 null（不畫）。
 *
 * - 批次為 0 的 tick 不參與單格比值（除以 0 無意義），但它們的訊息仍算進視窗比值——背景分頁 rAF
 *   被暫停時就是這種格子，此時視窗比值可能高於每一格的單格比值；取兩者較大者，最高水位才不會畫在
 *   液位線左邊。
 * - 無效樣本（暫停期間、恢復當下）整格略過，最高水位不會被操作造成的離群值拉高。
 */
export function peakRatio(samples: readonly RateSample[]): number | null {
  let peak: number | null = null;
  let msgs = 0;
  let batches = 0;
  for (const sample of samples) {
    if (sample.invalid === true) continue;
    msgs += sample.msgsPerSec;
    batches += sample.batchesPerSec;
    const r = sampleRatio(sample);
    if (r !== null && (peak === null || r > peak)) peak = r;
  }
  if (batches === 0) return null;
  return Math.max(peak ?? 0, msgs / batches);
}
