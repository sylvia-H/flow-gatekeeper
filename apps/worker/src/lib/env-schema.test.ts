import { describe, expect, it } from "vitest";
import { LOCK_TTL_MARGIN_MS, parseRedisEnv, parseWorkerEnv } from "./env-schema.js";

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
    expect(r.env.AI_MAX_OUTPUT_TOKENS).toBe(2048);
    expect(r.env.AI_TEMPERATURE).toBe(0.2);
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

  it("REDIS_PORT 超出 65535 → 失敗（與 api 同規則）", () => {
    const r = parseWorkerEnv({ REDIS_PORT: "70000" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("REDIS_PORT");
  });

  it("鎖 TTL 短於 AI 逾時 → 失敗", () => {
    const r = parseWorkerEnv({ AI_DEDUPE_LOCK_SECONDS: "10", AI_TIMEOUT_MS: "30000" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("AI_DEDUPE_LOCK_SECONDS");
  });

  it("鎖 TTL 恰等於 AI 逾時（無收尾餘裕）→ 失敗，訊息寫明餘裕", () => {
    const r = parseWorkerEnv({ AI_DEDUPE_LOCK_SECONDS: "30", AI_TIMEOUT_MS: "30000" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("AI_DEDUPE_LOCK_SECONDS");
    expect(r.error).toContain(`${LOCK_TTL_MARGIN_MS}ms`);
  });

  it("鎖 TTL 恰等於 AI 逾時 + 餘裕 → 通過；少 1 秒 → 失敗", () => {
    expect(LOCK_TTL_MARGIN_MS).toBe(5000);
    expect(parseWorkerEnv({ AI_DEDUPE_LOCK_SECONDS: "35", AI_TIMEOUT_MS: "30000" }).ok).toBe(true);
    expect(parseWorkerEnv({ AI_DEDUPE_LOCK_SECONDS: "34", AI_TIMEOUT_MS: "30000" }).ok).toBe(false);
  });

  it("AI_MAX_OUTPUT_TOKENS：正整數、上限 65536", () => {
    const ok = parseWorkerEnv({ AI_MAX_OUTPUT_TOKENS: "1024" });
    expect(ok.ok && ok.env.AI_MAX_OUTPUT_TOKENS).toBe(1024);
    for (const v of ["0", "-1", "1.5", "65537", "abc"]) {
      const r = parseWorkerEnv({ AI_MAX_OUTPUT_TOKENS: v });
      expect(r.ok, v).toBe(false);
      if (!r.ok) expect(r.error).toContain("AI_MAX_OUTPUT_TOKENS");
    }
  });

  it("AI_TEMPERATURE：0–2（含端點、可為小數），留空走預設", () => {
    for (const [v, want] of [["0", 0], ["2", 2], ["0.7", 0.7], ["", 0.2]] as const) {
      const r = parseWorkerEnv({ AI_TEMPERATURE: v });
      expect(r.ok && r.env.AI_TEMPERATURE, v).toBe(want);
    }
    for (const v of ["-0.1", "2.1", "hot"]) {
      const r = parseWorkerEnv({ AI_TEMPERATURE: v });
      expect(r.ok, v).toBe(false);
      if (!r.ok) expect(r.error).toContain("AI_TEMPERATURE");
    }
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

describe("WORKER_INSTANCE_ID", () => {
  it("未設定或留空 → undefined（由 redis-keys 退回 hostname）", () => {
    expect(parseRedisEnv({}).WORKER_INSTANCE_ID).toBeUndefined();
    expect(parseRedisEnv({ WORKER_INSTANCE_ID: " " }).WORKER_INSTANCE_ID).toBeUndefined();
  });

  it("合法值於完整 schema 與 Redis 子集都讀得到（探針與主行程推導同一 id）", () => {
    const r = parseWorkerEnv({ WORKER_INSTANCE_ID: "worker-a.1_x" });
    expect(r.ok && r.env.WORKER_INSTANCE_ID).toBe("worker-a.1_x");
    expect(parseRedisEnv({ WORKER_INSTANCE_ID: "worker-a.1_x" }).WORKER_INSTANCE_ID).toBe("worker-a.1_x");
  });

  it.each([["has space"], ["a:b"], ["w*"], ["x".repeat(129)]])("不合法 %s → 失敗", (v) => {
    const r = parseWorkerEnv({ WORKER_INSTANCE_ID: v });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("WORKER_INSTANCE_ID");
  });
});
