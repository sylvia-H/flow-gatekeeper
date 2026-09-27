import { MongoServerError } from "mongodb";
import type { Db } from "mongodb";
import type { DiagnosisResult } from "@flow-gatekeeper/contracts";

/**
 * processor 對 Mongo 的寫入需求（diagnoses／diagnosisTriggers）。抽成介面讓 processor
 * 的單元測試以 in-memory fake 取代真 Mongo。
 */
export interface DiagnosisRepository {
  /** 寫入最終診斷；同一 jobId 重複寫入（重試）視為成功、不覆寫。 */
  insertDiagnosis(doc: { machineId: string; jobId: string; result: DiagnosisResult }): Promise<void>;
  /** 每次觸發一筆輕量稽核（含 cache 命中與最終失敗）。 */
  insertTrigger(doc: { machineId: string; jobId: string; requestedBy: string; cached: boolean }): Promise<void>;
}

/** Mongo duplicate key。 */
const DUPLICATE_KEY = 11000;

/** 索引衝突類錯誤：E11000（既有資料重複）、85 IndexOptionsConflict、86 IndexKeySpecsConflict。 */
const INDEX_CONFLICT_CODES = new Set([DUPLICATE_KEY, 85, 86]);

/** diagnosisTriggers 保留天數：只是輕量稽核，不需永久保存，無限增長反而拖慢查詢。 */
export const TRIGGER_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface IndexLogger {
  error(obj: unknown, msg?: string): void;
}

function isIndexConflict(err: unknown): boolean {
  return err instanceof MongoServerError && typeof err.code === "number" && INDEX_CONFLICT_CODES.has(err.code);
}

/**
 * 建立 diagnoses／diagnosisTriggers 所需索引。
 *
 * `diagnoses.jobId` unique 是冪等的前提：processor 先 insert diagnoses 再寫 cache，若寫 cache
 * 失敗而重試，第二次 insert 會撞 unique 而被視為成功，不會多出重複的診斷紀錄。代價：同一個
 * jobId 在 BullMQ 清掉已完成 job（約 1h）後被重送時，新結果也會被當重複吞掉、diagnoses 只留舊的。
 *
 * 既有資料若已有重複 jobId（或同名索引選項不同），建 unique 會失敗；若因此讓 bootstrap exit 1，
 * worker 會進 restart loop、整個 AI 功能停擺。所以衝突時記 error 並退回非 unique 索引——insert
 * 仍以 11000 判定冪等，只是此時不再有保證，需人工清理重複資料後重啟以恢復 unique。
 */
export async function ensureDiagnosisIndexes(db: Db, log: IndexLogger): Promise<void> {
  const diagnoses = db.collection("diagnoses");
  await diagnoses.createIndex({ machineId: 1, createdAt: -1 });
  try {
    await diagnoses.createIndex({ jobId: 1 }, { unique: true });
  } catch (err) {
    if (!isIndexConflict(err)) throw err;
    log.error({ err }, "diagnoses.jobId unique 索引建立失敗（既有重複資料或索引衝突），退回非 unique 索引；重試冪等不再有保證");
    await diagnoses.createIndex({ jobId: 1 }).catch((e: unknown) => {
      if (!isIndexConflict(e)) throw e;
    });
  }

  const triggers = db.collection("diagnosisTriggers");
  await triggers.createIndex({ machineId: 1, createdAt: -1 });
  try {
    // TTL 索引須為單欄位；欄位與 insertTrigger 寫入的 createdAt（Date）一致。
    await triggers.createIndex({ createdAt: 1 }, { expireAfterSeconds: TRIGGER_TTL_SECONDS });
  } catch (err) {
    if (!isIndexConflict(err)) throw err;
    log.error({ err }, "diagnosisTriggers TTL 索引建立失敗（既有同鍵索引選項不同），稽核紀錄將不會自動過期");
  }
}

export function createMongoDiagnosisRepository(db: Db): DiagnosisRepository {
  return {
    async insertDiagnosis({ machineId, jobId, result }) {
      try {
        await db
          .collection("diagnoses")
          .insertOne({ machineId, jobId, cached: false, result, createdAt: new Date() });
      } catch (err) {
        if (err instanceof MongoServerError && err.code === DUPLICATE_KEY) return;
        throw err;
      }
    },
    async insertTrigger({ machineId, jobId, requestedBy, cached }) {
      await db
        .collection("diagnosisTriggers")
        .insertOne({ machineId, jobId, requestedBy, cached, createdAt: new Date() });
    },
  };
}
