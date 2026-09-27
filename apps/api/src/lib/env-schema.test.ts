import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_WS_CONNECTIONS,
  DEFAULT_WS_AUTH_GRACE_MS,
  MAX_WS_AUTH_GRACE_MS,
  MIN_WS_AUTH_GRACE_MS,
  DEFAULT_WS_SEND_HIGH_WATER_BYTES,
  MAX_MAX_WS_CONNECTIONS,
  MAX_TIMER_DELAY_MS,
  MAX_WS_SEND_HIGH_WATER_BYTES,
  MIN_WS_SEND_HIGH_WATER_BYTES,
  MIN_MOCK_TELEMETRY_INTERVAL_MS,
  MIN_WS_HEARTBEAT_MS,
  parseApiEnv,
} from "./env-schema.js";

describe("parseApiEnv", () => {
  it("完全未設定 → 全部套用預設值", () => {
    expect(parseApiEnv({})).toEqual({
      API_PORT: 3000,
      MOCK_TELEMETRY_INTERVAL_MS: 50,
      WS_HEARTBEAT_MS: 15_000,
      WS_AUTH_SECRET: undefined,
      WS_ALLOWED_ORIGINS: undefined,
      WS_SEND_HIGH_WATER_BYTES: 1024 * 1024,
      WS_AUTH_GRACE_MS: 10_000,
      MAX_WS_CONNECTIONS: 500,
      MONGO_URL: "mongodb://127.0.0.1:27017/flow-gatekeeper",
      MONGO_DB: "flow-gatekeeper",
      TELEMETRY_TTL_SECONDS: 604_800,
      REDIS_HOST: "127.0.0.1",
      REDIS_PORT: 6379,
      REDIS_PASSWORD: undefined,
    });
  });

  it("留空（X=）與只有空白都視同未設定，MUST NOT 變成 0", () => {
    const env = parseApiEnv({
      API_PORT: "",
      WS_HEARTBEAT_MS: "",
      MOCK_TELEMETRY_INTERVAL_MS: "   ",
      TELEMETRY_TTL_SECONDS: "",
      REDIS_PORT: "",
      REDIS_HOST: "",
      REDIS_PASSWORD: "",
      WS_AUTH_SECRET: "",
    });
    expect(env.API_PORT).toBe(3000);
    expect(env.WS_HEARTBEAT_MS).toBe(15_000);
    expect(env.MOCK_TELEMETRY_INTERVAL_MS).toBe(50);
    expect(env.TELEMETRY_TTL_SECONDS).toBe(604_800);
    expect(env.REDIS_PORT).toBe(6379);
    expect(env.REDIS_HOST).toBe("127.0.0.1");
    expect(env.REDIS_PASSWORD).toBeUndefined();
    expect(env.WS_AUTH_SECRET).toBeUndefined();
  });

  it("合法值照用（數字字串轉為 number）", () => {
    const env = parseApiEnv({ WS_HEARTBEAT_MS: "5000", REDIS_PASSWORD: "s3cret", REDIS_HOST: "redis" });
    expect(env.WS_HEARTBEAT_MS).toBe(5000);
    expect(env.REDIS_PASSWORD).toBe("s3cret");
    expect(env.REDIS_HOST).toBe("redis");
  });

  it("WS_HEARTBEAT_MS=0 被拒，訊息指名變數與收到的值", () => {
    expect(() => parseApiEnv({ WS_HEARTBEAT_MS: "0" })).toThrow(/WS_HEARTBEAT_MS.*收到 "0"/);
  });

  it.each([
    ["WS_HEARTBEAT_MS", "abc"],
    ["API_PORT", "abc"],
    ["MOCK_TELEMETRY_INTERVAL_MS", "-5"],
    ["TELEMETRY_TTL_SECONDS", "1.5"],
    ["REDIS_PORT", "70000"],
  ])("%s=%s 被拒", (key, value) => {
    expect(() => parseApiEnv({ [key]: value })).toThrow(new RegExp(key));
  });

  it("多個錯誤一次列完，不必逐個修逐個重啟", () => {
    let message = "";
    try {
      parseApiEnv({ WS_HEARTBEAT_MS: "0", API_PORT: "abc" });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("WS_HEARTBEAT_MS");
    expect(message).toContain("API_PORT");
  });

  it.each([
    ["WS_HEARTBEAT_MS", "1"],
    ["WS_HEARTBEAT_MS", "999"],
    ["WS_HEARTBEAT_MS", String(2 ** 31)],
    ["WS_HEARTBEAT_MS", "15000.5"],
    ["MOCK_TELEMETRY_INTERVAL_MS", "1"],
    ["MOCK_TELEMETRY_INTERVAL_MS", "4"],
    ["MOCK_TELEMETRY_INTERVAL_MS", String(2 ** 31)],
  ])("%s=%s（低於下限、超過計時器上限或非整數）被拒", (key, value) => {
    expect(() => parseApiEnv({ [key]: value })).toThrow(new RegExp(key));
  });

  it("計時器間隔的上下限邊界值照用", () => {
    expect(parseApiEnv({ WS_HEARTBEAT_MS: String(MIN_WS_HEARTBEAT_MS) }).WS_HEARTBEAT_MS).toBe(1_000);
    expect(
      parseApiEnv({ MOCK_TELEMETRY_INTERVAL_MS: String(MIN_MOCK_TELEMETRY_INTERVAL_MS) })
        .MOCK_TELEMETRY_INTERVAL_MS,
    ).toBe(5);
    expect(parseApiEnv({ WS_HEARTBEAT_MS: String(MAX_TIMER_DELAY_MS) }).WS_HEARTBEAT_MS).toBe(MAX_TIMER_DELAY_MS);
  });

  it("WS_SEND_HIGH_WATER_BYTES／MAX_WS_CONNECTIONS 留空套預設、邊界值照用", () => {
    const env = parseApiEnv({ WS_SEND_HIGH_WATER_BYTES: "", MAX_WS_CONNECTIONS: " " });
    expect(env.WS_SEND_HIGH_WATER_BYTES).toBe(DEFAULT_WS_SEND_HIGH_WATER_BYTES);
    expect(env.MAX_WS_CONNECTIONS).toBe(DEFAULT_MAX_WS_CONNECTIONS);
    expect(
      parseApiEnv({ WS_SEND_HIGH_WATER_BYTES: String(MIN_WS_SEND_HIGH_WATER_BYTES) }).WS_SEND_HIGH_WATER_BYTES,
    ).toBe(MIN_WS_SEND_HIGH_WATER_BYTES);
    expect(
      parseApiEnv({ WS_SEND_HIGH_WATER_BYTES: String(MAX_WS_SEND_HIGH_WATER_BYTES) }).WS_SEND_HIGH_WATER_BYTES,
    ).toBe(MAX_WS_SEND_HIGH_WATER_BYTES);
    expect(parseApiEnv({ MAX_WS_CONNECTIONS: "1" }).MAX_WS_CONNECTIONS).toBe(1);
    expect(parseApiEnv({ MAX_WS_CONNECTIONS: String(MAX_MAX_WS_CONNECTIONS) }).MAX_WS_CONNECTIONS).toBe(
      MAX_MAX_WS_CONNECTIONS,
    );
  });

  it.each([
    ["WS_SEND_HIGH_WATER_BYTES", "0"],
    ["WS_SEND_HIGH_WATER_BYTES", String(MIN_WS_SEND_HIGH_WATER_BYTES - 1)],
    ["WS_SEND_HIGH_WATER_BYTES", String(MAX_WS_SEND_HIGH_WATER_BYTES + 1)],
    ["WS_SEND_HIGH_WATER_BYTES", "1mb"],
    ["MAX_WS_CONNECTIONS", "0"],
    ["MAX_WS_CONNECTIONS", "-1"],
    ["MAX_WS_CONNECTIONS", "2.5"],
    ["MAX_WS_CONNECTIONS", String(MAX_MAX_WS_CONNECTIONS + 1)],
    ["WS_AUTH_GRACE_MS", String(MIN_WS_AUTH_GRACE_MS - 1)],
    ["WS_AUTH_GRACE_MS", String(MAX_WS_AUTH_GRACE_MS + 1)],
    ["WS_AUTH_GRACE_MS", "abc"],
  ])("%s=%s（超出範圍或非整數）被拒", (key, value) => {
    expect(() => parseApiEnv({ [key]: value })).toThrow(new RegExp(key));
  });

  it("WS_AUTH_GRACE_MS 留空套預設、上下限邊界值照用", () => {
    expect(parseApiEnv({ WS_AUTH_GRACE_MS: "" }).WS_AUTH_GRACE_MS).toBe(DEFAULT_WS_AUTH_GRACE_MS);
    expect(parseApiEnv({ WS_AUTH_GRACE_MS: String(MIN_WS_AUTH_GRACE_MS) }).WS_AUTH_GRACE_MS).toBe(1_000);
    expect(parseApiEnv({ WS_AUTH_GRACE_MS: String(MAX_WS_AUTH_GRACE_MS) }).WS_AUTH_GRACE_MS).toBe(60_000);
  });
});
