import { z } from "zod";
import type { DiagnosisResult } from "./schemas.js";
import type { JobStatus } from "./job-status.js";
import type { AiDone, AiError, AiStreamEvent, AiToken } from "./ai-stream.js";
import { WorkerMetricsSchema, type WorkerMetrics } from "./metrics.js";
import type { ClientControlMessage, MachineSubscribe, Ping } from "./ws-client.js";

export type { DiagnosisResult };
export type { JobStatus };
export type { AiDone, AiError, AiStreamEvent, AiToken };
export type { WorkerMetrics };
export type { ClientControlMessage, MachineSubscribe, Ping };

/**
 * 機台健康狀態的 runtime 清單，同時是 `MachineState` 型別的單一來源：型別由陣列推導，
 * 守衛與型別因此不可能各自增減而不一致。注意與診斷 `severity`（ok/warning/critical）
 * 刻意不同——此處無 `ok`、`severity` 無 `healthy`，契約與 AsyncAPI 文件 MUST 維持此區分。
 */
export const MACHINE_STATES = ["healthy", "warning", "critical"] as const;

export type MachineState = (typeof MACHINE_STATES)[number];

/**
 * machine/data：伺服器推送的高頻機台遙測資料點。傳輸時為 `TelemetryPoint[]`（無 envelope）。
 *
 * 型別由 Zod 推導，但這份 schema **只供契約漂移測試與低頻用途**：高頻路徑（web 收
 * `machine/data`，每秒數百筆）MUST NOT 逐筆 `safeParse`（CLAUDE.md 硬規則 1 的效能取捨），
 * 入口一律用下方手寫的 `isTelemetryPoint`／`isTelemetryBatch` 守衛擋住畸形資料。
 * 兩者判定刻意只差一處：守衛不驗 `timestamp` 的 ISO-8601 格式（逐筆跑 date-time regex 不划算，
 * 且畫面不解析它）；其餘正反例判定一致，見 `telemetry-guard.test.ts`。
 */
export const TelemetryPointSchema = z.object({
  type: z.literal("machine/data"),
  machineId: z.string(),
  /** RFC 3339（對齊 asyncapi `format: date-time`）：須含秒，接受 `Z` 或 `±hh:mm` 時區。 */
  timestamp: z.iso.datetime({ offset: true }),
  telemetry: z.object({
    temperature: z.number(),
    vibration: z.number(),
    throughput: z.number(),
    errorRate: z.number(),
  }),
  state: z.enum(MACHINE_STATES),
});

export type TelemetryPoint = z.infer<typeof TelemetryPointSchema>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * 高頻路徑的手寫型別守衛。檢查到畫面實際會用到的深度：四個數值欄位若是 NaN／Infinity／
 * 非數字，render 端的 `.toFixed` 與圖表計算會直接出錯，所以要求有限數字。
 */
export function isTelemetryPoint(value: unknown): value is TelemetryPoint {
  if (!isRecord(value)) return false;
  if (value.type !== "machine/data") return false;
  if (typeof value.machineId !== "string") return false;
  if (typeof value.timestamp !== "string") return false;
  if (!(MACHINE_STATES as readonly unknown[]).includes(value.state)) return false;
  const t = value.telemetry;
  return (
    isRecord(t) &&
    isFiniteNumber(t.temperature) &&
    isFiniteNumber(t.vibration) &&
    isFiniteNumber(t.throughput) &&
    isFiniteNumber(t.errorRate)
  );
}

/** `machine/data` 的整批 payload：必須是陣列且每一筆都通過 `isTelemetryPoint`。 */
export function isTelemetryBatch(value: unknown): value is TelemetryPoint[] {
  return Array.isArray(value) && value.every(isTelemetryPoint);
}

/**
 * 伺服器→客戶端的傳輸／控制訊息（002 新增）。這些是用來在 `switch(type)` 做分派的
 * discriminated union；依憲章 Principle III「型別來源分層」原本 MAY 以 TS 型別直接定義，
 * 升級 Zod 4 時改以 Zod 定義、型別由 `z.infer` 推導——目的是讓 AsyncAPI 漂移測試能做結構
 * 比對（屬加嚴，仍以本套件為單一來源）。客戶端→伺服器方向屬不可信輸入，定義於 `ws-client.ts`。
 */

