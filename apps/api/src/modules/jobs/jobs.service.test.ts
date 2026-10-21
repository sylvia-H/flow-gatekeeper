import { afterEach, describe, expect, it, vi } from "vitest";
import { ConflictException, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import type { Queue } from "bullmq";
import type { DiagnosisJobPayload } from "@flow-gatekeeper/contracts";
import { ENQUEUE_TIMEOUT_MS, JobsService, SOCKET_UNAVAILABLE_MESSAGE } from "./jobs.service.js";
import type { ClientPresence, JobBindingStore } from "./jobs.service.js";
import type { JobBinding } from "../websocket/job-routing-registry.js";
import { JobRoutingRegistry } from "../websocket/job-routing-registry.js";
import { MACHINE_IDS } from "@flow-gatekeeper/contracts";

const SOCKET_A = "5b1f9c1e-8a53-4c43-9f0e-2d1c3b4a5e6f";
const SOCKET_B = "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a";
const JOB_ID = "0e6c2b7a-1f3d-4d8e-a9b0-c1d2e3f4a5b6";

type FakeBindings = JobBindingStore & { map: Map<string, JobBinding> };

function makeBindings(): FakeBindings {
  const map = new Map<string, JobBinding>();
  return {
    map,
    bind: (jobId, clientId, machineId) => {
      const binding: JobBinding = { clientId, machineId, boundAt: Date.now() };
      map.set(jobId, binding);
      return binding;
    },
    get: (jobId) => map.get(jobId),
    deleteIfCurrent: (jobId, binding) => {
      if (map.get(jobId) !== binding) return false;
      map.delete(jobId);
      return true;
    },
  };
}

type QueueImpl = { getJob?: () => Promise<unknown>; add?: () => Promise<unknown> };

function makeQueue(impl: QueueImpl = {}) {
  return {
    getJob: vi.fn(impl.getJob ?? (async () => undefined)),
    add: vi.fn(impl.add ?? (async () => ({}))),
  };
}

/** 在線且已授權的 clientId 集合；預設 SOCKET_A／SOCKET_B 皆在線且已授權。 */
function makePresence(authorized: readonly string[] = [SOCKET_A, SOCKET_B]) {
  const set = new Set(authorized);
  const presence: ClientPresence & { set: Set<string> } = {
    set,
    isAuthorized: (clientId) => set.has(clientId),
  };
  return presence;
}

function makeService(queue: ReturnType<typeof makeQueue>, presence = makePresence()) {
  const bindings = makeBindings();
  const service = new JobsService(queue as unknown as Queue<DiagnosisJobPayload>, bindings, presence);
  return { service, bindings, presence };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("JobsService.createDiagnosis", () => {
  it("帶入 jobId → 以它入列並綁定，payload 不含 promptVersion", async () => {
    const queue = makeQueue();
    const { service, bindings } = makeService(queue);
    const res = await service.createDiagnosis({ jobId: JOB_ID, machineId: "mixer-01", socketId: SOCKET_A });

    expect(res).toEqual({ jobId: JOB_ID, machineId: "mixer-01", status: "waiting" });
    expect(bindings.map.get(JOB_ID)?.clientId).toBe(SOCKET_A);
    const [name, payload, opts] = queue.add.mock.calls[0] as unknown as [
      string,
      DiagnosisJobPayload,
      { jobId: string },
    ];
    expect(name).toBe("diagnose-machine");
    expect(opts.jobId).toBe(JOB_ID);
    expect(payload).not.toHaveProperty("promptVersion");
    expect(payload.requestedBy).toBe("demo-user");
  });

  it("未帶 jobId → api 自行產生 uuid", async () => {
    const { service } = makeService(makeQueue());
    const res = await service.createDiagnosis({ machineId: "mixer-01", socketId: SOCKET_A });
    expect(res.jobId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("同 jobId 重送（綁定仍在）→ 回同一回應、不重複入列、不改綁新 socketId", async () => {
    const queue = makeQueue();
    const { service, bindings } = makeService(queue);
    await service.createDiagnosis({ jobId: JOB_ID, machineId: "mixer-01", socketId: SOCKET_A });
    const again = await service.createDiagnosis({ jobId: JOB_ID, machineId: "mixer-01", socketId: SOCKET_B });

    expect(again).toEqual({ jobId: JOB_ID, machineId: "mixer-01", status: "waiting" });
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(bindings.map.get(JOB_ID)?.clientId).toBe(SOCKET_A);
  });

  it("併發重送（第一個尚未入列完成）也只入列一次", async () => {
    const queue = makeQueue();
    const { service } = makeService(queue);
    const body = { jobId: JOB_ID, machineId: "mixer-01", socketId: SOCKET_A };
    await Promise.all([service.createDiagnosis(body), service.createDiagnosis(body)]);
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it("併發重送時首發入列失敗 → 重送方拿到同一個錯誤，而不是指向不存在 job 的 200", async () => {
    let rejectAdd: (e: Error) => void = () => undefined;
    const queue = makeQueue({
      add: () =>
        new Promise((_, reject) => {
          rejectAdd = reject;
        }),
    });
    const { service, bindings } = makeService(queue);
    const body = { jobId: JOB_ID, machineId: "mixer-01", socketId: SOCKET_A };
    const first = service.createDiagnosis(body);
    const firstAssertion = expect(first).rejects.toBeInstanceOf(ServiceUnavailableException);
    // 等首發跑到 add（getJob 之後）再送重送。
    await vi.waitFor(() => expect(queue.add).toHaveBeenCalledTimes(1));
    const second = service.createDiagnosis({ ...body, socketId: SOCKET_B });
    const secondAssertion = expect(second).rejects.toBeInstanceOf(ServiceUnavailableException);
    rejectAdd(new Error("Connection is closed."));
    await firstAssertion;
    await secondAssertion;
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(bindings.map.has(JOB_ID)).toBe(false);
  });

  it("同 jobId 但不同 machineId → 409", async () => {
    const { service } = makeService(makeQueue());
    await service.createDiagnosis({ jobId: JOB_ID, machineId: "mixer-01", socketId: SOCKET_A });
    await expect(
      service.createDiagnosis({ jobId: JOB_ID, machineId: "press-02", socketId: SOCKET_A }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("綁定已清除但 job 仍在 Redis（已結束）→ 409，不入列、不殘留綁定", async () => {
    const queue = makeQueue({ getJob: async () => ({ id: JOB_ID }) });
    const { service, bindings } = makeService(queue);
    await expect(
      service.createDiagnosis({ jobId: JOB_ID, machineId: "mixer-01", socketId: SOCKET_A }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(queue.add).not.toHaveBeenCalled();
    expect(bindings.map.has(JOB_ID)).toBe(false);
  });

  it.each(["completed", "failed"] as const)(
    "綁定仍在但已標 %s（AR-5／D12 寬限保留中）→ 409「已使用過」，不查佇列、不入列、綁定原樣保留",
    async (kind) => {
      const queue = makeQueue();
      const { service, bindings } = makeService(queue);
      const original: JobBinding = {
        clientId: SOCKET_A,
        machineId: "mixer-01",
        boundAt: 1,
        terminal: { kind, at: 2 },
      };
      bindings.map.set(JOB_ID, original);
      const attempt = service.createDiagnosis({ jobId: JOB_ID, machineId: "mixer-01", socketId: SOCKET_B });
      await expect(attempt).rejects.toBeInstanceOf(ConflictException);
      await expect(attempt).rejects.toMatchObject({ message: expect.stringContaining("已使用過") });
      expect(queue.getJob).not.toHaveBeenCalled();
      expect(queue.add).not.toHaveBeenCalled();
      expect(bindings.map.get(JOB_ID)).toBe(original); // 寬限內晚到的 ai/* 仍要送給原連線
    },
  );

  it("入列等待期間綁定被 GET 改綁走、之後入列失敗 → 503，但只刪自己那份、不刪 GET 的綁定", async () => {
    const registry = new JobRoutingRegistry();
    let rejectAdd: (e: Error) => void = () => undefined;
    const queue = makeQueue({
      add: () =>
        new Promise((_, reject) => {
          rejectAdd = reject;
        }),
    });
    const service = new JobsService(queue as unknown as Queue<DiagnosisJobPayload>, registry, makePresence());
    const posting = service.createDiagnosis({ jobId: JOB_ID, machineId: "mixer-01", socketId: SOCKET_A });
    const assertion = expect(posting).rejects.toBeInstanceOf(ServiceUnavailableException);
    await vi.waitFor(() => expect(queue.add).toHaveBeenCalledTimes(1));

    // GET 以 previousSocketId 把綁定改到 SOCKET_B（原連線仍在線）。
    registry.claimForLookup({ jobId: JOB_ID, socketId: SOCKET_B, previousSocketId: SOCKET_A, isOnline: () => true });
    rejectAdd(new Error("Connection is closed."));
    await assertion;
    expect(registry.owner(JOB_ID)).toBe(SOCKET_B);
  });

  it("入列等待期間被 GET rebound 又撤回、之後入列失敗 → 503，且綁定已刪（撤回放回原物件，deleteIfCurrent 認得）", async () => {
    const registry = new JobRoutingRegistry();
    let rejectAdd: (e: Error) => void = () => undefined;
    const queue = makeQueue({
      add: () =>
        new Promise((_, reject) => {
          rejectAdd = reject;
        }),
    });
    const service = new JobsService(queue as unknown as Queue<DiagnosisJobPayload>, registry, makePresence());
    const posting = service.createDiagnosis({ jobId: JOB_ID, machineId: "mixer-01", socketId: SOCKET_A });
    const assertion = expect(posting).rejects.toBeInstanceOf(ServiceUnavailableException);
    await vi.waitFor(() => expect(queue.add).toHaveBeenCalledTimes(1));

    const claim = registry.claimForLookup({ jobId: JOB_ID, socketId: SOCKET_B, isOnline: () => false });
    expect(claim.kind).toBe("rebound");
    registry.revertClaim(claim); // 例如 GET 查到已完成或 503
    expect(registry.owner(JOB_ID)).toBe(SOCKET_A);
    rejectAdd(new Error("Connection is closed."));
    await assertion;
    expect(registry.isBound(JOB_ID)).toBe(false);
  });

  it("Redis 不可用（add reject）→ 503 並解除綁定", async () => {
    const queue = makeQueue({
      add: async () => {
        throw new Error("Stream isn't writeable and enableOfflineQueue options is false");
      },
    });
    const { service, bindings } = makeService(queue);
    await expect(
      service.createDiagnosis({ jobId: JOB_ID, machineId: "mixer-01", socketId: SOCKET_A }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(bindings.map.has(JOB_ID)).toBe(false);
  });

  it("入列逾時 → 503 並解除綁定", async () => {
    vi.useFakeTimers();
    const queue = makeQueue({ add: () => new Promise(() => undefined) });
    const { service, bindings } = makeService(queue);
    const pending = service.createDiagnosis({ jobId: JOB_ID, machineId: "mixer-01", socketId: SOCKET_A });
    const assertion = expect(pending).rejects.toBeInstanceOf(ServiceUnavailableException);
    await vi.advanceTimersByTimeAsync(ENQUEUE_TIMEOUT_MS);
    await assertion;
    expect(bindings.map.has(JOB_ID)).toBe(false);
  });

  it("machineId 不在機台名冊 → 404：不綁定、不查佇列、不入列", async () => {
    const queue = makeQueue();
    const { service, bindings } = makeService(queue);
    const err = await service
      .createDiagnosis({ jobId: JOB_ID, machineId: "cnc-99", socketId: SOCKET_A })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundException);
    expect((err as NotFoundException).getStatus()).toBe(404);
    expect((err as NotFoundException).getResponse()).toEqual({
      statusCode: 404,
      error: "Not Found",
      message: "此機台不在名冊中",
    });
    expect(bindings.map.size).toBe(0);
    expect(queue.getJob).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it("未知 machineId 重用既有 jobId → 仍是 404（名冊檢查先於冪等檢查）", async () => {
    const { service } = makeService(makeQueue());
    await service.createDiagnosis({ jobId: JOB_ID, machineId: "mixer-01", socketId: SOCKET_A });
    await expect(
      service.createDiagnosis({ jobId: JOB_ID, machineId: "cnc-99", socketId: SOCKET_A }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it.each([...MACHINE_IDS])("名冊內的 %s 可入列", async (machineId) => {
    const queue = makeQueue();
    const { service } = makeService(queue);
    await expect(service.createDiagnosis({ machineId, socketId: SOCKET_A })).resolves.toMatchObject({
      machineId,
      status: "waiting",
    });
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it("socketId 不在線或未授權 → 409（body 形狀同 400／404）：不綁定、不查佇列、不入列", async () => {
    const queue = makeQueue();
    const { service, bindings } = makeService(queue, makePresence([]));
    const err = await service
      .createDiagnosis({ jobId: JOB_ID, machineId: "mixer-01", socketId: SOCKET_A })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getStatus()).toBe(409);
    expect((err as ConflictException).getResponse()).toEqual({
      statusCode: 409,
      error: "Conflict",
      message: "WebSocket 連線不存在或未授權，請重新連線後再發起診斷",
    });
    // 文字由匯出常數提供（GET /diagnoses/:jobId 共用），內容不變。
    expect(SOCKET_UNAVAILABLE_MESSAGE).toBe("WebSocket 連線不存在或未授權，請重新連線後再發起診斷");
    expect(bindings.map.size).toBe(0);
    expect(queue.getJob).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it("冪等重送也檢查：原連線已斷線後以同 jobId 重送 → 409，原綁定不動", async () => {
    const queue = makeQueue();
    const { service, bindings, presence } = makeService(queue);
    await service.createDiagnosis({ jobId: JOB_ID, machineId: "mixer-01", socketId: SOCKET_A });
    presence.set.delete(SOCKET_A);
    await expect(
      service.createDiagnosis({ jobId: JOB_ID, machineId: "mixer-01", socketId: SOCKET_A }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(bindings.map.get(JOB_ID)?.clientId).toBe(SOCKET_A);
  });

  it("409（未授權）warn 以 30 秒全域節流：窗內只記一則，窗後一則附 suppressed", async () => {
    vi.useFakeTimers();
    const { service } = makeService(makeQueue(), makePresence([]));
    const warn = vi.spyOn((service as unknown as { plog: { warn: (...args: unknown[]) => void } }).plog, "warn");
    const reject = () =>
      service.createDiagnosis({ machineId: "mixer-01", socketId: SOCKET_A }).catch((e: unknown) => e);

    for (let i = 0; i < 5; i += 1) expect(await reject()).toBeInstanceOf(ConflictException);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).not.toHaveProperty("suppressed");

    vi.advanceTimersByTime(30_000);
    await reject();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[1]?.[0]).toMatchObject({ suppressed: 4 });
  });

  it("名冊檢查先於在線檢查：未知機台 + 未授權連線 → 仍是 404", async () => {
    const { service } = makeService(makeQueue(), makePresence([]));
    await expect(
      service.createDiagnosis({ jobId: JOB_ID, machineId: "cnc-99", socketId: SOCKET_A }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
