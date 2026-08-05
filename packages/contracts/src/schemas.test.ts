import { describe, expect, it } from "vitest";
import { DiagnosisResultSchema } from "./schemas.js";

/**
 * FR-014 / FR-007：契約結構驗證的實際（非 no-op）測試。
 * 確認 DiagnosisResultSchema 對合法資料通過、對結構錯誤資料丟 ZodError。
 */
describe("DiagnosisResultSchema", () => {
  const valid = {
    summary: "壓力機溫度持續升高，疑似冷卻不足。",
    severity: "warning",
    likelyCauses: ["冷卻液流量下降", "環境溫度偏高"],
    suggestedActions: [
      { label: "檢查冷卻液管路", priority: "high" },
      { label: "降載運轉", priority: "medium", command: "machine.derate(press-02)" },
    ],
    evidence: [
      { source: "telemetry", id: "t-1024", excerpt: "temperature 78→91°C / 10min" },
      { source: "errorlog", excerpt: "COOLANT_LOW x3" },
    ],
  };

  it("接受合法的診斷結果", () => {
    const parsed = DiagnosisResultSchema.parse(valid);
    expect(parsed.severity).toBe("warning");
    expect(parsed.suggestedActions).toHaveLength(2);
  });

  it("缺必填欄位時丟錯", () => {
    const { summary: _omit, ...missing } = valid;
    expect(() => DiagnosisResultSchema.parse(missing)).toThrow();
  });

  it("severity 為非法列舉值時丟錯", () => {
    expect(() =>
      DiagnosisResultSchema.parse({ ...valid, severity: "fatal" }),
    ).toThrow();
  });

  it("巢狀 suggestedActions 結構錯誤時丟錯", () => {
    expect(() =>
      DiagnosisResultSchema.parse({
        ...valid,
        suggestedActions: [{ priority: "urgent" }],
      }),
    ).toThrow();
  });

  it("evidence.source 非法時丟錯", () => {
    expect(() =>
      DiagnosisResultSchema.parse({
        ...valid,
        evidence: [{ source: "rumor", excerpt: "x" }],
      }),
    ).toThrow();
  });
});
