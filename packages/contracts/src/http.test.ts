import { describe, expect, it } from "vitest";
import { CreateDiagnosisBodySchema, CreateDiagnosisResponseSchema } from "./http.js";

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
