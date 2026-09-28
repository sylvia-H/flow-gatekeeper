import { afterEach, describe, expect, it, vi } from "vitest";
import { Job } from "bullmq";
import { AiStreamRelayService } from "./ai-stream-relay.service.js";
import { JobStatusRelayService, queueEventsConnection } from "./job-status-relay.service.js";
import { attachThrottledErrorLog } from "../../lib/connection-error-throttle.js";

const JOB_ID = "0e6c2b7a-1f3d-4d8e-a9b0-c1d2e3f4a5b6";
const OTHER_JOB_ID = "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a";
const CLIENT_ID = "5b1f9c1e-8a53-4c43-9f0e-2d1c3b4a5e6f";

/** 兩個 relay 的私有入口（由 Redis／QueueEvents 事件驅動，測試直接呼叫）。 */
type AiRelayInternals = { handleMessage(channel: string, message: string): void };
type StatusRelayInternals = { handleFailed(jobId: string, failedReason: string): Promise<void> };

function makeAiRelay() {
  const gateway = { send: vi.fn() };
  const relay = new AiStreamRelayService({} as never, gateway as never);
  relay.bindJobToClient(JOB_ID, CLIENT_ID, "cnc-01");
  const handle = (channel: string, payload: unknown) =>
    (relay as unknown as AiRelayInternals).handleMessage(
      channel,
      typeof payload === "string" ? payload : JSON.stringify(payload),
    );
  return { relay, gateway, handle };
}

const validToken = { type: "ai/token", jobId: JOB_ID, attempt: 1, seq: 0, text: "hi" };

afterEach(() => {
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
    const aiRelay = new AiStreamRelayService({} as never, gateway as never);
    aiRelay.bindJobToClient(JOB_ID, CLIENT_ID, "cnc-01");
    const originalDelete = aiRelay.deleteBinding.bind(aiRelay);
    vi.spyOn(aiRelay, "deleteBinding").mockImplementation((jobId) => {
      calls.push("deleteBinding");
      originalDelete(jobId);
    });
    const statusRelay = new JobStatusRelayService({} as never, gateway as never, aiRelay, {} as never);
    const handleFailed = (reason: string) =>
      (statusRelay as unknown as StatusRelayInternals).handleFailed(JOB_ID, reason);
    return { gateway, aiRelay, calls, handleFailed };
  }

  it("依序送 ai/error → job/status failed → deleteBinding，attempt 取 attemptsMade", async () => {
    vi.spyOn(Job, "fromId").mockResolvedValue({ attemptsMade: 3 } as never);
    const { gateway, aiRelay, calls, handleFailed } = makeStatusRelay();
    await handleFailed("boom");

    expect(calls).toEqual(["ai/error", "job/status", "deleteBinding"]);
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
    expect(aiRelay.getBinding(JOB_ID)).toBeUndefined();
  });

  it("查詢 attemptsMade 失敗 → attempt 回退 1，仍照常通知與清理", async () => {
    vi.spyOn(Job, "fromId").mockRejectedValue(new Error("redis down"));
    const { gateway, calls, handleFailed } = makeStatusRelay();
    await handleFailed("boom");

    expect(calls).toEqual(["ai/error", "job/status", "deleteBinding"]);
    expect(gateway.send.mock.calls[0]?.[1]).toMatchObject({ type: "ai/error", attempt: 1 });
  });

  it("job 已被清除（fromId 回 undefined）→ attempt 回退 1", async () => {
    vi.spyOn(Job, "fromId").mockResolvedValue(undefined);
    const { gateway, handleFailed } = makeStatusRelay();
    await handleFailed("boom");
    expect(gateway.send.mock.calls[0]?.[1]).toMatchObject({ type: "ai/error", attempt: 1 });
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
    const aiRelay = new AiStreamRelayService({} as never, gateway as never);
    aiRelay.bindJobToClient(JOB_ID, CLIENT_ID, "cnc-01");
    const statusRelay = new JobStatusRelayService({} as never, gateway as never, aiRelay, {} as never);
    const internals = statusRelay as unknown as DelayedInternals;
    const statuses = () =>
      gateway.send.mock.calls.map((c) => (c[1] as { status?: string }).status);
    return { gateway, aiRelay, internals, statuses };
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
    const { aiRelay, internals, gateway } = makeRelay();
    internals.handleDelayed(JOB_ID, 60_000);
    aiRelay.deleteBinding(JOB_ID);
    gateway.send.mockClear();
    internals.keepDelayedAlive(15_000);
    expect(gateway.send).not.toHaveBeenCalled();
  });
});

describe("queueEventsConnection：QueueEvents 接上連線錯誤節流", () => {
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
      queueEventsConnection(queueEvents as never),
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
    const conn = queueEventsConnection(queueEvents as never);
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
      queueEventsConnection(queueEvents as never),
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
