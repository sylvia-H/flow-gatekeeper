import { MongoServerError } from "mongodb";
import type { Collection, Db } from "mongodb";
import { DiagnosisResultSchema } from "@flow-gatekeeper/contracts";
import type { DiagnosisResult } from "@flow-gatekeeper/contracts";

/**
 * processor 對 Mongo 的寫入需求（diagnoses／diagnosisTriggers）。抽成介面讓 processor
 * 的單元測試以 in-memory fake 取代真 Mongo。
 */
export interface DiagnosisRepository {
  /** 寫入最終診斷；同一 jobId 重複寫入（重試）視為成功、不覆寫。 */
  insertDiagnosis(doc: { machineId: string; jobId: string; result: DiagnosisResult }): Promise<void>;
  /**
   * 每個 jobId 恰一筆輕量稽核（成功：cached true／false；最終失敗：cached false），**先寫者勝**（012 FR-025）：
   * `updateOne({ jobId }, { $setOnInsert }, { upsert: true })`，已有紀錄時不覆寫；併發 upsert 撞 E11000 視為成功（P10）。
   */
  upsertTrigger(doc: { machineId: string; jobId: string; requestedBy: string; cached: boolean }): Promise<void>;
  /**
   * 冪等短路 (ii)（012 FR-024、D6）：以 jobId 查 LLM 路徑已落地的診斷，讀回經 `DiagnosisResultSchema.safeParse`；
   * 查無或不合法都回 null；不合法時另呼叫 `onInvalid`，由呼叫端以自己的 logger（含 machineId 等綁定）記 warn。
   */
  findDiagnosisResult(jobId: string, onInvalid?: () => void): Promise<DiagnosisResult | null>;
}

/** Mongo duplicate key。 */
const DUPLICATE_KEY = 11000;

/** 索引衝突類錯誤：E11000（既有資料重複）、85 IndexOptionsConflict、86 IndexKeySpecsConflict。 */
const INDEX_CONFLICT_CODES = new Set([DUPLICATE_KEY, 85, 86]);

/** IndexNotFound：要移除的索引已不存在（多副本同時啟動時，另一個副本先移除了）。 */
const INDEX_NOT_FOUND = 27;

/** diagnosisTriggers 保留天數：只是輕量稽核，不需永久保存，無限增長反而拖慢查詢。 */
export const TRIGGER_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface IndexLogger {
  error(obj: unknown, msg?: string): void;
}

function mongoCode(err: unknown): number | undefined {
  return err instanceof MongoServerError && typeof err.code === "number" ? err.code : undefined;
}

function isIndexConflict(err: unknown): boolean {
  const code = mongoCode(err);
  return code !== undefined && INDEX_CONFLICT_CODES.has(code);
}

/**
 * 建立 diagnoses／diagnosisTriggers 所需索引。兩個集合的 `{ jobId: 1 }` unique 走同一套邏輯（`ensureUniqueJobIdIndex`）。
 * `diagnosisTriggers.jobId` unique 是「每個 jobId 恰一筆 trigger」的第二道保證（第一道是 upsert，012 FR-025）；
 * 退回非 unique 時 upsert 仍冪等，只是併發 upsert 的極窄窗口可能多一筆。
 *
 * `diagnoses.jobId` unique 擋的是**雙重執行的併發 insert**（012 起）：同 jobId 的重試與重派先走 processor 開頭的
 * 冪等短路——diagnoses 已有就由短路 (ii) 沿用、不再 insert；但 stalled 重派時舊執行可能還活著，兩者都可能走到
 * insert（例如短路 (i) 補寫與舊執行的寫庫同時發生），此時後到者撞 unique、被視為成功，不會多出重複的診斷紀錄。
 * 連帶語意：同一個 jobId 在 BullMQ 清掉已完成 job（約 1h）後被重送時，短路 (ii) 直接回舊結果、不重新診斷。
 *
 * 既有資料若已有重複 jobId（或同名索引選項不同），建 unique 會失敗；若因此讓 bootstrap exit 1，
 * worker 會進 restart loop、整個 AI 功能停擺。所以衝突時記 error 並退回非 unique 索引——insert
 * 仍以 11000 判定冪等，只是此時不再有保證，需人工清理重複資料後重啟以恢復 unique。
 *
 * 恢復路徑：退回時建立的非 unique `{ jobId: 1 }` 索引會以同鍵擋住下次的 unique 建立（85/86），
 * 若不處理，清完重複資料重啟也永遠回不到 unique。所以遇到衝突且存在這種同鍵非 unique 索引時，
 * 先移除它再建一次 unique；仍失敗（重複資料還在）才再退回。
 *
 * 移除前先探測是否仍有重複 jobId：重複資料未清就 drop → 重建 unique（全表掃描後撞 11000）→
 * 再建非 unique（又一次掃描），每次重啟都白做兩次索引重建，還讓 `{ jobId: 1 }` 有一段沒有索引。
 * 探測到重複就保留既有索引、只記 error。「列索引 → drop → 重建」不是原子操作，多副本同時啟動
 * 會互相踩到：drop 撞 IndexNotFound（27）代表別的副本已先移除；重建撞 85/86 但此時已存在 unique
 * 的 jobId 索引，代表別的副本已先建好——兩者都是目的已達成，不該退回非 unique 或記 error。
 */
