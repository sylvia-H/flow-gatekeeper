import {
  AiStreamEventSchema,
  isTelemetryPoint,
  JobStatusSchema,
  SystemMetricsSchema,
  type AiDone,
  type AiError,
  type AiToken,
  type JobStatus,
  type SystemMetrics,
  type TelemetryPoint,
} from "@flow-gatekeeper/contracts";

/** 005 診斷事件聯集——經**同一條** WebSocket 回送，由 onDiagnosisEvent 分流交 copilot.store。 */
export type DiagnosisEvent = JobStatus | AiToken | AiDone | AiError;

/**
 * WebSocket 訊息分類結果（純資料）。把「該進遙測 buffer / 該交診斷回呼 / 控制訊息 / 忽略」
 * 的判定抽成純函式，使**憲章 IV 分流不變量可單元測試**：診斷事件永不歸為 telemetry
 * （＝永不進遙測 buffer）。
 *
 * 這裡同時是信任邊界：通過分類的資料會直接進 store、再進 render，畸形值若放行，
 * 會在 `.toFixed` 或診斷結果畫面才炸開，比在入口丟棄難追得多。
 */
export type RoutedWsMessage =
  /** `rejected`：同批中未通過型別守衛而被剔除的筆數（供背壓計量的丟棄統計）。 */
  | { kind: "telemetry"; points: TelemetryPoint[]; rejected: number }
  | { kind: "diagnosis"; event: DiagnosisEvent }
  | { kind: "metrics"; metrics: SystemMetrics }
  | { kind: "control"; message: Record<string, unknown> }
  | { kind: "ignore"; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 分類一則已 `JSON.parse` 的 WebSocket 訊息。
 * - 陣列 → `telemetry`（唯一會進 buffer 的類別，憲章 IV）。逐筆 `isTelemetryPoint` 過濾，
 *   畸形點剔除並回報 `rejected` 筆數。選逐筆而非 `isTelemetryBatch` 整批否決：一批是多台
 *   機台的混合，一筆壞資料不該連帶讓其他機台該幀的更新消失。高頻路徑只用手寫守衛，不用 zod。
 * - `job/status`／`ai/*` → `diagnosis`（MUST NOT 進 buffer），以契約 schema `safeParse`。
 * - `system/metrics` → `metrics`（009，直接寫 metrics store，見下方註解）。
 * - `system/connected`／`pong`／`machine/subscribed`／`system/unauthorized` → `control`。
 * - 其餘（非物件、未知 type、驗證失敗）→ `ignore`，附原因方便除錯。
 */
export function classifyWsMessage(parsed: unknown): RoutedWsMessage {
  if (Array.isArray(parsed)) {
    const points = parsed.filter(isTelemetryPoint);
    return { kind: "telemetry", points, rejected: parsed.length - points.length };
  }
  if (!isRecord(parsed)) return { kind: "ignore", reason: "not-an-object" };

  switch (parsed.type) {
    case "job/status": {
      const r = JobStatusSchema.safeParse(parsed);
      return r.success
        ? { kind: "diagnosis", event: r.data }
        : { kind: "ignore", reason: "invalid job/status" };
    }
    case "ai/token":
    case "ai/done":
    case "ai/error": {
      const r = AiStreamEventSchema.safeParse(parsed);
      return r.success
        ? { kind: "diagnosis", event: r.data }
        : { kind: "ignore", reason: `invalid ${parsed.type}` };
    }
    // 009 US3：`system/metrics` 是 **60 秒一則的低頻控制訊息**，收到後**直接寫入 metrics
    // store**（低頻，直接 reactive 寫入無虞）。**MUST NOT** 進 `machine/data` 的 rAF buffer
    // 批次提交路徑——那條路徑是為每 50ms 的高頻遙測而設（憲章 IV）；把它塞進去會延遲到下一批
    // 遙測才顯示，並**污染背壓比值的量測**（received/rendered 是賣點一的核心證據）。
    // 契約邊界說明見 contracts/metrics-summary.md §3。
    // 驗證直接用契約的 `SystemMetricsSchema`（含巢狀 `WorkerMetricsSchema`；`windowMs ≥ 1`、
    // 各計數 ≥ 0 的規則也在契約內），不在 web 另寫平行檢查。低頻（60 秒一則），用 zod 無效能疑慮。
    case "system/metrics": {
      const r = SystemMetricsSchema.safeParse(parsed);
      return r.success
        ? { kind: "metrics", metrics: r.data }
        : { kind: "ignore", reason: "invalid system/metrics" };
    }
    case "system/connected":
      // clientId 會被當成 POST /diagnoses 的 socketId，不是字串就不能放行。
      return typeof parsed.clientId === "string"
        ? { kind: "control", message: parsed }
        : { kind: "ignore", reason: "invalid system/connected" };
    case "pong":
    case "machine/subscribed":
    case "system/unauthorized":
      return { kind: "control", message: parsed };
    default:
      return { kind: "ignore", reason: "unknown type" };
  }
}
