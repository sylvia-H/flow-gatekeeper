import { compose, docker } from "./compose.js";

/**
 * 容器內故障注入與後端證據讀取（012 FR-046／FR-047；plan「e2e harness 需要新增的 helper」）。
 *
 * 全部經 `compose()`（同一組 `-p flow-gatekeeper-e2e`／`-f`），不碰使用者的 demo／dev infra。
 *
 * 時間刻度：本檔所有 `after`／`from`／`to` 與回傳的時間戳都是 **epoch 毫秒**（`Date.now()` 刻度），日誌那端取
 * pino 每行自帶的 `time` 欄位（容器內的 `Date.now()`，worker 的 createLogger 未改 pino 預設 timestamp）。
 * 唯一拿 host 時間比日誌時間的是 `nextMetricsSummary(after)` 的 `after`（假設 host 與 Docker VM 時鐘大致同步，
 * 容忍範圍見該函式）；`cacheCounters(from, to)` 的兩個窗界都取自 `nextMetricsSummary` 的回傳值，
 * `workerReadyAt` 以則數基線判定、`W` 的起點取 `workerExitedAt`（Docker VM 時鐘），都只用容器側時間。
 * 與 `ParsedMessage.receivedAt`（`performance.now()`，單調時鐘）不是同一刻度，不可互相比較。
 *
 * 與 tasks T022 文字的兩處偏離（2026-10-21 交叉審查後協調者採納）：
 * - 日誌時間取 pino 每行自帶的 `time`，不加 `compose logs --timestamps`：兩者同為容器側時鐘，`time` 是毫秒整數，
 *   免解析奈秒 RFC3339 前綴；解析時仍容許前綴存在。
 * - `pubsubKillLoop` 的 Redis 密碼以 `REDISCLI_AUTH` 環境變數傳給 `redis-cli`，不用 `-a`：`-a` 會讓密碼出現在
 *   容器行程參數（`ps`／`docker top` 可見），與 docker-compose.yml healthcheck 的做法一致（第三輪審查 P1 即 Redis 密碼外洩）。
 */

/** 資料庫名：與 `apps/worker/.env.example`、`apps/api/.env.demo.example` 的 `MONGO_DB` 一致（e2e 只吃這兩份範本）。 */
export const MONGO_DB = "flow-gatekeeper";

/** worker 日誌中本 harness 會讀的訊息（apps/worker/src/main.ts、processor.ts、lib/metrics-collector.ts）。 */
export const LOG_MSG = {
  llmCall: "LLM call",
  workerReady: "worker ready",
  metricsSummary: "worker metrics summary",
} as const;

/** 一則 pino JSON 日誌：保證有 `time`（epoch ms）與 `msg`，其餘欄位（`jobId`、`cache`…）原樣保留。 */
export type LogEntry = Record<string, unknown> & { time: number; msg: string };

/**
 * 解析 `docker compose logs` 輸出為 pino JSON 行。每列從第一個 `{` 起 parse，故有無 compose 的服務名前綴
 * （`worker-1  | `）或 `--timestamps` 前綴都吃；非 JSON 列（Node 警告、stack 片段）與缺 `time`／`msg` 的物件略過。
 */
