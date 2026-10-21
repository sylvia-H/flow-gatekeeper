import { describe, expect, it } from "vitest";
import {
  CreateDiagnosisBodySchema,
  CreateDiagnosisResponseSchema,
  DiagnosisLookupParamsSchema,
  DiagnosisLookupQuerySchema,
  DiagnosisLookupResponseSchema,
} from "./http.js";

const socketId = "0b7f5a3e-6f0e-4a8e-9a57-6d1c1b0a2f11";

describe("CreateDiagnosisBodySchema", () => {
  it("接受最小合法 body，jobId／requestedBy 可省略", () => {
    expect(CreateDiagnosisBodySchema.safeParse({ machineId: "press-01", socketId }).success).toBe(
      true,
    );
    expect(
      CreateDiagnosisBodySchema.safeParse({
        jobId: "5f8d7c2a-1b3e-4c6d-8e9f-0a1b2c3d4e5f",
        machineId: "press-01",
        socketId,
        requestedBy: "demo-user",
      }).success,
    ).toBe(true);
  });

  it.each([
    ["machineId 為運算子物件", { machineId: { $ne: "x" }, socketId }],
    ["machineId 含大寫與空白", { machineId: "Press 01", socketId }],
    ["machineId 超過 32 字", { machineId: "a".repeat(33), socketId }],
    ["socketId 非 uuid", { machineId: "press-01", socketId: "abc" }],
    ["jobId 非 uuid", { jobId: "job-1", machineId: "press-01", socketId }],
    ["requestedBy 超過 64 字", { machineId: "press-01", socketId, requestedBy: "x".repeat(65) }],
    ["requestedBy 為空字串", { machineId: "press-01", socketId, requestedBy: "" }],
  ])("拒絕：%s", (_label, value) => {
    expect(CreateDiagnosisBodySchema.safeParse(value).success).toBe(false);
  });
});

describe("CreateDiagnosisResponseSchema", () => {
  it("只接受 waiting 初始狀態", () => {
    const base = { jobId: "5f8d7c2a-1b3e-4c6d-8e9f-0a1b2c3d4e5f", machineId: "press-01" };
    expect(CreateDiagnosisResponseSchema.safeParse({ ...base, status: "waiting" }).success).toBe(
      true,
    );
    expect(CreateDiagnosisResponseSchema.safeParse({ ...base, status: "active" }).success).toBe(
      false,
    );
  });
});

const jobId = "5f8d7c2a-1b3e-4c6d-8e9f-0a1b2c3d4e5f";
const previousSocketId = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

const result = {
  summary: "壓力機溫度持續升高，疑似冷卻不足。",
  severity: "warning",
  likelyCauses: ["冷卻液流量下降"],
  suggestedActions: [{ label: "檢查冷卻液管路", priority: "high" }],
  evidence: [{ source: "telemetry", excerpt: "temperature 78→91°C / 10min" }],
};

describe("DiagnosisLookupParamsSchema", () => {
  it("接受 uuid jobId、拒絕非 uuid", () => {
    expect(DiagnosisLookupParamsSchema.safeParse({ jobId }).success).toBe(true);
    expect(DiagnosisLookupParamsSchema.safeParse({ jobId: "job-1" }).success).toBe(false);
    expect(DiagnosisLookupParamsSchema.safeParse({}).success).toBe(false);
  });
});

describe("DiagnosisLookupQuerySchema", () => {
  it("接受只有 socketId，或另帶 previousSocketId", () => {
    expect(DiagnosisLookupQuerySchema.safeParse({ socketId }).success).toBe(true);
    expect(DiagnosisLookupQuerySchema.safeParse({ socketId, previousSocketId }).success).toBe(true);
  });

  it("未列出的 query key 被忽略（strip）", () => {
    const parsed = DiagnosisLookupQuerySchema.parse({ socketId, extra: "x" });
    expect(parsed).toEqual({ socketId });
  });

  it.each([
    ["缺 socketId", {}],
    ["socketId 非 uuid", { socketId: "abc" }],
    ["previousSocketId 非 uuid", { socketId, previousSocketId: "abc" }],
    ["重複 key 解析成陣列", { socketId: [socketId, previousSocketId] }],
  ])("拒絕：%s", (_label, value) => {
    expect(DiagnosisLookupQuerySchema.safeParse(value).success).toBe(false);
  });
});

describe("DiagnosisLookupResponseSchema", () => {
  it.each([
    ["completed", { status: "completed", jobId, result, cached: false }],
    ["failed", { status: "failed", jobId, error: "persist_failed: diagnosis record could not be written" }],
    ["waiting（最小）", { status: "waiting", jobId, rebound: true }],
    ["active（帶進度）", { status: "active", jobId, progress: 60, attempt: 1, execution: 2, rebound: true }],
  ])("接受四分支合法樣本：%s", (_label, value) => {
    expect(DiagnosisLookupResponseSchema.safeParse(value).success).toBe(true);
  });

  it.each([
    ["rebound: false", { status: "waiting", jobId, rebound: false }],
    ["進行中缺 rebound", { status: "active", jobId }],
    ["completed 缺 jobId", { status: "completed", result, cached: false }],
    ["failed 缺 jobId", { status: "failed", error: "boom" }],
    ["waiting 缺 jobId", { status: "waiting", rebound: true }],
    ["jobId 非 uuid", { status: "waiting", jobId: "job-1", rebound: true }],
    ["completed 缺 cached", { status: "completed", jobId, result }],
    ["completed 的 result 不合 schema", { status: "completed", jobId, result: { ...result, severity: "fatal" }, cached: false }],
    ["failed 缺 error", { status: "failed", jobId }],
    ["progress 超過 100", { status: "active", jobId, progress: 101, rebound: true }],
    ["attempt 為 0", { status: "active", jobId, attempt: 0, rebound: true }],
    ["execution 為 0", { status: "active", jobId, execution: 0, rebound: true }],
    ["未知 status", { status: "delayed", jobId, rebound: true }],
  ])("拒絕：%s", (_label, value) => {
    expect(DiagnosisLookupResponseSchema.safeParse(value).success).toBe(false);
  });
});
