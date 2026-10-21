import "reflect-metadata";
import type { AddressInfo } from "node:net";
import { Writable } from "node:stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Controller, Get, HttpException, Module } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { Queue } from "bullmq";
import { createLogger } from "@flow-gatekeeper/shared/logging";
import type { DiagnosisJobPayload } from "@flow-gatekeeper/contracts";
import { JobsController } from "../modules/jobs/jobs.controller.js";
import { JobsService } from "../modules/jobs/jobs.service.js";
import { DiagnosisLookupService } from "../modules/jobs/diagnosis-lookup.service.js";
import { JobRoutingRegistry } from "../modules/websocket/job-routing-registry.js";
import { RequestBodyError, createHttpApp, normalizeBodyParserError } from "./http-exception.filter.js";

/**
 * API-7／API-17：以真 Nest app（platform-express、真 body-parser）經 HTTP 驗證全域 filter 與 body 上限，
 * 並以真 JobsService（假 queue／綁定／在線查詢）確認 JobsController 既有回應形狀與文字不變。GET `/diagnoses/:jobId`
 * 以真 DiagnosisLookupService（假 queue／reader、真 registry）驗證 express 的 query 解析與錯誤 body 經 filter 原樣送出。
 */

const SECRET = "SECRET";
const SOCKET_ID = "5b1f9c1e-8a53-4c43-9f0e-2d1c3b4a5e6f";
const OFFLINE_SOCKET = "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a";
const JOB_ID = "0e6c2b7a-1f3d-4d8e-a9b0-c1d2e3f4a5b6";

@Controller("test")
class ProbeController {
  @Get("boom")
  boom(): never {
    throw Object.assign(new Error("kaboom"), { body: `{"password":"${SECRET}"}` });
  }

  @Get("http-error-422")
  httpError422(): never {
    // 非 HttpException 的 http-errors 形狀（例如第三方套件以 http-errors 拋出）
    throw Object.assign(new Error(`bad input ${SECRET}`), { status: 422, statusCode: 422, expose: true });
  }

  @Get("http-error-503")
  httpError503(): never {
    throw Object.assign(new Error("upstream down"), { statusCode: 503 });
  }

  @Get("body-parser-500")
  bodyParser500(): never {
    // 模擬原樣傳下來的 5xx body-parser 錯誤（middleware 不再換掉它）
    throw Object.assign(new Error("stream encoding should not be set"), {
      status: 500,
      statusCode: 500,
      type: "stream.encoding.set",
      body: `{"password":"${SECRET}"}`,
    });
  }

  @Get("http-exception-500")
  httpException500(): never {
    throw new HttpException("boom 500", 500);
  }
}

const logChunks: string[] = [];
let clock = 0;
let baseUrl = "";
let app: NestExpressApplication;

function logLines(): Record<string, unknown>[] {
  return logChunks.map((l) => JSON.parse(l) as Record<string, unknown>);
}

beforeAll(async () => {
  const queue = {
    getJob: vi.fn(async () => undefined),
    getJobState: vi.fn(async () => "unknown"),
    add: vi.fn(async () => ({})),
  } as unknown as Queue<DiagnosisJobPayload>;
  const bindings = { bind: vi.fn(), get: () => undefined, deleteIfCurrent: vi.fn() };
  const presence = { isAuthorized: (id: string) => id === SOCKET_ID, isOnline: (id: string) => id === SOCKET_ID };
  const lookup = new DiagnosisLookupService(queue, new JobRoutingRegistry(), presence, {
    findDiagnosisResult: async () => null,
  });

  @Module({
    controllers: [JobsController, ProbeController],
    providers: [
      { provide: JobsService, useValue: new JobsService(queue, bindings, presence) },
      { provide: DiagnosisLookupService, useValue: lookup },
    ],
  })
  class TestModule {}

  const stream = new Writable({
    write(chunk: Buffer | string, _enc, cb) {
      logChunks.push(chunk.toString());
      cb();
    },
  });
  const logger = createLogger("api", { LOG_LEVEL: "info", LOG_PRETTY: "false" }, stream).child({
    context: "HttpExceptionFilter",
  });

  app = await createHttpApp(TestModule, { logger: false }, { logger, now: () => clock });
  await app.listen(0, "127.0.0.1");
  const { port } = (app.getHttpServer() as { address(): AddressInfo }).address();
  baseUrl = `http://127.0.0.1:${port}`;
}, 30_000);

afterAll(async () => {
  await app?.close();
});

beforeEach(() => {
  logChunks.length = 0;
  // 每支測試推進 1 小時：節流窗（30 s）不跨測試互相壓掉。
  clock += 3_600_000;
});

function postJson(body: string, contentType = "application/json"): Promise<Response> {
  return fetch(`${baseUrl}/diagnoses`, { method: "POST", headers: { "content-type": contentType }, body });
}