export function parseLogLines(stdout: string): LogEntry[] {
  const entries: LogEntry[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const start = line.indexOf("{");
    if (start < 0) continue;
    let value: unknown;
    try {
      value = JSON.parse(line.slice(start));
    } catch {
      continue;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const obj = value as Record<string, unknown>;
    const time = typeof obj.time === "number" ? obj.time : typeof obj.time === "string" ? Date.parse(obj.time) : NaN;
    if (!Number.isFinite(time) || typeof obj.msg !== "string") continue;
    entries.push({ ...obj, time, msg: obj.msg });
  }
  return entries;
}

/** 該 jobId 的 `LLM call` 則數（processor 在 cache miss、真的要打 provider 前記一則）。 */
export function countLlmCallsIn(entries: readonly LogEntry[], jobId: string): number {
  return entries.filter((e) => e.msg === LOG_MSG.llmCall && e.jobId === jobId).length;
}

/** `after` 之後（嚴格大於）第一則訊息為 `msg` 的日誌時間戳；沒有則 undefined。 */
export function firstLogAfter(entries: readonly LogEntry[], msg: string, after: number): number | undefined {
  let best: number | undefined;
  for (const e of entries) {
    if (e.msg === msg && e.time > after && (best === undefined || e.time < best)) best = e.time;
  }
  return best;
}

/**
 * 加總時間落在 `(from, to]` 的 `worker metrics summary` 之 `cache.hits + cache.misses`。
 * 每則摘要是「該窗內」的計數（結算後歸零，lib/metrics-collector.ts），所以窗界之間逐則加總才是區間合計；
 * 欄位缺漏或非數字的摘要以 0 計。
 */
export function sumCacheCounters(entries: readonly LogEntry[], from: number, to: number): number {
  let total = 0;
  for (const e of entries) {
    if (e.msg !== LOG_MSG.metricsSummary || e.time <= from || e.time > to) continue;
    const cache = e.cache;
    if (typeof cache !== "object" || cache === null) continue;
    const { hits, misses } = cache as { hits?: unknown; misses?: unknown };
    total += (typeof hits === "number" ? hits : 0) + (typeof misses === "number" ? misses : 0);
  }
  return total;
}

/** 讀 worker 全部日誌（含 kill／stop 後同一容器的前幾輪輸出），解析為 pino 行。 */
export async function readWorkerLogs(): Promise<LogEntry[]> {
  const { stdout } = await compose(["logs", "--no-color", "--no-log-prefix", "worker"], { timeoutMs: 60_000 });
  return parseLogLines(stdout);
}

/** 每 1 s 重讀 worker 日誌直到 `find` 有值；逾時 reject。 */
async function pollWorkerLogs<T>(
  find: (entries: LogEntry[]) => T | undefined,
  timeoutMs: number,
  what: string,
): Promise<T> {
  const started = Date.now();
  for (;;) {
    const found = find(await readWorkerLogs());
    if (found !== undefined) return found;
    if (Date.now() - started >= timeoutMs) throw new Error(`等待 worker 日誌「${what}」逾時（${timeoutMs}ms）`);
    await new Promise((r) => setTimeout(r, 1_000));
  }
}

/** 該 jobId 在 worker 日誌中的 `LLM call` 則數（SC-004：恰 1）。 */
export async function countLlmCalls(jobId: string): Promise<number> {
  return countLlmCallsIn(await readWorkerLogs(), jobId);
}

/** 依時間排序後第 `n` 則（1 起算）訊息為 `msg` 的日誌時間戳；不足 `n` 則時 undefined。 */
export function nthLogTime(entries: readonly LogEntry[], msg: string, n: number): number | undefined {
  const times = entries
    .filter((e) => e.msg === msg)
    .map((e) => e.time)
    .sort((a, b) => a - b);
  return n >= 1 ? times[n - 1] : undefined;
}

/** 目前 worker 日誌中 `worker ready` 的則數——kill／stop worker **之前**先取，作為 `workerReadyAt` 的基線。 */
export async function workerReadyBaseline(): Promise<number> {
  return (await readWorkerLogs()).filter((e) => e.msg === LOG_MSG.workerReady).length;
}

/**
 * 等到 `worker ready` 則數超過 `baseline`（即 kill 之後重新起來的那一次），回第 `baseline + 1` 則的時間戳
 * （容器時鐘）。以則數判定、不拿 host 的 `Date.now()` 比日誌時間，host 與 Docker VM 時鐘有差也不會誤判。
 *
 * 場景 3a／3b 記錄 worker 冷啟動 `W`（plan 風險 1：含 compose 重啟延遲）時，用同為容器側時鐘的
 * `workerExitedAt()` 當起點：`W = await workerReadyAt(baseline) - await workerExitedAt()`。
 */
export async function workerReadyAt(baseline: number, timeoutMs = 120_000): Promise<number> {
  return pollWorkerLogs(
    (entries) => nthLogTime(entries, LOG_MSG.workerReady, baseline + 1),
    timeoutMs,
    `第 ${baseline + 1} 則 ${LOG_MSG.workerReady}`,
  );
}

/**
 * 解析 Docker 的 RFC3339 時間（`docker inspect` 的 `State.StartedAt`／`FinishedAt`，小數秒可到奈秒）為 epoch ms；
 * 小數截到毫秒。Docker 以 `0001-01-01T00:00:00Z` 表示「從未發生」，與格式不符者一樣回 NaN。
 */
export function parseDockerTime(value: string): number {
  const m = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d+))?(Z|[+-]\d\d:\d\d)$/.exec(value.trim());
  if (!m || m[1]?.startsWith("0001-")) return NaN;
  const frac = (m[2] ?? "").padEnd(3, "0").slice(0, 3);
  return Date.parse(`${m[1]}.${frac}${m[3]}`);
}

