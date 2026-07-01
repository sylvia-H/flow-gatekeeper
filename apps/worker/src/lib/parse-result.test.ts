import { describe, expect, it } from "vitest";
import type { DiagnosisResult } from "@flow-gatekeeper/contracts";
import { parseResult } from "./parse-result.js";

const validResult: DiagnosisResult = {
  summary: "壓力機溫度偏高，建議檢查冷卻系統",
  severity: "warning",
  likelyCauses: ["冷卻不足", "負載過高"],
  suggestedActions: [{ label: "檢查冷卻風扇", priority: "high", command: "inspect:fan" }],
  evidence: [{ source: "telemetry", id: "t-1", excerpt: "avgTemperature=82" }],
};

describe("parseResult", () => {
  it("抽出被前後文字／圍欄包住的合法 JSON 並通過 schema", () => {
    const text = "以下是診斷結果：\n```json\n" + JSON.stringify(validResult) + "\n```\n以上。";
    expect(parseResult(text)).toEqual(validResult);
  });

  it("無 `{}` 時丟錯（SC-007）", () => {
    expect(() => parseResult("模型沒有回傳任何 JSON 物件")).toThrow();
  });

  it("JSON 語法壞掉時丟錯", () => {
    expect(() => parseResult('{ "summary": }')).toThrow();
  });

  it("缺必要欄位（schema 不合法）時丟錯（SC-009）", () => {
    expect(() => parseResult(JSON.stringify({ summary: "只有摘要" }))).toThrow();
  });

  it("severity 非列舉值時丟錯", () => {
    const bad = { ...validResult, severity: "fatal" };
    expect(() => parseResult(JSON.stringify(bad))).toThrow();
  });
});
