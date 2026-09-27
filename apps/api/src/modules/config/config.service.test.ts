import { afterEach, describe, expect, it, vi } from "vitest";
import { AppConfigService } from "./config.service.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("AppConfigService.redisOptions", () => {
  it("blocking：maxRetriesPerRequest 為 null，不帶 commandTimeout／enableOfflineQueue", () => {
    vi.stubEnv("REDIS_PASSWORD", "");
    const opts = new AppConfigService().redisOptions("blocking");
    expect(opts.maxRetriesPerRequest).toBeNull();
    expect(opts).not.toHaveProperty("commandTimeout");
    expect(opts).not.toHaveProperty("enableOfflineQueue");
  });

  it("command：有限重試＋命令逾時＋關閉離線佇列", () => {
    const opts = new AppConfigService().redisOptions("command");
    expect(opts.maxRetriesPerRequest).toBe(3);
    expect(opts.commandTimeout).toBe(5000);
    expect(opts.enableOfflineQueue).toBe(false);
  });

  it("未設密碼（含留空）時不帶 password 鍵", () => {
    vi.stubEnv("REDIS_PASSWORD", "");
    const config = new AppConfigService();
    expect(config.redisOptions("command")).not.toHaveProperty("password");
    expect(config.redisOptions("blocking")).not.toHaveProperty("password");
  });

  it("有設密碼時兩種連線都帶上，host／port 取自 env", () => {
    vi.stubEnv("REDIS_PASSWORD", "s3cret");
    vi.stubEnv("REDIS_HOST", "redis");
    vi.stubEnv("REDIS_PORT", "6380");
    const config = new AppConfigService();
    for (const kind of ["command", "blocking"] as const) {
      expect(config.redisOptions(kind)).toMatchObject({ host: "redis", port: 6380, password: "s3cret" });
    }
  });
});

describe("AppConfigService env 驗證與 WS Origin 白名單", () => {
  it("數值變數不合法時建構即 throw（bootstrap 因此 reject）", () => {
    vi.stubEnv("WS_HEARTBEAT_MS", "0");
    expect(() => new AppConfigService()).toThrow(/WS_HEARTBEAT_MS/);
  });

  it("WS_ALLOWED_ORIGINS 解析為正規化後的陣列；留空為空陣列（不檢查）", () => {
    vi.stubEnv("WS_ALLOWED_ORIGINS", "https://A.example.com/, http://localhost:5173");
    expect(new AppConfigService().wsAllowedOrigins).toEqual([
      "https://a.example.com",
      "http://localhost:5173",
    ]);
    vi.stubEnv("WS_ALLOWED_ORIGINS", "");
    expect(new AppConfigService().wsAllowedOrigins).toEqual([]);
  });

  it("WS 背壓高水位與連線數上限：留空套預設、有值照用、超出範圍建構即 throw", () => {
    const defaults = new AppConfigService();
    expect(defaults.wsSendHighWaterBytes).toBe(1024 * 1024);
    expect(defaults.maxWsConnections).toBe(500);
    expect(defaults.wsAuthGraceMs).toBe(10_000);

    vi.stubEnv("WS_SEND_HIGH_WATER_BYTES", "131072");
    vi.stubEnv("MAX_WS_CONNECTIONS", "20");
    vi.stubEnv("WS_AUTH_GRACE_MS", "5000");
    const custom = new AppConfigService();
    expect(custom.wsAuthGraceMs).toBe(5_000);
    expect(custom.wsSendHighWaterBytes).toBe(131_072);
    expect(custom.maxWsConnections).toBe(20);

    vi.stubEnv("MAX_WS_CONNECTIONS", "0");
    expect(() => new AppConfigService()).toThrow(/MAX_WS_CONNECTIONS/);
  });
});
