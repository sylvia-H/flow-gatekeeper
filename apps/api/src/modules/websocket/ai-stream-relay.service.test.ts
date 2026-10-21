import { afterEach, describe, expect, it, vi } from "vitest";
import { Logger } from "@nestjs/common";

// Redis 不可達時 psubscribe 會在連線關閉清佇列時 reject：用假 ioredis 重現這個 rejection。
const psubscribe = vi.fn(() => Promise.reject(new Error("Connection is closed.")));
/** 假連線上掛的監聽（event → listeners），讓測試能手動觸發 error／ready／close／reconnecting。 */
const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
const on = vi.fn((event: string, listener: (...args: unknown[]) => void) => {
  listeners.set(event, [...(listeners.get(event) ?? []), listener]);
});
const quit = vi.fn((): Promise<string> => Promise.resolve("OK"));
const disconnect = vi.fn((): void => undefined);
// 被測程式以 `new IORedis()` 建構：vitest 4 起箭頭函式實作的 vi.fn 不能被 `new`，須用 function 實作。
vi.mock("ioredis", () => ({
  default: vi.fn(function () {
    return { psubscribe, on, quit, disconnect };
  }),
}));

const { AiStreamRelayService } = await import("./ai-stream-relay.service.js");
const { RELAY_CLOSE_DEADLINE_MS } = await import("./relay-close.js");
const { JobRoutingRegistry } = await import("./job-routing-registry.js");

const fire = (event: string, ...args: unknown[]): void => {
  for (const l of listeners.get(event) ?? []) l(...args);
};

function makeRelay() {
  const relay = new AiStreamRelayService(
    { redisOptions: () => ({}) } as never,
    { send: vi.fn() } as never,
    new JobRoutingRegistry(),
  );
  relay.onModuleInit();
  return relay;
}

describe("AiStreamRelayService.onModuleInit", () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };

  afterEach(() => {
    process.off("unhandledRejection", onUnhandled);
    listeners.clear();
    vi.useRealTimers();
    vi.restoreAllMocks();
    quit.mockReset().mockImplementation(() => Promise.resolve("OK"));
    disconnect.mockReset();
  });

  it("psubscribe 被 reject 時自行吸收，不變成浮空 rejection（否則會被致命守門 exit(1)）", async () => {
    process.on("unhandledRejection", onUnhandled);
    const config = { redisOptions: () => ({}) };
    const relay = new AiStreamRelayService(config as never, { send: vi.fn() } as never, new JobRoutingRegistry());
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
    const relay = makeRelay();
    warn.mockClear();
    for (let i = 0; i < 5; i += 1) fire("error", new Error("WRONGPASS invalid password"));
    const subscriberWarns = warn.mock.calls.filter(([m]) => String(m).startsWith("subscriber error"));
    expect(subscriberWarns).toHaveLength(1);
    fire("ready");
    expect(log.mock.calls.some(([m]) => String(m).includes("recovered"))).toBe(true);
    await relay.onModuleDestroy();
  });

  it("AR-6：對端關閉連線只發 close／reconnecting（無 error）→ 整段斷線只記一則 warn，恢復由 ready 記錄", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const log = vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    const relay = makeRelay();
    warn.mockClear();
    log.mockClear();

    // 例如 `CLIENT KILL TYPE pubsub`：close 後 ioredis 每輪重連各發一次 reconnecting。
    fire("close");
    for (let i = 0; i < 4; i += 1) fire("reconnecting", 100);
    const lostWarns = warn.mock.calls.filter(([m]) => String(m).startsWith("subscriber connection lost"));
    expect(lostWarns).toHaveLength(1);
    expect(String(lostWarns[0]?.[0])).toContain("(close)");

    fire("ready");
    const recovered = log.mock.calls.filter(([m]) => String(m).includes("recovered"));
    expect(recovered).toHaveLength(1);
    expect(String(recovered[0]?.[0])).toContain("共壓掉 4 則");

    // 恢復後再斷：新一段故障的第一則照樣立即可見。
    fire("reconnecting", 100);
    expect(warn.mock.calls.filter(([m]) => String(m).startsWith("subscriber connection lost"))).toHaveLength(2);
    await relay.onModuleDestroy();
  });

  it("AR-6：close／reconnecting 與 error 共用同一段故障狀態——error 先到時斷線事件不重複記", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    const relay = makeRelay();
    warn.mockClear();
    fire("error", new Error("ECONNRESET"));
    fire("close");
    fire("reconnecting", 100);
    // psubscribe 被 reject 的 warn 是非同步、與本案無關，只看連線類訊息。
    const connectionWarns = warn.mock.calls
      .map(([m]) => String(m))
      .filter((m) => m.startsWith("subscriber error") || m.startsWith("subscriber connection lost"));
    expect(connectionWarns).toHaveLength(1);
    expect(connectionWarns[0]).toContain("subscriber error");
    await relay.onModuleDestroy();
  });

  it("AR-6：優雅關閉時 quit() 引發的 close 不記成斷線", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    quit.mockImplementation(() => {
      fire("close");
      return Promise.resolve("OK");
    });
    const relay = makeRelay();
    warn.mockClear();
    await relay.onModuleDestroy();
    expect(quit).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls.filter(([m]) => String(m).startsWith("subscriber connection lost"))).toEqual([]);
    expect(disconnect).not.toHaveBeenCalled();
  });

  it("API-12：quit() 卡在 offline queue（Redis 不可達）→ 逾 RELAY_CLOSE_DEADLINE_MS 改 disconnect()，destroy 如期返回", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    quit.mockImplementation(() => new Promise<string>(() => undefined)); // 永不 resolve
    const relay = makeRelay();
    vi.useFakeTimers();
    let returned = false;
    const destroying = relay.onModuleDestroy().then(() => {
      returned = true;
    });

    await vi.advanceTimersByTimeAsync(RELAY_CLOSE_DEADLINE_MS - 1);
    expect(returned).toBe(false);
    expect(disconnect).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await destroying;
    expect(returned).toBe(true);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls.some(([m]) => String(m).includes("subscriber quit()"))).toBe(true);
    // 強制斷線引發的 close 屬關閉流程，不記成斷線。
    fire("close");
    expect(warn.mock.calls.filter(([m]) => String(m).startsWith("subscriber connection lost"))).toEqual([]);
  });

  it("API-12：quit() reject、disconnect() 同步拋錯 → destroy 仍不拋出", async () => {
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    quit.mockImplementation(() => Promise.reject(new Error("Connection is closed.")));
    const relay = makeRelay();
    await expect(relay.onModuleDestroy()).resolves.toBeUndefined();
    expect(disconnect).not.toHaveBeenCalled(); // reject 也算「已結束」，不需強制斷線

    quit.mockImplementation(() => new Promise<string>(() => undefined));
    disconnect.mockImplementation(() => {
      throw new Error("boom");
    });
    const stuck = makeRelay();
    vi.useFakeTimers();
    const destroying = stuck.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(RELAY_CLOSE_DEADLINE_MS);
    await expect(destroying).resolves.toBeUndefined();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});
