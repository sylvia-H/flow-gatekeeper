import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createKeepalive } from "./keepalive.js";
import type { Keepalive } from "./keepalive.js";

const INTERVAL = 10_000;

describe("createKeepalive（FR-019、P12）", () => {
  let ka: Keepalive | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    ka?.stop();
    ka = null;
    vi.useRealTimers();
  });

  it("10 s 無 touch 觸發一次；未滿 10 s 不觸發", () => {
    const onIdle = vi.fn();
    ka = createKeepalive({ intervalMs: INTERVAL, onIdle });
    vi.advanceTimersByTime(INTERVAL - 1);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("touch 重設閒置計時", () => {
    const onIdle = vi.fn();
    ka = createKeepalive({ intervalMs: INTERVAL, onIdle });
    vi.advanceTimersByTime(9_000);
    ka.touch();
    vi.advanceTimersByTime(9_000);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("連續閒置時每 10 s 觸發一次", async () => {
    const onIdle = vi.fn(async () => {});
    ka = createKeepalive({ intervalMs: INTERVAL, onIdle });
    await vi.advanceTimersByTimeAsync(INTERVAL * 3);
    expect(onIdle).toHaveBeenCalledTimes(3);
  });

  it("stop() 後不再觸發；之後的 touch 也不會重新排程", () => {
    const onIdle = vi.fn();
    ka = createKeepalive({ intervalMs: INTERVAL, onIdle });
    vi.advanceTimersByTime(INTERVAL);
    expect(onIdle).toHaveBeenCalledTimes(1);
    ka.stop();
    ka.touch();
    vi.advanceTimersByTime(INTERVAL * 5);
    expect(onIdle).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("onIdle 同步拋錯或 reject 都不中斷排程，且每個實例至多回報一次", async () => {
    const onError = vi.fn();
    let n = 0;
    const onIdle = vi.fn(() => {
      n += 1;
      if (n === 1) throw new Error("sync boom");
      return Promise.reject(new Error("async boom"));
    });
    ka = createKeepalive({ intervalMs: INTERVAL, onIdle, onError });
    await vi.advanceTimersByTimeAsync(INTERVAL * 4);
    expect(onIdle).toHaveBeenCalledTimes(4);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "sync boom" }));
  });

  it("未提供 onError 時失敗靜默吞掉（不產生浮空 rejection）", async () => {
    const onIdle = vi.fn(() => Promise.reject(new Error("redis down")));
    ka = createKeepalive({ intervalMs: INTERVAL, onIdle });
    await vi.advanceTimersByTimeAsync(INTERVAL * 2);
    expect(onIdle).toHaveBeenCalledTimes(2);
  });

  /** 每次呼叫回一個待放行的 promise；`release()` 放行最近一次。 */
  function pendingOnIdle() {
    let release: () => void = () => {};
    const onIdle = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    return { onIdle, release: () => release() };
  }

  it("在途時略過該輪但節拍固定：t=10 在途、t=20 略過、t=25 放行 → t=30 即觸發第 2 次", async () => {
    const { onIdle, release } = pendingOnIdle();
    ka = createKeepalive({ intervalMs: INTERVAL, onIdle });
    await vi.advanceTimersByTimeAsync(10_000); // t=10：第 1 次，在途
    expect(onIdle).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(15_000); // t=25：t=20 那拍因在途而略過
    expect(onIdle).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(4_999); // t=29.999
    expect(onIdle).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); // t=30：原節拍，不因放行時刻順延
    expect(onIdle).toHaveBeenCalledTimes(2);
  });

  it("在途期間 touch() 照常重設計時：settle 後依 touch 時刻起算", async () => {
    const { onIdle, release } = pendingOnIdle();
    ka = createKeepalive({ intervalMs: INTERVAL, onIdle });
    await vi.advanceTimersByTimeAsync(10_000); // t=10：在途
    await vi.advanceTimersByTimeAsync(5_000); // t=15
    ka.touch(); // 下一拍改為 t=25（t=20 那拍被取消）
    await vi.advanceTimersByTimeAsync(1_000); // t=16
    release();
    await vi.advanceTimersByTimeAsync(8_999); // t=24.999
    expect(onIdle).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); // t=25
    expect(onIdle).toHaveBeenCalledTimes(2);
  });

  it("在途期間 stop()：之後 settle 不會重新排程，timer 數為 0", async () => {
    const { onIdle, release } = pendingOnIdle();
    ka = createKeepalive({ intervalMs: INTERVAL, onIdle });
    await vi.advanceTimersByTimeAsync(INTERVAL);
    ka.stop();
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(INTERVAL * 5);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("第一次觸發前 stop()：完全不觸發", () => {
    const onIdle = vi.fn();
    ka = createKeepalive({ intervalMs: INTERVAL, onIdle });
    vi.advanceTimersByTime(5_000);
    ka.stop();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(INTERVAL * 5);
    expect(onIdle).not.toHaveBeenCalled();
  });

  it("onError 本身拋錯也不中斷排程，且仍只呼叫一次", async () => {
    const onError = vi.fn(() => {
      throw new Error("logger broken");
    });
    const onIdle = vi.fn(() => Promise.reject(new Error("redis down")));
    ka = createKeepalive({ intervalMs: INTERVAL, onIdle, onError });
    await vi.advanceTimersByTimeAsync(INTERVAL * 3);
    expect(onIdle).toHaveBeenCalledTimes(3);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("可注入 timers（不依賴全域計時器）", () => {
    const pending: (() => void)[] = [];
    const timers = {
      setTimeout: vi.fn((fn: () => void) => {
        pending.push(fn);
        return pending.length;
      }),
      clearTimeout: vi.fn(),
    };
    const onIdle = vi.fn();
    ka = createKeepalive({ intervalMs: INTERVAL, onIdle, timers });
    expect(timers.setTimeout).toHaveBeenCalledWith(expect.any(Function), INTERVAL);
    pending.shift()?.();
    expect(onIdle).toHaveBeenCalledTimes(1);
    // 觸發後重新排程。
    expect(timers.setTimeout).toHaveBeenCalledTimes(2);
  });

  it("注入 timers 時 touch()／stop() 會以目前的 handle 呼叫 clearTimeout", () => {
    let next = 0;
    const timers = {
      setTimeout: vi.fn(() => {
        next += 1;
        return next;
      }),
      clearTimeout: vi.fn(),
    };
    ka = createKeepalive({ intervalMs: INTERVAL, onIdle: vi.fn(), timers });
    ka.touch();
    expect(timers.clearTimeout).toHaveBeenLastCalledWith(1);
    expect(timers.setTimeout).toHaveBeenCalledTimes(2);
    ka.stop();
    expect(timers.clearTimeout).toHaveBeenLastCalledWith(2);
    expect(timers.clearTimeout).toHaveBeenCalledTimes(2);
  });
});
