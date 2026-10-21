import { afterEach, describe, expect, it, vi } from "vitest";
import { TimeoutError, withTimeout } from "./with-timeout.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("withTimeout", () => {
  it("時限內 resolve → 回傳結果，並清掉計時器", async () => {
    vi.useFakeTimers();
    await expect(withTimeout(Promise.resolve(42), 1_000)).resolves.toBe(42);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("時限內 reject → 原錯誤照傳（不是 TimeoutError），並清掉計時器", async () => {
    vi.useFakeTimers();
    const boom = new Error("boom");
    await expect(withTimeout(Promise.reject(boom), 1_000)).rejects.toBe(boom);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("逾時 → TimeoutError，訊息帶 label 與毫秒數；恰差 1 ms 尚未逾時", async () => {
    vi.useFakeTimers();
    let settled = false;
    const pending = withTimeout(new Promise<never>(() => undefined), 5_000, "enqueue").finally(() => {
      settled = true;
    });
    const assertion = expect(pending).rejects.toSatisfy(
      (err: unknown) => err instanceof TimeoutError && err.message === "enqueue timed out after 5000ms",
    );
    await vi.advanceTimersByTimeAsync(4_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("未給 label → 以 operation 代入", async () => {
    vi.useFakeTimers();
    const pending = withTimeout(new Promise<never>(() => undefined), 10);
    const assertion = expect(pending).rejects.toThrow("operation timed out after 10ms");
    await vi.advanceTimersByTimeAsync(10);
    await assertion;
  });
});
