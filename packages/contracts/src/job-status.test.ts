import { describe, expect, it } from "vitest";
import { JobStatusSchema } from "./job-status.js";

const base = {
  type: "job/status",
  jobId: "5f8d7c2a-1b3e-4c6d-8e9f-0a1b2c3d4e5f",
  machineId: "press-01",
} as const;

const result = {
  summary: "壓力機溫度持續升高，疑似冷卻不足。",
  severity: "warning",
  likelyCauses: ["冷卻液流量下降"],
  suggestedActions: [{ label: "檢查冷卻液管路", priority: "high" }],
  evidence: [{ source: "telemetry", excerpt: "temperature 78→91°C / 10min" }],
};

describe("JobStatusSchema（1.4.0 新增 attempt／execution／reason／cached）", () => {
  it("舊形狀（無新欄位）照常通過", () => {
    expect(JobStatusSchema.safeParse({ ...base, status: "waiting" }).success).toBe(true);
    expect(JobStatusSchema.safeParse({ ...base, status: "active", progress: 40 }).success).toBe(true);
    expect(JobStatusSchema.safeParse({ ...base, status: "completed", result }).success).toBe(true);
    expect(JobStatusSchema.safeParse({ ...base, status: "failed", error: "boom" }).success).toBe(true);
  });

  it("帶齊四個新欄位可過", () => {
    const parsed = JobStatusSchema.parse({
      ...base,
      status: "completed",
      result,
      cached: true,
      attempt: 2,
      execution: 3,
    });
    expect(parsed.cached).toBe(true);
    expect(parsed.attempt).toBe(2);
    expect(parsed.execution).toBe(3);
    expect(
      JobStatusSchema.safeParse({ ...base, status: "active", progress: 60, attempt: 1, execution: 2 }).success,
    ).toBe(true);
  });

  it("reason 是開放字串：已知值 stalled 與未知值都可過", () => {
    expect(JobStatusSchema.safeParse({ ...base, status: "waiting", reason: "stalled" }).success).toBe(true);
    expect(JobStatusSchema.safeParse({ ...base, status: "waiting", reason: "anything" }).success).toBe(true);
  });

  it("帶 result 卻缺 cached 仍可過（不以 refine 綁定）", () => {
    expect(JobStatusSchema.safeParse({ ...base, status: "completed", result, attempt: 1 }).success).toBe(true);
  });

  it("未知欄位接受後丟棄（strip）：日後新增欄位不會讓舊 web 丟掉整則", () => {
    const parsed = JobStatusSchema.parse({ ...base, status: "waiting", futureField: 1 });
    expect(parsed).not.toHaveProperty("futureField");
  });

  it.each([
    ["attempt 為 0", { ...base, status: "active", attempt: 0 }],
    ["execution 為 0", { ...base, status: "active", execution: 0 }],
    ["attempt 非整數", { ...base, status: "active", attempt: 1.5 }],
    ["reason 非字串", { ...base, status: "waiting", reason: 1 }],
    ["cached 非布林", { ...base, status: "completed", result, cached: "true" }],
    ["status 非法", { ...base, status: "stalled" }],
  ])("拒絕：%s", (_label, value) => {
    expect(JobStatusSchema.safeParse(value).success).toBe(false);
  });
});
