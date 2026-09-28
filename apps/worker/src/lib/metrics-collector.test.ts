import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChildLogger } from "@flow-gatekeeper/shared/logging";
import type { WorkerMetrics } from "@flow-gatekeeper/contracts";
import {
  createMetricsCollector,
  MAX_LATENCY_SAMPLES,
  type MetricsRedis,
} from "./metrics-collector.js";
import { workerMetricsKey } from "./redis-keys.js";

const KEY = workerMetricsKey("test-instance");

/**
 * 收集器的**視窗語意**測試（data-model E5）。重點是環形緩衝寫滿 1000 筆後繞回的路徑——
 * quickstart 實機演練只累積得到個位數樣本，這條路徑在演練中從未執行過。
 */

type Write = { key: string; value: string; seconds: number };
type Logged = { fields: Record<string, unknown>; msg: string };

function stubs(): {
  redis: MetricsRedis;
  writes: Write[];
  logger: ChildLogger;
  logged: Logged[];
} {
  const writes: Write[] = [];
  const redis: MetricsRedis = {
    set: (key, value, _mode, seconds) => {
      writes.push({ key, value, seconds });
      return Promise.resolve("OK");
    },
  };
  const logged: Logged[] = [];
  const record = (fields: Record<string, unknown>, msg: string): void => {
    logged.push({ fields, msg });
  };
  const logger = { info: record, warn: record } as unknown as ChildLogger;
  return { redis, writes, logger, logged };
}

