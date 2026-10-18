import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Logger } from "@nestjs/common";

/**
 * TQ-6：以假 `QueueEvents`（EventEmitter 替身）驅動 `JobStatusRelayService` 的真實接線——
 * `onModuleInit` 內的事件監聽、`sweepOrphans` 與 keepalive 計時器都經由真正的 `onModuleInit`
 * 掛上，測試只負責 emit 事件與推時間，不直接呼叫私有方法。
 */

/** 假 QueueEvents 的底層 ioredis 連線：只需要 `on('ready')` 與 `status`。 */
class FakeRedisClient extends EventEmitter {
  status = "connecting";
}

class FakeQueueEvents extends EventEmitter {
  readonly fakeClient = new FakeRedisClient();
  readonly client: Promise<FakeRedisClient> = Promise.resolve(this.fakeClient);
  readonly close = vi.fn((): Promise<void> => Promise.resolve());
  readonly disconnect = vi.fn((): Promise<void> => Promise.resolve());
  constructor(
    readonly name: string,
    readonly opts: unknown,
  ) {
    super();
  }
}

const created: FakeQueueEvents[] = [];

// 被測程式以 `new QueueEvents()` 建構：vitest 4 起箭頭函式實作的 vi.fn 不能被 `new`，須用 function 實作。
vi.mock("bullmq", async (importOriginal) => {
  const actual = await importOriginal<typeof import("bullmq")>();
  return {
    ...actual,
    QueueEvents: vi.fn(function (name: string, opts: unknown) {
      const qe = new FakeQueueEvents(name, opts);
      created.push(qe);
      return qe;
    }),
  };
});

// 結構化 logger 換成替身：斷言孤兒回收的 warn，也避免測試期間建立真 pino 實例。
const plog = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };
vi.mock("../../logging/app-logger.js", () => ({
  getAppLogger: () => ({ child: () => plog }),
}));

const { Job } = await import("bullmq");
const { AiStreamRelayService } = await import("./ai-stream-relay.service.js");
const { JobStatusRelayService, DELAYED_KEEPALIVE_MS, COMPLETED_BINDING_GRACE_MS } = await import(
  "./job-status-relay.service.js"
);
const { RELAY_CLOSE_DEADLINE_MS } = await import("./relay-close.js");
const { JobsService } = await import("../jobs/jobs.service.js");

/** ai-stream relay 的私有入口（由 Redis pmessage 驅動，測試直接呼叫）。 */
type AiRelayInternals = { handleMessage(channel: string, message: string): void };

const JOB_ID = "0e6c2b7a-1f3d-4d8e-a9b0-c1d2e3f4a5b6";
const OTHER_JOB_ID = "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a";
const CLIENT_ID = "5b1f9c1e-8a53-4c43-9f0e-2d1c3b4a5e6f";
const ORPHAN_TTL_MS = 10 * 60_000;
const SWEEP_INTERVAL_MS = 60_000;

type Sent = { clientId: string; payload: Record<string, unknown> };

function setup() {
  const sent: Sent[] = [];
  const gateway = {
    send: vi.fn((clientId: string, payload: Record<string, unknown>) => {
      sent.push({ clientId, payload });
    }),
  };
  const aiRelay = new AiStreamRelayService({} as never, gateway as never);
  aiRelay.bindJobToClient(JOB_ID, CLIENT_ID, "cnc-01");
  const config = { redisOptions: vi.fn(() => ({ host: "fake" })) };
  const relay = new JobStatusRelayService(config as never, gateway as never, aiRelay, {} as never);
  relay.onModuleInit();
  const qe = created.at(-1);
  if (!qe) throw new Error("QueueEvents 未被建立");
  const statuses = () =>
    sent
      .filter((s) => s.payload.type === "job/status")
      .map((s) => s.payload.status as string);
  return { relay, aiRelay, gateway, qe, sent, statuses, config };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-27T00:00:00Z"));
  vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  plog.warn.mockClear();
  created.length = 0;
});

