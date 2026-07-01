import { describe, expect, it } from "vitest";
import { buildDiagnosisSignature } from "./signature.js";

const base = {
  machineId: "press-02",
  state: "critical",
  topErrorCodes: ["critical", "warning"],
  promptVersion: "diagnosis-v1",
  model: "gemini-2.5-flash",
};

describe("buildDiagnosisSignature", () => {
  it("相同輸入具決定性一致（SC-009）", () => {
    expect(buildDiagnosisSignature(base)).toBe(buildDiagnosisSignature({ ...base }));
  });

  it("topErrorCodes 順序不影響結果", () => {
    const a = buildDiagnosisSignature({ ...base, topErrorCodes: ["warning", "critical"] });
    const b = buildDiagnosisSignature({ ...base, topErrorCodes: ["critical", "warning"] });
    expect(a).toBe(b);
  });

  it("不同 state 產生不同簽章（案例2：狀態轉變不誤命中）", () => {
    expect(buildDiagnosisSignature({ ...base, state: "warning" })).not.toBe(
      buildDiagnosisSignature(base),
    );
  });

  it("不同 topErrorCodes 產生不同簽章", () => {
    expect(buildDiagnosisSignature({ ...base, topErrorCodes: ["warning"] })).not.toBe(
      buildDiagnosisSignature(base),
    );
  });

  it("不同 model 產生不同簽章", () => {
    expect(buildDiagnosisSignature({ ...base, model: "gemini-1.5-pro" })).not.toBe(
      buildDiagnosisSignature(base),
    );
  });

  it("不同 promptVersion 產生不同簽章", () => {
    expect(buildDiagnosisSignature({ ...base, promptVersion: "diagnosis-v2" })).not.toBe(
      buildDiagnosisSignature(base),
    );
  });

  it("回傳 24 字元 hex", () => {
    expect(buildDiagnosisSignature(base)).toMatch(/^[0-9a-f]{24}$/);
  });
});
