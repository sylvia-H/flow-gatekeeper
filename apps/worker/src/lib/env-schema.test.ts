import { describe, expect, it } from "vitest";
import { parseRedisEnv, parseWorkerEnv } from "./env-schema.js";

describe("parseWorkerEnv", () => {
  it("全部未設定 → 預設值，並對缺金鑰 warn", () => {
    const r = parseWorkerEnv({});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.env.AI_TIMEOUT_MS).toBe(30_000);
    expect(r.env.AI_DEDUPE_LOCK_SECONDS).toBe(45);
    expect(r.env.REDIS_PORT).toBe(6379);
    expect(r.env.WORKER_CONCURRENCY).toBe(2);
    expect(r.env.GEMINI_MODEL).toBe("gemini-2.5-flash");
    expect(r.warnings.some((w) => w.includes("GEMINI_API_KEY"))).toBe(true);
  });

  it("空字串視為未設定（不會變成 0）", () => {
    const r = parseWorkerEnv({ AI_DEDUPE_LOCK_SECONDS: "", REDIS_PORT: "  ", REDIS_PASSWORD: "" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.env.AI_DEDUPE_LOCK_SECONDS).toBe(45);
    expect(r.env.REDIS_PORT).toBe(6379);
    expect(r.env.REDIS_PASSWORD).toBeUndefined();
  });

  it("字串數字會被 coerce", () => {
    const r = parseWorkerEnv({ AI_RPM: "20", AI_TIMEOUT_MS: "10000" });
    expect(r.ok && r.env.AI_RPM).toBe(20);
  });

  it.each([["0"], ["-5"], ["1.5"], ["abc"]])("非正整數 %s → 失敗", (v) => {
    const r = parseWorkerEnv({ AI_CACHE_TTL_SECONDS: v });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("AI_CACHE_TTL_SECONDS");
  });

  it("鎖 TTL 短於 AI 逾時 → 失敗", () => {
    const r = parseWorkerEnv({ AI_DEDUPE_LOCK_SECONDS: "10", AI_TIMEOUT_MS: "30000" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("AI_DEDUPE_LOCK_SECONDS");
  });

  it("鎖 TTL 恰等於 AI 逾時 → 通過", () => {
    expect(parseWorkerEnv({ AI_DEDUPE_LOCK_SECONDS: "30", AI_TIMEOUT_MS: "30000" }).ok).toBe(true);
  });

  it("production 缺金鑰也可啟動（金鑰永遠可選），但有 warning；有金鑰則不 warn", () => {
    const missing = parseWorkerEnv({ NODE_ENV: "production", GEMINI_API_KEY: "" });
    expect(missing.ok).toBe(true);
    if (missing.ok) expect(missing.warnings.some((w) => w.includes("不重試"))).toBe(true);
    const good = parseWorkerEnv({ NODE_ENV: "production", GEMINI_API_KEY: "k" });
    expect(good.ok).toBe(true);
    if (good.ok) expect(good.warnings).toEqual([]);
  });
});

describe("parseRedisEnv", () => {
  it("只驗 Redis 子集，忽略其他變數", () => {
    expect(parseRedisEnv({ REDIS_HOST: "redis", AI_TIMEOUT_MS: "-1" }).REDIS_HOST).toBe("redis");
  });
});
