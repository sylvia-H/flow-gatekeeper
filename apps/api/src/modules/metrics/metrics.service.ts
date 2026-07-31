import { Injectable } from "@nestjs/common";
import type { OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import IORedis from "ioredis";
import type { Redis } from "ioredis";
import type { SystemMetrics } from "@flow-gatekeeper/contracts";
import { AppConfigService } from "../config/config.service.js";
import { mergeMetrics } from "../../lib/metrics-merge.js";
import { getAppLogger } from "../../logging/app-logger.js";

/** worker 側指標快照的 Redis key（contracts/metrics-summary.md §5）。 */
export const WORKER_METRICS_KEY = "metrics:worker";

/**
 * 指標來源與出口——由組合根（`main.ts`）於 `app.listen()` 後綁定。
 *
 * 為何不直接注入 `JobsService`／`MonitoringGateway`：兩者是 `AppModule` 層的 provider，
 * 對被 import 的 `MetricsModule` 不可見（Nest 的相依只沿 imports/exports 流動）。與其為了
 * 注入而改動既有 ws／jobs 佈線（FR-012 零回歸的高風險區），沿用本專案既有的組合根接線
 * 慣例——`main.ts` 已以同樣方式呼叫 `gateway.attach(httpServer)`。
 */
export type MetricsSources = {
  queueCounts(): Promise<{ waiting: number; active: number; failed: number }>;
  wsConnections(): number;
  broadcast(payload: SystemMetrics): void;
};

/**
 * 週期指標結算（009 US3；FR-008／FR-008a、contracts/metrics-summary.md §4）。
 *
 * 每 `METRICS_INTERVAL_MS`：讀 queue counts + ws 連線數 → `GET metrics:worker`（非破壞性，
 * 不 `DEL`）→ `mergeMetrics` 合併 → 以**專屬 metrics child logger** 輸出一則摘要 → 廣播
 * `system/metrics` 給所有連線。
 *
 * **FR-009**：本服務不在任何高頻路徑（`publishTelemetry`／`persistBatch`）記錄任何東西，
 * 只在週期結算時輸出一則。
 */
@Injectable()
export class MetricsService implements OnModuleInit, OnModuleDestroy {
  // 專屬 metrics child logger：level 由 METRICS_LOG_LEVEL 獨立釘定，LOG_LEVEL=warn 時
  // 摘要仍會輸出（SC-005／contracts/log-fields.md §5）。
  private readonly logger = getAppLogger().metrics;
  private redis?: Redis;
  private timer?: ReturnType<typeof setInterval>;
  private sources?: MetricsSources;
  /** 重入防護：上一輪結算仍在途時跳過本輪（理由見 settle）。 */
  private settling = false;

  constructor(private readonly config: AppConfigService) {}

  onModuleInit(): void {
    // 專屬連線（憲章 IV 連線分離）：與 BullMQ producer／QueueEvents／ai-stream subscriber／
    // health 探測皆分開，僅供本服務讀取 worker 快照使用。
    this.redis = new IORedis({
      host: this.config.redisHost,
      port: this.config.redisPort,
      maxRetriesPerRequest: null,
    });
    this.redis.on("error", (err) => this.logger.warn({ err }, "metrics redis connection error"));
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    // 關閉時不輸出未滿一窗的殘窗摘要（data-model E3）。
    void this.redis?.quit().catch(() => undefined);
  }

  /** 由組合根注入來源與出口並啟動週期結算。冪等：重入只重設 timer。 */
  bind(sources: MetricsSources): void {
    this.sources = sources;
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => void this.settle(), this.config.metricsIntervalMs);
  }

  /**
   * 單次結算。**MUST NOT 拋錯、MUST NOT 影響主流程**——本方法由 timer 以
   * fire-and-forget 呼叫，任何逸出的 rejection 都會變成浮空 rejection。
   *
   * **重入防護**：Redis 中斷期間 `queueCounts()`（BullMQ → Redis）會**掛住**而非立刻失敗
   * （連線設 `maxRetriesPerRequest: null`，指令會排隊等重連）。沒有防護時，中斷每過一個間隔
   * 就多堆一輪在途結算，恢復當下全部同時完成——實測會看到同一毫秒連續兩則摘要，違反
   * 「每 `METRICS_INTERVAL_MS` 一則」。跳過的那一輪不補發（本訊息本就是 at-most-once）。
   */
  private async settle(): Promise<void> {
    const sources = this.sources;
    if (!sources || this.settling) return;
    this.settling = true;
    try {
      await this.collectAndEmit(sources);
    } finally {
      this.settling = false;
    }
  }

  private async collectAndEmit(sources: MetricsSources): Promise<void> {
    let queue: { waiting: number; active: number; failed: number };
    try {
      queue = await sources.queueCounts();
    } catch (err) {
      // 佇列讀取失敗（通常代表 Redis 不通，`/healthz` 會同時翻 unhealthy）。契約的 `queue`
      // 三項皆為必填 number、沒有「不可用」的表示法，補 0 會被讀成「佇列是空的」這個**錯誤
      // 事實**。故本週期改為只記一則 warn 指名失敗來源，等下一週期恢復——摘要本身是
      // at-most-once、不重送不補發（contracts/metrics-summary.md §2），漏一則屬正常範圍。
      this.logger.warn({ err }, "queue counts 讀取失敗，本週期摘要略過");
      return;
    }

    // worker 快照：key 不存在／過期／畸形一律由 mergeMetrics 降級為 `worker: null`，
    // 摘要照常輸出（FR-008）。讀取本身失敗（Redis 不通）也一律當作缺席，不中斷。
    let workerRaw: string | null = null;
    try {
      workerRaw = (await this.redis?.get(WORKER_METRICS_KEY)) ?? null;
    } catch (err) {
      this.logger.warn({ err }, "worker 指標快照讀取失敗，本則以 worker: null 降級輸出");
    }

    const payload = mergeMetrics(
      {
        windowMs: this.config.metricsIntervalMs,
        collectedAt: new Date().toISOString(),
        queue,
        wsConnections: sources.wsConnections(),
      },
      workerRaw,
    );

    this.logger.info(
      {
        windowMs: payload.windowMs,
        queue: payload.queue,
        wsConnections: payload.wsConnections,
        worker: payload.worker,
      },
      "metrics summary",
    );

    // 廣播失敗不得拖垮結算：日誌那一份已經落地，ws 這一份漏了就等下一週期。
    try {
      sources.broadcast(payload);
    } catch (err) {
      this.logger.warn({ err }, "metrics 廣播失敗");
    }
  }
}
