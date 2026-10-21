import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConflictException, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { DiagnosisLookupResponseSchema } from "@flow-gatekeeper/contracts";

// 結構化 logger 換成替身：斷言 info／warn 欄位，也避免測試期間建立真 pino 實例。
const plog = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };
vi.mock("../../logging/app-logger.js", () => ({
  getAppLogger: () => ({ child: () => plog }),
}));

const { DiagnosisLookupService, MONGO_LOOKUP_TIMEOUT_MS } = await import("./diagnosis-lookup.service.js");
const { ENQUEUE_TIMEOUT_MS } = await import("./jobs.service.js");
const { JobRoutingRegistry } = await import("../websocket/job-routing-registry.js");
const { JobStatusRelayService } = await import("../websocket/job-status-relay.service.js");

const JOB_ID = "0e6c2b7a-1f3d-4d8e-a9b0-c1d2e3f4a5b6";
const SOCKET_OLD = "5b1f9c1e-8a53-4c43-9f0e-2d1c3b4a5e6f";
const SOCKET_NEW = "7c2e4d6f-1a3b-4c5d-8e9f-0a1b2c3d4e5f";
const SOCKET_OTHER = "3f4e5d6c-7b8a-4c9d-8e1f-2a3b4c5d6e7f";
const T0 = new Date("2026-10-21T00:00:00Z").getTime();

const RESULT = {
  summary: "主軸溫度偏高",
  severity: "warning",
  likelyCauses: ["冷卻液不足"],
  suggestedActions: [{ label: "補充冷卻液", priority: "high" }],
  evidence: [{ source: "telemetry", excerpt: "temp=92" }],
};

type FakeJob = {
  state: string;
  returnvalue?: unknown;
  failedReason?: unknown;
  progress?: unknown;
  attemptsMade?: unknown;
  attemptsStarted?: unknown;
  machineId?: unknown;
};

/** `queue.getJob` 的替身：回 `getState` 與欄位；`undefined` 表示 BullMQ 查無 job。 */
function toJob(fake: FakeJob | undefined) {
  if (!fake) return undefined;
  return {
    getState: async () => fake.state,
    data: { machineId: fake.machineId ?? "cnc-01" },
    returnvalue: fake.returnvalue,
    failedReason: fake.failedReason,
    progress: fake.progress,
    attemptsMade: fake.attemptsMade ?? 0,
    attemptsStarted: fake.attemptsStarted ?? 1,
  };
}

function setup(opts: { authorized?: string[]; online?: string[] } = {}) {
  const authorized = new Set(opts.authorized ?? [SOCKET_OLD, SOCKET_NEW, SOCKET_OTHER]);
  const online = new Set(opts.online ?? [SOCKET_NEW]);
  const registry = new JobRoutingRegistry();
  const queue = { getJob: vi.fn(async (_jobId: string): Promise<unknown> => undefined) };
  const reader = { findDiagnosisResult: vi.fn(async (_jobId: string): Promise<unknown> => null) };
  const presence = { isAuthorized: (id: string) => authorized.has(id), isOnline: (id: string) => online.has(id) };
  const service = new DiagnosisLookupService(queue as never, registry, presence, reader);
  const jobReturns = (fake: FakeJob | undefined) => queue.getJob.mockImplementation(async () => toJob(fake));
  const lookup = (socketId = SOCKET_NEW, previousSocketId?: string) =>
    service.lookup({ jobId: JOB_ID, socketId, ...(previousSocketId ? { previousSocketId } : {}) });
  return { registry, queue, reader, presence, service, online, jobReturns, lookup };
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected promise to reject");
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  plog.warn.mockClear();
  plog.info.mockClear();
});