export async function ensureDiagnosisIndexes(db: Db, log: IndexLogger): Promise<void> {
  const diagnoses = db.collection("diagnoses");
  await diagnoses.createIndex({ machineId: 1, createdAt: -1 });
  await ensureUniqueJobIdIndex(diagnoses, "diagnoses", log);
  await ensureTriggerIndexes(db, log);
}

/**
 * 沒有 unique 時各集合失去的保證（日誌措辭）：diagnoses 失去「併發 insert 只留一筆」；diagnosisTriggers 的 upsert 本身
 * 仍冪等，只剩併發 upsert 的窄窗口可能多一筆。
 */
const FALLBACK_CONSEQUENCE: Record<string, string> = {
  diagnoses: "雙重執行併發寫入時可能多出重複的診斷紀錄",
  diagnosisTriggers: "trigger 的 upsert 仍冪等，只剩併發 upsert 的窄窗口可能多一筆",
};

/** `label` 為日誌中的集合名（`diagnoses`／`diagnosisTriggers`）。 */
async function ensureUniqueJobIdIndex(coll: Collection, label: string, log: IndexLogger): Promise<void> {
  const consequence = FALLBACK_CONSEQUENCE[label] ?? "冪等不再有保證";
  const createUnique = () => tryCreateIndex(coll, { jobId: 1 }, { unique: true });
  let lastErr = await createUnique();
  if (lastErr === undefined) return;

  // 11000 是資料重複、沒有索引擋路，直接退回；85/86 才需要看是哪個同鍵索引擋住。
  if (mongoCode(lastErr) !== DUPLICATE_KEY) {
    const existing = await findJobIdIndex(coll);
    if (existing?.unique === true) return; // 已有 unique（不同名、或另一副本剛建好）
    if (existing) {
      if (await hasDuplicateJobIds(coll)) {
        log.error(
          { err: lastErr, collection: label },
          `${label}.jobId 仍有重複資料，保留既有的非 unique 索引（${consequence}）；清理後重啟即恢復 unique`,
        );
        return;
      }
      await dropIndexIfExists(coll, existing.name);
    }
    // 擋路的索引已移除（由本副本或併發副本），再建一次。
    lastErr = await createUnique();
    if (lastErr === undefined) return;
    if (mongoCode(lastErr) !== DUPLICATE_KEY && (await findJobIdIndex(coll))?.unique === true) return;
  }

  log.error(
    { err: lastErr, collection: label },
    `${label}.jobId unique 索引建立失敗（既有重複資料或索引衝突），退回非 unique 索引；${consequence}`,
  );
  await tryCreateIndex(coll, { jobId: 1 });
}