/** 取最後一次寫入 Redis 的快照（與日誌摘要同源）。 */
function lastSnapshot(writes: Write[]): WorkerMetrics {
  const last = writes.at(-1);
  if (!last) throw new Error("no snapshot written");
  return JSON.parse(last.value) as WorkerMetrics;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createMetricsCollector — 窗內累加與環形緩衝", () => {
  it("樣本超過上限時保留最新 1000 筆、覆寫最舊（環形緩衝繞回）", () => {
    vi.useFakeTimers();
    const { redis, writes, logger } = stubs();
    const collector = createMetricsCollector({
      redis,
      key: KEY,
      logger,
      env: { METRICS_INTERVAL_MS: "5000" },
    });

    // 1500 筆遞增樣本 → 繞回後應只留下第 501–1500 筆。
    for (let i = 1; i <= 1500; i += 1) collector.recordLatency(i);
    collector.start();
    vi.advanceTimersByTime(5000);

    const { llmLatency } = lastSnapshot(writes);
    expect(llmLatency.count).toBe(MAX_LATENCY_SAMPLES);
    // 最舊的 500 筆已被覆寫：max 為 1500、avg 為 (501+1500)/2、p95 取升冪第 950 名（1450）。
    expect(llmLatency.maxMs).toBe(1500);
    expect(llmLatency.avgMs).toBe(Math.round((501 + 1500) / 2));
    expect(llmLatency.p95Ms).toBe(1450);
    collector.stop();
  });

  it("剛好寫滿上限時不繞回，統計涵蓋全部樣本", () => {
    vi.useFakeTimers();
    const { redis, writes, logger } = stubs();
    const collector = createMetricsCollector({
      redis,
      key: KEY,
      logger,
      env: { METRICS_INTERVAL_MS: "5000" },
    });

    for (let i = 1; i <= MAX_LATENCY_SAMPLES; i += 1) collector.recordLatency(i);
    collector.start();
    vi.advanceTimersByTime(5000);

    const { llmLatency } = lastSnapshot(writes);
    expect(llmLatency.count).toBe(MAX_LATENCY_SAMPLES);
    expect(llmLatency.maxMs).toBe(MAX_LATENCY_SAMPLES);
    expect(llmLatency.avgMs).toBe(Math.round((1 + MAX_LATENCY_SAMPLES) / 2));
    collector.stop();
  });

  it("結算後累加器歸零：下一窗無樣本時回 null（不是沿用上一窗的值）", () => {
    vi.useFakeTimers();
    const { redis, writes, logger } = stubs();
    const collector = createMetricsCollector({
      redis,
      key: KEY,
      logger,
      env: { METRICS_INTERVAL_MS: "5000" },
    });

    collector.recordLatency(120);
    collector.recordCacheHit();
    collector.start();

    vi.advanceTimersByTime(5000);
    const first = lastSnapshot(writes);
    expect(first.llmLatency.count).toBe(1);
    expect(first.cache).toEqual({ hits: 1, misses: 0, hitRate: 1 });

    vi.advanceTimersByTime(5000);
    const second = lastSnapshot(writes);
    expect(second.llmLatency).toEqual({ count: 0, avgMs: null, p95Ms: null, maxMs: null });
    expect(second.cache).toEqual({ hits: 0, misses: 0, hitRate: null });
    collector.stop();
  });

  it("繞回後歸零，下一窗重新從 0 計數（環形指標一併重置）", () => {
    vi.useFakeTimers();
    const { redis, writes, logger } = stubs();
    const collector = createMetricsCollector({
      redis,
      key: KEY,
      logger,
      env: { METRICS_INTERVAL_MS: "5000" },
    });

    for (let i = 1; i <= 1500; i += 1) collector.recordLatency(i);
    collector.start();
    vi.advanceTimersByTime(5000);

    collector.recordLatency(7);
    vi.advanceTimersByTime(5000);
    const { llmLatency } = lastSnapshot(writes);
    expect(llmLatency).toEqual({ count: 1, avgMs: 7, p95Ms: 7, maxMs: 7 });
    collector.stop();
  });

  it("只寫本實例的 metrics:worker:<id>，TTL 為 3 × 間隔秒數；MUST NOT 碰 007 的 worker:heartbeat（FR-010）", () => {
    vi.useFakeTimers();
    const { redis, writes, logger } = stubs();
    const collector = createMetricsCollector({
      redis,
      key: KEY,
      logger,
      env: { METRICS_INTERVAL_MS: "5000" },
    });

    collector.start();
    vi.advanceTimersByTime(15_000);

    expect(writes.length).toBeGreaterThan(0);
    expect(writes.every((w) => w.key === "metrics:worker:test-instance")).toBe(true);
    expect(writes.every((w) => w.seconds === 15)).toBe(true);
    collector.stop();
  });

  it("stop() 後不再結算，且不輸出未滿一窗的殘窗摘要（data-model E3）", () => {
    vi.useFakeTimers();
    const { redis, writes, logger } = stubs();
    const collector = createMetricsCollector({
      redis,
      key: KEY,
      logger,
      env: { METRICS_INTERVAL_MS: "5000" },
    });

    collector.start();
    vi.advanceTimersByTime(5000);
    const afterFirst = writes.length;

    collector.recordLatency(50); // 殘窗樣本
    collector.stop();
    vi.advanceTimersByTime(60_000);
    expect(writes.length).toBe(afterFirst);
  });

  it("間隔低於下限時回退預設並記一則 warn（FR-008／職責歸屬 analyze E3）", () => {
    const { redis, logger, logged } = stubs();
    const collector = createMetricsCollector({
      redis,
      key: KEY,
      logger,
      env: { METRICS_INTERVAL_MS: "1000" },
    });

    expect(collector.intervalMs).toBe(60_000);
    expect(logged).toHaveLength(1);
    expect(logged[0]?.fields).toMatchObject({
      invalidMetricsInterval: "1000",
      fallbackIntervalMs: 60_000,
    });
    expect(logged[0]?.msg).toContain("須為 5000–2147483647 的整數");
  });

  it.each(["5000.5", "2147483648"])("非整數或超上限 %s 同樣回退並 warn 寫明範圍", (v) => {
    const { redis, logger, logged } = stubs();
    const collector = createMetricsCollector({ redis, key: KEY, logger, env: { METRICS_INTERVAL_MS: v } });
    expect(collector.intervalMs).toBe(60_000);
    expect(logged).toHaveLength(1);
    expect(logged[0]?.msg).toContain("5000–2147483647");
  });
});
