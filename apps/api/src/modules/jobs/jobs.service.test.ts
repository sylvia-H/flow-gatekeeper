import { afterEach, describe, expect, it, vi } from "vitest";
import { ConflictException, ServiceUnavailableException } from "@nestjs/common";
import type { Queue } from "bullmq";
import type { DiagnosisJobPayload } from "@flow-gatekeeper/contracts";
import { ENQUEUE_TIMEOUT_MS, JobsService } from "./jobs.service.js";
import type { JobBindingStore } from "./jobs.service.js";
import type { JobBinding } from "../websocket/ai-stream-relay.service.js";

const SOCKET_A = "5b1f9c1e-8a53-4c43-9f0e-2d1c3b4a5e6f";
const SOCKET_B = "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a";
const JOB_ID = "0e6c2b7a-1f3d-4d8e-a9b0-c1d2e3f4a5b6";

type FakeBindings = JobBindingStore & { map: Map<string, JobBinding> };

function makeBindings(): FakeBindings {
  const map = new Map<string, JobBinding>();
  return {
    map,
    bindJobToClient: (jobId, clientId, machineId) => {
      map.set(jobId, { clientId, machineId, boundAt: Date.now() });
    },
    getBinding: (jobId) => map.get(jobId),
    deleteBinding: (jobId) => {
      map.delete(jobId);
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

function makeService(queue: ReturnType<typeof makeQueue>) {
  const bindings = makeBindings();
  const service = new JobsService(queue as unknown as Queue<DiagnosisJobPayload>, bindings);
  return { service, bindings };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("JobsService.createDiagnosis", () => {
  it("帶入 jobId → 以它入列並綁定，payload 不含 promptVersion", async () => {
    const queue = makeQueue();
    const { service, bindings } = makeService(queue);
    const res = await service.createDiagnosis({ jobId: JOB_ID, machineId: "cnc-01", socketId: SOCKET_A });

    expect(res).toEqual({ jobId: JOB_ID, machineId: "cnc-01", status: "waiting" });
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
    const res = await service.createDiagnosis({ machineId: "cnc-01", socketId: SOCKET_A });
    expect(res.jobId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("同 jobId 重送（綁定仍在）→ 回同一回應、不重複入列、不改綁新 socketId", async () => {
    const queue = makeQueue();
    const { service, bindings } = makeService(queue);
    await service.createDiagnosis({ jobId: JOB_ID, machineId: "cnc-01", socketId: SOCKET_A });
    const again = await service.createDiagnosis({ jobId: JOB_ID, machineId: "cnc-01", socketId: SOCKET_B });

    expect(again).toEqual({ jobId: JOB_ID, machineId: "cnc-01", status: "waiting" });
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(bindings.map.get(JOB_ID)?.clientId).toBe(SOCKET_A);
  });

  it("併發重送（第一個尚未入列完成）也只入列一次", async () => {
    const queue = makeQueue();
    const { service } = makeService(queue);
    const body = { jobId: JOB_ID, machineId: "cnc-01", socketId: SOCKET_A };
    await Promise.all([service.createDiagnosis(body), service.createDiagnosis(body)]);
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it("同 jobId 但不同 machineId → 409", async () => {
    const { service } = makeService(makeQueue());
    await service.createDiagnosis({ jobId: JOB_ID, machineId: "cnc-01", socketId: SOCKET_A });
    await expect(
      service.createDiagnosis({ jobId: JOB_ID, machineId: "cnc-02", socketId: SOCKET_A }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("綁定已清除但 job 仍在 Redis（已結束）→ 409，不入列、不殘留綁定", async () => {
    const queue = makeQueue({ getJob: async () => ({ id: JOB_ID }) });
    const { service, bindings } = makeService(queue);
    await expect(
      service.createDiagnosis({ jobId: JOB_ID, machineId: "cnc-01", socketId: SOCKET_A }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(queue.add).not.toHaveBeenCalled();
    expect(bindings.map.has(JOB_ID)).toBe(false);
  });

  it("Redis 不可用（add reject）→ 503 並解除綁定", async () => {
    const queue = makeQueue({
      add: async () => {
        throw new Error("Stream isn't writeable and enableOfflineQueue options is false");
      },
    });
    const { service, bindings } = makeService(queue);
    await expect(
      service.createDiagnosis({ jobId: JOB_ID, machineId: "cnc-01", socketId: SOCKET_A }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(bindings.map.has(JOB_ID)).toBe(false);
  });

  it("入列逾時 → 503 並解除綁定", async () => {
    vi.useFakeTimers();
    const queue = makeQueue({ add: () => new Promise(() => undefined) });
    const { service, bindings } = makeService(queue);
    const pending = service.createDiagnosis({ jobId: JOB_ID, machineId: "cnc-01", socketId: SOCKET_A });
    const assertion = expect(pending).rejects.toBeInstanceOf(ServiceUnavailableException);
    await vi.advanceTimersByTimeAsync(ENQUEUE_TIMEOUT_MS);
    await assertion;
    expect(bindings.map.has(JOB_ID)).toBe(false);
  });
});
