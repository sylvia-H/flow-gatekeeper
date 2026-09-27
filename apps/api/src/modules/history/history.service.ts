import { Injectable, Logger } from "@nestjs/common";
import type { OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { MongoClient } from "mongodb";
import type { Db } from "mongodb";
import type { MachineState, TelemetryPoint } from "@flow-gatekeeper/contracts";
import { AppConfigService } from "../config/config.service.js";
import { detectErrorTransitions } from "../../lib/errorlog-transition.js";
import type { ErrorLogDoc } from "../../lib/errorlog-transition.js";
import {
  BoundedBuffer,
  LogThrottle,
  SingleFlight,
  withDeadline,
} from "../../lib/telemetry-buffer.js";
import {
  NAMESPACE_EXISTS,
  classifyInsertFailure,
  isIndexConflict,
  isOnlyDuplicateKeyError,
  mongoErrorCode,
  planTimeSeriesTtl,
} from "../../lib/mongo-ttl.js";

/** 每隔多久把 buffer 批次寫進 Mongo。1 秒一次 ≈ 舊寫法（每 50ms 一次）的 1/20 round-trip。 */
const FLUSH_INTERVAL_MS = 1_000;
/**
 * telemetry buffer 上限（點數）。buffer 只吸收「單批寫入卡住」期間的累積（選址逾時 3 秒、
 * socket 卡住上限 10 秒，約 300–1000 點），不是故障期間的重試佇列——失敗的那批不放回
 * （見類別註解的有損語意）。上限只是防止寫入長時間卡住時記憶體無界成長的保險。
 */
const TELEMETRY_BUFFER_CAPACITY = 5_000;
/** errorlog 待寫上限。轉換事件頻率遠低於 telemetry，1000 筆足以撐過長時間故障。 */
const ERRORLOG_BUFFER_CAPACITY = 1_000;
/** onModuleDestroy 等待進行中寫入的上限（正常路徑 main.ts 已先 flush，這裡只收尾）。 */
const DESTROY_IDLE_DEADLINE_MS = 3_000;
/** 同類寫入錯誤 log 的節流間隔。 */
const ERROR_LOG_THROTTLE_MS = 30_000;
/**
 * errorlogs 保存期（30 天）。errorlog 量小、是給人看的異常軌跡，保存期刻意比 telemetry 長；
 * 目前寫死於此、未開環境變數（設定集中處 AppConfigService 不在這次修改範圍內）。
 */
const ERRORLOG_TTL_SECONDS = 30 * 24 * 60 * 60;

/** telemetry 文件形狀：只存 time-series 需要的欄位，不重複存 `type`／`machineId`。 */
type TelemetryDoc = {
  timestamp: Date;
  metadata: { machineId: string };
  telemetry: TelemetryPoint["telemetry"];
  state: MachineState;
};

/** 寫入路徑計數器快照；經 `toPersistStats` 摘要後接進 `system/metrics.persist`（此處只暴露、不自行輸出）。 */
export type HistoryWriteStats = {
  /** 目前 buffer 內待寫的 telemetry 點數。 */
  bufferedPoints: number;
  /** buffer 滿而被丟棄的最舊 telemetry 點數（累計）。 */
  droppedPoints: number;
  /** `insertMany` 失敗次數（telemetry 與 errorlogs 合計，累計）。 */
  persistFailures: number;
  /** 因寫入失敗而遺失的 telemetry 點數（累計；telemetry 失敗不重試）。 */
  failedPoints: number;
  /** 目前待寫（含失敗待重試）的 errorlog 筆數。 */
  pendingErrorLogs: number;
  /** errorlog 被丟棄的筆數（累計）：待寫佇列滿，或遇到非暫時性錯誤（毒批次）不再重試。 */
  droppedErrorLogs: number;
};

/**
 * `system/metrics.persist` 的摘要：`dropped`＝遺失的紀錄數（buffer 滿丟棄的遙測點＋寫入失敗不重試的
 * 遙測點＋被丟棄的 errorlog），`failed`＝`insertMany` 失敗批數。兩者皆為累計值。
 */
export function toPersistStats(stats: HistoryWriteStats): { dropped: number; failed: number } {
  return {
    dropped: stats.droppedPoints + stats.failedPoints + stats.droppedErrorLogs,
    failed: stats.persistFailures,
  };
}

function toTelemetryDoc(point: TelemetryPoint): TelemetryDoc {
  return {
    timestamp: new Date(point.timestamp),
    metadata: { machineId: point.machineId },
    telemetry: point.telemetry,
    state: point.state,
  };
}

/**
 * MongoDB 歷史層（憲章 VII：telemetry/errorlogs/maintenanceRecords 必須持久化）。
 *
 * - telemetry：time-series，TTL = TELEMETRY_TTL_SECONDS；既有 collection 的 TTL 以 collMod 更新。
 * - errorlogs：僅於狀態轉入 warning/critical 時寫（去重邏輯見 detectErrorTransitions），TTL 30 天。
 * - 寫入路徑：Gateway 每 tick 呼叫 `enqueue()`（同步、只進記憶體），本服務每秒 flush 一次，
 *   同時只允許一個 in-flight。推送 cadence 因此完全不受資料庫延遲牽制，Mongo 故障時記憶體
 *   與 promise 數量也都有上限。
 *
 * **有損寫入語意（明文宣告，ADR-002 §6.4 接受的取捨）**：
 * - 崩潰時 buffer 內至多約 1 秒（加上進行中的一批）的 telemetry 會遺失；
 * - Mongo 故障時 buffer 滿即丟最舊（計入 `droppedPoints`），寫入失敗的那批 telemetry 不重試
 *   （計入 `failedPoints`）——重試會跟著新資料一起擠爆 buffer，而舊遙測的價值遠低於即時性。
 *
 * **errorlog 不隨 telemetry 失敗而遺失**：狀態轉換在 `enqueue()` 當下就判定（`lastState` 同步
 * 前進），產生的 errorlog 進獨立佇列；網路／選址類失敗會放回佇列重試，server 已逐筆拒絕或
 * 整批拒絕的非暫時性錯誤（毒批次）則直接丟棄並計數，避免每秒重送同一批直到永遠。取捨：`lastState` 在寫入成功前
 * 就更新；若改成「寫入成功才更新」，Mongo 故障期間每一批都會重判出同一個轉換、恢復後一次灌入
 * 大量重複 errorlog。現做法只在佇列本身滿（故障長到累積上千個轉換）或行程崩潰時才會遺失。
 * 重試時若前一次其實部分寫入成功，撞到的重複鍵（11000）視為成功，不會重複入庫。
 * 升級路徑（若未來轉為不可丟失）：寫入前先進佇列（BullMQ 或 Redis Stream）再批次落庫。
 */
@Injectable()
export class HistoryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(HistoryService.name);
  private client?: MongoClient;
  private db?: Db;
  private lastState: ReadonlyMap<string, MachineState> = new Map();
  private flushTimer?: ReturnType<typeof setInterval>;
  private closed = false;

  private readonly telemetryBuffer = new BoundedBuffer<TelemetryDoc>(TELEMETRY_BUFFER_CAPACITY);
  private readonly errorBuffer = new BoundedBuffer<ErrorLogDoc>(ERRORLOG_BUFFER_CAPACITY);
  private readonly flight = new SingleFlight();
  private readonly throttle = new LogThrottle(ERROR_LOG_THROTTLE_MS);

  private droppedPoints = 0;
  private persistFailures = 0;
  private failedPoints = 0;
  private droppedErrorLogs = 0;

  constructor(private readonly config: AppConfigService) {}

  async onModuleInit(): Promise<void> {
    // serverSelectionTimeoutMS 預設 30 秒：Mongo 不可達時每次操作都卡 30 秒才失敗。
    // 縮到 3 秒讓啟動失敗與寫入失敗都快速浮現（等待期間新點先進 buffer，推送 cadence 不受牽制；
    // 失敗的那批 telemetry 依有損語意不重試）。
    // socketTimeoutMS：Mongo「可達但卡住」時（選址成功、回應遲遲不來）單次操作也有上限。
    // 10 秒遠大於一批 ≤5000 點 insertMany 的正常耗時，不會誤殺正常寫入。
    this.client = new MongoClient(this.config.mongoUrl, {
      serverSelectionTimeoutMS: 3_000,
      socketTimeoutMS: 10_000,
    });
    await this.client.connect();
    this.db = this.client.db(this.config.mongoDb);
    await this.ensureCollections(this.db);
    this.flushTimer = setInterval(() => {
      void this.flight.run(() => this.writeOnce());
    }, FLUSH_INTERVAL_MS);
    // 計時器不應單獨撐住行程存活：關閉流程由 main.ts 顯式 flush 收尾。
    this.flushTimer.unref();
    this.logger.log("history service connected to mongo");
  }

  async onModuleDestroy(): Promise<void> {
    if (this.flushTimer) clearInterval(this.flushTimer);
    // 不在這裡再寫一次：正常關閉路徑（main.ts shutdown）已先做有時限的 flush。這裡只有時限地
    // 等進行中那一批，然後關連線——任何無上限的 await 都會讓 app.close() 卡到被 SIGKILL，
    // 而非零退出會被 on-failure 誤判為崩潰。
    const idle = await withDeadline(this.flight.idle(), DESTROY_IDLE_DEADLINE_MS);
    this.closed = true;
    const { bufferedPoints, pendingErrorLogs } = this.getWriteStats();
    if (!idle || bufferedPoints > 0 || pendingErrorLogs > 0) {
      this.logger.warn(
        `closing mongo with unflushed data: bufferedPoints=${bufferedPoints} ` +
          `pendingErrorLogs=${pendingErrorLogs} inFlightTimedOut=${!idle}`,
      );
    }
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

  /**
   * 一個 tick 的**全部機台**進 buffer（全量、與訂閱無關）。同步、不碰 I/O，
   * Gateway 在高頻 tick 內直接呼叫，不需 await。
   */
  enqueue(points: readonly TelemetryPoint[]): void {
    if (points.length === 0 || this.closed) return;
    const { errors, nextState } = detectErrorTransitions(points, this.lastState, new Date());
    this.lastState = nextState;
    this.droppedPoints += this.telemetryBuffer.push(points.map(toTelemetryDoc));
    this.droppedErrorLogs += this.errorBuffer.push(errors);
  }

  /**
   * 立即把 buffer 寫掉：先等進行中的那一批結束，再寫一次當下的殘量。
   * 用於關閉流程（先停 producer、再 flush、再 app.close()）。不會拋出。
   *
   * `deadlineMs` 是「等進行中＋寫殘量」兩段合計的上限；逾時回 `false`（寫入仍在背景進行，
   * 但呼叫端不再等）。不給 deadline 則等到完成。
   */
  async flush(opts: { deadlineMs?: number } = {}): Promise<boolean> {
    const { deadlineMs } = opts;
    if (deadlineMs === undefined) {
      await this.flight.idle();
      await this.flight.run(() => this.writeOnce()).catch(() => undefined);
      return true;
    }
    const startedAt = Date.now();
    if (!(await withDeadline(this.flight.idle(), deadlineMs))) return false;
    const remaining = deadlineMs - (Date.now() - startedAt);
    const done = await withDeadline(
      this.flight.run(() => this.writeOnce()),
      remaining,
    );
    if (!done) this.logger.warn(`history flush did not finish within ${deadlineMs}ms`);
    return done;
  }

  getWriteStats(): HistoryWriteStats {
    return {
      bufferedPoints: this.telemetryBuffer.size,
      droppedPoints: this.droppedPoints,
      persistFailures: this.persistFailures,
      failedPoints: this.failedPoints,
      pendingErrorLogs: this.errorBuffer.size,
      droppedErrorLogs: this.droppedErrorLogs,
    };
  }

  /** 單次寫入。只經由 `SingleFlight` 呼叫，保證同時至多一個 in-flight；錯誤在此吸收、不外拋。 */
  private async writeOnce(): Promise<void> {
    const db = this.db;
    if (!db || this.closed) return;

    const docs = this.telemetryBuffer.drain();
    const errors = this.errorBuffer.drain();

    if (docs.length > 0) {
      try {
        await db.collection<TelemetryDoc>("telemetry").insertMany(docs, { ordered: false });
      } catch (err) {
        this.persistFailures += 1;
        this.failedPoints += docs.length;
        this.reportWriteError("telemetry", err, `${docs.length} points lost`);
      }
    }

    // errorlog 與 telemetry 各自獨立：telemetry 寫失敗不影響 errorlog 這一步。
    if (errors.length > 0) {
      try {
        await db.collection<ErrorLogDoc>("errorlogs").insertMany(errors, { ordered: false });
      } catch (err) {
        if (!isOnlyDuplicateKeyError(err)) {
          this.persistFailures += 1;
          const failure = classifyInsertFailure(err, errors.length);
          if (failure.kind === "transient") {
            this.droppedErrorLogs += this.errorBuffer.unshift(errors);
            this.reportWriteError("errorlogs", err, `${errors.length} errorlogs requeued`);
          } else {
            // 毒批次：未被拒的已寫入，被拒的重送也只會再被拒——丟棄並計數，不重試。
            this.droppedErrorLogs += failure.rejected;
            this.reportWriteError(
              "errorlogs-rejected",
              err,
              `${failure.rejected} errorlogs rejected and dropped`,
            );
          }
        }
      }
    }
  }

  private reportWriteError(kind: string, err: unknown, detail: string): void {
    const pass = this.throttle.hit(kind, Date.now());
    if (!pass) return;
    const message = err instanceof Error ? err.message : String(err);
    const suppressed =
      pass.suppressed > 0 ? `; ${pass.suppressed} similar failures suppressed in last 30s` : "";
    this.logger.error(
      `persist ${kind} failed (${detail}): ${message}${suppressed}; ` +
        `totals persistFailures=${this.persistFailures} droppedPoints=${this.droppedPoints} ` +
        `failedPoints=${this.failedPoints} droppedErrorLogs=${this.droppedErrorLogs}`,
    );
  }

  private async ensureCollections(db: Db): Promise<void> {
    await this.ensureTelemetryCollection(db);
    await db.collection("errorlogs").createIndex({ machineId: 1, timestamp: -1 });
    await this.ensureTtlIndex(db, "errorlogs", "timestamp", ERRORLOG_TTL_SECONDS);
    await db.collection("maintenanceRecords").createIndex({ machineId: 1, performedAt: -1 });
    // diagnosisTriggers 的索引（含 TTL）由 worker 擁有與建立，api 不在此重複處理。
  }

  private async ensureTelemetryCollection(db: Db): Promise<void> {
    const ttl = this.config.telemetryTtlSeconds;
    try {
      await db.createCollection("telemetry", {
        timeseries: { timeField: "timestamp", metaField: "metadata", granularity: "seconds" },
        expireAfterSeconds: ttl,
      });
      return;
    } catch (err) {
      if (mongoErrorCode(err) !== NAMESPACE_EXISTS) throw err;
    }

    // 已存在（重啟）：建立時帶的 expireAfterSeconds 不會套用到既有 collection，須比對後 collMod。
    const [info] = await db.listCollections({ name: "telemetry" }).toArray();
    const plan = planTimeSeriesTtl(info, ttl);
    switch (plan.action) {
      case "none":
        return;
      case "not-timeseries":
        this.logger.warn(
          `telemetry collection is not time-series (type=${plan.type ?? "unknown"}); ` +
            "TTL cannot be applied - drop the collection and restart to recreate it",
        );
        return;
      case "collMod":
        await db.command({ collMod: "telemetry", expireAfterSeconds: plan.to });
        this.logger.log(
          `telemetry TTL updated via collMod: ${plan.from ?? "unset"} -> ${plan.to} seconds`,
        );
        return;
    }
  }

  /**
   * 建立單欄位 TTL 索引；同鍵／同名索引已存在但選項不同（85/86）時改用 collMod 更新秒數。
   * collMod 也失敗時只記 warn、不讓啟動失敗——少了 TTL 是資料保存期問題，不值得讓 api 起不來。
   */
  private async ensureTtlIndex(
    db: Db,
    collection: string,
    field: string,
    ttlSeconds: number,
  ): Promise<void> {
    const keyPattern = { [field]: 1 };
    try {
      await db
        .collection(collection)
        .createIndex(keyPattern, { expireAfterSeconds: ttlSeconds, name: `${field}_ttl` });
      return;
    } catch (err) {
      if (!isIndexConflict(err)) throw err;
    }
    try {
      await db.command({
        collMod: collection,
        index: { keyPattern, expireAfterSeconds: ttlSeconds },
      });
      this.logger.log(`${collection} TTL index updated via collMod: ${ttlSeconds} seconds`);
    } catch (err) {
      this.logger.warn(
        `${collection} TTL index conflict and collMod failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
