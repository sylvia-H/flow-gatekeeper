import { describe, expect, it, vi } from "vitest";
import {
  BadRequestException,
  ConflictException,
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
import type { DiagnosisCreator, DiagnosisLookup } from "./jobs.controller.js";

/** 不該被呼叫的 lookup（POST 測試用）。 */
const noLookup: DiagnosisLookup = { lookup: vi.fn(() => Promise.reject(new Error("lookup not expected"))) };

const SOCKET_ID = "5b1f9c1e-8a53-4c43-9f0e-2d1c3b4a5e6f";
const JOB_ID = "0e6c2b7a-1f3d-4d8e-a9b0-c1d2e3f4a5b6";
const JSON_TYPE = "application/json";

async function defaultCreate(body: CreateDiagnosisBody): Promise<CreateDiagnosisResponse> {
  return { jobId: body.jobId ?? JOB_ID, machineId: body.machineId, status: "waiting" };
}

function makeController(impl: DiagnosisCreator["createDiagnosis"] = defaultCreate) {
  const createDiagnosis = vi.fn(impl);
  const controller = new JobsController({ createDiagnosis }, noLookup);
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
      bind: vi.fn(),
      get: () => undefined,
      delete: vi.fn(),
    };
    const presence = { isAuthorized: () => true };
    const controller = new JobsController(new JobsService(queue, bindings, presence), noLookup);
    const err = await captureError(controller.create(JSON_TYPE, { machineId: "ghost-01", socketId: SOCKET_ID }));
    expect(err).toBeInstanceOf(NotFoundException);
    expect((err as NotFoundException).getStatus()).toBe(404);
    expect(add).not.toHaveBeenCalled();
    expect(bindings.bind).not.toHaveBeenCalled();

    await expect(
      controller.create(JSON_TYPE, { machineId: "mixer-01", socketId: SOCKET_ID }),
    ).resolves.toMatchObject({ machineId: "mixer-01", status: "waiting" });
    expect(add).toHaveBeenCalledTimes(1);
  });

  it("接真實 JobsService：socketId 未在線或未授權 → 409，不綁定、不入列", async () => {
    const add = vi.fn(async () => ({}));
    const queue = { getJob: vi.fn(async () => undefined), add } as unknown as Queue<DiagnosisJobPayload>;
    const bindings = {
      bind: vi.fn(),
      get: () => undefined,
      delete: vi.fn(),
    };
    const authorized = new Set<string>();
    const presence = { isAuthorized: (clientId: string) => authorized.has(clientId) };
    const controller = new JobsController(new JobsService(queue, bindings, presence), noLookup);
    const err = await captureError(controller.create(JSON_TYPE, { machineId: "mixer-01", socketId: SOCKET_ID }));
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getStatus()).toBe(409);
    expect(add).not.toHaveBeenCalled();
    expect(bindings.bind).not.toHaveBeenCalled();

    authorized.add(SOCKET_ID);
    await expect(
      controller.create(JSON_TYPE, { machineId: "mixer-01", socketId: SOCKET_ID }),
    ).resolves.toMatchObject({ machineId: "mixer-01", status: "waiting" });
    expect(bindings.bind).toHaveBeenCalledTimes(1);
  });
});

describe("JobsController.lookup（GET /diagnoses/:jobId）", () => {
  const PREV_SOCKET_ID = "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a";

  function makeLookupController(impl: DiagnosisLookup["lookup"] = async () => ({ status: "waiting", jobId: JOB_ID, rebound: true })) {
    const lookup = vi.fn(impl);
    const controller = new JobsController({ createDiagnosis: vi.fn(defaultCreate) }, { lookup });
    return { controller, lookup };
  }

  it("合法 params／query → 委派 lookup（previousSocketId 可選、未列出的 key 忽略），回傳原樣", async () => {
    const { controller, lookup } = makeLookupController();
    await expect(controller.lookup({ jobId: JOB_ID }, { socketId: SOCKET_ID, extra: "x" })).resolves.toEqual({
      status: "waiting",
      jobId: JOB_ID,
      rebound: true,
    });
    expect(lookup).toHaveBeenLastCalledWith({ jobId: JOB_ID, socketId: SOCKET_ID });
    await controller.lookup({ jobId: JOB_ID }, { socketId: SOCKET_ID, previousSocketId: PREV_SOCKET_ID });
    expect(lookup).toHaveBeenLastCalledWith({ jobId: JOB_ID, socketId: SOCKET_ID, previousSocketId: PREV_SOCKET_ID });
  });

  it.each([
    ["jobId 非 uuid", { jobId: "job-1" }, { socketId: SOCKET_ID }, ["jobId"]],
    ["缺 socketId", { jobId: JOB_ID }, {}, ["socketId"]],
    ["socketId 非 uuid", { jobId: JOB_ID }, { socketId: "<script>alert(1)</script>" }, ["socketId"]],
    ["重複 query key（express 解析成陣列）", { jobId: JOB_ID }, { socketId: [SOCKET_ID, PREV_SOCKET_ID] }, ["socketId"]],
    ["previousSocketId 非 uuid", { jobId: JOB_ID }, { socketId: SOCKET_ID, previousSocketId: "abc" }, ["previousSocketId"]],
    ["params 與 query 同時不合法", { jobId: "x" }, { socketId: "y" }, ["jobId", "socketId"]],
  ])("%s → 400（issues 只帶 path／code、不回顯輸入），不呼叫 lookup", async (_label, params, query, paths) => {
    const { controller, lookup } = makeLookupController();
    const err = await captureError(controller.lookup(params, query));
    expect(err).toBeInstanceOf(BadRequestException);
    const response = (err as BadRequestException).getResponse() as {
      statusCode: number;
      message: string;
      issues: { path: string; code: string }[];
    };
    expect(response.statusCode).toBe(400);
    expect(response.message).toBe("request 不符合 GET /diagnoses/:jobId 契約");
    expect(response.issues.map((i) => i.path)).toEqual(paths);
    for (const issue of response.issues) expect(Object.keys(issue).sort()).toEqual(["code", "path"]);
    expect(JSON.stringify(response)).not.toContain("script");
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each([
    ["404", new NotFoundException("查無此診斷（可能已過期）")],
    ["409 socket_unauthorized", new ConflictException({ statusCode: 409, error: "Conflict", code: "socket_unauthorized", message: "m" })],
    ["503", new ServiceUnavailableException("診斷狀態暫時無法查詢，請稍後再試")],
  ])("service 拋 %s → 原樣上拋（body 不改寫）", async (_label, error) => {
    const { controller } = makeLookupController(async () => {
      throw error;
    });
    await expect(controller.lookup({ jobId: JOB_ID }, { socketId: SOCKET_ID })).rejects.toBe(error);
  });
});
