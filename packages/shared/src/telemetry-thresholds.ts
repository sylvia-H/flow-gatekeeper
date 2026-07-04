/**
 * 機台遙測門檻——**跨端單一來源**（review 006 altitude）。
 *
 * 過去 apps/api 的 mock producer（推導整體 state）與 apps/web 的數值染色各自硬編同一組
 * 門檻數字，跨 process 無任何連結、會靜默漂移。此處集中定義，producer 與前端一律 import，
 * 改門檻只改這一處。屬純領域常數，非通訊 payload，故放 shared 而非 contracts。
 */
export interface Threshold {
  warn: number;
  crit: number;
}

/** 參與整體 state 判定的三個指標門檻；throughput 為下降型、不參與，故不列。 */
export const METRIC_THRESHOLDS = {
  temperature: { warn: 78, crit: 95 },
  vibration: { warn: 0.9, crit: 1.7 },
  errorRate: { warn: 0.04, crit: 0.12 },
} as const satisfies Record<string, Threshold>;

export type ThresholdMetric = keyof typeof METRIC_THRESHOLDS;

/** 機台整體 state（與契約 `MachineState` 同值域；此處不 import 契約以免 shared→contracts 反向相依）。 */
export type DerivedMachineState = "healthy" | "warning" | "critical";

/**
 * 由（未四捨五入的）遙測值推導整體 state：任一指標越 crit → critical；任一越 warn → warning；
 * 否則 healthy。producer 與前端共用同一判定，杜絕門檻漂移。
 */
export function deriveMachineState(t: {
  temperature: number;
  vibration: number;
  errorRate: number;
}): DerivedMachineState {
  const over = (metric: ThresholdMetric, level: "warn" | "crit"): boolean =>
    t[metric] > METRIC_THRESHOLDS[metric][level];
  if (over("temperature", "crit") || over("vibration", "crit") || over("errorRate", "crit")) {
    return "critical";
  }
  if (over("temperature", "warn") || over("vibration", "warn") || over("errorRate", "warn")) {
    return "warning";
  }
  return "healthy";
}