describe("全域 HttpExceptionFilter：body-parser 錯誤", () => {
  it("壞 JSON → 400 固定英文訊息，不回顯輸入；warn 一則、不帶本文、無 error 等級", async () => {
    const res = await postJson(`{"password":"${SECRET}"`);
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ statusCode: 400, message: "Invalid JSON body" });
    expect(text).not.toContain(SECRET);

    expect(logChunks.join("")).not.toContain(SECRET);
    const lines = logLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 40,
      msg: "http request rejected",
      statusCode: 400,
      method: "POST",
      path: "/diagnoses",
      errorType: "entity.parse.failed",
    });
    expect(lines[0]).not.toHaveProperty("err");
  });

  it("超過 16 kb → 413 Payload too large；16 kb 以內照常交給 controller", async () => {
    const big = JSON.stringify({ machineId: "mixer-01", socketId: SOCKET_ID, pad: "x".repeat(17 * 1024) });
    const res = await postJson(big);
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ statusCode: 413, message: "Payload too large" });
    expect(logLines()[0]).toMatchObject({ level: 40, statusCode: 413, errorType: "entity.too.large" });

    const fits = JSON.stringify({ machineId: "mixer-01", socketId: SOCKET_ID, pad: "x".repeat(15 * 1024) });
    const ok = await postJson(fits);
    // 通過 body parser 與 controller（契約外的多餘欄位由 Zod 預設剝除）→ 201
    expect(ok.status).toBe(201);
  });

  it("4xx warn 節流：同狀態碼在窗內只記一則，之後放行時附 suppressed", async () => {
    await postJson("{bad");
    await postJson("{bad");
    await postJson("{bad");
    expect(logLines()).toHaveLength(1);
    clock += 30_000;
    await postJson("{bad");
    const lines = logLines();
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatchObject({ suppressed: 2 });
  });

  it("節流 key 含 body-parser 的 type：壞 JSON 與 urlencoded 深度超限兩種 400 各自放行", async () => {
    const deep = `a${"[b]".repeat(40)}=1`;
    const tooDeep = await postJson(deep, "application/x-www-form-urlencoded");
    expect(tooDeep.status).toBe(400);
    expect(await tooDeep.json()).toEqual({ statusCode: 400, message: "Bad Request" });
    await postJson("{bad");
    await postJson("{bad");
    const lines = logLines();
    expect(lines.map((l) => l.errorType)).toEqual(["querystring.parse.rangeError", "entity.parse.failed"]);
  });

  it("回應不帶 X-Powered-By", async () => {
    const res = await postJson("{bad");
    expect(res.headers.get("x-powered-by")).toBeNull();
  });
});

describe("createHttpApp：建立 app 與 HTTP 設定成對套用", () => {
  // 守住「關掉 Nest 的 body parser」與「自行掛 parser＋filter」不被拆開：只做前者就完全沒有 body parser。
  it("合法 JSON 經 body parser 解析後交給 controller（201），且回應不帶 X-Powered-By", async () => {
    const res = await postJson(JSON.stringify({ machineId: "mixer-01", socketId: SOCKET_ID }));
    expect(res.status).toBe(201);
    expect(res.headers.get("x-powered-by")).toBeNull();
    expect(await res.json()).toMatchObject({ machineId: "mixer-01", status: "waiting" });
  });
});

describe("全域 HttpExceptionFilter：既有 HttpException 回應不變", () => {
  it("415 非 JSON", async () => {
    const res = await postJson("machineId=mixer-01", "application/x-www-form-urlencoded");
    expect(res.status).toBe(415);
    expect(await res.json()).toEqual({
      statusCode: 415,
      error: "Unsupported Media Type",
      message: "Content-Type 必須為 application/json",
    });
    // HttpException 照 Nest 原本行為：filter 不另記 log
    expect(logLines()).toEqual([]);
  });

  it("400 不符契約（只回 issue 路徑與代碼）", async () => {
    const res = await postJson(JSON.stringify({ machineId: "BAD ID", socketId: SOCKET_ID }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      statusCode: 400,
      error: "Bad Request",
      message: "request body 不符合 POST /diagnoses 契約",
      issues: [{ path: "machineId", code: "invalid_format" }],
    });
  });

  it("404 不在名冊、409 socket 未授權：body 與 JobsService 拋出的一致", async () => {
    const notFound = await postJson(JSON.stringify({ machineId: "ghost-01", socketId: SOCKET_ID }));
    expect(notFound.status).toBe(404);
    expect(await notFound.json()).toEqual({ statusCode: 404, error: "Not Found", message: "此機台不在名冊中" });

    const conflict = await postJson(JSON.stringify({ machineId: "mixer-01", socketId: OFFLINE_SOCKET }));
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({
      statusCode: 409,
      error: "Conflict",
      message: "WebSocket 連線不存在或未授權，請重新連線後再發起診斷",
    });
    // 409／404 的 warn 由 JobsService 自己記（已節流）；filter 不再重複記一則
    expect(logLines()).toEqual([]);
  });

  it("GET /diagnoses/:jobId：重複的 query key 被解析成陣列 → 400，issues 只帶 path／code", async () => {
    const res = await fetch(`${baseUrl}/diagnoses/${JOB_ID}?socketId=${SOCKET_ID}&socketId=${OFFLINE_SOCKET}`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      statusCode: 400,
      error: "Bad Request",
      message: "request 不符合 GET /diagnoses/:jobId 契約",
      issues: [{ path: "socketId", code: "invalid_type" }],
    });
  });

  it("GET /diagnoses/:jobId：409 body 帶 code、message 與 POST 同句；查無 → 404", async () => {
    const conflict = await fetch(`${baseUrl}/diagnoses/${JOB_ID}?socketId=${OFFLINE_SOCKET}`);
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({
      statusCode: 409,
      error: "Conflict",
      code: "socket_unauthorized",
      message: "WebSocket 連線不存在或未授權，請重新連線後再發起診斷",
    });

    const notFound = await fetch(`${baseUrl}/diagnoses/${JOB_ID}?socketId=${SOCKET_ID}`);
    expect(notFound.status).toBe(404);
    expect(await notFound.json()).toEqual({ statusCode: 404, error: "Not Found", message: "查無此診斷（可能已過期）" });
    expect(logLines()).toEqual([]);
  });

  it("201 成功路徑不受影響", async () => {
    const res = await postJson(JSON.stringify({ machineId: "mixer-01", socketId: SOCKET_ID }));
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ machineId: "mixer-01", status: "waiting" });
    expect(logLines().filter((l) => l.context === "HttpExceptionFilter")).toEqual([]);
  });

  it("HttpException >=500：回應照 Nest 預設，filter 不另記", async () => {
    const res = await fetch(`${baseUrl}/test/http-exception-500`);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ statusCode: 500, message: "boom 500" });
    expect(logLines()).toEqual([]);
  });
});