describe("DiagnosisLookupService：200 四種回應", () => {
  it("completed（returnvalue 合法）→ 200 completed 帶 result／cached；api 重啟後的暫定綁定撤回", async () => {
    const { registry, jobReturns, lookup, reader } = setup();
    jobReturns({ state: "completed", returnvalue: { result: RESULT, cached: true } });
    const res = await lookup();
    expect(res).toEqual({ status: "completed", jobId: JOB_ID, result: RESULT, cached: true });
    expect(DiagnosisLookupResponseSchema.safeParse(res).success).toBe(true);
    expect(registry.isBound(JOB_ID)).toBe(false);
    expect(reader.findDiagnosisResult).not.toHaveBeenCalled();
  });

  it("failed → 200 failed 帶 failedReason 原文；撤回", async () => {
    const { registry, jobReturns, lookup } = setup();
    jobReturns({ state: "failed", failedReason: "persist_failed: diagnosis record could not be written" });
    await expect(lookup()).resolves.toEqual({
      status: "failed",
      jobId: JOB_ID,
      error: "persist_failed: diagnosis record could not be written",
    });
    expect(registry.isBound(JOB_ID)).toBe(false);
  });

  it("active（api 重啟後無綁定）→ 200 active rebound，progress 取物件的 value、attempt＝attemptsMade+1、execution＝attemptsStarted；保留綁定並補上 machineId", async () => {
    const { registry, jobReturns, lookup } = setup();
    jobReturns({
      state: "active",
      progress: { value: 60, attempt: 1, execution: 2 },
      attemptsMade: 0,
      attemptsStarted: 2,
      machineId: "press-02",
    });
    const res = await lookup();
    expect(res).toEqual({ status: "active", jobId: JOB_ID, progress: 60, attempt: 1, execution: 2, rebound: true });
    expect(DiagnosisLookupResponseSchema.safeParse(res).success).toBe(true);
    expect(registry.get(JOB_ID)).toMatchObject({ clientId: SOCKET_NEW, machineId: "press-02" });
    expect(plog.info).toHaveBeenCalledWith(
      { jobId: JOB_ID, claim: "created", fromClientId: null, toClientId: SOCKET_NEW, viaPreviousSocketId: false },
      "diagnosis lookup rebound job to requesting connection",
    );
  });

  it.each(["waiting", "delayed", "prioritized", "waiting-children"])(
    "BullMQ %s → 200 waiting rebound（數字 progress 照用，attemptsStarted 為 0 時不帶 execution）",
    async (state) => {
      const { registry, jobReturns, lookup } = setup();
      jobReturns({ state, progress: 0, attemptsMade: 1, attemptsStarted: 0 });
      await expect(lookup()).resolves.toEqual({ status: "waiting", jobId: JOB_ID, progress: 0, attempt: 2, rebound: true });
      expect(registry.owner(JOB_ID)).toBe(SOCKET_NEW);
    },
  );

  it("綁定本來就是本 socket（unchanged）→ 200 rebound，綁定不動", async () => {
    const { registry, jobReturns, lookup } = setup();
    registry.bind(JOB_ID, SOCKET_NEW, "cnc-01");
    const before = registry.get(JOB_ID);
    jobReturns({ state: "active" });
    await expect(lookup()).resolves.toMatchObject({ status: "active", rebound: true });
    expect(registry.get(JOB_ID)).toBe(before);
    expect(plog.info).not.toHaveBeenCalled();
  });

  it("原連線離線 → rebound 到本 socket、保留；info 記 fromClientId／toClientId", async () => {
    const { registry, jobReturns, lookup } = setup();
    registry.bind(JOB_ID, SOCKET_OLD, "cnc-01");
    jobReturns({ state: "active" });
    await expect(lookup()).resolves.toMatchObject({ status: "active", rebound: true });
    expect(registry.owner(JOB_ID)).toBe(SOCKET_NEW);
    expect(plog.info).toHaveBeenCalledWith(
      { jobId: JOB_ID, claim: "rebound", fromClientId: SOCKET_OLD, toClientId: SOCKET_NEW, viaPreviousSocketId: false },
      "diagnosis lookup rebound job to requesting connection",
    );
  });

  it("previousSocketId 等於仍在線的原綁定 → 200 rebound（viaPreviousSocketId），改綁到本 socket", async () => {
    const { registry, jobReturns, lookup } = setup({ online: [SOCKET_OLD, SOCKET_NEW] });
    registry.bind(JOB_ID, SOCKET_OLD, "cnc-01");
    jobReturns({ state: "waiting" });
    await expect(lookup(SOCKET_NEW, SOCKET_OLD)).resolves.toMatchObject({ status: "waiting", rebound: true });
    expect(registry.owner(JOB_ID)).toBe(SOCKET_NEW);
    expect(plog.info).toHaveBeenCalledWith(
      expect.objectContaining({ claim: "rebound", fromClientId: SOCKET_OLD, viaPreviousSocketId: true }),
      "diagnosis lookup rebound job to requesting connection",
    );
  });

  it("已完成的任務、原綁定仍在線（conflict claim）→ 照常 200 completed，原綁定不動", async () => {
    const { registry, jobReturns, lookup } = setup({ online: [SOCKET_OLD, SOCKET_NEW] });
    registry.bind(JOB_ID, SOCKET_OLD, "cnc-01");
    const before = registry.get(JOB_ID);
    jobReturns({ state: "completed", returnvalue: { result: RESULT, cached: false } });
    await expect(lookup()).resolves.toMatchObject({ status: "completed", result: RESULT });
    expect(registry.get(JOB_ID)).toBe(before);
  });

  it("rebound 後查到已失敗 → 200 failed，撤回改綁、還原原綁定", async () => {
    const { registry, jobReturns, lookup } = setup();
    registry.bind(JOB_ID, SOCKET_OLD, "cnc-01");
    jobReturns({ state: "failed", failedReason: "boom" });
    await expect(lookup()).resolves.toMatchObject({ status: "failed" });
    expect(registry.get(JOB_ID)).toMatchObject({ clientId: SOCKET_OLD, boundAt: T0 });
  });

  it("rebound 後查到已完成 → 200 completed，撤回改綁、還原原綁定", async () => {
    const { registry, jobReturns, lookup } = setup();
    registry.bind(JOB_ID, SOCKET_OLD, "cnc-01");
    vi.advanceTimersByTime(1_000);
    jobReturns({ state: "completed", returnvalue: { result: RESULT, cached: false } });
    await expect(lookup()).resolves.toEqual({ status: "completed", jobId: JOB_ID, result: RESULT, cached: false });
    expect(registry.get(JOB_ID)).toEqual({ clientId: SOCKET_OLD, machineId: "cnc-01", boundAt: T0 });
  });

  it("created 但 job.data.machineId 不是字串 → 503、warn，撤回暫定綁定（不留 null 綁定）", async () => {
    const { registry, jobReturns, lookup } = setup();
    jobReturns({ state: "active", machineId: 123 });
    await expect(lookup()).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(registry.isBound(JOB_ID)).toBe(false);
    expect(plog.warn).toHaveBeenCalledWith(
      { jobId: JOB_ID },
      "diagnosis lookup: job data has no machineId, cannot route job/status",
    );
  });
});

