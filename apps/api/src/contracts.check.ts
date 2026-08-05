import type { DiagnosisResult, TelemetryPoint } from "@flow-gatekeeper/contracts";

/**
 * 契約匯入驗證（FR-006 / SC-003）——長期保留的型別佐證，被 `typecheck` 涵蓋，
 * 以 `*.check.ts` 命名排除於 build 產出，避免打包/lint 雜訊。
 *
 * 證明 api 端能 import 共用契約型別且與單一來源一致。
 */
export const sampleTelemetry: TelemetryPoint = {
  type: "machine/data",
  machineId: "press-02",
  timestamp: new Date(0).toISOString(),
  telemetry: { temperature: 72, vibration: 0.4, throughput: 120, errorRate: 0.01 },
  state: "healthy",
};

export const sampleDiagnosis: DiagnosisResult = {
  summary: "skeleton",
  severity: "ok",
  likelyCauses: [],
  suggestedActions: [],
  evidence: [],
};
