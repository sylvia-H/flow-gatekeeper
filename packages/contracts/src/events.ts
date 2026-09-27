import type { DiagnosisResult } from "./schemas.js";
import type { JobStatus } from "./job-status.js";
import type { AiDone, AiError, AiStreamEvent, AiToken } from "./ai-stream.js";
import type { WorkerMetrics } from "./metrics.js";
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
 * machine/data：伺服器推送的高頻機台遙測資料點。
 *
 * 刻意維持純 TS 型別而非 Zod：這條路徑每秒數百筆，逐筆跑 schema 解析的成本不划算；
 * 入口改用下方手寫的 `isTelemetryPoint`／`isTelemetryBatch` 守衛擋住畸形資料。
 * 傳輸時為 `TelemetryPoint[]`（無 envelope）。
 */
export type TelemetryPoint = {
  type: "machine/data";
  machineId: string;
  timestamp: string;
  telemetry: {
    temperature: number;
    vibration: number;
    throughput: number;
    errorRate: number;
  };
  state: MachineState;
};

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
 * discriminated union，依憲章 Principle III「型別來源分層」——純做型別分派的控制訊息 MAY
 * 以 TS 型別直接定義，仍以本套件為單一來源。客戶端→伺服器方向屬不可信輸入，改以 Zod
 * 定義於 `ws-client.ts`。
 */

/** system/connected：連線建立確認，派發 clientId。 */
export type SystemConnected = { type: "system/connected"; clientId: string };

/** machine/subscribed：訂閱成功回執（回報當前訂閱集合）。 */
export type MachineSubscribed = { type: "machine/subscribed"; machineIds: string[] };

/** pong：伺服器對應用層 ping 的回應。 */
export type Pong = { type: "pong"; ts: number };

/** system/unauthorized：訂閱授權失敗。 */
export type SystemUnauthorized = { type: "system/unauthorized" };

/**
 * system/metrics：伺服器週期廣播的營運指標摘要。
 * 廣播給**所有已連線 client**、與 `machine/subscribe` 訂閱狀態無關——這是系統層級的健康訊號，
 * 不屬於任何一台機台，沒訂閱機台的畫面也需要它。
 */
export type SystemMetrics = {
  type: "system/metrics";
  /** 本則摘要涵蓋的時間窗（＝`METRICS_INTERVAL_MS`）；前端過期門檻由此推導，不得硬編。 */
  windowMs: number;
  /** api 結算時間（ISO-8601）——前端新鮮度判定以此為基準，非收訊時間。 */
  collectedAt: string;
  queue: { waiting: number; active: number; failed: number };
  wsConnections: number;
  worker: WorkerMetrics | null;
};

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
