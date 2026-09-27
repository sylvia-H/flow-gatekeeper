import { describe, expect, it, vi } from "vitest";
import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
  UnsupportedMediaTypeException,
} from "@nestjs/common";
import type {
  CreateDiagnosisBody,
  CreateDiagnosisResponse,
  DiagnosisJobPayload,
} from "@flow-gatekeeper/contracts";
import type { Queue } from "bullmq";
import { JobsService } from "./jobs.service.js";
import { JobsController } from "./jobs.controller.js";
import type { DiagnosisCreator } from "./jobs.controller.js";

const SOCKET_ID = "5b1f9c1e-8a53-4c43-9f0e-2d1c3b4a5e6f";
const JOB_ID = "0e6c2b7a-1f3d-4d8e-a9b0-c1d2e3f4a5b6";
const JSON_TYPE = "application/json";

async function defaultCreate(body: CreateDiagnosisBody): Promise<CreateDiagnosisResponse> {
  return { jobId: body.jobId ?? JOB_ID, machineId: body.machineId, status: "waiting" };
}

function makeController(impl: DiagnosisCreator["createDiagnosis"] = defaultCreate) {
  const createDiagnosis = vi.fn(impl);
  const controller = new JobsController({ createDiagnosis });
  return { controller, createDiagnosis };
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected promise to reject");
}

describe("JobsController.create", () => {
  it("合法 body → 交給 service 並回傳契約形狀", async () => {
    const { controller, createDiagnosis } = makeController();
    const res = await controller.create("application/json; charset=utf-8", {
      machineId: "cnc-01",
      socketId: SOCKET_ID,
    });
    expect(res).toEqual({ jobId: JOB_ID, machineId: "cnc-01", status: "waiting" });
    expect(createDiagnosis).toHaveBeenCalledWith({ machineId: "cnc-01", socketId: SOCKET_ID });
  });

  it.each([undefined, "application/x-www-form-urlencoded", "text/plain", "multipart/form-data"])(
    "Content-Type=%s → 415，不呼叫 service",
    async (contentType) => {
      const { controller, createDiagnosis } = makeController();
      const err = await captureError(
        controller.create(contentType, { machineId: "cnc-01", socketId: SOCKET_ID }),
      );
      expect(err).toBeInstanceOf(UnsupportedMediaTypeException);
      expect(createDiagnosis).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["缺 socketId", { machineId: "cnc-01" }, "socketId"],
    ["socketId 非 uuid", { machineId: "cnc-01", socketId: "abc" }, "socketId"],
    ["machineId 為運算子物件", { machineId: { $ne: "x" }, socketId: SOCKET_ID }, "machineId"],
    ["machineId 超長", { machineId: "a".repeat(33), socketId: SOCKET_ID }, "machineId"],
    [
      "requestedBy 超過 64 字",
      { machineId: "cnc-01", socketId: SOCKET_ID, requestedBy: "x".repeat(65) },
      "requestedBy",
    ],
    ["jobId 非 uuid", { jobId: "job-1", machineId: "cnc-01", socketId: SOCKET_ID }, "jobId"],
  ])("%s → 400，回 issue 路徑且不回顯原始輸入", async (_label, body, path) => {
    const { controller, createDiagnosis } = makeController();
    const err = await captureError(controller.create(JSON_TYPE, body));
    expect(err).toBeInstanceOf(BadRequestException);
    const response = (err as BadRequestException).getResponse() as { issues: { path: string }[] };
    expect(response.issues.map((i) => i.path)).toContain(path);
    const serialized = JSON.stringify(response);
    expect(serialized).not.toContain("$ne");
    expect(serialized).not.toContain("xxxxxxxx");
    expect(serialized).not.toContain("aaaaaaaa");
    expect(createDiagnosis).not.toHaveBeenCalled();
  });

  it("body 不是物件（null）→ 400", async () => {
    const { controller } = makeController();
    await expect(controller.create(JSON_TYPE, null)).rejects.toBeInstanceOf(BadRequestException);
  });

  it("service 回 503 時原樣上拋", async () => {
    const { controller } = makeController(async () => {
      throw new ServiceUnavailableException();
    });
    await expect(
      controller.create(JSON_TYPE, { machineId: "cnc-01", socketId: SOCKET_ID }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it("service 回 404（machineId 不在名冊）時原樣上拋", async () => {
    const { controller } = makeController(async () => {
      throw new NotFoundException();
    });
    await expect(
      controller.create(JSON_TYPE, { machineId: "cnc-01", socketId: SOCKET_ID }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("接真實 JobsService：格式合法但不在名冊的 machineId → 404，不入列", async () => {
    const add = vi.fn(async () => ({}));
    const queue = { getJob: vi.fn(async () => undefined), add } as unknown as Queue<DiagnosisJobPayload>;
    const bindings = {
      bindJobToClient: vi.fn(),
      getBinding: () => undefined,
      deleteBinding: vi.fn(),
    };
    const controller = new JobsController(new JobsService(queue, bindings));
    const err = await captureError(controller.create(JSON_TYPE, { machineId: "ghost-01", socketId: SOCKET_ID }));
    expect(err).toBeInstanceOf(NotFoundException);
    expect((err as NotFoundException).getStatus()).toBe(404);
    expect(add).not.toHaveBeenCalled();
    expect(bindings.bindJobToClient).not.toHaveBeenCalled();

    await expect(
      controller.create(JSON_TYPE, { machineId: "mixer-01", socketId: SOCKET_ID }),
    ).resolves.toMatchObject({ machineId: "mixer-01", status: "waiting" });
    expect(add).toHaveBeenCalledTimes(1);
  });
});
