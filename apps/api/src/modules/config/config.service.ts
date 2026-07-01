import { Injectable } from "@nestjs/common";

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
}
