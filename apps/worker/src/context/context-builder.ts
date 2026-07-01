import type { Db } from "mongodb";

/** telemetry 彙總（窗口內 avg/max 與樣本數）。 */
export type TelemetrySummary = {
  count: number;
  avgTemperature: number;
  maxTemperature: number;
  avgVibration: number;
  maxVibration: number;
  avgErrorRate: number;
  maxErrorRate: number;
};

/** 組 prompt／簽章用的機台脈絡（讀自 002 落地的 Mongo 歷史）。 */
export type DiagnosisContext = {
  machineId: string;
  windowMinutes: number;
  /** 最近 1 筆遙測的 state（'healthy'|'warning'|'critical'）；無資料為 'unknown'。進 cache 簽章。 */
  latestState: string;
  /** 窗口內遙測彙總；無資料為 null。 */
  telemetry: TelemetrySummary | null;
  /** 近 5 筆異常事件。 */
  recentErrors: { state: string; message: string; timestamp: string }[];
  /** 近期錯誤類型（distinct、排序，由 recentErrors 的 state 導出）——進 cache 簽章。 */
  topErrorCodes: string[];
  /** 近 3 筆維修紀錄摘要。 */
  maintenance: { performedAt?: string; summary: string }[];
};

/**
 * 讀 Mongo 組診斷脈絡（FR-011）：窗口內 telemetry 彙總、最近 state、近 5 筆 errorlogs、
 * 近 3 筆 maintenanceRecords，並導出 `topErrorCodes`（供 US2 簽章）。純讀取、不寫入。
 */
export async function buildDiagnosisContext(args: {
  mongo: Db;
  machineId: string;
  windowMinutes: number;
}): Promise<DiagnosisContext> {
  const { mongo, machineId, windowMinutes } = args;
  const since = new Date(Date.now() - windowMinutes * 60_000);

  const aggRows = await mongo
    .collection("telemetry")
    .aggregate<TelemetrySummary & { _id: null }>([
      { $match: { "metadata.machineId": machineId, timestamp: { $gte: since } } },
      {
        $group: {
          _id: null,
          count: { $sum: 1 },
          avgTemperature: { $avg: "$telemetry.temperature" },
          maxTemperature: { $max: "$telemetry.temperature" },
          avgVibration: { $avg: "$telemetry.vibration" },
          maxVibration: { $max: "$telemetry.vibration" },
          avgErrorRate: { $avg: "$telemetry.errorRate" },
          maxErrorRate: { $max: "$telemetry.errorRate" },
        },
      },
    ])
    .toArray();
  const telemetry: TelemetrySummary | null = aggRows[0]
    ? {
        count: aggRows[0].count,
        avgTemperature: round(aggRows[0].avgTemperature),
        maxTemperature: round(aggRows[0].maxTemperature),
        avgVibration: round(aggRows[0].avgVibration),
        maxVibration: round(aggRows[0].maxVibration),
        avgErrorRate: round(aggRows[0].avgErrorRate),
        maxErrorRate: round(aggRows[0].maxErrorRate),
      }
    : null;

  const latestDoc = (await mongo
    .collection("telemetry")
    .find({ "metadata.machineId": machineId })
    .sort({ timestamp: -1 })
    .limit(1)
    .next()) as { state?: string } | null;
  const latestState = latestDoc?.state ?? "unknown";

  const errorDocs = (await mongo
    .collection("errorlogs")
    .find({ machineId, timestamp: { $gte: since } })
    .sort({ timestamp: -1 })
    .limit(5)
    .toArray()) as { state?: string; message?: string; timestamp?: Date }[];
  const recentErrors = errorDocs.map((doc) => ({
    state: doc.state ?? "unknown",
    message: doc.message ?? "",
    timestamp: doc.timestamp ? new Date(doc.timestamp).toISOString() : "",
  }));
  const topErrorCodes = [...new Set(recentErrors.map((e) => e.state))].sort();

  const maintenanceDocs = (await mongo
    .collection("maintenanceRecords")
    .find({ machineId })
    .sort({ performedAt: -1 })
    .limit(3)
    .toArray()) as {
    performedAt?: Date | string;
    summary?: string;
    notes?: string;
    description?: string;
    type?: string;
  }[];
  const maintenance = maintenanceDocs.map((doc) => ({
    performedAt: doc.performedAt ? new Date(doc.performedAt).toISOString() : undefined,
    summary: doc.summary ?? doc.notes ?? doc.description ?? doc.type ?? "maintenance record",
  }));

  return { machineId, windowMinutes, latestState, telemetry, recentErrors, topErrorCodes, maintenance };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
