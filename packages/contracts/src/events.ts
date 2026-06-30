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
