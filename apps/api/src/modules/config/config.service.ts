import { Injectable } from "@nestjs/common";
import type { RedisOptions } from "ioredis";
import {
  MAX_METRICS_INTERVAL_MS,
  MIN_METRICS_INTERVAL_MS,
  resolveLogLevel,
  resolveMetricsInterval,
  resolveMetricsLogLevel,
  resolvePretty,
} from "@flow-gatekeeper/shared/logging";
import { resolveHealthProbeTimeout } from "../../lib/health-probe-timeout.js";
import { parseApiEnv } from "../../lib/env-schema.js";
import { parseAllowedOrigins } from "../../lib/ws-origin.js";
import type { ApiEnv } from "../../lib/env-schema.js";
import { getAppLogger } from "../../logging/app-logger.js";

/**
 * Redis 連線的兩種用途，決定斷線時命令該「等」還是「立刻失敗」：
 * - `blocking`：BullMQ Worker／QueueEvents／Pub/Sub subscriber。BullMQ 對 blocking 連線強制
 *   `maxRetriesPerRequest: null`（否則 XREAD/BRPOPLPUSH 會被重試上限打斷），subscriber 只收不發，
 *   斷線時靠 ioredis 自動重連後重新訂閱即可。
 * - `command`：一般指令（BullMQ producer、health PING、metrics GET）。這些呼叫都有「呼叫端在等」
 *   ——HTTP 請求、健康探測、週期結算——斷線時必須快速 reject，讓呼叫端回 503／判 down／略過本輪。
 */
export type RedisConnectionKind = "blocking" | "command";

/** command 連線單一指令的逾時上限（毫秒）；超過即 reject，不讓呼叫端無限期掛住。 */
const REDIS_COMMAND_TIMEOUT_MS = 5_000;

/**
 * 集中、型別化讀取環境設定（dotenv 由 main.ts 於啟動前載入）。
 * 避免 process.env 散落於各 service（沿用 001 的 .env.example 設定形狀）。
 *
 * 建構時以 `parseApiEnv` 一次驗證：任何數值變數設成 0、負數或非數字即 throw，Nest 建立
 * provider 失敗 → bootstrap reject → 行程非零退出。寧可啟動失敗並說清楚哪裡錯，也不要帶著
 * `WS_HEARTBEAT_MS=0` 這類設定「看起來正常地」跑起來（理由見 lib/env-schema.ts）。
 */
@Injectable()
export class AppConfigService {
  // 必須是第一個欄位：後續欄位初始化器都從這份已驗證的 env 取值。
  private readonly env: ApiEnv = parseApiEnv(process.env);

  readonly apiPort = this.env.API_PORT;
  // 執行環境是否為 production（與 shared logging 的 `resolvePretty` 同一判準：精確等於 "production"）。
  // 集中在此讀，service 不直接碰 process.env.NODE_ENV。
  readonly isProduction = process.env.NODE_ENV === "production";
  readonly mockTelemetryIntervalMs = this.env.MOCK_TELEMETRY_INTERVAL_MS;
  readonly wsHeartbeatMs = this.env.WS_HEARTBEAT_MS;
  readonly wsAuthSecret = this.env.WS_AUTH_SECRET ?? "";
  // WS upgrade 的 Origin 白名單；空陣列＝不檢查（解析規則與 Gateway 共用 lib/ws-origin.ts）。
  readonly wsAllowedOrigins = parseAllowedOrigins(this.env.WS_ALLOWED_ORIGINS);
  // WS 出口背壓高水位（bytes）與同時連線數上限（範圍驗證見 lib/env-schema.ts）。
  readonly wsSendHighWaterBytes = this.env.WS_SEND_HIGH_WATER_BYTES;
  readonly maxWsConnections = this.env.MAX_WS_CONNECTIONS;
  // 有設 WS_AUTH_SECRET 時，連線通過 token 檢查的期限（逾時以 1008 關閉，防止佔住連線名額）。
  readonly wsAuthGraceMs = this.env.WS_AUTH_GRACE_MS;
  readonly mongoUrl = this.env.MONGO_URL;
  readonly mongoDb = this.env.MONGO_DB;
  readonly telemetryTtlSeconds = this.env.TELEMETRY_TTL_SECONDS;
  // 003：jobs module（BullMQ producer）與 AI/job-status relay 連線用（憲章 IV 連線分離）。
  readonly redisHost = this.env.REDIS_HOST;
  readonly redisPort = this.env.REDIS_PORT;
  // 與 worker 讀同一個變數：Redis 一旦設了 requirepass，api 的五條連線若不帶密碼會全部 NOAUTH、
  // 無限重連，佇列與 /healthz 一起掛掉——所以兩端必須同時讀、同時生效。
  readonly redisPassword = this.env.REDIS_PASSWORD;
  // 009：日誌等級與呈現模式（實際 pino 實例已於 main.ts 用 createLogger() 建立；此處僅供
  // 設定內省，複用同一組純函式避免解析邏輯重複，FR-003/research R3）。
  readonly logLevel = resolveLogLevel(process.env).level;
  readonly logPretty = resolvePretty(process.env);
  // 009 US2：健康端點對每個依賴探測的獨立逾時（FR-007）。留空或非數值一律回退預設 2000ms
  // ——裸 `Number()` 會把 `HEALTH_PROBE_TIMEOUT_MS=`（空字串，`??` 不生效）解成 0、非數值解成
  // NaN，兩者都讓逾時 promise 立刻 reject → 依賴恆判 down → /healthz 恆 503（見 lib 的說明）。
  readonly healthProbeTimeoutMs = resolveHealthProbeTimeout(process.env).timeoutMs;
  // 009 US3：指標結算間隔（預設 60000ms、須為 5000–2^31-1 的整數，不合法一律回退預設而非 clamp）。
  readonly metricsIntervalMs = resolveMetricsInterval(process.env).intervalMs;
  // 指標摘要 child logger 的等級——**獨立於 LOG_LEVEL**，使 LOG_LEVEL=warn 時摘要仍輸出（SC-005）。
  readonly metricsLogLevel = resolveMetricsLogLevel(process.env);

