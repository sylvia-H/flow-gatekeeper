import { afterEach, describe, expect, it, vi } from "vitest";
import { Logger } from "@nestjs/common";

// Redis 不可達時 psubscribe 會在連線關閉清佇列時 reject：用假 ioredis 重現這個 rejection。
const psubscribe = vi.fn(() => Promise.reject(new Error("Connection is closed.")));
/** 假連線上掛的監聽（event → listeners），讓測試能手動觸發 error／ready。 */
const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
const on = vi.fn((event: string, listener: (...args: unknown[]) => void) => {
  listeners.set(event, [...(listeners.get(event) ?? []), listener]);
});
// 被測程式以 `new IORedis()` 建構：vitest 4 起箭頭函式實作的 vi.fn 不能被 `new`，須用 function 實作。
vi.mock("ioredis", () => ({
  default: vi.fn(function () {
    return { psubscribe, on, quit: vi.fn(() => Promise.resolve("OK")) };
  }),
}));

const { AiStreamRelayService } = await import("./ai-stream-relay.service.js");

describe("AiStreamRelayService.onModuleInit", () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };

  afterEach(() => {
    process.off("unhandledRejection", onUnhandled);
    listeners.clear();
    vi.restoreAllMocks();
  });

  it("psubscribe 被 reject 時自行吸收，不變成浮空 rejection（否則會被致命守門 exit(1)）", async () => {
    process.on("unhandledRejection", onUnhandled);
    const config = { redisOptions: () => ({}) };
    const relay = new AiStreamRelayService(config as never, { send: vi.fn() } as never);
    relay.onModuleInit();
    // 讓 rejection 與 unhandledRejection 偵測都有機會跑完。
    await new Promise((r) => setTimeout(r, 20));
    expect(psubscribe).toHaveBeenCalledWith("ai-stream:*");
    expect(unhandled).toEqual([]);
    await relay.onModuleDestroy();
  });

  it("subscriber error 走轉態節流：故障期間連續錯誤只記第一則，恢復時記一次", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const log = vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    const relay = new AiStreamRelayService({ redisOptions: () => ({}) } as never, { send: vi.fn() } as never);
    relay.onModuleInit();
    const fire = (event: string, ...args: unknown[]) => {
      for (const l of listeners.get(event) ?? []) l(...args);
    };
    warn.mockClear();
    for (let i = 0; i < 5; i += 1) fire("error", new Error("WRONGPASS invalid password"));
    const subscriberWarns = warn.mock.calls.filter(([m]) => String(m).startsWith("subscriber error"));
    expect(subscriberWarns).toHaveLength(1);
    fire("ready");
    expect(log.mock.calls.some(([m]) => String(m).includes("recovered"))).toBe(true);
    await relay.onModuleDestroy();
  });
});