describe("全域 HttpExceptionFilter：其他錯誤", () => {
  it("未預期例外 → 500 固定訊息；記 error（帶 message／stack），err.body 不進日誌", async () => {
    const res = await fetch(`${baseUrl}/test/boom`);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ statusCode: 500, message: "Internal server error" });
    expect(logChunks.join("")).not.toContain(SECRET);
    const [line] = logLines();
    expect(line).toMatchObject({
      level: 50,
      msg: "unhandled request error",
      statusCode: 500,
      method: "GET",
      path: "/test/boom",
      err: { type: "Error", message: "kaboom" },
    });
  });

  it("非 HttpException 的 4xx http-errors → 原狀態碼、固定英文 reason phrase、warn 不帶原訊息", async () => {
    const res = await fetch(`${baseUrl}/test/http-error-422`);
    expect(res.status).toBe(422);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ statusCode: 422, message: "Unprocessable Entity" });
    expect(text).not.toContain(SECRET);
    expect(logChunks.join("")).not.toContain(SECRET);
    expect(logLines()[0]).toMatchObject({ level: 40, statusCode: 422 });
  });

  it("5xx body-parser 錯誤 → 500 固定訊息；error 日誌保留原 message 與 stack，body 不進日誌", async () => {
    const res = await fetch(`${baseUrl}/test/body-parser-500`);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ statusCode: 500, message: "Internal server error" });
    expect(logChunks.join("")).not.toContain(SECRET);
    const [line] = logLines();
    expect(line).toMatchObject({ level: 50, err: { message: "stream encoding should not be set" } });
    expect((line?.err as { stack: string }).stack).toContain("stream encoding should not be set");
    expect(line?.err).not.toHaveProperty("body");
  });

  it("非 HttpException 的 5xx http-errors → 原狀態碼、固定 reason phrase、記 error", async () => {
    const res = await fetch(`${baseUrl}/test/http-error-503`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ statusCode: 503, message: "Service Unavailable" });
    expect(logLines()[0]).toMatchObject({ level: 50, statusCode: 503 });
  });
});

describe("normalizeBodyParserError（express error middleware）", () => {
  function run(err: unknown): unknown {
    let passed: unknown = "not-called";
    normalizeBodyParserError(err, {}, {}, (e) => {
      passed = e;
    });
    return passed;
  }

  it("4xx body-parser 錯誤換成 RequestBodyError（固定訊息、不帶 body）", () => {
    const err = Object.assign(new SyntaxError(`Unexpected token in "${SECRET}"`), {
      status: 400,
      statusCode: 400,
      type: "entity.parse.failed",
      body: SECRET,
    });
    const out = run(err);
    expect(out).toBeInstanceOf(RequestBodyError);
    expect(out).toMatchObject({ status: 400, statusCode: 400, type: "entity.parse.failed", message: "Invalid JSON body" });
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });

  it("5xx body-parser 錯誤（stream.not.readable 等）原樣往下傳，保留原 message 與 stack", () => {
    const err = Object.assign(new Error("stream is not readable"), {
      status: 500,
      statusCode: 500,
      type: "stream.not.readable",
    });
    expect(run(err)).toBe(err);
  });

  it("非 body-parser 錯誤原樣往下傳", () => {
    const err = new Error("other");
    expect(run(err)).toBe(err);
  });
});
