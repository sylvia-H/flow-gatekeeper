import { afterEach, describe, expect, it, vi } from "vitest";
import { Job } from "bullmq";
import { AiStreamRelayService } from "./ai-stream-relay.service.js";
import { JobStatusRelayService } from "./job-status-relay.service.js";
import { JobRoutingRegistry, TERMINAL_BINDING_GRACE_MS } from "./job-routing-registry.js";
import { attachThrottledErrorLog, bullmqConnection } from "../../lib/connection-error-throttle.js";

const JOB_ID = "0e6c2b7a-1f3d-4d8e-a9b0-c1d2e3f4a5b6";
const OTHER_JOB_ID = "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a";
const CLIENT_ID = "5b1f9c1e-8a53-4c43-9f0e-2d1c3b4a5e6f";

/** 兩個 relay 的私有入口（由 Redis／QueueEvents 事件驅動，測試直接呼叫）。 */
type AiRelayInternals = { handleMessage(channel: string, message: string): void };
type StatusRelayInternals = { handleFailed(jobId: string, failedReason: string): Promise<void> };

function makeAiRelay() {
  const gateway = { send: vi.fn() };
  const registry = new JobRoutingRegistry();
  const relay = new AiStreamRelayService({} as never, gateway as never, registry);
  registry.bind(JOB_ID, CLIENT_ID, "cnc-01");
  const handle = (channel: string, payload: unknown) =>
    (relay as unknown as AiRelayInternals).handleMessage(
      channel,
      typeof payload === "string" ? payload : JSON.stringify(payload),
    );
  return { relay, registry, gateway, handle };
}

