import { z } from "zod";

/**
 * worker 回報的指標（api 自 Redis 快照 `metrics:worker` 讀入）。worker 缺席、快照過期或
 * 畸形時整體為 `null`：api 仍照常廣播自己那一半的指標，讓 worker 掛掉時營運面板降級而非整塊消失。
 *
 * 以 Zod 定義是因為快照跨 process 經 Redis 傳遞，api 讀回時必須驗證；有了 schema，
 * api 就不必在 contracts 之外另寫一份平行的手工驗證。
 */
export const WorkerMetricsSchema = z.object({
  /** worker 端結算時間（ISO-8601），供判讀快照新鮮度。 */
  snapshotAt: z.string(),
  llmLatency: z.object({
    /** 窗內 LLM 呼叫樣本數。 */
    count: z.number().int().nonnegative(),
    /** 以下三項於 `count === 0` 時為 `null`（**不是 0**）。 */
    avgMs: z.number().nullable(),
    p95Ms: z.number().nullable(),
    maxMs: z.number().nullable(),
  }),
  cache: z.object({
    hits: z.number().int().nonnegative(),
    misses: z.number().int().nonnegative(),
    /** `hits / (hits + misses)`；分母為 0 時為 `null`（**不是 0**）。 */
    hitRate: z.number().nullable(),
  }),
});

export type WorkerMetrics = z.infer<typeof WorkerMetricsSchema>;
