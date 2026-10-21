import type { WorkerOptions } from "bullmq";

/**
 * BullMQ Worker 的 lock／stalled 參數與 worker keepalive 間隔（012 FR-018；ADR-003 D4；data-model §5 末表）。
 *
 * 符號：`L`＝`lockDuration`、`S`＝`stalledInterval`、`K`＝keepalive 間隔。
 * worker 被 SIGKILL 後，job 最晚在 `t + L + 2S` 被搬回 wait（`W ≤ L` 時；`W` 為新 worker 跑第一次 stalled 檢查前的
 * 重啟＋冷啟動時間），而 worker 活著時 keepalive 保證每 `K` 至少一則對外事件，被殺前最後一則事件最早在 `t − K`。
 * 因此前端看到的**最長無事件間隔**上界為：
 *
 *     K + L + 2S ＝ 10 + 15 + 2×5 ＝ 35 s   ＜  web 端 45 s watchdog（餘裕 10 s）
 *
 * **任一值調整（含 `AI_TIMEOUT_MS`）都 MUST 重算此上界**，並同步 ADR-003 D4 與本檔單測的不變量；`W > L` 時公式改為
 * `K + W + 2S`（仍 < 45 s 需 `W < 25 s`）。
 *
 * `lockRenewTime` 刻意不設：維持 BullMQ 預設 `L/2`（7.5 s）；BullMQ 以 `lockRenewTime/2` 的計時器檢查續租，實際節拍約
 * 3.75 s（最慢 7.5 s）續一次，所以 Redis 卡頓約 11.25～15 s 就可能讓 lock 過期、觸發 stalled。`maxStalledCount` 2：
 * 留一次額度給這種卡頓、一次給真正的 worker 崩潰。
 */

/** `L`：BullMQ job lock 的有效期（BullMQ 預設 30000）。 */
export const LOCK_DURATION_MS = 15_000;
/** `S`：stalled 檢查間隔（BullMQ 預設 30000）。只影響「多快發現」，誤判率由 `L` 決定。 */
export const STALLED_INTERVAL_MS = 5_000;
/** stalled 重派額度（BullMQ 預設 1）。 */
export const MAX_STALLED_COUNT = 2;
/** `K`：processor 一次執行中閒置多久就以 `updateProgress(目前里程碑)` 補送一則事件（worker 自訂，見 `lib/keepalive.ts`）。 */
export const KEEPALIVE_INTERVAL_MS = 10_000;

/** 展開進 `new Worker(…, { …WORKER_LOCK_OPTIONS })`；不含 `lockRenewTime`（見檔頭）。 */
export const WORKER_LOCK_OPTIONS = {
  lockDuration: LOCK_DURATION_MS,
  stalledInterval: STALLED_INTERVAL_MS,
  maxStalledCount: MAX_STALLED_COUNT,
} as const satisfies Pick<WorkerOptions, "lockDuration" | "stalledInterval" | "maxStalledCount">;
