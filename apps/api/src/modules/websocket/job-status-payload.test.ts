import { describe, expect, it } from "vitest";
import { JobStatusSchema } from "@flow-gatekeeper/contracts";
import { completedStatus, progressStatus } from "./job-status-payload.js";

const JOB_ID = "0e6c2b7a-1f3d-4d8e-a9b0-c1d2e3f4a5b6";
const RESULT = {
  summary: "主軸溫度偏高",
  severity: "warning",
  likelyCauses: ["冷卻液不足"],
  suggestedActions: [{ label: "補充冷卻液", priority: "high" }],
  evidence: [{ source: "telemetry", excerpt: "temp=92" }],
} as const;
const base = { type: "job/status", jobId: JOB_ID, machineId: "cnc-01", status: "completed" } as const;

describe("completedStatus", () => {
  it("returnvalue 合法 → 帶 result、cached 與綁定上已知的 attempt／execution，且通過 JobStatusSchema", () => {
    const { status, issues } = completedStatus({
      jobId: JOB_ID,
      machineId: "cnc-01",
      returnvalue: { result: RESULT, cached: false },
      binding: { attempt: 2, execution: 3 },
    });
    expect(issues).toBeUndefined();
    expect(status).toEqual({ ...base, result: RESULT, cached: false, attempt: 2, execution: 3 });
    expect(JobStatusSchema.safeParse(status).success).toBe(true);
  });

  it.each([true, false])("帶 result 必帶 cached（P8）：cached=%s 原樣帶上", (cached) => {
    const { status } = completedStatus({ jobId: JOB_ID, machineId: "cnc-01", returnvalue: { result: RESULT, cached } });
    expect(status.result).toBeDefined();
    expect(status.cached).toBe(cached);
  });

  it("綁定上沒有 attempt／execution（或沒傳 binding）→ 不帶這兩欄（P7）", () => {
    for (const binding of [undefined, {}, { attempt: 1 }]) {
      const { status } = completedStatus({
        jobId: JOB_ID,
        machineId: "cnc-01",
        returnvalue: { result: RESULT, cached: true },
        binding,
      });
      expect(status).not.toHaveProperty("execution");
      if (binding?.attempt === undefined) expect(status).not.toHaveProperty("attempt");
      else expect(status.attempt).toBe(1);
    }
  });

  it("只轉發驗證後的資料：result 內夾帶的未知欄位被剝除，不是原物件", () => {
    const tainted = { result: { ...RESULT, injected: "<script>" }, cached: false, extra: 1 };
    const { status } = completedStatus({ jobId: JOB_ID, machineId: "cnc-01", returnvalue: tainted });
    expect(status.result).not.toBe(tainted.result);
    expect(status.result).not.toHaveProperty("injected");
    expect(status).not.toHaveProperty("extra");
  });

  it.each([
    ["不合法（缺 cached）", { result: RESULT }],
    ["不合法（result 形狀錯）", { result: { summary: 1 }, cached: false }],
    ["null（舊版 worker）", null],
    ["undefined（缺值）", undefined],
    ["字串", "done"],
  ])("%s → 不帶 result／cached／attempt／execution，回 issues（只路徑與代碼）", (_label, returnvalue) => {
    const { status, issues } = completedStatus({
      jobId: JOB_ID,
      machineId: "cnc-01",
      returnvalue,
      binding: { attempt: 2, execution: 2 },
    });
    expect(status).toEqual(base);
    expect(JobStatusSchema.safeParse(status).success).toBe(true);
    expect(issues?.length).toBeGreaterThan(0);
    for (const issue of issues ?? []) {
      expect(Object.keys(issue).sort()).toEqual(["code", "path"]);
      expect(typeof issue.path).toBe("string");
      expect(typeof issue.code).toBe("string");
    }
  });

  it("issues 路徑以點號串接、根層為 (root)，且最多 5 則", () => {
    const nested = completedStatus({
      jobId: JOB_ID,
      machineId: "cnc-01",
      returnvalue: { result: { ...RESULT, suggestedActions: [{ label: "x", priority: "urgent" }] }, cached: false },
    });
    expect(nested.issues).toEqual([{ path: "result.suggestedActions.0.priority", code: "invalid_value" }]);

    const root = completedStatus({ jobId: JOB_ID, machineId: "cnc-01", returnvalue: null });
    expect(root.issues).toEqual([{ path: "(root)", code: "invalid_type" }]);

    const many = completedStatus({ jobId: JOB_ID, machineId: "cnc-01", returnvalue: { result: {}, cached: "no" } });
    expect(many.issues).toHaveLength(5);
  });
});

describe("progressStatus", () => {
  it("DiagnosisJobProgress 物件 → progress＝value，並帶 attempt／execution", () => {
    expect(progressStatus({ value: 40, attempt: 1, execution: 2 })).toEqual({ progress: 40, attempt: 1, execution: 2 });
  });

  it.each([0, 42, 100, 12.5])("舊 worker 的數字 %s → 只帶 progress", (data) => {
    expect(progressStatus(data)).toEqual({ progress: data });
  });

  it.each([-1, 101, Number.NaN, Number.POSITIVE_INFINITY])("數字超出 0～100 或非有限（%s）→ 省略 progress", (data) => {
    expect(progressStatus(data)).toEqual({});
  });

  it.each([
    ["不完整的物件", { value: 40 }],
    ["value 超出範圍", { value: 150, attempt: 1, execution: 1 }],
    ["attempt 為 0", { value: 40, attempt: 0, execution: 1 }],
    ["舊格式物件", { phase: "llm" }],
    ["null", null],
    ["字串", "40"],
  ])("%s → {}", (_label, data) => {
    expect(progressStatus(data)).toEqual({});
  });
});