describe("DiagnosisLookupService：Mongo 後援與 404", () => {
  it("BullMQ 查無 job → Mongo 有合法結果 → 200 completed（cached false）", async () => {
    const { registry, reader, lookup } = setup();
    reader.findDiagnosisResult.mockResolvedValue(RESULT);
    await expect(lookup()).resolves.toEqual({ status: "completed", jobId: JOB_ID, result: RESULT, cached: false });
    expect(reader.findDiagnosisResult).toHaveBeenCalledWith(JOB_ID);
    expect(registry.isBound(JOB_ID)).toBe(false);
  });

  it("BullMQ 與 Mongo 皆無 → 404，撤回暫定綁定", async () => {
    const { registry, lookup } = setup();
    const err = await captureError(lookup());
    expect(err).toBeInstanceOf(NotFoundException);
    expect((err as NotFoundException).getResponse()).toEqual({
      statusCode: 404,
      error: "Not Found",
      message: "查無此診斷（可能已過期）",
    });
    expect(registry.isBound(JOB_ID)).toBe(false);
  });

  it("returnvalue 不合法 → warn（只記 issues）後退 Mongo → 200 completed", async () => {
    const { reader, jobReturns, lookup } = setup();
    jobReturns({ state: "completed", returnvalue: { result: { summary: "SECRET-RAW" }, cached: false } });
    reader.findDiagnosisResult.mockResolvedValue(RESULT);
    await expect(lookup()).resolves.toEqual({ status: "completed", jobId: JOB_ID, result: RESULT, cached: false });
    expect(plog.warn).toHaveBeenCalledWith(
      { jobId: JOB_ID, issues: expect.arrayContaining([{ path: "result.severity", code: "invalid_value" }]) },
      "diagnosis lookup: invalid returnvalue, falling back to mongo",
    );
    expect(JSON.stringify(plog.warn.mock.calls)).not.toContain("SECRET-RAW");
  });

  it("Mongo 結果不合法 → 404（不回未驗證物件）", async () => {
    const { reader, lookup } = setup();
    reader.findDiagnosisResult.mockResolvedValue({ summary: 1 });
    await expect(lookup()).rejects.toBeInstanceOf(NotFoundException);
    expect(plog.warn).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: JOB_ID }),
      "diagnosis lookup: invalid mongo result",
    );
  });

  it("BullMQ state 不在列舉內（unknown）→ 視同查無 job，查 Mongo", async () => {
    const { reader, jobReturns, lookup } = setup();
    jobReturns({ state: "unknown" });
    reader.findDiagnosisResult.mockResolvedValue(RESULT);
    await expect(lookup()).resolves.toMatchObject({ status: "completed", cached: false });
  });
});

