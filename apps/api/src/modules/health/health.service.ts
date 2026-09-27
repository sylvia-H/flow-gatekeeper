import { Injectable, Logger } from "@nestjs/common";
import type { OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import IORedis from "ioredis";
import type { Redis } from "ioredis";
import { AppConfigService } from "../config/config.service.js";
import { HistoryService } from "../history/history.service.js";
import type { DependencyProbe } from "../../lib/health-aggregate.js";

/**
 * 依賴連通探測（US2，contracts/health-endpoint.md §4）：Redis `PING` 用**專屬** ioredis
 * 連線（憲章 IV 連線分離，MUST NOT 借用 relay 的 subscriber）；Mongo 複用
 * `HistoryService.ping()`（不另開連線）。兩者併行探測，各自獨立逾時。
 */
@Injectable()
export class HealthService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(HealthService.name);
  private redis?: Redis;

  constructor(
    private readonly config: AppConfigService,
    private readonly history: HistoryService,
  ) {}

  onModuleInit(): void {
    // 專屬連線（憲章 IV）：與 BullMQ producer／job-status QueueEvents／ai-stream subscriber
    // 皆分開，僅供本服務的 PING 探測使用。用 `command` 設定：斷線時 PING 立刻 reject、即時判
    // down，不在離線佇列裡排隊；probe() 的 Promise.race 仍是最後一道逾時保護（research R4）。
    this.redis = new IORedis(this.config.redisOptions("command"));
    this.redis.on("error", (err) => this.logger.warn(`health redis connection error: ${err.message}`));
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis?.quit().catch(() => undefined);
  }

  /** 併行探測 Redis 與 Mongo，回傳兩者的 DependencyProbe（每次請求即時探測，不快取）。 */
  async check(): Promise<{ redis: DependencyProbe; mongo: DependencyProbe }> {
    const timeoutMs = this.config.healthProbeTimeoutMs;
    const [redis, mongo] = await Promise.all([
      this.probe(() => this.pingRedis(), timeoutMs),
      this.probe(() => this.history.ping(), timeoutMs),
    ]);
    return { redis, mongo };
  }

  private async pingRedis(): Promise<void> {
    if (!this.redis) throw new Error("redis client not initialized");
    await this.redis.ping();
  }

  /**
   * 逾時或任何例外一律轉為 `{ status: "down", error }`，**MUST NOT 向上拋錯**——
   * 端點本身不得因依賴故障而回 500 或掛住（FR-007）。
   */
  private async probe(fn: () => Promise<void>, timeoutMs: number): Promise<DependencyProbe> {
    const start = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        fn(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
        }),
      ]);
      return { status: "up", latencyMs: Date.now() - start, error: null };
    } catch (err) {
      return {
        status: "down",
        latencyMs: null,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
