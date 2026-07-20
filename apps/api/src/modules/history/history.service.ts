import { Injectable, Logger } from "@nestjs/common";
import type { OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { MongoClient } from "mongodb";
import type { Db } from "mongodb";
import type { MachineState, TelemetryPoint } from "@flow-gatekeeper/contracts";
import { AppConfigService } from "../config/config.service.js";
import { detectErrorTransitions } from "../../lib/errorlog-transition.js";

/**
 * MongoDB 歷史層（憲章 VII：telemetry/errorlogs/maintenanceRecords 必須持久化）。
 *
 * - telemetry：time-series，TTL = TELEMETRY_TTL_SECONDS（可調，預設 7 天）。
 * - errorlogs：僅於狀態轉入 warning/critical 時寫（FR-011 去重，邏輯見 detectErrorTransitions）。
 * - persistBatch 由 Gateway 以 void fire-and-forget 呼叫，落地與推送解耦（FR-010）。
 */
@Injectable()
export class HistoryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(HistoryService.name);
  private client?: MongoClient;
  private db?: Db;
  private readonly lastState = new Map<string, MachineState>();

  constructor(private readonly config: AppConfigService) {}

  async onModuleInit(): Promise<void> {
    this.client = new MongoClient(this.config.mongoUrl);
    await this.client.connect();
    this.db = this.client.db(this.config.mongoDb);
    await this.ensureCollections(this.db);
    this.logger.log("history service connected to mongo");
  }

  async onModuleDestroy(): Promise<void> {
    await this.client?.close();
  }

  /**
   * Mongo 連通探測（009 US2，contracts/health-endpoint.md §4）：複用既有 `Db`，不另開連線。
   * `db` 未就緒（啟動中）或指令本身失敗一律 **reject**——這正是 spec Edge Case「api 啟動中、
   * 依賴尚未就緒」的落地：兩種情形對呼叫端而言是同一種「探測不到」，故用同一條錯誤路徑，
   * 不需在此另外分岔。呼叫端（health.service）MUST 統一把任何拋出轉為 `{ status: "down" }`
   * （FR-007），本方法不做這層轉換。
   */
  async ping(): Promise<void> {
    if (!this.db) {
      throw new Error("mongo not ready");
    }
    await this.db.command({ ping: 1 });
  }

  private async ensureCollections(db: Db): Promise<void> {
    try {
      await db.createCollection("telemetry", {
        timeseries: { timeField: "timestamp", metaField: "metadata", granularity: "seconds" },
        expireAfterSeconds: this.config.telemetryTtlSeconds,
      });
    } catch (err) {
      // 已存在則略過（重啟冪等）；NamespaceExists=48，其餘錯誤照拋。
      if ((err as { code?: number }).code !== 48) throw err;
    }
    await db.collection("errorlogs").createIndex({ machineId: 1, timestamp: -1 });
    await db.collection("maintenanceRecords").createIndex({ machineId: 1, performedAt: -1 });
  }

  /**
   * 一個 tick 的**全部機台**一起寫（FR-009 全量、與訂閱無關）。
   * 呼叫端 void fire-and-forget，不 await 阻塞推送 cadence（FR-010）；
   * 落地錯誤在此 catch + log，不向上拋（FR-010/FR-017）。
   */
  async persistBatch(points: readonly TelemetryPoint[]): Promise<void> {
    const db = this.db;
    if (points.length === 0 || !db) return;

    const now = new Date();
    const telemetryDocs = points.map((point) => ({
      ...point,
      timestamp: new Date(point.timestamp),
      metadata: { machineId: point.machineId },
    }));

    const { errors, nextState } = detectErrorTransitions(points, this.lastState, now);
    for (const [machineId, state] of nextState) {
      this.lastState.set(machineId, state);
    }

    try {
      await db.collection("telemetry").insertMany(telemetryDocs, { ordered: false });
      if (errors.length > 0) {
        await db.collection("errorlogs").insertMany(errors, { ordered: false });
      }
    } catch (err) {
      this.logger.error(`persistBatch failed: ${(err as Error).message}`);
    }
  }
}
