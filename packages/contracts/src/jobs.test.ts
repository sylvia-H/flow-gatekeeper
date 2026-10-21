import { describe, expect, it } from "vitest";
import { DiagnosisJobProgressSchema, DiagnosisJobReturnValueSchema } from "./jobs.js";

const result = {
  summary: "壓力機溫度持續升高，疑似冷卻不足。",
  severity: "warning",
  likelyCauses: ["冷卻液流量下降"],
  suggestedActions: [{ label: "檢查冷卻液管路", priority: "high" }],
  evidence: [{ source: "telemetry", excerpt: "temperature 78→91°C / 10min" }],
};

describe("DiagnosisJobReturnValueSchema", () => {
  it("接受 result＋cached（true／false 皆可）", () => {
    expect(DiagnosisJobReturnValueSchema.safeParse({ result, cached: false }).success).toBe(true);
    expect(DiagnosisJobReturnValueSchema.safeParse({ result, cached: true }).success).toBe(true);
  });

  it.each([
    ["缺 cached", { result }],
    ["cached 非布林", { result, cached: "false" }],
    ["缺 result", { cached: false }],
    ["result 不合 DiagnosisResultSchema", { result: { ...result, severity: "fatal" }, cached: false }],
    ["舊 worker 的裸 DiagnosisResult", result],
    ["null", null],
  ])("拒絕：%s", (_label, value) => {
    expect(DiagnosisJobReturnValueSchema.safeParse(value).success).toBe(false);
  });
});

describe("DiagnosisJobProgressSchema", () => {
  it("接受合法進度物件（含邊界 0 與 100）", () => {
    expect(DiagnosisJobProgressSchema.safeParse({ value: 60, attempt: 1, execution: 2 }).success).toBe(true);
    expect(DiagnosisJobProgressSchema.safeParse({ value: 0, attempt: 1, execution: 1 }).success).toBe(true);
    expect(DiagnosisJobProgressSchema.safeParse({ value: 100, attempt: 3, execution: 5 }).success).toBe(true);
  });

  it.each([
    ["value 超過 100", { value: 101, attempt: 1, execution: 1 }],
    ["value 為負", { value: -1, attempt: 1, execution: 1 }],
    ["value 非整數", { value: 12.5, attempt: 1, execution: 1 }],
    ["attempt 為 0", { value: 10, attempt: 0, execution: 1 }],
    ["execution 為 0", { value: 10, attempt: 1, execution: 0 }],
    ["attempt 非整數", { value: 10, attempt: 1.5, execution: 1 }],
    ["缺 execution", { value: 10, attempt: 1 }],
    ["舊 worker 的純數字", 60],
  ])("拒絕：%s", (_label, value) => {
    expect(DiagnosisJobProgressSchema.safeParse(value).success).toBe(false);
  });
});
