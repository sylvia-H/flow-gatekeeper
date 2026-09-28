import type { WorkerMetrics } from "@flow-gatekeeper/contracts";
import type { ChildLogger } from "@flow-gatekeeper/shared/logging";
import { MAX_METRICS_INTERVAL_MS, MIN_METRICS_INTERVAL_MS, resolveMetricsInterval } from "@flow-gatekeeper/shared/logging";
import { hitRate } from "./hit-rate.js";
import { summarizeLatency } from "./latency.js";

/**
 * worker 端指標收集器（009 US3；data-model E4／E5、contracts/metrics-summary.md §5／§6）。
 *
 * 記憶體累加 → 每 `METRICS_INTERVAL_MS` 結算一次：寫入本實例的 Redis 快照
 * `metrics:worker:<instanceId>`（api 掃描所有實例後合併；共用單一 key 時多副本會互相覆寫、
 * 只剩 1/N 的數字）、同時記入 worker 自身的 metrics 日誌（使 worker 日誌可獨立判讀），
 * 然後把窗內累加器歸零。
 *
 * **FR-009**：所有累加都只動記憶體，高頻路徑不寫任何日誌——只在結算時輸出一則。
 *
 * **MUST NOT 讀寫、覆寫或改動 007 的 `worker:heartbeat:<instanceId>`**：兩者各自獨立
 * ——不同命名空間（`worker:` vs `metrics:`）、不同 TTL（30s vs 3×間隔）、不同消費者
 * （compose healthcheck vs api 收集器），MUST NOT 互相取代或合併。
 */

/** 環形緩衝上限（data-model E5）：無界成長會在長跑 demo 緩慢吃記憶體，且拉高 p95 計算成本。 */
export const MAX_LATENCY_SAMPLES = 1000;

/** 最小結構相依：只需要 `SET key value EX seconds`（掛既有 `cache` 連線，不佔 subscriber）。 */
export interface MetricsRedis {
  set(key: string, value: string, mode: "EX", seconds: number): Promise<unknown>;
}

export type MetricsCollector = {
  /** 記錄一次 LLM 呼叫耗時（毫秒）。純觀測，MUST NOT 影響控制流。 */
  recordLatency(ms: number): void;
  /** 記錄一次快取命中／未命中。 */
  recordCacheHit(): void;
  recordCacheMiss(): void;
  /** 啟動週期結算。冪等：重入只重設 timer。 */
  start(): void;
  /** 清除 timer。**不輸出未滿一窗的殘窗摘要**（data-model E3）。 */
  stop(): void;
  /** 本收集器實際採用的結算間隔（毫秒）——供呼叫端內省／測試。 */
  readonly intervalMs: number;
};

export type CreateMetricsCollectorOptions = {
  redis: MetricsRedis;
  /** 本實例的快照 key（由 `workerMetricsKey(instanceId)` 產生）。 */
  key: string;
  /** 專屬 metrics child logger（`context: "metrics"`、level 由 `METRICS_LOG_LEVEL` 獨立釘定）。 */
  logger: ChildLogger;
  env?: Record<string, string | undefined>;
};

export function createMetricsCollector({
  redis,
  key,
  logger,
  env = process.env,
}: CreateMetricsCollectorOptions): MetricsCollector {
  const { intervalMs, fellBackToDefault, rawValue } = resolveMetricsInterval(env);

  // FR-008 下限回退警告由呼叫端輸出（職責邊界見 tasks T011a／analyze E3：`createLogger` 只管
  // `LOG_LEVEL`，`METRICS_INTERVAL_MS` 與日誌無關、歸屬各自的消費者）。建立當下就記，
  // 不等第一次結算——設定錯誤應在啟動時就看得見。
  if (fellBackToDefault) {
    logger.warn(
      { invalidMetricsInterval: rawValue, fallbackIntervalMs: intervalMs },
      `METRICS_INTERVAL_MS="${rawValue ?? ""}" 不合法（須為 ${MIN_METRICS_INTERVAL_MS}–${MAX_METRICS_INTERVAL_MS} 的整數），已回退至 ${intervalMs}ms`,
    );
  }

  // 環形緩衝（data-model E5）：寫滿 1000 後覆寫最舊樣本。統計與順序無關，故結算時直接取
  // 前 `sampleCount` 個 slot 即可（滿載時即整個陣列）。
  const latencySamples: number[] = new Array<number>(MAX_LATENCY_SAMPLES).fill(0);
  let sampleWrite = 0;
  let sampleCount = 0;
  let cacheHits = 0;
  let cacheMisses = 0;
  let timer: ReturnType<typeof setInterval> | null = null;

  const settle = (): void => {
    const snapshot: WorkerMetrics = {
      snapshotAt: new Date().toISOString(),
      llmLatency: summarizeLatency(latencySamples.slice(0, sampleCount)),
      cache: { hits: cacheHits, misses: cacheMisses, hitRate: hitRate(cacheHits, cacheMisses) },
    };

    // 歸零先於 I/O：窗界以「結算時刻」為準，寫入期間新進的樣本屬於下一窗（data-model E3）。
    sampleWrite = 0;
    sampleCount = 0;
    cacheHits = 0;
    cacheMisses = 0;

    logger.info(
      { llmLatency: snapshot.llmLatency, cache: snapshot.cache, windowMs: intervalMs },
      "worker metrics summary",
    );

    // TTL＝3 × 間隔（data-model E4）：key 消失即代表 worker 已缺席逾 3 個週期，api 端合併時
    // 降級為 `worker: null`。寫入失敗只記 warn 不拋出——單次快照失敗不該變成浮空 rejection
    // 觸發致命守門（let it crash → exit(1)），把觀測層小故障放大成行程級重啟。
    void redis
      .set(key, JSON.stringify(snapshot), "EX", Math.ceil((intervalMs * 3) / 1000))
      .catch((err: unknown) => {
        logger.warn({ err }, "metrics 快照寫入失敗");
      });
  };

  return {
    intervalMs,
    recordLatency(ms: number): void {
      latencySamples[sampleWrite] = ms;
      sampleWrite = (sampleWrite + 1) % MAX_LATENCY_SAMPLES;
      if (sampleCount < MAX_LATENCY_SAMPLES) sampleCount += 1;
    },
    recordCacheHit(): void {
      cacheHits += 1;
    },
    recordCacheMiss(): void {
      cacheMisses += 1;
    },
    start(): void {
      if (timer) clearInterval(timer);
      timer = setInterval(settle, intervalMs);
    },
    stop(): void {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
