import type { TelemetryPoint } from "@flow-gatekeeper/contracts";

/**
 * US1 卡片呈現純函式（telemetry 的呈現投影，不改 store 型別、不動契約）。
 * 三支：`metricUnit`（單位）、`offendingMetrics`（越界判定，供 amber/crit 染色）、
 * `relativeTimeLabel`（相對「Ns ago」）。皆為決定性純函式，便於單元測試（研究 R1/R2/R3）。
 */
export type MetricKey = "temperature" | "vibration" | "throughput" | "errorRate";

/** 越界程度：`warn`（染 amber）／`crit`（染 crit）／`null`（未越界，用預設色）。 */
export type Offense = "warn" | "crit" | null;

const UNITS: Record<MetricKey, string> = {
  temperature: "°C",
  vibration: "mm/s",
  throughput: "u/min",
  errorRate: "%",
};

/** 遙測單位（FR-003）；靜態字串常數，design-spec §7.3 未規定字串、無衝突。 */
export function metricUnit(key: MetricKey): string {
  return UNITS[key];
}

/**
 * 越界門檻——**鏡射 002 `mock-telemetry.service.ts` 推導 `state` 的門檻**（research R1）：
 * warning 為 `temp>78 / vib>0.9 / err>0.04`，critical 為 `temp>95 / vib>1.7 / err>0.12`。
 * `throughput` 為下降型、非 state 觸發指標，不參與 amber。errorRate 以原始比例（如 0.04）比對。
 * 若後端調門檻，此處需同步（純呈現，機台整體 state 仍以契約 `state` 為準）。
 */
const THRESHOLDS: Record<"temperature" | "vibration" | "errorRate", { warn: number; crit: number }> = {
  temperature: { warn: 78, crit: 95 },
  vibration: { warn: 0.9, crit: 1.7 },
  errorRate: { warn: 0.04, crit: 0.12 },
};

function classify(value: number, warn: number, crit: number): Offense {
  if (value > crit) return "crit";
  if (value > warn) return "warn";
  return null;
}

/** 逐 metric 回傳越界程度；卡片據此只染**越界的數值本身**（FR-002），不染整卡。 */
export function offendingMetrics(t: TelemetryPoint["telemetry"]): Record<MetricKey, Offense> {
  return {
    temperature: classify(t.temperature, THRESHOLDS.temperature.warn, THRESHOLDS.temperature.crit),
    vibration: classify(t.vibration, THRESHOLDS.vibration.warn, THRESHOLDS.vibration.crit),
    errorRate: classify(t.errorRate, THRESHOLDS.errorRate.warn, THRESHOLDS.errorRate.crit),
    throughput: null,
  };
}

/**
 * 相對時間「Ns ago」（FR-004）。以 sec 級精度，讀既有 `store.now`（每秒 tick）即可更新，
 * 不另開計時器。邊界：<5s→`just now`、<60s→`Ns ago`、<60m→`Nm ago`、<24h→`Nh ago`、否則 `Nd ago`。
 */
export function relativeTimeLabel(lastUpdated: number, now: number): string {
  const sec = Math.floor(Math.max(0, now - lastUpdated) / 1000);
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}