  constructor() {
    // FR-008 下限回退警告由呼叫端輸出（職責邊界見 tasks T011a／analyze E3：`createLogger`
    // 只負責 LOG_LEVEL 那一則，METRICS_INTERVAL_MS 與日誌無關，由各自的消費者負責）。
    // 在建構當下就記，讓設定錯誤在啟動時即可見，而非等到第一次結算。
    const interval = resolveMetricsInterval(process.env);
    if (interval.fellBackToDefault) {
      getAppLogger()
        .child({ context: AppConfigService.name })
        .warn(
          { invalidMetricsInterval: interval.rawValue, fallbackIntervalMs: interval.intervalMs },
          `METRICS_INTERVAL_MS="${interval.rawValue ?? ""}" 不合法（須為 ${MIN_METRICS_INTERVAL_MS}–${MAX_METRICS_INTERVAL_MS} 的整數），已回退至 ${interval.intervalMs}ms`,
        );
    }

    // 同理（見 healthProbeTimeoutMs 的說明）：逾時設錯只會表現為「健康端點永遠說 unhealthy」，
    // 症狀與真的依賴掛掉一模一樣，故在啟動當下就明說是設定值被回退，而非等人去追 503。
    const probeTimeout = resolveHealthProbeTimeout(process.env);
    if (probeTimeout.fellBackToDefault) {
      getAppLogger()
        .child({ context: AppConfigService.name })
        .warn(
          {
            invalidHealthProbeTimeout: probeTimeout.rawValue,
            fallbackTimeoutMs: probeTimeout.timeoutMs,
          },
          `HEALTH_PROBE_TIMEOUT_MS="${probeTimeout.rawValue ?? ""}" 不是正數，已回退至 ${probeTimeout.timeoutMs}ms`,
        );
    }
  }

  /**
   * 五條 Redis 連線的單一設定來源（host／port／password 與重試策略），避免各處自組而漏帶密碼。
   *
   * `command` 取捨：`enableOfflineQueue: false` 讓斷線期間的命令**立刻 reject**，而不是在
   * ioredis 的離線佇列裡排隊等重連——排隊的代價是 `POST /diagnoses` 永久掛住、指標結算一輪輪堆積、
   * 健康探測只能靠外層逾時才判 down。代價是連線建立完成前、或短暫斷線瞬間送出的命令會失敗，
   * 需由呼叫端處理（jobs 回 503、health 判 down、metrics 略過本輪）；BullMQ 官方亦建議對
   * 面向 HTTP 的 Queue 這樣設定以快速失敗。`commandTimeout` 涵蓋「連線還在、但 Redis 不回應」；
   * `maxRetriesPerRequest: 3` 限制斷線瞬間已送出、尚未回覆的在途命令跨重連重送的次數（ioredis
   * 在第 N+1 次重連時才把在途 commandQueue 以錯誤 flush），避免它們跟著無限重連一起懸著。
   */
  redisOptions(kind: RedisConnectionKind): RedisOptions {
    const base: RedisOptions = {
      host: this.redisHost,
      port: this.redisPort,
      ...(this.redisPassword !== undefined ? { password: this.redisPassword } : {}),
    };
    if (kind === "blocking") {
      return { ...base, maxRetriesPerRequest: null };
    }
    return {
      ...base,
      maxRetriesPerRequest: 3,
      commandTimeout: REDIS_COMMAND_TIMEOUT_MS,
      enableOfflineQueue: false,
    };
  }
}
