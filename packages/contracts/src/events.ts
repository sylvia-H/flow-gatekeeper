import type { DiagnosisResult } from "./schemas.js";

export type { DiagnosisResult };

/**
 * 機台健康狀態。注意：與診斷 `severity`（ok/warning/critical）刻意不同——
 * 此處無 `ok`、`severity` 無 `healthy`，契約與 AsyncAPI 文件 MUST 維持此區分。
 */
export type MachineState = "healthy" | "warning" | "critical";

/** machine/data：伺服器推送的高頻機台遙測資料點。 */
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

/** machine/subscribe：客戶端訂閱機台遙測。 */
export type MachineSubscribe = {
  type: "machine/subscribe";
  token: string;
  machineIds: string[];
};

/** job/status：伺服器推送的診斷任務狀態。 */
export type JobStatus = {
  type: "job/status";
  jobId: string;
  machineId: string;
  status: "waiting" | "active" | "completed" | "failed";
  progress?: number;
  result?: DiagnosisResult;
  error?: string;
};

/** ai/token：串流 AI token 區塊。 */
export type AiToken = {
  type: "ai/token";
  jobId: string;
  seq: number;
  text: string;
};

/** ai/done：最終 AI 診斷結果。 */
export type AiDone = {
  type: "ai/done";
  jobId: string;
  cached: boolean;
  result: DiagnosisResult;
};

/** ai/error：AI 供應商或 worker 錯誤。 */
export type AiError = {
  type: "ai/error";
  jobId: string;
  code: string;
  message: string;
};

export type AiStreamEvent = AiToken | AiDone | AiError;

/**
 * 傳輸／控制訊息（002 新增）。這些是用來在 `switch(type)` 做分派的 discriminated union，
 * 依憲章 Principle III「型別來源分層」——純做型別分派的控制訊息 MAY 以 TS 型別直接定義，
 * 仍以本套件為單一來源；需 runtime 驗證的 payload（如 DiagnosisResult）才用 Zod。
 */

/** ping：客戶端應用層心跳請求。 */
export type Ping = { type: "ping" };

/** system/connected：連線建立確認，派發 clientId。 */
export type SystemConnected = { type: "system/connected"; clientId: string };

/** machine/subscribed：訂閱成功回執（回報當前訂閱集合）。 */
export type MachineSubscribed = { type: "machine/subscribed"; machineIds: string[] };

/** pong：伺服器對應用層 ping 的回應。 */
export type Pong = { type: "pong"; ts: number };

/** system/unauthorized：訂閱授權失敗。 */
export type SystemUnauthorized = { type: "system/unauthorized" };

/** 客戶端→伺服器的控制訊息聯集（供 Gateway narrow）。 */
export type ClientControlMessage = Ping | MachineSubscribe;

/** 伺服器→客戶端的控制訊息聯集。 */
export type ServerControlMessage =
  | SystemConnected
  | MachineSubscribed
  | Pong
  | SystemUnauthorized;
