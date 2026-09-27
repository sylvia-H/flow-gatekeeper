/**
 * Mongo TTL 維護的判斷邏輯（純函式）。
 *
 * 背景：`expireAfterSeconds` 只在「第一次建立」時生效——collection 已存在（NamespaceExists=48）
 * 或同鍵索引已存在但選項不同（IndexOptionsConflict=85／IndexKeySpecsConflict=86）時，建立呼叫
 * 只會失敗，改了 `TELEMETRY_TTL_SECONDS` 也不會套用。必須改走 `collMod` 才能更新既有 TTL。
 */

/** collection 已存在。 */
export const NAMESPACE_EXISTS = 48;
/** 同鍵索引已存在但選項不同（例如 TTL 秒數不同或原本沒有 TTL）。 */
export const INDEX_OPTIONS_CONFLICT = 85;
/** 同名索引已存在但鍵不同。 */
export const INDEX_KEY_SPECS_CONFLICT = 86;

export function mongoErrorCode(err: unknown): number | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "number" ? code : undefined;
}

export function isIndexConflict(err: unknown): boolean {
  const code = mongoErrorCode(err);
  return code === INDEX_OPTIONS_CONFLICT || code === INDEX_KEY_SPECS_CONFLICT;
}

/** `listCollections` 回傳的最小子集（避免依賴 driver 的完整型別）。 */
export type CollectionInfoLike = {
  type?: string;
  options?: { expireAfterSeconds?: unknown };
};

export type TimeSeriesTtlPlan =
  | { action: "none" }
  | { action: "collMod"; from: number | undefined; to: number }
  | { action: "not-timeseries"; type: string | undefined };

/**
 * 既有 telemetry collection 該怎麼處理 TTL：
 * - 不是 time-series（例如早期被一般 insert 自動建成普通 collection）→ 無法轉換，只能回報；
 * - TTL 已相同 → 不動；
 * - 不同或沒設 → `collMod { expireAfterSeconds }`。
 */
export function planTimeSeriesTtl(
  info: CollectionInfoLike | undefined,
  desiredSeconds: number,
): TimeSeriesTtlPlan {
  if (!info || info.type !== "timeseries") {
    return { action: "not-timeseries", type: info?.type };
  }
  const raw = info.options?.expireAfterSeconds;
  const current = typeof raw === "number" ? raw : undefined;
  if (current === desiredSeconds) return { action: "none" };
  return { action: "collMod", from: current, to: desiredSeconds };
}

/**
 * `insertMany({ ordered: false })` 的錯誤是否**只**含重複鍵（11000）。
 *
 * 重試一批先前部分寫入成功的文件時（driver 會在第一次 insert 時補上 `_id`），已寫入的那幾筆
 * 會撞 11000、其餘照寫——對「至少寫一次」的語意而言這就是成功，不該再算失敗、再重排一次。
 */
export function isOnlyDuplicateKeyError(err: unknown): boolean {
  const e = err as { code?: unknown; writeErrors?: unknown } | null;
  if (!e) return false;
  const writeErrors = e.writeErrors;
  if (Array.isArray(writeErrors)) {
    return (
      writeErrors.length > 0 &&
      writeErrors.every((w) => (w as { code?: unknown } | null)?.code === 11000)
    );
  }
  if (writeErrors && typeof writeErrors === "object") {
    return (writeErrors as { code?: unknown }).code === 11000;
  }
  return e.code === 11000;
}

/** 失敗的 `insertMany` 該怎麼處理。 */
export type InsertFailure =
  /** 網路／選址類：server 沒有逐筆判定，整批都沒寫進去（或無從得知），可以原封重試。 */
  | { kind: "transient" }
  /** server 已逐筆判定：未列在 writeErrors 的已寫入，被拒的重送也只會再被拒——終局，不重試。 */
  | { kind: "terminal"; rejected: number };

