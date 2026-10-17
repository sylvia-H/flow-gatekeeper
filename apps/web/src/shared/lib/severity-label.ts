import type { DiagnosisResult } from "@flow-gatekeeper/contracts";

/**
 * 診斷嚴重度（契約 `DiagnosisResult.severity`）的繁中譯名，全站唯一來源（research R13）。
 * ⚠️ 與機台健康狀態（healthy/warning/critical）刻意不同：診斷 severity 有 `ok`，譯為「正常」。
 * 診斷結果徽章、卡片診斷狀態 chip 與手機 peek 條都由這裡取字，避免各自維護一份對照而漂移。
 */
export type DiagnosisSeverity = DiagnosisResult["severity"];

const SEVERITY_LABEL: Record<DiagnosisSeverity, "正常" | "警告" | "嚴重"> = {
  ok: "正常",
  warning: "警告",
  critical: "嚴重",
};

export function severityLabel(severity: DiagnosisSeverity): "正常" | "警告" | "嚴重" {
  return SEVERITY_LABEL[severity];
}
