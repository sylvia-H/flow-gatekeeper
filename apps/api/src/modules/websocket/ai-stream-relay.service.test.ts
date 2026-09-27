import { afterEach, describe, expect, it, vi } from "vitest";

// Redis 不可達時 psubscribe 會在連線關閉清佇列時 reject：用假 ioredis 重現這個 rejection。
const psubscribe = vi.fn(() => Promise.reject(new Error("Connection is closed.")));
vi.mock("ioredis", () => ({
  default: vi.fn(() => ({ psubscribe, on: vi.fn(), quit: vi.fn(() => Promise.resolve("OK")) })),
}));

const { AiStreamRelayService } = await import("./ai-stream-relay.service.js");

describe("AiStreamRelayService.onModuleInit", () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };

  afterEach(() => {
    process.off("unhandledRejection", onUnhandled);
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
});