/** 建索引；索引衝突類錯誤以回傳值交還呼叫端判斷，其餘（連線失敗等）照拋。 */
async function tryCreateIndex(
  coll: Collection,
  key: Record<string, 1 | -1>,
  opts?: { unique: true },
): Promise<unknown> {
  try {
    await (opts ? coll.createIndex(key, opts) : coll.createIndex(key));
    return undefined;
  } catch (err) {
    if (!isIndexConflict(err)) throw err;
    return err;
  }
}

/**
 * 找出鍵恰為 `{ jobId: 1 }` 的索引。同名索引（預設 `jobId_1`）選項不同時 Mongo 回 85／86；但 2026-09-27
 * 整合測試實測 Mongo 7：**不同名**的非 unique `{ jobId: 1 }` 與 unique 索引可以並存（此時重複資料撞的是
 * 11000、不是 85）。因此同鍵有多個時**優先回傳 unique 者**——只要有任一 unique 就代表目的已達成，
 * 不能因為列在前面的是非 unique 舊索引，就去 drop 它再重建。
 */
async function findJobIdIndex(coll: Collection): Promise<{ name: string; unique: boolean } | undefined> {
  const sameKey = (await coll.indexes()).filter((i) => isJobIdOnlyKey(i.key) && typeof i.name === "string");
  const ix = sameKey.find((i) => i.unique === true) ?? sameKey[0];
  return ix?.name ? { name: ix.name, unique: ix.unique === true } : undefined;
}

async function hasDuplicateJobIds(coll: Collection): Promise<boolean> {
  const dup = await coll
    .aggregate([
      { $group: { _id: "$jobId", n: { $sum: 1 } } },
      { $match: { n: { $gt: 1 } } },
      { $limit: 1 },
    ])
    .toArray();
  return dup.length > 0;
}

async function dropIndexIfExists(coll: Collection, name: string): Promise<void> {
  try {
    await coll.dropIndex(name);
  } catch (err) {
    if (mongoCode(err) !== INDEX_NOT_FOUND) throw err;
  }
}

/** 索引鍵是否恰為 `{ jobId: 1 }`（排除以 jobId 開頭的複合索引）。 */
function isJobIdOnlyKey(key: unknown): boolean {
  if (!key || typeof key !== "object") return false;
  const entries = Object.entries(key as Record<string, unknown>);
  return entries.length === 1 && entries[0]?.[0] === "jobId" && entries[0]?.[1] === 1;
}

async function ensureTriggerIndexes(db: Db, log: IndexLogger): Promise<void> {
  const triggers = db.collection("diagnosisTriggers");
  await triggers.createIndex({ machineId: 1, createdAt: -1 });
  try {
    // TTL 索引須為單欄位；欄位與 upsertTrigger 寫入的 createdAt（Date）一致。
    await triggers.createIndex({ createdAt: 1 }, { expireAfterSeconds: TRIGGER_TTL_SECONDS });
  } catch (err) {
    if (!isIndexConflict(err)) throw err;
    log.error({ err }, "diagnosisTriggers TTL 索引建立失敗（既有同鍵索引選項不同），稽核紀錄將不會自動過期");
  }
  await ensureUniqueJobIdIndex(triggers, "diagnosisTriggers", log);
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
    async upsertTrigger({ machineId, jobId, requestedBy, cached }) {
      try {
        await db
          .collection("diagnosisTriggers")
          .updateOne(
            { jobId },
            { $setOnInsert: { machineId, jobId, requestedBy, cached, createdAt: new Date() } },
            { upsert: true },
          );
      } catch (err) {
        // 兩個執行同時 upsert 同一 jobId：unique 索引讓後到者撞 E11000——對方已寫入，目的已達成。
        if (mongoCode(err) === DUPLICATE_KEY) return;
        throw err;
      }
    },
    async findDiagnosisResult(jobId, onInvalid) {
      const doc = await db.collection("diagnoses").findOne({ jobId }, { projection: { _id: 0, result: 1 } });
      if (!doc) return null;
      const checked = DiagnosisResultSchema.safeParse(doc.result);
      if (checked.success) return checked.data;
      onInvalid?.();
      return null;
    },
  };
}
