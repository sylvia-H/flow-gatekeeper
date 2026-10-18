import { afterEach, describe, expect, it, vi } from "vitest";
import { DUPLICATE_SIGNAL_WINDOW_MS, SHUTDOWN_TOTAL_DEADLINE_MS, createShutdownHandler } from "./graceful-shutdown.js";

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

describe("createShutdownHandler：同名訊號的重送忽略窗（使用者裁決）", () => {
  function setupWithClock(close: () => Promise<void>) {
    let clock = 1_000_000;
    const exit = vi.fn<(code: number) => void>();
    const log = { info: vi.fn<(m: string) => void>(), warn: vi.fn<(m: string) => void>(), error: vi.fn<(m: string) => void>() };
    const shutdown = createShutdownHandler({ close, exit, log, now: () => clock });
    return { shutdown, exit, log, advance: (ms: number) => (clock += ms) };
  }

  it("忽略窗為 1 秒", () => {
    expect(DUPLICATE_SIGNAL_WINDOW_MS).toBe(1_000);
  });

  it("1 秒內（第 30 ms、第 999 ms）的同名訊號忽略並記 info：不退出、不另起 close，優雅關閉照常完成後才 exit(0)", async () => {
    let finish: () => void = () => undefined;
    const close = vi.fn(() => new Promise<void>((r) => (finish = r)));
    const { shutdown, exit, log, advance } = setupWithClock(close);
    const first = shutdown("SIGINT");
    advance(30);
    await shutdown("SIGINT");
    advance(DUPLICATE_SIGNAL_WINDOW_MS - 31);
    await shutdown("SIGINT");
    expect(exit).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("ignoring duplicate SIGINT"));
    finish();
    await first;
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it("第 1000 ms 起的同名訊號才算第二次：立即 exit(0)", async () => {
    const { shutdown, exit, log, advance } = setupWithClock(() => new Promise<void>(() => undefined));
    void shutdown("SIGINT");
    advance(DUPLICATE_SIGNAL_WINDOW_MS);
    await shutdown("SIGINT");
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("received SIGINT again"));
  });

  it("不同名的訊號不套用忽略窗：1 秒內也立即 exit(0)", async () => {
    const { shutdown, exit, advance } = setupWithClock(() => new Promise<void>(() => undefined));
    void shutdown("SIGTERM");
    advance(10);
    await shutdown("SIGINT");
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });
});