describe("DiagnosisLookupService：409", () => {
  it("socketId 不在線或未授權 → 409 socket_unauthorized（message 與 POST 同句）；不建立綁定、不查佇列；warn 30 s 節流", async () => {
    const { registry, queue, lookup } = setup({ authorized: [] });
    const err = await captureError(lookup());
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toEqual({
      statusCode: 409,
      error: "Conflict",
      code: "socket_unauthorized",
      message: "WebSocket 連線不存在或未授權，請重新連線後再發起診斷",
    });
    expect(registry.isBound(JOB_ID)).toBe(false);
    expect(queue.getJob).not.toHaveBeenCalled();

    for (let i = 0; i < 3; i += 1) await captureError(lookup());
    expect(plog.warn).toHaveBeenCalledTimes(1);
    expect(plog.warn.mock.calls[0]?.[0]).toEqual({ jobId: JOB_ID });
    vi.advanceTimersByTime(30_000);
    await captureError(lookup());
    expect(plog.warn).toHaveBeenCalledTimes(2);
    expect(plog.warn.mock.calls[1]?.[0]).toEqual({ jobId: JOB_ID, suppressed: 3 });
  });

  it("進行中且原綁定在線、不是本 socket、不等於 previousSocketId → 409 job_bound_elsewhere；info；綁定不動", async () => {
    const { registry, jobReturns, lookup } = setup({ online: [SOCKET_OLD, SOCKET_NEW] });
    registry.bind(JOB_ID, SOCKET_OLD, "cnc-01");
    const before = registry.get(JOB_ID);
    jobReturns({ state: "active" });
    const err = await captureError(lookup(SOCKET_NEW, SOCKET_OTHER));
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toEqual({
      statusCode: 409,
      error: "Conflict",
      code: "job_bound_elsewhere",
      message: "此診斷仍綁定在另一條連線",
    });
    expect(registry.get(JOB_ID)).toBe(before);
    expect(plog.info).toHaveBeenCalledWith(
      { jobId: JOB_ID, clientId: SOCKET_NEW },
      "diagnosis lookup conflict: job bound to another live connection",
    );
  });
});

