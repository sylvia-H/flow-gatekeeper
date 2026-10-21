import { formatDuration } from "../../../shared/lib/format.js";

/**
 * 診斷耗時量測（data-model §8、research R7）：每台一份、session 內記憶，存放於 `copilot.store` 的
 * `timings` Map（不改 `copilot-reducer` 狀態機）。純函式、不就地改、不讀時鐘——`now` 一律由呼叫端傳入
 * （store 以 `performance.now()` 取得；`POST /diagnoses` 送出前 start，`ai/done` 時 settle）。
 */

export interface DiagnosisTiming {
  /** 進行中的量測；`jobId` 由前端先產生，用來比對 `ai/done`。 */
  pending: { jobId: string; startedAt: number } | null;
  /** 最近一次 `cached:false` 的耗時（ms）。 */
  lastUncachedMs: number | null;
  /** 最近一次 `cached:true` 的耗時（ms）。 */
  lastCachedMs: number | null;
  /**
   * 最近一次以 GET 取回（重連續接或 2 s／45 s 退路）的耗時（ms；012 data-model §6.4、research P16）。耗時含斷線時間，
   * 只用來顯示本次，不寫進 `lastUncachedMs`／`lastCachedMs`，免得成為下一次快取對比的「上一次」基準。
   * 從未有過取回紀錄時不存在（optional，避免每份既有量測都得補欄位）。
   */
  lastRecoveredMs?: number;
  /** `lastRecoveredMs` 那次結果是否來自快取（`compareLabel` 決定主字寫「快取 · N ms」或「N.N s」）。 */
  lastRecoveredCached?: boolean;
  /** 最近一次完成的是哪一種（data-model 未列；`compareLabel` 需要知道主字顯示哪一筆）。 */
  lastKind: "cached" | "uncached" | "recovered" | null;
}

/** `settleTiming` 的選用參數。 */
export interface SettleOptions {
  /** 以 GET 取回的完成（P16）：只寫 `lastRecoveredMs`／`lastKind: "recovered"`，不動非快取／快取兩欄。 */
  recovered?: boolean;
}

/** 完成態 meta 的耗時呈現；排版由元件決定。 */
export interface TimingLabel {
  /** 主字：快取為 `快取 · N ms`，非快取為 `N.N s`。 */
  primary: string;
  cached: boolean;
}

export function createTiming(): DiagnosisTiming {
  return { pending: null, lastUncachedMs: null, lastCachedMs: null, lastKind: null };
}

/** 開始量測（覆蓋先前未完成的 pending）。`timing` 為 undefined 時從初始值起算。 */
export function startTiming(
  timing: DiagnosisTiming | undefined,
  jobId: string,
  now: number,
): DiagnosisTiming {
  return { ...(timing ?? createTiming()), pending: { jobId, startedAt: now } };
}

/**
 * `ai/done` 到達：`pending` 存在且 `jobId` 相符時計算 `elapsed = now - startedAt`（負值夾為 0），
 * 依 `cached` 寫入對應欄位並清 `pending`；無 pending 或 jobId 不符（過期事件）則原樣回傳。
 * `opts.recovered` 時改寫 `lastRecoveredMs`（P16），非快取／快取兩欄不動。
 */
export function settleTiming(
  timing: DiagnosisTiming,
  jobId: string,
  cached: boolean,
  now: number,
  opts?: SettleOptions,
): DiagnosisTiming {
  const { pending } = timing;
  if (!pending || pending.jobId !== jobId) return timing;
  const elapsed = Math.max(0, now - pending.startedAt);
  if (opts?.recovered) {
    return { ...timing, pending: null, lastRecoveredMs: elapsed, lastRecoveredCached: cached, lastKind: "recovered" };
  }
  return cached
    ? { ...timing, pending: null, lastCachedMs: elapsed, lastKind: "cached" }
    : { ...timing, pending: null, lastUncachedMs: elapsed, lastKind: "uncached" };
}

/** `ai/error`／取消：清 `pending`，保留歷史耗時。 */
export function cancelTiming(timing: DiagnosisTiming): DiagnosisTiming {
  return timing.pending === null ? timing : { ...timing, pending: null };
}

/** 完成態 meta 的耗時標籤；尚無任何完成紀錄時回 `null`。 */
export function compareLabel(timing: DiagnosisTiming | undefined): TimingLabel | null {
  if (!timing) return null;
  if (timing.lastKind === "cached" && timing.lastCachedMs !== null) {
    return {
      primary: `快取 · ${formatDuration(timing.lastCachedMs)}`,
      cached: true,
    };
  }
  if (timing.lastKind === "uncached" && timing.lastUncachedMs !== null) {
    return { primary: formatDuration(timing.lastUncachedMs), cached: false };
  }
  // 以 GET 取回：照常顯示本次耗時（快取與否照當次結果），但不畫對比橫條（`compareBars` 回 null）。
  if (timing.lastKind === "recovered" && timing.lastRecoveredMs !== undefined) {
    const cached = timing.lastRecoveredCached === true;
    const value = formatDuration(timing.lastRecoveredMs);
    return { primary: cached ? `快取 · ${value}` : value, cached };
  }
  return null;
}

/** 快取對比橫條的一列：`ratio` 為相對兩者最大值的長度比例（0–1，同一刻度）。 */
export interface CompareBar {
  kind: "cached" | "previous";
  /** 列標籤：「快取」／「上一次」。 */
  label: string;
  /** 耗時文字（`N ms`／`N.N s`）。 */
  value: string;
  ratio: number;
}

/**
 * 快取態的耗時對比橫條（critique 第一輪 B）：僅「最近一次是快取」時回傳，兩條共用同一刻度
 * （以兩者較大值為滿格），把差距畫出來。沒有非快取紀錄時回 `null`——單獨一條滿格的「快取」條沒有比較對象，
 * 反而像「很慢」（重新載入後第一次就命中後端快取是常見情況）；此時只留大字耗時與快取標記。
 */
export function compareBars(timing: DiagnosisTiming | undefined): CompareBar[] | null {
  if (!timing || timing.lastKind !== "cached" || timing.lastCachedMs === null || timing.lastUncachedMs === null) {
    return null;
  }
  const cachedMs = timing.lastCachedMs;
  const previousMs = timing.lastUncachedMs;
  const scale = Math.max(cachedMs, previousMs);
  const ratioOf = (ms: number): number => (scale > 0 ? ms / scale : 1);
  return [
    { kind: "cached", label: "快取", value: formatDuration(cachedMs), ratio: ratioOf(cachedMs) },
    { kind: "previous", label: "上一次", value: formatDuration(previousMs), ratio: ratioOf(previousMs) },
  ];
}