/**
 * worker 容器上一次結束（被 SIGKILL／stop）的時刻（`docker inspect` 的 `State.FinishedAt`，Docker VM 時鐘、與日誌
 * `time` 同一側）。compose 依 restart policy 重啟同一容器後此值仍保留到下一次結束，故在重啟後讀即可。
 */
export async function workerExitedAt(): Promise<number> {
  const { stdout: ids } = await compose(["ps", "-a", "-q", "worker"], { timeoutMs: 15_000 });
  const id = ids.split(/\r?\n/).find((l) => l.trim() !== "")?.trim();
  if (id === undefined) throw new Error("找不到 worker 容器");
  const { stdout } = await docker(["inspect", "-f", "{{.State.FinishedAt}}", id], { timeoutMs: 15_000 });
  const t = parseDockerTime(stdout);
  if (!Number.isFinite(t)) throw new Error(`worker 容器沒有結束紀錄（State.FinishedAt=${stdout.trim()}）`);
  return t;
}

/**
 * 等到 `after`（epoch ms）之後第一則 `worker metrics summary`，回其時間戳，作為 `cacheCounters` 的窗界。
 * e2e override 把 `METRICS_INTERVAL_MS` 設 5000，正常最多等 5 s；預設逾時留到 4 個週期。
 * `after` 若是 host 的 `Date.now()`：容器時鐘落後 host 超過約 15 s（逾時 20 s 減一個 5 s 週期）時會等不到而逾時；
 * 超前時則可能取到 host 時間上稍早的那一則（窗界提前，最多一個週期）。
 */
export async function nextMetricsSummary(after: number, timeoutMs = 20_000): Promise<number> {
  return pollWorkerLogs(
    (entries) => firstLogAfter(entries, LOG_MSG.metricsSummary, after),
    timeoutMs,
    LOG_MSG.metricsSummary,
  );
}

/**
 * 窗界 `(from, to]` 之間所有 `worker metrics summary` 的 `cache.hits + cache.misses` 合計（SC-004：恰 1）。
 * `from`／`to` 應取自 `nextMetricsSummary` 的回傳值。MUST NOT 改用 `system/metrics` 前後兩次相減：那是窗內值、
 * 結算後歸零，且 Redis 停頓期間快照寫不進去（spec FR-046）。
 */
export async function cacheCounters(from: number, to: number): Promise<number> {
  return sumCacheCounters(await readWorkerLogs(), from, to);
}

/** jobId 只允許 UUID／BullMQ id 會用到的字元：要內嵌進 mongosh `--eval` 的 JS 字串。 */
function assertSafeJobId(jobId: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(jobId)) throw new Error(`jobId 含非預期字元：${JSON.stringify(jobId)}`);
}

/** `diagnosisTriggers` 中該 jobId 的筆數（SC-004：恰 1；trigger 以 upsert 冪等寫入）。 */
export async function countTriggers(jobId: string): Promise<number> {
  assertSafeJobId(jobId);
  // JS 字串用單引號：Windows 上 spawn 會把內嵌雙引號跳脫，單引號免掉一層引號規則
  const { stdout } = await compose(
    [
      "exec",
      "-T",
      "mongo",
      "mongosh",
      "--quiet",
      MONGO_DB,
      "--eval",
      `db.diagnosisTriggers.countDocuments({ jobId: '${jobId}' })`,
    ],
    { timeoutMs: 30_000 },
  );
  return parseMongoshCount(stdout);
}