describe("DiagnosisLookupService：503", () => {
  it("BullMQ 查詢逾時（5 s）→ 503 並撤回暫定綁定", async () => {
    const { registry, queue, lookup } = setup();
    queue.getJob.mockImplementation(() => new Promise(() => undefined));
    const pending = captureError(lookup());
    expect(registry.isBound(JOB_ID)).toBe(true); // 先綁定後查詢
    await vi.advanceTimersByTimeAsync(ENQUEUE_TIMEOUT_MS);
    const err = await pending;
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect((err as ServiceUnavailableException).getResponse()).toEqual({
      statusCode: 503,
      error: "Service Unavailable",
      message: "診斷狀態暫時無法查詢，請稍後再試",
    });
    expect(registry.isBound(JOB_ID)).toBe(false);
    expect(plog.warn).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: JOB_ID }),
      "diagnosis lookup failed, redis unavailable",
    );
  });

  it("Redis 錯誤 → 503；rebound 的改綁一併撤回", async () => {
    const { registry, queue, lookup } = setup();
    registry.bind(JOB_ID, SOCKET_OLD, "cnc-01");
    queue.getJob.mockRejectedValue(new Error("Connection is closed."));
    await expect(lookup()).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(registry.owner(JOB_ID)).toBe(SOCKET_OLD);
  });

  it("Mongo 錯誤 → 503", async () => {
    const { registry, reader, lookup } = setup();
    reader.findDiagnosisResult.mockRejectedValue(new Error("mongo not ready"));
    await expect(lookup()).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(registry.isBound(JOB_ID)).toBe(false);
    expect(plog.warn).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: JOB_ID }),
      "diagnosis lookup failed, mongo unavailable",
    );
  });

  it("Mongo 查詢逾時（3 s）→ 503", async () => {
    const { reader, lookup } = setup();
    reader.findDiagnosisResult.mockImplementation(() => new Promise(() => undefined));
    const pending = captureError(lookup());
    await vi.advanceTimersByTimeAsync(MONGO_LOOKUP_TIMEOUT_MS);
    expect(await pending).toBeInstanceOf(ServiceUnavailableException);
  });

  it("registry 已標終態但 BullMQ 仍是進行中（實務上不可達）→ 503，綁定不動", async () => {
    const { registry, jobReturns, lookup } = setup();
    registry.bind(JOB_ID, SOCKET_OLD, "cnc-01");
    registry.markTerminal(JOB_ID, "completed");
    const before = registry.get(JOB_ID);
    jobReturns({ state: "active" });
    await expect(lookup()).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(registry.get(JOB_ID)).toBe(before);
  });
});

