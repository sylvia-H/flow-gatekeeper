import type {
  AiStreamEvent,
  DiagnosisResult,
  TelemetryPoint,
} from "@flow-gatekeeper/contracts";

/**
 * 契約匯入驗證（FR-006 / SC-003）——長期保留的型別佐證，被 `typecheck` 涵蓋，
 * 以 `*.check.ts` 命名排除於 build 產出。
 *
 * 證明 web 端能 import 共用契約型別（telemetry / 診斷結果 / AI 串流事件）
 * 且與單一來源一致。
 */
export function renderState(point: TelemetryPoint): string {
  return `${point.machineId}:${point.state}`;
}

export function summarize(result: DiagnosisResult): string {
  return `${result.severity} — ${result.summary}`;
}

export function isDone(ev: AiStreamEvent): boolean {
  return ev.type === "ai/done";
}
