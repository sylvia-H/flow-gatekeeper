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
 * 單一查詢的伺服器端時間上限。驅動預設 `socketTimeoutMS: 0`（永不逾時）——查詢一旦掛住，
 * processor 就卡在這裡、佔住 concurrency 槽，而 heartbeat 仍新鮮。設上限讓它以錯誤結束，
 * 交給 BullMQ 重試；5s 對「近 N 分鐘、單一機台、有索引」的查詢是很寬裕的預算。
 */
export const CONTEXT_QUERY_MAX_TIME_MS = 5000;

/**
 * 讀 Mongo 組診斷脈絡（FR-011）：窗口內 telemetry 彙總、最近 state、近 5 筆 errorlogs、
 * 近 3 筆 maintenanceRecords，並導出 `topErrorCodes`（供 US2 簽章）。純讀取、不寫入。
 */
export async function buildDiagnosisContext(args: {
  mongo: Db;
  machineId: string;
  windowMinutes: number;
  maxTimeMS?: number;
}): Promise<DiagnosisContext> {
  const { mongo, machineId, windowMinutes } = args;
  const maxTimeMS = args.maxTimeMS ?? CONTEXT_QUERY_MAX_TIME_MS;
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
    ], { maxTimeMS })
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
    .find({ "metadata.machineId": machineId }, { maxTimeMS })
    .sort({ timestamp: -1 })
    .limit(1)
    .next()) as { state?: string } | null;
  const latestState = latestDoc?.state ?? "unknown";

  const errorDocs = (await mongo
    .collection("errorlogs")
    .find({ machineId, timestamp: { $gte: since } }, { maxTimeMS })
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
    .find({ machineId }, { maxTimeMS })
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

/**
 * 空脈絡判定（純函式）：沒有任何遙測（窗口內無樣本、也沒有最近一筆 state）、窗口內無異常事件、
 * 也沒有維修紀錄。此時 prompt 裡只剩機台名，LLM 只能憑空編造診斷——典型來源是不存在的
 * machineId（每個亂數 id 都 cache miss、必打 LLM）。processor 據此短路、不呼叫 LLM。
 *
 * 刻意把 `latestState` 也納入：機台窗口內沒資料但仍有歷史 state（例如模擬器剛停），
 * 至少還有「目前狀態」可據以診斷，不視為空。
 */
export function isEmptyContext(context: DiagnosisContext): boolean {
  return (
    context.telemetry === null &&
    context.latestState === "unknown" &&
    context.recentErrors.length === 0 &&
    context.maintenance.length === 0
  );
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