const validToken = { type: "ai/token", jobId: JOB_ID, attempt: 1, seq: 0, text: "hi" };

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("AiStreamRelayService.handleMessage", () => {
  it("合法事件轉發給綁定的 client", () => {
    const { gateway, handle } = makeAiRelay();
    handle(`ai-stream:${JOB_ID}`, validToken);
    expect(gateway.send).toHaveBeenCalledWith(CLIENT_ID, validToken);
  });

  it.each([
    ["非 JSON", "{not json"],
    ["缺 attempt", { type: "ai/token", jobId: JOB_ID, seq: 0, text: "hi" }],
    ["未知 type", { type: "ai/hack", jobId: JOB_ID, attempt: 1 }],
    ["ai/done 帶未驗證的 result", { type: "ai/done", jobId: JOB_ID, attempt: 1, cached: false, result: { x: 1 } }],
  ])("%s → 丟棄，不轉發", (_label, payload) => {
    const { gateway, handle } = makeAiRelay();
    handle(`ai-stream:${JOB_ID}`, payload);
    expect(gateway.send).not.toHaveBeenCalled();
  });

  it("驗證失敗的 warn：issues 與 job-status relay 同形狀（{ path, code } 物件陣列），不記原文", () => {
    const { relay, handle } = makeAiRelay();
    const warn = vi
      .spyOn((relay as unknown as { plog: { warn: (...args: unknown[]) => void } }).plog, "warn")
      .mockImplementation(() => undefined);
    handle(`ai-stream:${JOB_ID}`, { type: "ai/token", jobId: JOB_ID, seq: 0, text: "SECRET-TEXT" });
    expect(warn).toHaveBeenCalledWith(
      { jobId: JOB_ID, channel: `ai-stream:${JOB_ID}`, issues: [{ path: "attempt", code: "invalid_type" }] },
      "invalid ai-stream message dropped",
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain("SECRET-TEXT");
  });

  it("payload 的 jobId 與 channel 尾綴不符 → 丟棄", () => {
    const { gateway, handle } = makeAiRelay();
    handle(`ai-stream:${JOB_ID}`, { ...validToken, jobId: OTHER_JOB_ID });
    expect(gateway.send).not.toHaveBeenCalled();
  });

  it("channel 無綁定 → 略過", () => {
    const { gateway, handle } = makeAiRelay();
    handle(`ai-stream:${OTHER_JOB_ID}`, { ...validToken, jobId: OTHER_JOB_ID });
    expect(gateway.send).not.toHaveBeenCalled();
  });
});

describe("JobStatusRelayService.handleFailed", () => {
  function makeStatusRelay() {
    const calls: string[] = [];
    const gateway = {
      send: vi.fn((_clientId: string, payload: { type: string }) => calls.push(payload.type)),
    };
    const registry = new JobRoutingRegistry();
    const aiRelay = new AiStreamRelayService({} as never, gateway as never, registry);
    registry.bind(JOB_ID, CLIENT_ID, "cnc-01");
    const originalMarkTerminal = registry.markTerminal.bind(registry);
    vi.spyOn(registry, "markTerminal").mockImplementation((jobId, kind, now) => {
      calls.push(`markTerminal:${kind}`);
      originalMarkTerminal(jobId, kind, now);
    });
    const statusRelay = new JobStatusRelayService({} as never, gateway as never, registry, {} as never);
    const handleFailed = (reason: string) =>
      (statusRelay as unknown as StatusRelayInternals).handleFailed(JOB_ID, reason);
    return { gateway, aiRelay, registry, calls, handleFailed };
  }

  it("依序送 ai/error → job/status failed → markTerminal(failed)，attempt 取 attemptsMade", async () => {
    vi.spyOn(Job, "fromId").mockResolvedValue({ attemptsMade: 3 } as never);
    const { gateway, registry, calls, handleFailed } = makeStatusRelay();
    await handleFailed("boom");

    expect(calls).toEqual(["ai/error", "job/status", "markTerminal:failed"]);
    expect(gateway.send).toHaveBeenNthCalledWith(1, CLIENT_ID, {
      type: "ai/error",
      jobId: JOB_ID,
      attempt: 3,
      code: "worker_failed",
      message: "boom",
    });
    expect(gateway.send).toHaveBeenNthCalledWith(2, CLIENT_ID, {
      type: "job/status",
      jobId: JOB_ID,
      machineId: "cnc-01",
      status: "failed",
      error: "boom",
    });
    // D12：failed 不再立即刪綁定，改標 terminal 保留寬限。
    expect(registry.get(JOB_ID)?.terminal?.kind).toBe("failed");
  });

  it("查詢 attemptsMade 失敗 → attempt 回退 1，仍照常通知與清理", async () => {
    vi.spyOn(Job, "fromId").mockRejectedValue(new Error("redis down"));
    const { gateway, calls, handleFailed } = makeStatusRelay();
    await handleFailed("boom");

    expect(calls).toEqual(["ai/error", "job/status", "markTerminal:failed"]);
    expect(gateway.send.mock.calls[0]?.[1]).toMatchObject({ type: "ai/error", attempt: 1 });
  });

  it("D12：failed 後 10 s 寬限內遲到的 ai/error(persist_failed) 仍轉發到原連線，期滿後不再轉發", async () => {
    vi.useFakeTimers();
    vi.spyOn(Job, "fromId").mockResolvedValue({ attemptsMade: 1 } as never);
    const { gateway, aiRelay, registry, handleFailed } = makeStatusRelay();
    await handleFailed("boom");
    gateway.send.mockClear();
    const late = { type: "ai/error", jobId: JOB_ID, attempt: 1, code: "persist_failed", message: "late" };
    const publishLate = () =>
      (aiRelay as unknown as AiRelayInternals).handleMessage(`ai-stream:${JOB_ID}`, JSON.stringify(late));

    vi.advanceTimersByTime(TERMINAL_BINDING_GRACE_MS - 1);
    publishLate();
    expect(gateway.send).toHaveBeenCalledWith(CLIENT_ID, late);

    vi.advanceTimersByTime(1);
    expect(registry.isBound(JOB_ID)).toBe(false);
    gateway.send.mockClear();
    publishLate();
    expect(gateway.send).not.toHaveBeenCalled();
  });

  it("查詢 attemptsMade 期間綁定被改綁（GET rebind）→ ai/error 與 job/status failed 都送到新連線", async () => {
    const NEW_CLIENT = "7c2e4d6f-1a3b-4c5d-8e9f-0a1b2c3d4e5f";
    const { gateway, registry, handleFailed } = makeStatusRelay();
    vi.spyOn(Job, "fromId").mockImplementation(async () => {
      registry.rebind(JOB_ID, NEW_CLIENT);
      return { attemptsMade: 2 } as never;
    });
    await handleFailed("boom");

    expect(gateway.send.mock.calls.map(([clientId, payload]) => [clientId, payload.type])).toEqual([
      [NEW_CLIENT, "ai/error"],
      [NEW_CLIENT, "job/status"],
    ]);
  });

  it("job 已被清除（fromId 回 undefined）→ attempt 回退 1", async () => {
    vi.spyOn(Job, "fromId").mockResolvedValue(undefined);
    const { gateway, handleFailed } = makeStatusRelay();
    await handleFailed("boom");
    expect(gateway.send.mock.calls[0]?.[1]).toMatchObject({ type: "ai/error", attempt: 1 });
  });
});

describe("JobStatusRelayService stalled（T057）", () => {
  type Internals = {
    handleStalled(jobId: string): void;
    handleProgress(jobId: string, data: unknown): void;
    handleCompleted(jobId: string, returnvalue: unknown): void;
  };

  function makeRelay() {
    const gateway = { send: vi.fn() };
    const registry = new JobRoutingRegistry();
    registry.bind(JOB_ID, CLIENT_ID, "cnc-01");
    const statusRelay = new JobStatusRelayService({} as never, gateway as never, registry, {} as never);
    const payloads = () => gateway.send.mock.calls.map((c) => c[1] as Record<string, unknown>);
    return { gateway, registry, internals: statusRelay as unknown as Internals, payloads };
  }

  it("stalled 送 waiting＋reason（不帶 attempt／execution）；之後 progress 帶 execution 2，completed 沿用", () => {
    const { registry, internals, payloads } = makeRelay();
    internals.handleProgress(JOB_ID, { value: 40, attempt: 1, execution: 1 });
    internals.handleStalled(JOB_ID);
    internals.handleProgress(JOB_ID, { value: 5, attempt: 1, execution: 2 });
    internals.handleCompleted(JOB_ID, null);
    expect(payloads().map((p) => [p.status, p.reason, p.execution])).toEqual([
      ["active", undefined, 1],
      ["waiting", "stalled", undefined],
      ["active", undefined, 2],
      ["completed", undefined, undefined], // returnvalue 不合法：不帶 result，也不帶 attempt／execution
    ]);
    expect(registry.get(JOB_ID)).toMatchObject({ attempt: 1, execution: 2 });
    registry.onModuleDestroy();
  });

  it("綁定已被刪除 → 不送", () => {
    const { gateway, registry, internals } = makeRelay();
    registry.delete(JOB_ID);
    internals.handleStalled(JOB_ID);
    expect(gateway.send).not.toHaveBeenCalled();
  });
});

describe("JobStatusRelayService delayed keepalive", () => {
  type DelayedInternals = {
    handleDelayed(jobId: string, until: number): void;
    keepDelayedAlive(now: number): void;
    emit(jobId: string, status: string): void;
  };

  function makeRelay() {
    const gateway = { send: vi.fn() };
    const registry = new JobRoutingRegistry();
    registry.bind(JOB_ID, CLIENT_ID, "cnc-01");
    const statusRelay = new JobStatusRelayService({} as never, gateway as never, registry, {} as never);
    const internals = statusRelay as unknown as DelayedInternals;
    const statuses = () =>
      gateway.send.mock.calls.map((c) => (c[1] as { status?: string }).status);
    return { gateway, registry, internals, statuses };
  }

  it("限流延後：立即送 waiting，延後期間每輪補送，到期逾寬限後停止", () => {
    const { internals, statuses } = makeRelay();
    internals.handleDelayed(JOB_ID, 60_000);
    internals.keepDelayedAlive(15_000);
    internals.keepDelayedAlive(30_000);
    internals.keepDelayedAlive(45_000);
    internals.keepDelayedAlive(70_000); // 已過 60s + 5s 寬限
    internals.keepDelayedAlive(85_000);
    expect(statuses()).toEqual(["waiting", "waiting", "waiting", "waiting"]);
  });

  it("job 回到 active 後不再補送", () => {
    const { internals, statuses } = makeRelay();
    internals.handleDelayed(JOB_ID, 60_000);
    internals.emit(JOB_ID, "active");
    internals.keepDelayedAlive(15_000);
    expect(statuses()).toEqual(["waiting", "active"]);
  });

  it("綁定已清除（終態或孤兒回收）→ 不補送", () => {
    const { registry, internals, gateway } = makeRelay();
    internals.handleDelayed(JOB_ID, 60_000);
    registry.delete(JOB_ID);
    gateway.send.mockClear();
    internals.keepDelayedAlive(15_000);
    expect(gateway.send).not.toHaveBeenCalled();
  });
});

describe("bullmqConnection：QueueEvents 接上連線錯誤節流（與 producer Queue 共用同一份實作）", () => {
  it("error 掛在 QueueEvents、ready 取自底層連線；持續故障只放行第一則，恢復後重置", async () => {
    const qeListeners = new Map<string, (err: Error) => void>();
    const clientListeners = new Map<string, () => void>();
    const fakeClient = { on: vi.fn((event: string, l: () => void) => clientListeners.set(event, l)) };
    const queueEvents = {
      on: vi.fn((event: string, l: (err: Error) => void) => qeListeners.set(event, l)),
      client: Promise.resolve(fakeClient),
    };
    const errors: number[] = [];
    const recovered: number[] = [];
    attachThrottledErrorLog(
      bullmqConnection(queueEvents as never),
      { error: (_err, suppressed) => errors.push(suppressed), recovered: (n) => recovered.push(n) },
      { now: () => 0 },
    );
    await Promise.resolve();
    await Promise.resolve();

    const fireError = qeListeners.get("error");
    expect(fireError).toBeDefined();
    for (let i = 0; i < 4; i += 1) fireError?.(new Error("ECONNREFUSED"));
    expect(errors).toEqual([0]);
    clientListeners.get("ready")?.();
    expect(recovered).toEqual([3]);
    fireError?.(new Error("ECONNREFUSED"));
    expect(errors).toEqual([0, 0]);
  });

  it("取底層連線失敗 → 只是收不到恢復訊號，不產生浮空 rejection", async () => {
    const queueEvents = { on: vi.fn(), client: Promise.reject(new Error("closing")) };
    const conn = bullmqConnection(queueEvents);
    conn.on("ready", () => undefined);
    await new Promise((r) => setTimeout(r, 10));
    expect(queueEvents.on).not.toHaveBeenCalled();
  });

  it("掛上監聽時底層連線已是 ready（首次 ready 已發過）→ 補觸發一次，開機期間的故障也記得到恢復", async () => {
    const qeListeners = new Map<string, (err: Error) => void>();
    const fakeClient = { status: "ready", on: vi.fn() };
    const queueEvents = {
      on: vi.fn((event: string, l: (err: Error) => void) => qeListeners.set(event, l)),
      client: Promise.resolve(fakeClient),
    };
    const errors: number[] = [];
    const recovered: number[] = [];
    attachThrottledErrorLog(
      bullmqConnection(queueEvents),
      { error: (_err, suppressed) => errors.push(suppressed), recovered: (n) => recovered.push(n) },
      { now: () => 0 },
    );
    // 開機期間（client 尚未 resolve）已發生故障。
    qeListeners.get("error")?.(new Error("ECONNREFUSED"));
    qeListeners.get("error")?.(new Error("ECONNREFUSED"));
    await vi.waitFor(() => expect(recovered).toEqual([1]));
    expect(errors).toEqual([0]);
    expect(fakeClient.on).toHaveBeenCalledWith("ready", expect.any(Function));
  });
});
