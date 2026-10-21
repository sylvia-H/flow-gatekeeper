import { describe, expect, it, vi } from "vitest";
import { createRedisStore, INCR_WINDOW_SCRIPT, RELEASE_LOCK_SCRIPT } from "./redis-store.js";
import type { StoreRedis } from "./redis-store.js";

function fakeRedis(overrides: Partial<Record<keyof StoreRedis, unknown>>) {
  return {
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
    eval: vi.fn(),
    ...overrides,
  } as unknown as StoreRedis & Record<keyof StoreRedis, ReturnType<typeof vi.fn>>;
}

describe("createRedisStore", () => {
  it("tryAcquireLock 以 SET NX EX 寫入持有者 token", async () => {
    const r = fakeRedis({ set: vi.fn().mockResolvedValue("OK") });
    expect(await createRedisStore(r).tryAcquireLock("ai-lock:s", "tok", 45)).toBe(true);
    expect(r.set).toHaveBeenCalledWith("ai-lock:s", "tok", "EX", 45, "NX");
  });

  it("tryAcquireLock 已被持有 → false", async () => {
    const r = fakeRedis({ set: vi.fn().mockResolvedValue(null) });
    expect(await createRedisStore(r).tryAcquireLock("k", "t", 1)).toBe(false);
  });

  it("releaseLock 走 Lua compare-and-del（只刪自己的鎖）", async () => {
    const r = fakeRedis({ eval: vi.fn().mockResolvedValue(0) });
    expect(await createRedisStore(r).releaseLock("ai-lock:s", "tok")).toBe(false);
    expect(r.eval).toHaveBeenCalledWith(RELEASE_LOCK_SCRIPT, 1, "ai-lock:s", "tok");
  });

  it("setIfAbsent 以 SET NX EX 寫入，回 OK → true", async () => {
    const r = fakeRedis({ set: vi.fn().mockResolvedValue("OK") });
    expect(await createRedisStore(r).setIfAbsent("ai-metric:j1", "1", 86_400)).toBe(true);
    expect(r.set).toHaveBeenCalledWith("ai-metric:j1", "1", "EX", 86_400, "NX");
  });

  it("setIfAbsent 已存在（SET NX 回 null）→ false", async () => {
    const r = fakeRedis({ set: vi.fn().mockResolvedValue(null) });
    expect(await createRedisStore(r).setIfAbsent("ai-metric:j1", "1", 86_400)).toBe(false);
  });

  it("setIfAbsent 的 Redis 錯誤照常拋出（交給 processor 走重試）", async () => {
    const r = fakeRedis({ set: vi.fn().mockRejectedValue(new Error("redis down")) });
    await expect(createRedisStore(r).setIfAbsent("ai-metric:j1", "1", 86_400)).rejects.toThrow("redis down");
  });

  it("incrementWindow 以單一腳本 INCR + 首次 EXPIRE", async () => {
    const r = fakeRedis({ eval: vi.fn().mockResolvedValue(3) });
    expect(await createRedisStore(r).incrementWindow("ai-rpm:1", 60)).toBe(3);
    expect(r.eval).toHaveBeenCalledWith(INCR_WINDOW_SCRIPT, 1, "ai-rpm:1", "60");
  });
});