/** system/connected：連線建立確認，派發 clientId。 */
export const SystemConnectedSchema = z.object({
  type: z.literal("system/connected"),
  clientId: z.string(),
});

/** machine/subscribed：訂閱成功回執（回報當前訂閱集合）。 */
export const MachineSubscribedSchema = z.object({
  type: z.literal("machine/subscribed"),
  machineIds: z.array(z.string()),
});

/** pong：伺服器對應用層 ping 的回應（`ts` 為伺服器 `Date.now()`）。 */
export const PongSchema = z.object({ type: z.literal("pong"), ts: z.number().int() });

/** system/unauthorized：訂閱授權失敗。 */
export const SystemUnauthorizedSchema = z.object({ type: z.literal("system/unauthorized") });

/**
 * system/metrics：伺服器週期廣播的營運指標摘要。
 * 廣播給**所有已連線 client**、與 `machine/subscribe` 訂閱狀態無關——這是系統層級的健康訊號，
 * 不屬於任何一台機台，沒訂閱機台的畫面也需要它。
 */
export const SystemMetricsSchema = z.object({
  type: z.literal("system/metrics"),
  /**
   * 本則摘要涵蓋的時間窗（＝`METRICS_INTERVAL_MS`）；前端過期門檻由此推導，不得硬編。
   * 必須 ≥ 1：0 會讓過期門檻歸零、面板永遠判為過期。用 `.min(1)` 而非 `.positive()`：整數下語意相同，
   * 但前者輸出 JSON Schema 的 `minimum: 1`、與 asyncapi 同形（後者輸出 `exclusiveMinimum: 0`）。
   */
  windowMs: z.number().int().min(1),
  /** api 結算時間（RFC 3339，同 `timestamp`）——前端新鮮度判定以此為基準，非收訊時間。 */
  collectedAt: z.iso.datetime({ offset: true }),
  queue: z.object({
    waiting: z.number().int().nonnegative(),
    active: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  }),
  wsConnections: z.number().int().nonnegative(),
  /** worker 快照缺席、過期或畸形時為 `null`（降級輸出，api 仍廣播自己那一半）。 */
  worker: WorkerMetricsSchema.nullable(),
});

export type SystemConnected = z.infer<typeof SystemConnectedSchema>;
export type MachineSubscribed = z.infer<typeof MachineSubscribedSchema>;
export type Pong = z.infer<typeof PongSchema>;
export type SystemUnauthorized = z.infer<typeof SystemUnauthorizedSchema>;
export type SystemMetrics = z.infer<typeof SystemMetricsSchema>;

/** 伺服器→客戶端的控制訊息聯集。 */
export type ServerControlMessage =
  | SystemConnected
  | MachineSubscribed
  | Pong
  | SystemUnauthorized
  | SystemMetrics;

/** 伺服器→客戶端的所有訊息 `type`（`machine/data` 以陣列整批送出，但 `type` 仍取自其元素）。 */
export type ServerMessage = TelemetryPoint | JobStatus | AiStreamEvent | ServerControlMessage;

/** WS 上所有訊息 `type` 字面值的聯集。 */
export type WsMessageType = ServerMessage["type"] | ClientControlMessage["type"];

/**
 * WS 訊息 `type` 的 runtime 清單，供契約漂移測試與 asyncapi 比對。
 * 物件鍵以 `Record<WsMessageType, true>` 綁定：聯集新增成員而此處漏列、或列了不存在的
 * type，都會 typecheck 失敗——比單純 `satisfies readonly WsMessageType[]` 多擋住「漏列」。
 */
const WS_MESSAGE_TYPE_SET = {
  "machine/data": true,
  "machine/subscribe": true,
  "machine/subscribed": true,
  "job/status": true,
  "ai/token": true,
  "ai/done": true,
  "ai/error": true,
  ping: true,
  pong: true,
  "system/connected": true,
  "system/unauthorized": true,
  "system/metrics": true,
} as const satisfies Record<WsMessageType, true>;

export const WS_MESSAGE_TYPES = Object.keys(
  WS_MESSAGE_TYPE_SET,
) as readonly WsMessageType[];
