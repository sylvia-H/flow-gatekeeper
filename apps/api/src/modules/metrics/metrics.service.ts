import { Injectable } from "@nestjs/common";
import type { OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import IORedis from "ioredis";
import type { Redis } from "ioredis";
import { SystemMetricsSchema } from "@flow-gatekeeper/contracts";
import type { SystemMetrics } from "@flow-gatekeeper/contracts";
import { AppConfigService } from "../config/config.service.js";
import { attachThrottledErrorLog } from "../../lib/connection-error-throttle.js";
import { mergeMetrics } from "../../lib/metrics-merge.js";
import { LogThrottle } from "@flow-gatekeeper/shared/logging";
import { throttledFields } from "../../lib/throttled-log.js";
import { getAppLogger } from "../../logging/app-logger.js";
import { readWorkerSnapshots } from "./worker-snapshots.js";

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
  /** 歷史寫入路徑的累計遺失／失敗計數（`HistoryService.getWriteStats()` 的摘要）。 */
  persistStats(): PersistStats;
  broadcast(payload: SystemMetrics): void;
};

export type PersistStats = NonNullable<SystemMetrics["persist"]>;

/** 出口自檢失敗的 error 日誌節流間隔：設定錯誤會讓每一則都違約，只需週期性提醒。 */
const SELF_CHECK_LOG_THROTTLE_MS = 5 * 60_000;

/**
 * 週期指標結算（009 US3；FR-008／FR-008a、contracts/metrics-summary.md §4）。
 *
 * 每 `METRICS_INTERVAL_MS`：讀 queue counts + ws 連線數 + 歷史寫入 persist 計數 → `SCAN metrics:worker:*` + `MGET`
 * 讀回各 worker 實例快照（非破壞性，不 `DEL`）→ `mergeMetrics` 合併 → 以**專屬 metrics child logger** 輸出一則摘要 → 廣播
 * `system/metrics` 給所有連線。
 *
 * 本服務刻意不在任何高頻路徑（每 tick 的 telemetry 廣播與 History `enqueue`）記錄任何東西，
 * 只在週期結算時輸出一則——否則指標本身就會成為每秒 20 次的 log 噪音源。
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
  private readonly selfCheckThrottle = new LogThrottle(SELF_CHECK_LOG_THROTTLE_MS);

  constructor(private readonly config: AppConfigService) {}

  onModuleInit(): void {
    // 專屬連線（憲章 IV 連線分離）：與 BullMQ producer／QueueEvents／ai-stream subscriber／
    // health 探測皆分開，僅供本服務讀取 worker 快照使用。`command` 設定：Redis 不通時 SCAN／MGET
    // 立刻失敗、本則以 `worker: null` 降級，而不是排隊到重連。
    this.redis = new IORedis(this.config.redisOptions("command"));
    // 轉態節流：斷線（含 AUTH 失敗）時 ioredis 每 100–270 ms 重連一次，逐則記錄會洗版。
    // err 經 logger 的 serializer／redact 剝掉 `command.args`（AUTH 失敗時即為密碼）。
    attachThrottledErrorLog(this.redis, {
      error: (err, suppressed) =>
        this.logger.warn({ err, suppressed }, "metrics redis connection error"),
      recovered: (suppressed) =>
        this.logger.info({ suppressed }, "metrics redis connection recovered"),
    });
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
   * **重入防護**：producer 與本服務的連線已改為斷線即 reject（`redisOptions("command")`），
   * 但 BullMQ Queue 在「首次連線尚未 ready」時仍會等待連線建立，`queueCounts()` 可能掛到
   * Redis 恢復。沒有防護時，每過一個間隔就多堆一輪在途結算，恢復當下全部同時完成——實測會看到
   * 同一毫秒連續兩則摘要，違反「每 `METRICS_INTERVAL_MS` 一則」。跳過的那一輪不補發（本訊息本就
   * 是 at-most-once）。
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

    // worker 快照：每個實例一把 key，逐筆驗證後合併；過期／畸形者由 mergeMetrics 略過，
    // 一筆有效的都沒有時降級為 `worker: null`，摘要照常輸出。讀取本身失敗（Redis 不通）也一律
    // 當作全數缺席，不中斷。
    let workerRaws: (string | null)[] = [];
    try {
      workerRaws = this.redis ? await readWorkerSnapshots(this.redis) : [];
    } catch (err) {
      this.logger.warn({ err }, "worker 指標快照讀取失敗，本則以 worker: null 降級輸出");
    }

    // persist 計數讀取失敗不拖累摘要：省略該欄位（契約為 optional），不以 0 冒充「沒有遺失」。
    let persist: PersistStats | undefined;
    try {
      persist = sources.persistStats();
    } catch (err) {
      this.logger.warn({ err }, "persist 計數讀取失敗，本則省略 persist 欄位");
    }

    const payload = mergeMetrics(
      {
        windowMs: this.config.metricsIntervalMs,
        collectedAt: new Date().toISOString(),
        queue,
        wsConnections: sources.wsConnections(),
        ...(persist !== undefined ? { persist } : {}),
      },
      workerRaws,
    );
    if (!this.config.isProduction) this.checkContract(payload);

    this.logger.info(
      {
        windowMs: payload.windowMs,
        queue: payload.queue,
        wsConnections: payload.wsConnections,
        worker: payload.worker,
        persist: payload.persist,
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

  /**
   * 出口契約自檢（僅非 production，判準為 `AppConfigService.isProduction`）。違約的 `system/metrics`
   * 會被前端整則丟棄、面板永遠 `empty`，而 api 端毫無徵兆（例如 `windowMs` 非整數）；production 不做——
   * 出口形狀由型別與測試保證，不在每週期多付一次驗證。違約只記 error（節流），照常廣播——不改變出口行為。
   */
  private checkContract(payload: SystemMetrics): void {
    const result = SystemMetricsSchema.safeParse(payload);
    if (result.success) return;
    const fields = throttledFields(this.selfCheckThrottle, "system/metrics", {
      issues: result.error.issues.map((issue) => ({
        path: issue.path.join(".") || "(root)",
        code: issue.code,
      })),
    });
    if (!fields) return;
    this.logger.error(
      fields,
      "system/metrics 出口違反契約，前端會整則丟棄（檢查 METRICS_INTERVAL_MS 等設定）",
    );
  }
}