describe("JobStatusRelayService：QueueEvents 事件驅動（TQ-6）", () => {
  it("onModuleInit 以 blocking 連線建立 QueueEvents 並掛上各事件監聽", async () => {
    const { qe, config, relay } = setup();
    expect(qe.name).toBe("diagnosis");
    expect(config.redisOptions).toHaveBeenCalledWith("blocking");
    expect(qe.opts).toEqual({ connection: { host: "fake" } });
    for (const event of ["waiting", "active", "progress", "delayed", "completed", "failed", "error"]) {
      expect(qe.listenerCount(event), event).toBeGreaterThan(0);
    }
    await relay.onModuleDestroy();
  });

  it("waiting → active → progress(數值) → completed：依序轉發 job/status，progress 保留數值，寬限期滿才刪綁定", async () => {
    const { qe, aiRelay, sent, relay } = setup();
    qe.emit("waiting", { jobId: JOB_ID });
    qe.emit("active", { jobId: JOB_ID });
    qe.emit("progress", { jobId: JOB_ID, data: 42 });
    qe.emit("progress", { jobId: JOB_ID, data: { phase: "llm" } }); // 非數值 progress：不帶欄位
    qe.emit("completed", { jobId: JOB_ID });

    const base = { type: "job/status", jobId: JOB_ID, machineId: "cnc-01" };
    expect(sent).toEqual([
      { clientId: CLIENT_ID, payload: { ...base, status: "waiting" } },
      { clientId: CLIENT_ID, payload: { ...base, status: "active" } },
      { clientId: CLIENT_ID, payload: { ...base, status: "active", progress: 42 } },
      { clientId: CLIENT_ID, payload: { ...base, status: "active" } },
      { clientId: CLIENT_ID, payload: { ...base, status: "completed" } },
    ]);
    // AR-5：completed 後綁定仍保留，直到寬限期滿（恰差 1 ms 仍在）。
    vi.advanceTimersByTime(COMPLETED_BINDING_GRACE_MS - 1);
    expect(aiRelay.getBinding(JOB_ID)).toBeDefined();
    vi.advanceTimersByTime(1);
    expect(aiRelay.getBinding(JOB_ID)).toBeUndefined();

    // 綁定已清：之後同一 job 的遲到事件不再轉發。
    qe.emit("active", { jobId: JOB_ID });
    expect(sent).toHaveLength(5);
    await relay.onModuleDestroy();
  });

  it("AR-5：completed 先於 ai/done 到達（跨連線無順序保證）→ 寬限內遲到的 ai/done 仍轉發給原 client，期滿後不再轉發", async () => {
    const { qe, aiRelay, sent, relay } = setup();
    const aiDone = {
      type: "ai/done",
      jobId: JOB_ID,
      attempt: 1,
      cached: false,
      result: { summary: "s", severity: "ok", likelyCauses: [], suggestedActions: [], evidence: [] },
    };
    const publishAiDone = () =>
      (aiRelay as unknown as AiRelayInternals).handleMessage(`ai-stream:${JOB_ID}`, JSON.stringify(aiDone));

    qe.emit("completed", { jobId: JOB_ID });
    vi.advanceTimersByTime(COMPLETED_BINDING_GRACE_MS - 1);
    publishAiDone();
    expect(sent.map((s) => [s.clientId, s.payload.type])).toEqual([
      [CLIENT_ID, "job/status"],
      [CLIENT_ID, "ai/done"],
    ]);
    expect(sent[1]?.payload).toEqual(aiDone);

    vi.advanceTimersByTime(1);
    publishAiDone(); // 寬限已過：綁定已刪，不再轉發
    expect(sent).toHaveLength(2);
    await relay.onModuleDestroy();
  });

  it("AR-5：寬限內同 jobId 重送 POST /diagnoses → 409「已使用過」（不是 200 waiting），且不影響遲到 ai/done 的轉發", async () => {
    const { qe, aiRelay, sent, relay } = setup();
    const queue = { getJob: vi.fn(async () => undefined), add: vi.fn(async () => ({})) };
    const jobs = new JobsService(queue as never, aiRelay, { isAuthorized: () => true });
    aiRelay.bindJobToClient(JOB_ID, CLIENT_ID, "mixer-01"); // JobsService 先查名冊，須是已知機台

    qe.emit("completed", { jobId: JOB_ID });
    expect(aiRelay.getBinding(JOB_ID)?.completedAt).toBeDefined();
    await expect(
      jobs.createDiagnosis({ jobId: JOB_ID, machineId: "mixer-01", socketId: CLIENT_ID }),
    ).rejects.toMatchObject({ status: 409, message: expect.stringContaining("已使用過") });
    expect(queue.add).not.toHaveBeenCalled();

    // 重送被拒後綁定原樣保留：寬限內晚到的 ai/done 照常送給原 client。
    const aiDone = {
      type: "ai/done",
      jobId: JOB_ID,
      attempt: 1,
      cached: true,
      result: { summary: "s", severity: "ok", likelyCauses: [], suggestedActions: [], evidence: [] },
    };
    (aiRelay as unknown as AiRelayInternals).handleMessage(`ai-stream:${JOB_ID}`, JSON.stringify(aiDone));
    expect(sent.at(-1)).toEqual({ clientId: CLIENT_ID, payload: aiDone });
    await relay.onModuleDestroy();
  });

  it("寬限計時器 unref、不阻止行程結束；期間綁定被刪後又以同 jobId 重新綁定 → 期滿不誤刪新綁定", async () => {
    const graceTimers: Array<ReturnType<typeof setTimeout>> = [];
    const fakeSetTimeout = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation((fn: () => void, ms?: number) => {
      const t = fakeSetTimeout(fn, ms);
      if (ms === COMPLETED_BINDING_GRACE_MS) graceTimers.push(t);
      return t;
    });
    const { qe, aiRelay, relay } = setup();
    qe.emit("completed", { jobId: JOB_ID });
    spy.mockRestore();
    expect(graceTimers).toHaveLength(1);
    expect(graceTimers[0]?.hasRef()).toBe(false);

    aiRelay.deleteBinding(JOB_ID); // 例如孤兒回收
    aiRelay.bindJobToClient(JOB_ID, "another-client", "cnc-02");
    vi.advanceTimersByTime(COMPLETED_BINDING_GRACE_MS);
    expect(aiRelay.getBinding(JOB_ID)).toMatchObject({ clientId: "another-client" });
    await relay.onModuleDestroy();
  });

  it("failed：先送 ai/error(worker_failed) 帶原因、再送 job/status failed 帶 error，最後刪綁定", async () => {
    vi.spyOn(Job, "fromId").mockResolvedValue({ attemptsMade: 2 } as never);
    const { qe, aiRelay, sent, relay } = setup();
    qe.emit("failed", { jobId: JOB_ID, failedReason: "stalled too many times" });
    await vi.waitFor(() => expect(sent).toHaveLength(2));

    expect(sent.map((s) => s.payload)).toEqual([
      {
        type: "ai/error",
        jobId: JOB_ID,
        attempt: 2,
        code: "worker_failed",
        message: "stalled too many times",
      },
      {
        type: "job/status",
        jobId: JOB_ID,
        machineId: "cnc-01",
        status: "failed",
        error: "stalled too many times",
      },
    ]);
    expect(aiRelay.getBinding(JOB_ID)).toBeUndefined();
    await relay.onModuleDestroy();
  });

  it("未綁定的 job（純後端 smoke）事件一律略過，不轉發", async () => {
    const { qe, gateway, relay } = setup();
    for (const event of ["waiting", "active", "completed"]) qe.emit(event, { jobId: OTHER_JOB_ID });
    qe.emit("progress", { jobId: OTHER_JOB_ID, data: 10 });
    qe.emit("delayed", { jobId: OTHER_JOB_ID, delay: Date.now() + 30_000 });
    vi.advanceTimersByTime(DELAYED_KEEPALIVE_MS);
    expect(gateway.send).not.toHaveBeenCalled();
    await relay.onModuleDestroy();
  });

  it("delayed：立即以 waiting 轉發，延後期間由 keepalive 計時器定期補送，promote 回 waiting 後停止補送", async () => {
    const { qe, statuses, relay } = setup();
    qe.emit("delayed", { jobId: JOB_ID, delay: String(Date.now() + 60_000) });
    expect(statuses()).toEqual(["waiting"]);

    vi.advanceTimersByTime(DELAYED_KEEPALIVE_MS);
    vi.advanceTimersByTime(DELAYED_KEEPALIVE_MS);
    expect(statuses()).toEqual(["waiting", "waiting", "waiting"]);

    qe.emit("waiting", { jobId: JOB_ID }); // 到期被 promote：送一次 waiting，之後不再補送
    vi.advanceTimersByTime(DELAYED_KEEPALIVE_MS * 2);
    expect(statuses()).toEqual(["waiting", "waiting", "waiting", "waiting"]);
    await relay.onModuleDestroy();
  });

  it("sweepOrphans：每 60 秒掃描，只回收超過 10 分鐘安全期的綁定（剛好等於安全期不回收）", async () => {
    const { aiRelay, relay } = setup();
    // 5 分鐘後才綁定的另一個 job：第一個被回收時它仍在安全期內。
    vi.advanceTimersByTime(5 * 60_000);
    aiRelay.bindJobToClient(OTHER_JOB_ID, CLIENT_ID, "cnc-02");

    // 推到 t = 10 分鐘（第 10 次掃描）：age 恰等於 ORPHAN_TTL_MS，不回收。
    vi.advanceTimersByTime(ORPHAN_TTL_MS - 5 * 60_000);
    expect(aiRelay.getBinding(JOB_ID)).toBeDefined();
    expect(plog.warn).not.toHaveBeenCalled();

    // 再一輪掃描（t = 11 分鐘）：超過安全期 → 回收並記 warn（jobId 為獨立欄位）。
    vi.advanceTimersByTime(SWEEP_INTERVAL_MS);
    expect(aiRelay.getBinding(JOB_ID)).toBeUndefined();
    expect(aiRelay.getBinding(OTHER_JOB_ID)).toBeDefined();
    expect(plog.warn).toHaveBeenCalledTimes(1);
    expect(plog.warn).toHaveBeenCalledWith({ jobId: JOB_ID }, "swept orphan job binding");
    await relay.onModuleDestroy();
  });

  it("error 走轉態節流：持續故障只記第一則，底層連線 ready 時記一次恢復（含壓掉的則數）", async () => {
    const { qe, relay } = setup();
    // 等 `client` promise resolve、ready 監聽掛上底層連線（不依賴 microtask 層數）。
    await vi.waitFor(() => expect(qe.fakeClient.listenerCount("ready")).toBe(1));
    const warn = vi.mocked(Logger.prototype.warn);
    const log = vi.mocked(Logger.prototype.log);
    warn.mockClear();
    log.mockClear();

    for (let i = 0; i < 5; i += 1) qe.emit("error", new Error("ECONNREFUSED"));
    const errorWarns = warn.mock.calls.filter(([m]) => String(m).startsWith("QueueEvents error"));
    expect(errorWarns).toHaveLength(1);

    qe.fakeClient.emit("ready");
    const recovered = log.mock.calls.filter(([m]) => String(m).includes("recovered"));
    expect(recovered).toHaveLength(1);
    expect(String(recovered[0]?.[0])).toContain("共壓掉 4 則");
    await relay.onModuleDestroy();
  });

  it("onModuleDestroy 停止計時器（含 completed 寬限）並關閉 QueueEvents：之後推時間不再回收或補送", async () => {
    const { qe, aiRelay, gateway, relay } = setup();
    qe.emit("delayed", { jobId: JOB_ID, delay: Date.now() + ORPHAN_TTL_MS * 2 });
    aiRelay.bindJobToClient(OTHER_JOB_ID, CLIENT_ID, "cnc-02");
    qe.emit("completed", { jobId: OTHER_JOB_ID });
    gateway.send.mockClear();
    await relay.onModuleDestroy();
    expect(qe.close).toHaveBeenCalledTimes(1);
    expect(qe.disconnect).not.toHaveBeenCalled(); // 如期關閉：不需強制斷線
    expect(vi.getTimerCount()).toBe(0);

    vi.advanceTimersByTime(ORPHAN_TTL_MS + SWEEP_INTERVAL_MS);
    expect(gateway.send).not.toHaveBeenCalled();
    expect(aiRelay.getBinding(JOB_ID)).toBeDefined();
    expect(aiRelay.getBinding(OTHER_JOB_ID)).toBeDefined();
  });

  it("API-12：QueueEvents.close() 卡住（Redis 不可達）→ 逾 RELAY_CLOSE_DEADLINE_MS 改 disconnect()，destroy 如期返回", async () => {
    const { qe, relay } = setup();
    qe.close.mockImplementation(() => new Promise<void>(() => undefined)); // 永不 resolve
    let returned = false;
    const destroying = relay.onModuleDestroy().then(() => {
      returned = true;
    });

    await vi.advanceTimersByTimeAsync(RELAY_CLOSE_DEADLINE_MS - 1);
    expect(returned).toBe(false);
    expect(qe.disconnect).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await destroying;
    expect(returned).toBe(true);
    expect(qe.disconnect).toHaveBeenCalledTimes(1);
    const warns = vi.mocked(Logger.prototype.warn).mock.calls.map(([m]) => String(m));
    expect(warns.some((m) => m.includes("QueueEvents close()") && m.includes(`${RELAY_CLOSE_DEADLINE_MS} ms`))).toBe(
      true,
    );
  });

  it("API-12：disconnect() 也拋錯或 reject → 仍不拋出、不產生浮空 rejection", async () => {
    const { qe, relay } = setup();
    qe.close.mockImplementation(() => new Promise<void>(() => undefined));
    qe.disconnect.mockImplementation(() => Promise.reject(new Error("Connection is closed.")));
    const destroying = relay.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(RELAY_CLOSE_DEADLINE_MS);
    await expect(destroying).resolves.toBeUndefined();
    expect(qe.disconnect).toHaveBeenCalledTimes(1);
  });
});
