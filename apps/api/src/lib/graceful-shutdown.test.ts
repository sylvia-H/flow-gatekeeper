import { afterEach, describe, expect, it, vi } from "vitest";
import { SHUTDOWN_TOTAL_DEADLINE_MS, createShutdownHandler } from "./graceful-shutdown.js";

function setup(close: () => Promise<void>) {
  const exit = vi.fn<(code: number) => void>();
  const log = { info: vi.fn<(m: string) => void>(), warn: vi.fn<(m: string) => void>(), error: vi.fn<(m: string) => void>() };
  const shutdown = createShutdownHandler({ close, exit, log });
  return { shutdown, exit, log };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createShutdownHandler（API-12）", () => {
  it("總時限為 12 秒（compose stop_grace_period 15 s 之內）", () => {
    expect(SHUTDOWN_TOTAL_DEADLINE_MS).toBe(12_000);
  });

  it("close 如期完成 → exit(0)，不記 warn", async () => {
    const close = vi.fn(async () => undefined);
    const { shutdown, exit, log } = setup(close);
    await shutdown("SIGTERM");
    expect(close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("close 拋錯 → 記 error，仍 exit(0)", async () => {
    const { shutdown, exit, log } = setup(async () => {
      throw new Error("mongo gone");
    });
    await shutdown("SIGTERM");
    expect(log.error).toHaveBeenCalledWith("shutdown error: mongo gone");
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it("close 卡住（例如 Redis 不可達）→ 12 秒時記 warn 後 exit(0)，之前不退出", async () => {
    vi.useFakeTimers();
    const { shutdown, exit, log } = setup(() => new Promise<void>(() => undefined));
    const done = shutdown("SIGTERM");
    await vi.advanceTimersByTimeAsync(SHUTDOWN_TOTAL_DEADLINE_MS - 1);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("did not finish within 12000ms"));
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it("關閉中第二次訊號 → 立即 exit(0)，不另起一輪 close；逾時後也不重複 exit", async () => {
    vi.useFakeTimers();
    const close = vi.fn(() => new Promise<void>(() => undefined));
    const { shutdown, exit, log } = setup(close);
    const first = shutdown("SIGTERM");
    await shutdown("SIGINT");
    expect(close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("received SIGINT again"));

    await vi.advanceTimersByTimeAsync(SHUTDOWN_TOTAL_DEADLINE_MS);
    await first;
    expect(exit).toHaveBeenCalledTimes(1);
  });
});
