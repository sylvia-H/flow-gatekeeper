import { Injectable } from "@nestjs/common";
import { resolveLogLevel, resolvePretty } from "@flow-gatekeeper/shared/logging";

/**
 * 集中、型別化讀取環境設定（dotenv 由 main.ts 於啟動前載入）。
 * 避免 process.env 散落於各 service（沿用 001 的 .env.example 設定形狀）。
 */
@Injectable()
export class AppConfigService {
  readonly apiPort = Number(process.env.API_PORT ?? 3000);
  readonly mockTelemetryIntervalMs = Number(process.env.MOCK_TELEMETRY_INTERVAL_MS ?? 50);
  readonly wsHeartbeatMs = Number(process.env.WS_HEARTBEAT_MS ?? 15000);
  readonly wsAuthSecret = process.env.WS_AUTH_SECRET ?? "";
  readonly mongoUrl = process.env.MONGO_URL ?? "mongodb://127.0.0.1:27017/flow-gatekeeper";
  readonly mongoDb = process.env.MONGO_DB ?? "flow-gatekeeper";
  readonly telemetryTtlSeconds = Number(process.env.TELEMETRY_TTL_SECONDS ?? 604800);
  // 003：jobs module（BullMQ producer）與 AI/job-status relay 連線用（憲章 IV 連線分離）。
  readonly redisHost = process.env.REDIS_HOST ?? "127.0.0.1";
  readonly redisPort = Number(process.env.REDIS_PORT ?? 6379);
  // 009：日誌等級與呈現模式（實際 pino 實例已於 main.ts 用 createLogger() 建立；此處僅供
  // 設定內省，複用同一組純函式避免解析邏輯重複，FR-003/research R3）。
  readonly logLevel = resolveLogLevel(process.env).level;
  readonly logPretty = resolvePretty(process.env);
  // 009 US2：健康端點對每個依賴探測的獨立逾時（FR-007）。
  readonly healthProbeTimeoutMs = Number(process.env.HEALTH_PROBE_TIMEOUT_MS ?? 2000);
}
