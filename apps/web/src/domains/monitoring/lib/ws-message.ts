import type {
  AiDone,
  AiError,
  AiToken,
  JobStatus,
  SystemMetrics,
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
  | { kind: "metrics"; metrics: SystemMetrics }
  | { kind: "control"; message: Record<string, unknown> }
  | { kind: "ignore" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * 分類一則已 `JSON.parse` 的 WebSocket 訊息。
 * - 陣列 → `telemetry`（唯一會進 buffer 的類別，憲章 IV）。
 * - `job/status`／`ai/token`／`ai/done`／`ai/error` → `diagnosis`（MUST NOT 進 buffer，FR-017）。
 * - `system/metrics` → `metrics`（009，直接寫 metrics store，見下方註解）。
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
    // 009 US3：`system/metrics` 是 **60 秒一則的低頻控制訊息**，收到後**直接寫入 metrics
    // store**（低頻，直接 reactive 寫入無虞）。**MUST NOT** 進 `machine/data` 的 rAF buffer
    // 批次提交路徑——那條路徑是為每 50ms 的高頻遙測而設（憲章 IV）；把它塞進去會延遲到下一批
    // 遙測才顯示，並**污染背壓比值的量測**（received/rendered 是賣點一的核心證據）。
    // 契約邊界說明見 contracts/metrics-summary.md §3。
    case "system/metrics":
      return { kind: "metrics", metrics: parsed as unknown as SystemMetrics };
    case "system/connected":
    case "pong":
    case "machine/subscribed":
    case "system/unauthorized":
      return { kind: "control", message: parsed };
    default:
      return { kind: "ignore" };
  }
}