/** 視為暫時性、值得重試的 driver 錯誤類別（名稱比對，避免依賴 driver 的 class 實體）。 */
const TRANSIENT_ERROR_NAMES = new Set([
  "MongoNetworkError",
  "MongoNetworkTimeoutError",
  "MongoServerSelectionError",
  "MongoTopologyClosedError",
  "MongoNotConnectedError",
]);

function writeErrorList(err: unknown): unknown[] | undefined {
  const we = (err as { writeErrors?: unknown } | null)?.writeErrors;
  if (Array.isArray(we)) return we as unknown[];
  if (we && typeof we === "object") return [we];
  return undefined;
}

/**
 * bulk 錯誤是否為 write concern 失敗（duck typing，不依賴 driver 的 class 實體）：
 * driver 把 `WriteConcernError` 放在 `err`（server 回應層），或只留在 `result.getWriteConcernError()`
 * （複製確認逾時被當成 `MongoWriteConcernError` 拋出、再包成 bulk 錯誤的那條路徑）。
 */
function hasWriteConcernError(err: unknown): boolean {
  const e = err as { err?: unknown; result?: { getWriteConcernError?: unknown } } | null;
  if (e?.err && typeof e.err === "object") return true;
  const getter = e?.result?.getWriteConcernError;
  return typeof getter === "function" && getter.call(e?.result) != null;
}

/**
 * 分類 `insertMany({ ordered: false })` 的失敗，區分「可重試」與「毒批次」。
 *
 * 只有網路／選址類錯誤（沒有 writeErrors，且是上列錯誤類別或帶 RetryableWriteError 標籤）才重試；
 * 其餘——帶 writeErrors（例如 121 文件驗證失敗）、或 server 直接拒絕整個指令（例如 10334
 * 文件過大）——都是同一批重送也必定再失敗的終局錯誤，重試只會每秒重送同一批直到永遠。
 * `rejected` 為這批中未寫入的筆數（重複鍵 11000 視為已寫入）。
 *
 * driver 6.x 的 `insertMany` 內部走 `bulkWrite`：連網路／選址失敗也會被包成
 * `MongoBulkWriteError`，帶**空的** `writeErrors: []`，原始錯誤放在 `errorResponse`。
 * 空陣列代表 server 根本沒有逐筆判定，不能當成毒批次——要拆開看原始錯誤才分得出能否重試。
 *
 * write concern 失敗（replica set 下 `w: majority` 逾時等）也是 `writeErrors: []`，但語意相反：
 * 文件已套用在 primary、只是複製確認未達標。不該計成遺失（會高估 droppedErrorLogs），也不必重試
 * （driver 已補 `_id`，重送只會整批撞 11000）——視為已寫入、終局。
 */
export function classifyInsertFailure(err: unknown, batchSize: number): InsertFailure {
  const writeErrors = writeErrorList(err);
  if (writeErrors && writeErrors.length > 0) {
    const rejected = writeErrors.filter(
      (w) => (w as { code?: unknown } | null)?.code !== 11000,
    ).length;
    return { kind: "terminal", rejected };
  }
  if (writeErrors && hasWriteConcernError(err)) {
    return { kind: "terminal", rejected: 0 };
  }
  const inner = (err as { errorResponse?: unknown } | null)?.errorResponse;
  if (
    writeErrors &&
    inner !== err &&
    typeof inner === "object" &&
    inner !== null &&
    typeof (inner as { name?: unknown }).name === "string"
  ) {
    return classifyInsertFailure(inner, batchSize);
  }
  const e = err as { name?: unknown; errorLabels?: unknown } | null;
  const name = typeof e?.name === "string" ? e.name : "";
  const labels = Array.isArray(e?.errorLabels) ? e.errorLabels : [];
  if (TRANSIENT_ERROR_NAMES.has(name) || labels.includes("RetryableWriteError")) {
    return { kind: "transient" };
  }
  return { kind: "terminal", rejected: batchSize };
}