/**
 * 從 `mongosh --quiet --eval` 輸出取 countDocuments 的整數：由尾往前找第一個「整列只有非負整數」的列，
 * 容許前置雜訊列與尾端警告列（例如 mongosh 的 deprecation／更新提示）；找不到時拋錯並附輸出尾段。
 */
export function parseMongoshCount(stdout: string): number {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i] ?? "";
    if (/^\d+$/.test(l)) return Number(l);
  }
  throw new Error(`mongosh countDocuments 輸出找不到整數：${stdout.slice(-300)}`);
}

export interface PubsubKillSummary {
  /** 迴圈跑了幾輪（每輪一次 `CLIENT KILL TYPE pubsub`）。 */
  iterations: number;
  /** 累計被踢掉的 pubsub 連線數（各輪 `CLIENT KILL` 回傳值加總）；> 0 才代表故障真的注入到 api／worker。 */
  killed: number;
}

/**
 * 在 redis 容器內執行的 sh 迴圈（research P19：Windows 上每次 `docker exec` 數百 ms，做不到 50 ms 間隔，
 * 故整段迴圈放進容器）。跑到 `date +%s` 超過起點＋`seconds`，實際時長落在 `(seconds, seconds + 1]`。
 *
 * - 密碼：redis 容器 env 有 `REDIS_PASSWORD` 時匯出 `REDISCLI_AUTH`（與 docker-compose.yml healthcheck 同法，
 *   不把密碼放進 `-a` 行程參數）；沒有時不匯出——對無認證的 redis 送 AUTH "" 會被拒。
 * - 單行、不含雙引號：經 Windows `spawn` 傳參時不必處理內嵌引號跳脫。
 * - `redis-cli` 失敗（輸出非數字）該輪以 0 計，不中斷迴圈。
 */
export function pubsubKillScript(seconds: number): string {
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 600) {
    throw new Error(`pubsubKillLoop 秒數須為 1–600 的整數，實得 ${seconds}`);
  }
  return [
    `end=$(( $(date +%s) + ${seconds} ))`,
    "i=0",
    "killed=0",
    "case ${REDIS_PASSWORD:-} in '') ;; *) export REDISCLI_AUTH=$REDIS_PASSWORD ;; esac",
    "while [ $(date +%s) -le $end ]; do n=$(redis-cli CLIENT KILL TYPE pubsub 2>/dev/null); case $n in ''|*[!0-9]*) n=0 ;; esac; killed=$((killed + n)); i=$((i + 1)); sleep 0.05; done",
    "echo pubsub-kill-loop iterations=$i killed=$killed",
  ].join("; ");
}

/** 解析 `pubsubKillScript` 的結尾輸出行；找不到時拋錯（代表迴圈沒有正常跑完）。 */
export function parsePubsubKillOutput(stdout: string): PubsubKillSummary {
  const m = /pubsub-kill-loop iterations=(\d+) killed=(\d+)/.exec(stdout);
  if (!m) throw new Error(`pubsubKillLoop 未輸出結尾摘要：${stdout.slice(-300)}`);
  return { iterations: Number(m[1]), killed: Number(m[2]) };
}

/**
 * 在 redis 容器內每 50 ms `CLIENT KILL TYPE pubsub`，持續 `seconds` 秒（場景 5，SC-002）。
 * 呼叫即開始（背景執行），回傳的 Promise 在迴圈結束時 resolve 為摘要；場景結束前 MUST await 它。
 */
export async function pubsubKillLoop(seconds: number): Promise<PubsubKillSummary> {
  // async 函式的同步段會立即 spawn `docker compose exec`：呼叫端不 await 也已開始注入
  const run = compose(["exec", "-T", "redis", "sh", "-c", pubsubKillScript(seconds)], {
    timeoutMs: (seconds + 30) * 1_000,
  });
  return parsePubsubKillOutput((await run).stdout);
}
