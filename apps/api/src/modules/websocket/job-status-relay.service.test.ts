import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Logger } from "@nestjs/common";
import type { JobRoutingRegistry as JobRoutingRegistryClass } from "./job-routing-registry.js";

/**
 * TQ-6：以假 `QueueEvents`（EventEmitter 替身）驅動 `JobStatusRelayService` 的真實接線——
 * `onModuleInit` 內的事件監聽與 keepalive 計時器、`JobRoutingRegistry` 的孤兒回收與終態寬限計時器都經由
 * 真正的 `onModuleInit`／`markTerminal` 掛上，測試只負責 emit 事件與推時間，不直接呼叫私有方法。
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
/** 各測試建立的 registry：afterEach 一律停掉它的計時器。 */
const registries: JobRoutingRegistryClass[] = [];

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
const { JobStatusRelayService, DELAYED_KEEPALIVE_MS } = await import("./job-status-relay.service.js");
const { JobRoutingRegistry, TERMINAL_BINDING_GRACE_MS } = await import("./job-routing-registry.js");
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
  const registry = new JobRoutingRegistry();
  registries.push(registry);
  registry.onModuleInit();
  const aiRelay = new AiStreamRelayService({} as never, gateway as never, registry);
  registry.bind(JOB_ID, CLIENT_ID, "cnc-01");
  const config = { redisOptions: vi.fn(() => ({ host: "fake" })) };
  const relay = new JobStatusRelayService(config as never, gateway as never, registry, {} as never);
  relay.onModuleInit();
  const qe = created.at(-1);
  if (!qe) throw new Error("QueueEvents 未被建立");
  const statuses = () =>
    sent
      .filter((s) => s.payload.type === "job/status")
      .map((s) => s.payload.status as string);
  return { relay, registry, aiRelay, gateway, qe, sent, statuses, config };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-27T00:00:00Z"));
  vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  for (const registry of registries.splice(0)) registry.onModuleDestroy();
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
    for (const event of ["waiting", "active", "progress", "delayed", "stalled", "completed", "failed", "error"]) {
      expect(qe.listenerCount(event), event).toBeGreaterThan(0);
    }
    await relay.onModuleDestroy();
  });

  it("waiting → active → progress(數值) → completed：依序轉發 job/status，progress 保留數值，寬限期滿才刪綁定", async () => {
    const { qe, registry, sent, relay } = setup();
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
    vi.advanceTimersByTime(TERMINAL_BINDING_GRACE_MS - 1);
    expect(registry.get(JOB_ID)).toBeDefined();
    vi.advanceTimersByTime(1);
    expect(registry.get(JOB_ID)).toBeUndefined();

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
    vi.advanceTimersByTime(TERMINAL_BINDING_GRACE_MS - 1);
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
    const { qe, registry, aiRelay, sent, relay } = setup();
    const queue = { getJob: vi.fn(async () => undefined), add: vi.fn(async () => ({})) };
    const jobs = new JobsService(queue as never, registry, { isAuthorized: () => true });
    registry.bind(JOB_ID, CLIENT_ID, "mixer-01"); // JobsService 先查名冊，須是已知機台

    qe.emit("completed", { jobId: JOB_ID });
    expect(registry.get(JOB_ID)?.terminal?.kind).toBe("completed");
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
      if (ms === TERMINAL_BINDING_GRACE_MS) graceTimers.push(t);
      return t;
    });
    const { qe, registry, relay } = setup();
    qe.emit("completed", { jobId: JOB_ID });
    spy.mockRestore();
    expect(graceTimers).toHaveLength(1);
    expect(graceTimers[0]?.hasRef()).toBe(false);

    registry.delete(JOB_ID); // 例如孤兒回收
    registry.bind(JOB_ID, "another-client", "cnc-02");
    vi.advanceTimersByTime(TERMINAL_BINDING_GRACE_MS);
    expect(registry.get(JOB_ID)).toMatchObject({ clientId: "another-client" });
    await relay.onModuleDestroy();
  });

  it("failed：先送 ai/error(worker_failed) 帶原因、再送 job/status failed 帶 error，最後標 terminal、寬限期滿才刪（D12）", async () => {
    vi.spyOn(Job, "fromId").mockResolvedValue({ attemptsMade: 2 } as never);
    const { qe, registry, sent, relay } = setup();
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
    expect(registry.get(JOB_ID)?.terminal?.kind).toBe("failed");
    vi.advanceTimersByTime(TERMINAL_BINDING_GRACE_MS);
    expect(registry.get(JOB_ID)).toBeUndefined();
    await relay.onModuleDestroy();
  });

  it("D12：failed 先於 worker 的 ai/error(persist_failed) 到達 → 寬限內仍轉發到原 client，期滿後不再轉發", async () => {
    vi.spyOn(Job, "fromId").mockResolvedValue({ attemptsMade: 1 } as never);
    const { qe, registry, aiRelay, sent, relay } = setup();
    const persistFailed = {
      type: "ai/error",
      jobId: JOB_ID,
      attempt: 1,
      code: "persist_failed",
      message: "診斷結果寫入失敗",
    };
    const publishPersistFailed = () =>
      (aiRelay as unknown as AiRelayInternals).handleMessage(`ai-stream:${JOB_ID}`, JSON.stringify(persistFailed));

    qe.emit("failed", { jobId: JOB_ID, failedReason: "persist failed" });
    await vi.waitFor(() => expect(sent).toHaveLength(2)); // ai/error(worker_failed) + job/status failed
    // fake timers 下 vi.waitFor 每輪會推進時間：寬限自標記時刻起算，推到恰差 1 ms。
    const markedAt = registry.get(JOB_ID)?.terminal?.at ?? Number.NaN;
    vi.advanceTimersByTime(markedAt + TERMINAL_BINDING_GRACE_MS - 1 - Date.now());
    publishPersistFailed();
    expect(sent.at(-1)).toEqual({ clientId: CLIENT_ID, payload: persistFailed });

    vi.advanceTimersByTime(1);
    publishPersistFailed(); // 寬限已過：綁定已刪，不再轉發
    expect(sent).toHaveLength(3);
    await relay.onModuleDestroy();
  });

  it("D12：failed 寬限內同 jobId 重送 POST /diagnoses → 409「已使用過」，綁定原樣保留", async () => {
    vi.spyOn(Job, "fromId").mockResolvedValue({ attemptsMade: 1 } as never);
    const { qe, registry, sent, relay } = setup();
    const queue = { getJob: vi.fn(async () => undefined), add: vi.fn(async () => ({})) };
    const jobs = new JobsService(queue as never, registry, { isAuthorized: () => true });
    registry.bind(JOB_ID, CLIENT_ID, "mixer-01"); // JobsService 先查名冊，須是已知機台

    qe.emit("failed", { jobId: JOB_ID, failedReason: "boom" });
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    const terminal = registry.get(JOB_ID);
    expect(terminal?.terminal?.kind).toBe("failed");
    await expect(
      jobs.createDiagnosis({ jobId: JOB_ID, machineId: "mixer-01", socketId: CLIENT_ID }),
    ).rejects.toMatchObject({ status: 409, message: expect.stringContaining("已使用過") });
    expect(queue.add).not.toHaveBeenCalled();
    expect(registry.get(JOB_ID)).toBe(terminal);
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
    const { registry, relay } = setup();
    // 5 分鐘後才綁定的另一個 job：第一個被回收時它仍在安全期內。
    vi.advanceTimersByTime(5 * 60_000);
    registry.bind(OTHER_JOB_ID, CLIENT_ID, "cnc-02");

    // 推到 t = 10 分鐘（第 10 次掃描）：age 恰等於 ORPHAN_TTL_MS，不回收。
    vi.advanceTimersByTime(ORPHAN_TTL_MS - 5 * 60_000);
    expect(registry.get(JOB_ID)).toBeDefined();
    expect(plog.warn).not.toHaveBeenCalled();

    // 再一輪掃描（t = 11 分鐘）：超過安全期 → 回收並記 warn（jobId 為獨立欄位）。
    vi.advanceTimersByTime(SWEEP_INTERVAL_MS);
    expect(registry.get(JOB_ID)).toBeUndefined();
    expect(registry.get(OTHER_JOB_ID)).toBeDefined();
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

  it("onModuleDestroy（relay 與 registry）停止計時器（含終態寬限）並關閉 QueueEvents：之後推時間不再回收或補送", async () => {
    const { qe, registry, gateway, relay } = setup();
    qe.emit("delayed", { jobId: JOB_ID, delay: Date.now() + ORPHAN_TTL_MS * 2 });
    registry.bind(OTHER_JOB_ID, CLIENT_ID, "cnc-02");
    qe.emit("completed", { jobId: OTHER_JOB_ID });
    gateway.send.mockClear();
    await relay.onModuleDestroy();
    registry.onModuleDestroy();
    expect(qe.close).toHaveBeenCalledTimes(1);
    expect(qe.disconnect).not.toHaveBeenCalled(); // 如期關閉：不需強制斷線
    expect(vi.getTimerCount()).toBe(0);

    vi.advanceTimersByTime(ORPHAN_TTL_MS + SWEEP_INTERVAL_MS);
    expect(gateway.send).not.toHaveBeenCalled();
    expect(registry.get(JOB_ID)).toBeDefined();
    expect(registry.get(OTHER_JOB_ID)).toBeDefined();
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

describe("JobStatusRelayService：completed returnvalue 與 progress 物件（T025、D1、D7）", () => {
  const RESULT = {
    summary: "主軸溫度偏高",
    severity: "warning",
    likelyCauses: ["冷卻液不足"],
    suggestedActions: [{ label: "補充冷卻液", priority: "high" }],
    evidence: [{ source: "telemetry", excerpt: "temp=92" }],
  };
  const base = { type: "job/status", jobId: JOB_ID, machineId: "cnc-01" };

  it("returnvalue 合法 → completed 帶 result 與 cached，不記 warn，之後標 terminal", async () => {
    const { qe, registry, sent, relay } = setup();
    qe.emit("completed", { jobId: JOB_ID, returnvalue: { result: RESULT, cached: true } });
    expect(sent).toEqual([{ clientId: CLIENT_ID, payload: { ...base, status: "completed", result: RESULT, cached: true } }]);
    expect(plog.warn).not.toHaveBeenCalled();
    expect(registry.get(JOB_ID)?.terminal?.kind).toBe("completed");
    await relay.onModuleDestroy();
  });

  it("returnvalue 不合法 → 照送不帶 result 的 completed，warn 只記 jobId 與 issue 路徑／代碼（不記原文），仍標 terminal", async () => {
    const { qe, registry, sent, relay } = setup();
    const secret = "SECRET-PAYLOAD-TEXT";
    qe.emit("completed", { jobId: JOB_ID, returnvalue: { result: { summary: secret }, cached: false } });
    expect(sent).toEqual([{ clientId: CLIENT_ID, payload: { ...base, status: "completed" } }]);
    expect(plog.warn).toHaveBeenCalledTimes(1);
    const [fields, msg] = plog.warn.mock.calls[0] as [Record<string, unknown>, string];
    expect(msg).toBe("invalid completed returnvalue, forwarding completed without result");
    expect(fields.jobId).toBe(JOB_ID);
    expect(fields.issues).toEqual(expect.arrayContaining([{ path: "result.severity", code: "invalid_value" }]));
    expect(JSON.stringify(plog.warn.mock.calls)).not.toContain(secret);
    expect(registry.get(JOB_ID)?.terminal?.kind).toBe("completed");
    await relay.onModuleDestroy();
  });

  it.each([
    ["null（舊版 worker）", null],
    ["缺值", undefined],
  ])("returnvalue %s → 照送不帶 result 的 completed 並記 warn", async (_label, returnvalue) => {
    const { qe, sent, relay } = setup();
    qe.emit("completed", { jobId: JOB_ID, returnvalue });
    expect(sent).toEqual([{ clientId: CLIENT_ID, payload: { ...base, status: "completed" } }]);
    expect(plog.warn).toHaveBeenCalledWith(
      { jobId: JOB_ID, issues: [{ path: "(root)", code: "invalid_type" }] },
      "completed without returnvalue (legacy worker?)",
    );
    await relay.onModuleDestroy();
  });

  it("MUST NOT 轉發未驗證物件：result 夾帶的未知欄位與 returnvalue 的多餘欄位都不出現在送出的 job/status", async () => {
    const { qe, sent, relay } = setup();
    const returnvalue = { result: { ...RESULT, injected: "<img onerror>" }, cached: false, extra: { big: "x" } };
    qe.emit("completed", { jobId: JOB_ID, returnvalue });
    const payload = sent[0]?.payload;
    expect(payload).toEqual({ ...base, status: "completed", result: RESULT, cached: false });
    expect(payload?.result).not.toBe(returnvalue.result);
    await relay.onModuleDestroy();
  });

  it("progress 物件 → active 帶 progress／attempt／execution 並記進綁定；completed 沿用最近一次的值（P7）", async () => {
    const { qe, registry, sent, relay } = setup();
    qe.emit("progress", { jobId: JOB_ID, data: { value: 20, attempt: 1, execution: 1 } });
    qe.emit("progress", { jobId: JOB_ID, data: { value: 60, attempt: 2, execution: 3 } });
    expect(registry.get(JOB_ID)).toMatchObject({ attempt: 2, execution: 3 });
    qe.emit("completed", { jobId: JOB_ID, returnvalue: { result: RESULT, cached: false } });
    expect(sent.map((s) => s.payload)).toEqual([
      { ...base, status: "active", progress: 20, attempt: 1, execution: 1 },
      { ...base, status: "active", progress: 60, attempt: 2, execution: 3 },
      { ...base, status: "completed", result: RESULT, cached: false, attempt: 2, execution: 3 },
    ]);
    await relay.onModuleDestroy();
  });

  it("progress 數字照舊只帶 progress、不記綁定；超出 0～100 省略 progress；不合法物件送不帶 progress 的 active", async () => {
    const { qe, registry, sent, relay } = setup();
    qe.emit("progress", { jobId: JOB_ID, data: 42 });
    qe.emit("progress", { jobId: JOB_ID, data: 150 });
    qe.emit("progress", { jobId: JOB_ID, data: { value: 10, attempt: 0, execution: 1 } });
    expect(sent.map((s) => s.payload)).toEqual([
      { ...base, status: "active", progress: 42 },
      { ...base, status: "active" },
      { ...base, status: "active" },
    ]);
    expect(registry.get(JOB_ID)).not.toHaveProperty("attempt");
    expect(registry.get(JOB_ID)).not.toHaveProperty("execution");
    await relay.onModuleDestroy();
  });
});

describe("JobStatusRelayService：machineId 尚未補上的暫定綁定（T032、P1）", () => {
  const NEW_CLIENT = "7c2e4d6f-1a3b-4c5d-8e9f-0a1b2c3d4e5f";

  /** 模擬 api 重啟後 GET 的 created claim：原綁定不在，以 machineId null 暫定綁定到 NEW_CLIENT。 */
  function setupProvisional() {
    const ctx = setup();
    ctx.registry.delete(JOB_ID);
    const claim = ctx.registry.claimForLookup({ jobId: JOB_ID, socketId: NEW_CLIENT, isOnline: () => true });
    return { ...ctx, claim };
  }

  it("job/status 擱置不送並記 deferred；ai/* 照常送到暫定連線", async () => {
    const { qe, registry, aiRelay, sent, relay } = setupProvisional();
    qe.emit("active", { jobId: JOB_ID });
    qe.emit("progress", { jobId: JOB_ID, data: { value: 30, attempt: 1, execution: 1 } });
    expect(sent).toEqual([]);
    expect(registry.get(JOB_ID)?.deferred).toBe(true);

    const token = { type: "ai/token", jobId: JOB_ID, attempt: 1, seq: 0, text: "hi" };
    (aiRelay as unknown as AiRelayInternals).handleMessage(`ai-stream:${JOB_ID}`, JSON.stringify(token));
    expect(sent).toEqual([{ clientId: NEW_CLIENT, payload: token }]);
    await relay.onModuleDestroy();
  });

  it("resolveClaim 補上 machineId 後回報 deferred，之後的 job/status 照常送到暫定連線（不補送被擱置的那幾則）", async () => {
    const { qe, registry, claim, sent, relay } = setupProvisional();
    qe.emit("active", { jobId: JOB_ID });
    expect(registry.resolveClaim(claim, "cnc-01")).toEqual({ deferred: true });
    expect(sent).toEqual([]);

    qe.emit("progress", { jobId: JOB_ID, data: { value: 60, attempt: 1, execution: 2 } });
    expect(sent).toEqual([
      {
        clientId: NEW_CLIENT,
        payload: {
          type: "job/status",
          jobId: JOB_ID,
          machineId: "cnc-01",
          status: "active",
          progress: 60,
          attempt: 1,
          execution: 2,
        },
      },
    ]);
    expect(registry.get(JOB_ID)).not.toHaveProperty("deferred");
    await relay.onModuleDestroy();
  });

  it("擱置期間到 completed → 不送、仍標 terminal；GET 隨後 resolveClaim 得到 deferred，撤回不刪終態副本", async () => {
    const { qe, registry, claim, sent, relay } = setupProvisional();
    qe.emit("completed", { jobId: JOB_ID, returnvalue: null });
    expect(sent).toEqual([]);
    expect(registry.get(JOB_ID)).toMatchObject({ terminal: { kind: "completed" }, deferred: true });
    expect(registry.resolveClaim(claim, "cnc-01")).toEqual({ deferred: true });
    registry.revertClaim(claim);
    expect(registry.get(JOB_ID)?.terminal?.kind).toBe("completed");
    await relay.onModuleDestroy();
  });

  it("擱置期間到 failed → ai/error(worker_failed) 照送暫定連線，job/status failed 擱置", async () => {
    vi.spyOn(Job, "fromId").mockResolvedValue({ attemptsMade: 1 } as never);
    const { qe, registry, sent, relay } = setupProvisional();
    qe.emit("failed", { jobId: JOB_ID, failedReason: "boom" });
    await vi.waitFor(() => expect(registry.get(JOB_ID)?.terminal?.kind).toBe("failed"));
    expect(sent.map((s) => [s.clientId, s.payload.type])).toEqual([[NEW_CLIENT, "ai/error"]]);
    expect(registry.get(JOB_ID)?.deferred).toBe(true);
    await relay.onModuleDestroy();
  });
});

describe("JobStatusRelayService：stalled 重派（T057、FR-021、D7）", () => {
  const RESULT = {
    summary: "主軸溫度偏高",
    severity: "warning",
    likelyCauses: ["冷卻液不足"],
    suggestedActions: [{ label: "補充冷卻液", priority: "high" }],
    evidence: [{ source: "telemetry", excerpt: "temp=92" }],
  };
  const base = { type: "job/status", jobId: JOB_ID, machineId: "cnc-01" };

  it("BullMQ 先寫 waiting 再寫 stalled → 依序送兩則 waiting，第二則帶 reason；記 warn", async () => {
    const { qe, sent, relay } = setup();
    qe.emit("waiting", { jobId: JOB_ID });
    qe.emit("stalled", { jobId: JOB_ID });
    expect(sent.map((s) => s.payload)).toEqual([
      { ...base, status: "waiting" },
      { ...base, status: "waiting", reason: "stalled" },
    ]);
    expect(plog.warn).toHaveBeenCalledWith({ jobId: JOB_ID, reason: "stalled" }, "job stalled, re-queued by bullmq");
    await relay.onModuleDestroy();
  });

  it("stalled → 新 worker 撿起後 progress 物件帶 execution 2 → completed 沿用最新的 attempt／execution", async () => {
    const { qe, registry, sent, relay } = setup();
    qe.emit("active", { jobId: JOB_ID });
    qe.emit("progress", { jobId: JOB_ID, data: { value: 20, attempt: 1, execution: 1 } });
    qe.emit("waiting", { jobId: JOB_ID });
    qe.emit("stalled", { jobId: JOB_ID });
    qe.emit("active", { jobId: JOB_ID });
    qe.emit("progress", { jobId: JOB_ID, data: { value: 10, attempt: 1, execution: 2 } });
    qe.emit("completed", { jobId: JOB_ID, returnvalue: { result: RESULT, cached: false } });

    expect(sent.map((s) => s.payload)).toEqual([
      { ...base, status: "active" },
      { ...base, status: "active", progress: 20, attempt: 1, execution: 1 },
      { ...base, status: "waiting" },
      { ...base, status: "waiting", reason: "stalled" },
      { ...base, status: "active" },
      { ...base, status: "active", progress: 10, attempt: 1, execution: 2 },
      { ...base, status: "completed", result: RESULT, cached: false, attempt: 1, execution: 2 },
    ]);
    expect(registry.get(JOB_ID)?.terminal?.kind).toBe("completed");
    await relay.onModuleDestroy();
  });

  it("雙重執行：exec 2 之後才到的 exec 1 progress 不覆寫綁定，completed 仍帶 execution 2", async () => {
    const { qe, registry, sent, relay } = setup();
    qe.emit("progress", { jobId: JOB_ID, data: { value: 10, attempt: 1, execution: 2 } });
    qe.emit("progress", { jobId: JOB_ID, data: { value: 80, attempt: 1, execution: 1 } }); // 舊的 exec1 恢復後送出
    expect(registry.get(JOB_ID)).toMatchObject({ attempt: 1, execution: 2 });
    qe.emit("completed", { jobId: JOB_ID, returnvalue: { result: RESULT, cached: false } });
    expect(sent.at(-1)?.payload).toEqual({ ...base, status: "completed", result: RESULT, cached: false, attempt: 1, execution: 2 });
    await relay.onModuleDestroy();
  });

  it("無綁定（純後端 smoke）→ 不送，仍記 warn", async () => {
    const { qe, gateway, relay } = setup();
    qe.emit("stalled", { jobId: OTHER_JOB_ID });
    expect(gateway.send).not.toHaveBeenCalled();
    expect(plog.warn).toHaveBeenCalledWith({ jobId: OTHER_JOB_ID, reason: "stalled" }, "job stalled, re-queued by bullmq");
    await relay.onModuleDestroy();
  });

  it("終態寬限內晚到的 stalled → 不送（不把已結束的任務拉回排隊中）", async () => {
    const { qe, sent, relay } = setup();
    qe.emit("completed", { jobId: JOB_ID, returnvalue: { result: RESULT, cached: false } });
    qe.emit("stalled", { jobId: JOB_ID });
    expect(sent.map((s) => s.payload.status)).toEqual(["completed"]);
    await relay.onModuleDestroy();
  });

  it("delayed 補送中收到 stalled → 送帶 reason 的 waiting，keepalive 照舊補送到期為止", async () => {
    const { qe, sent, relay } = setup();
    qe.emit("delayed", { jobId: JOB_ID, delay: Date.now() + 20_000 });
    qe.emit("stalled", { jobId: JOB_ID });
    vi.advanceTimersByTime(DELAYED_KEEPALIVE_MS);
    expect(sent.map((s) => [s.payload.status, s.payload.reason])).toEqual([
      ["waiting", undefined],
      ["waiting", "stalled"],
      ["waiting", undefined],
    ]);
    await relay.onModuleDestroy();
  });

  it("machineId 尚未補上的暫定綁定 → stalled 也擱置並記 deferred", async () => {
    const { qe, registry, sent, relay } = setup();
    registry.delete(JOB_ID);
    registry.claimForLookup({ jobId: JOB_ID, socketId: CLIENT_ID, isOnline: () => true });
    qe.emit("stalled", { jobId: JOB_ID });
    expect(sent).toEqual([]);
    expect(registry.get(JOB_ID)?.deferred).toBe(true);
    await relay.onModuleDestroy();
  });
});
