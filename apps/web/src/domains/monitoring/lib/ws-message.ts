import type {
  AiDone,
  AiError,
  AiToken,
  JobStatus,
  TelemetryPoint,
} from "@flow-gatekeeper/contracts";

/** 005 診斷事件聯集——經**同一條** WebSocket 回送，由 onDiagnosisEvent 分流交 copilot.store。 */
export type DiagnosisEvent = JobStatus | AiToken | AiDone | AiError;

/**
 * WebSocket 訊息分類結果（純資料）。把「該進遙測 buffer / 該交診斷回呼 / 控制訊息 / 忽略」
 * 的判定抽成純函式，使**憲章 IV／FR-017 分流不變量可單元測試**：診斷事件永不歸為 telemetry
 * （＝永不進遙測 buffer）。
 */
export type RoutedWsMessage =
  | { kind: "telemetry"; points: TelemetryPoint[] }
  | { kind: "diagnosis"; event: DiagnosisEvent }
  | { kind: "control"; message: Record<string, unknown> }
  | { kind: "ignore" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * 分類一則已 `JSON.parse` 的 WebSocket 訊息。
 * - 陣列 → `telemetry`（唯一會進 buffer 的類別，憲章 IV）。
 * - `job/status`／`ai/token`／`ai/done`／`ai/error` → `diagnosis`（MUST NOT 進 buffer，FR-017）。
 * - `system/connected`／`pong`／`machine/subscribed`／`system/unauthorized` → `control`。
 * - 其餘（非物件、未知 type）→ `ignore`。
 */
export function classifyWsMessage(parsed: unknown): RoutedWsMessage {
  if (Array.isArray(parsed)) return { kind: "telemetry", points: parsed as TelemetryPoint[] };
  if (!isRecord(parsed)) return { kind: "ignore" };

  switch (parsed.type) {
    case "job/status":
    case "ai/token":
    case "ai/done":
    case "ai/error":
      return { kind: "diagnosis", event: parsed as unknown as DiagnosisEvent };
    case "system/connected":
    case "pong":
    case "machine/subscribed":
    case "system/unauthorized":
      return { kind: "control", message: parsed };
    default:
      return { kind: "ignore" };
  }
}
