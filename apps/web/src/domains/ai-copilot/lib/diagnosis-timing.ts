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
  /** 最近一次完成的是哪一種（data-model 未列；`compareLabel` 需要知道主字顯示哪一筆）。 */
  lastKind: "cached" | "uncached" | null;
}

/** 完成態 meta 的耗時呈現；排版由元件決定。 */
export interface TimingLabel {
  /** 主字：快取為 `快取 · N ms`，非快取為 `N.N s`。 */
  primary: string;
  /** 並列的對比：僅「最近一次是快取且有非快取紀錄」時為 `上一次 N.N s`，否則 `null`。 */
  secondary: string | null;
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
 */
export function settleTiming(
  timing: DiagnosisTiming,
  jobId: string,
  cached: boolean,
  now: number,
): DiagnosisTiming {
  const { pending } = timing;
  if (!pending || pending.jobId !== jobId) return timing;
  const elapsed = Math.max(0, now - pending.startedAt);
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
      secondary: timing.lastUncachedMs !== null ? `上一次 ${formatDuration(timing.lastUncachedMs)}` : null,
      cached: true,
    };
  }
  if (timing.lastKind === "uncached" && timing.lastUncachedMs !== null) {
    return { primary: formatDuration(timing.lastUncachedMs), secondary: null, cached: false };
  }
  return null;
}