describe("DiagnosisLookupService：先綁定後查詢與 deferred（FR-009、P1）", () => {
  type StatusRelayInternals = {
    handleCompleted(jobId: string, returnvalue: unknown): void;
    handleProgress(jobId: string, data: unknown): void;
  };

  function withRelay(ctx: ReturnType<typeof setup>) {
    const gateway = { send: vi.fn() };
    const relay = new JobStatusRelayService({} as never, gateway as never, ctx.registry, {} as never);
    return { gateway, relay: relay as unknown as StatusRelayInternals };
  }

  it("Job.fromId 尚未 resolve 時 relay 收到 completed → job/status 送到新 socket；GET 回 completed，撤回不還原終態綁定", async () => {
    const ctx = setup();
    const { registry, queue, lookup } = ctx;
    const { gateway, relay } = withRelay(ctx);
    registry.bind(JOB_ID, SOCKET_OLD, "cnc-01");
    let release: (job: unknown) => void = () => undefined;
    queue.getJob.mockImplementation(() => new Promise((resolve) => (release = resolve)));

    const pending = lookup();
    expect(registry.owner(JOB_ID)).toBe(SOCKET_NEW); // 任何 await 之前已改綁
    relay.handleCompleted(JOB_ID, { result: RESULT, cached: false });
    expect(gateway.send).toHaveBeenCalledWith(SOCKET_NEW, expect.objectContaining({ type: "job/status", status: "completed" }));

    release(toJob({ state: "completed", returnvalue: { result: RESULT, cached: false } }));
    await expect(pending).resolves.toMatchObject({ status: "completed" });
    // 綁定已標終態：撤回不還原到舊連線，寬限期滿照刪。
    expect(registry.get(JOB_ID)).toMatchObject({ clientId: SOCKET_NEW, terminal: { kind: "completed" } });
    registry.onModuleDestroy();
  });

  it("deferred：暫定綁定期間 relay 有 job/status 被擱置 → resolveClaim 回 deferred，重讀一次 job 以最新 state 回應", async () => {
    const ctx = setup();
    const { registry, queue, lookup } = ctx;
    const { gateway, relay } = withRelay(ctx);
    let release: (job: unknown) => void = () => undefined;
    queue.getJob
      .mockImplementationOnce(() => new Promise((resolve) => (release = resolve)))
      .mockImplementationOnce(async () => toJob({ state: "completed", returnvalue: { result: RESULT, cached: true } }));

    const pending = lookup();
    relay.handleProgress(JOB_ID, { value: 90, attempt: 1, execution: 1 }); // machineId 尚為 null → 擱置
    expect(gateway.send).not.toHaveBeenCalled();
    expect(registry.get(JOB_ID)?.deferred).toBe(true);

    release(toJob({ state: "active" }));
    await expect(pending).resolves.toEqual({ status: "completed", jobId: JOB_ID, result: RESULT, cached: true });
    expect(queue.getJob).toHaveBeenCalledTimes(2);
    expect(registry.isBound(JOB_ID)).toBe(false); // 非保留結果：撤回暫定綁定
  });

  it("同 socket 並發兩個 GET（created＋unchanged）：deferred 歸 created，unchanged 不補 machineId、不搶旗標", async () => {
    const ctx = setup();
    const { registry, queue, service } = ctx;
    const { relay } = withRelay(ctx);
    const releases: Array<(job: unknown) => void> = [];
    queue.getJob.mockImplementation(() => new Promise((resolve) => releases.push(resolve)));
    const lookupNew = () => service.lookup({ jobId: JOB_ID, socketId: SOCKET_NEW });

    const created = lookupNew(); // claim created（machineId null）
    const unchanged = lookupNew(); // 同 socket：claim unchanged
    relay.handleProgress(JOB_ID, { value: 50, attempt: 1, execution: 1 }); // 擱置 → deferred
    expect(releases).toHaveLength(2);

    releases[1]?.(toJob({ state: "active", machineId: "press-02" })); // unchanged 先拿到 job
    await expect(unchanged).resolves.toMatchObject({ status: "active", rebound: true });
    expect(registry.get(JOB_ID)).toMatchObject({ machineId: null, deferred: true });

    releases[0]?.(toJob({ state: "active", machineId: "press-02" })); // created：resolveClaim 得到 deferred → 重讀
    await vi.waitFor(() => expect(releases).toHaveLength(3));
    releases[2]?.(toJob({ state: "active", progress: 70, machineId: "press-02" }));
    await expect(created).resolves.toMatchObject({ status: "active", progress: 70, rebound: true });
    expect(registry.get(JOB_ID)).toMatchObject({ clientId: SOCKET_NEW, machineId: "press-02" });
    expect(registry.get(JOB_ID)).not.toHaveProperty("deferred");
  });

  it("GET1 等 Redis 期間被 GET2 以 previousSocketId 改綁走 → GET1 回 409 job_bound_elsewhere，不撤回 GET2 的綁定", async () => {
    const ctx = setup({ online: [SOCKET_NEW, SOCKET_OTHER] }); // 原綁定 SOCKET_OLD 已離線
    const { registry, queue, service } = ctx;
    registry.bind(JOB_ID, SOCKET_OLD, "cnc-01");
    const releases: Array<(job: unknown) => void> = [];
    queue.getJob.mockImplementation(() => new Promise((resolve) => releases.push(resolve)));

    const first = service.lookup({ jobId: JOB_ID, socketId: SOCKET_NEW }); // rebound OLD → NEW
    const second = service.lookup({ jobId: JOB_ID, socketId: SOCKET_OTHER, previousSocketId: SOCKET_NEW }); // NEW → OTHER
    expect(registry.owner(JOB_ID)).toBe(SOCKET_OTHER);

    releases[1]?.(toJob({ state: "active" }));
    await expect(second).resolves.toMatchObject({ status: "active", rebound: true });
    releases[0]?.(toJob({ state: "active" }));
    const err = await captureError(first);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({ code: "job_bound_elsewhere" });
    expect(registry.owner(JOB_ID)).toBe(SOCKET_OTHER);
  });

  it("無擱置 → 只讀一次 job", async () => {
    const { queue, jobReturns, lookup } = setup();
    jobReturns({ state: "active" });
    await lookup();
    expect(queue.getJob).toHaveBeenCalledTimes(1);
  });
});
