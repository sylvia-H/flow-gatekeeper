import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SystemMetricsSchema } from "@flow-gatekeeper/contracts";
import type { SystemMetrics } from "@flow-gatekeeper/contracts";
import { getAppLogger } from "../../logging/app-logger.js";
import type { AppConfigService } from "../config/config.service.js";
import { toPersistStats } from "../history/history.service.js";
import { MetricsService } from "./metrics.service.js";
import type { MetricsSources, PersistStats } from "./metrics.service.js";

const INTERVAL = 5_000;

function makeService(intervalMs = INTERVAL): MetricsService {
  // 不呼叫 onModuleInit：不建立 Redis 連線，worker 快照走「全數缺席」降級（worker: null）。
  const config = { metricsIntervalMs: intervalMs } as unknown as AppConfigService;
  return new MetricsService(config);
}

function makeSources(overrides: Partial<MetricsSources> = {}) {
  const broadcast = vi.fn<(payload: SystemMetrics) => void>();
  const sources: MetricsSources = {
    queueCounts: async () => ({ waiting: 1, active: 0, failed: 0 }),
    wsConnections: () => 2,
    persistStats: (): PersistStats => ({ dropped: 5, failed: 1 }),
    broadcast,
    ...overrides,
  };
  return { sources, broadcast };
}

async function tick(ms = INTERVAL): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("MetricsService.persist", () => {
  it("廣播的 system/metrics 帶 persist 計數，且符合契約", async () => {
    const service = makeService();
    const { sources, broadcast } = makeSources();
    service.bind(sources);
    await tick();
    service.onModuleDestroy();

    expect(broadcast).toHaveBeenCalledTimes(1);
    const payload = broadcast.mock.calls[0]?.[0];
    expect(payload?.persist).toEqual({ dropped: 5, failed: 1 });
    expect(SystemMetricsSchema.safeParse(payload).success).toBe(true);
  });

  it("persist 來源拋錯：省略 persist，摘要照常廣播", async () => {
    const service = makeService();
    const { sources, broadcast } = makeSources({
      persistStats: () => {
        throw new Error("boom");
      },
    });
    service.bind(sources);
    await tick();
    service.onModuleDestroy();

    const payload = broadcast.mock.calls[0]?.[0];
    expect(payload).toBeDefined();
    expect(payload).not.toHaveProperty("persist");
  });

  it("toPersistStats：dropped 合計三種遺失、failed 取失敗批數", () => {
    expect(
      toPersistStats({
        bufferedPoints: 9,
        droppedPoints: 10,
        persistFailures: 2,
        failedPoints: 300,
        pendingErrorLogs: 4,
        droppedErrorLogs: 3,
      }),
    ).toEqual({ dropped: 313, failed: 2 });
  });
});

describe("MetricsService 出口契約自檢", () => {
  it("非 production：違約 payload 記一則 error（節流），照常廣播", async () => {
    vi.stubEnv("NODE_ENV", "test");
    const errorSpy = vi.spyOn(getAppLogger().metrics, "error").mockImplementation(() => undefined);
    // 非整數 windowMs → 違反 `windowMs: int`
    const service = makeService(5_000.5);
    const { sources, broadcast } = makeSources();
    service.bind(sources);
    await tick(5_001);
    await tick(5_001);
    await tick(5_001);
    service.onModuleDestroy();

    expect(broadcast).toHaveBeenCalledTimes(3);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [fields] = errorSpy.mock.calls[0] as unknown as [{ issues: { path: string }[] }];
    expect(fields.issues.map((i) => i.path)).toContain("windowMs");
  });

  it("合法 payload 不記 error", async () => {
    vi.stubEnv("NODE_ENV", "test");
    const errorSpy = vi.spyOn(getAppLogger().metrics, "error").mockImplementation(() => undefined);
    const service = makeService();
    service.bind(makeSources().sources);
    await tick();
    service.onModuleDestroy();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("production：不做自檢", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const errorSpy = vi.spyOn(getAppLogger().metrics, "error").mockImplementation(() => undefined);
    const service = makeService(5_000.5);
    service.bind(makeSources().sources);
    await tick(5_001);
    service.onModuleDestroy();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
