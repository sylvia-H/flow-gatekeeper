import { randomUUID } from "node:crypto";
import { DelayedError, UnrecoverableError } from "bullmq";
import { z } from "zod";
import { DiagnosisResultSchema } from "@flow-gatekeeper/contracts";
import type {
  AiStreamEvent,
  DiagnosisJobPayload,
  DiagnosisJobProgress,
  DiagnosisJobReturnValue,
  DiagnosisResult,
} from "@flow-gatekeeper/contracts";
import { AiProviderError } from "./ai/provider.js";
import type { AiProvider, AiStreamResult } from "./ai/provider.js";
import { buildPrompt, PROMPT_VERSION } from "./ai/prompt.js";
import {
  AI_FAIL_TTL_SECONDS,
  AI_METRIC_TTL_SECONDS,
  AI_RESULT_TTL_SECONDS,
  aiFailKey,
  aiMetricKey,
  aiResultKey,
} from "./cache/job-keys.js";
import { buildDiagnosisSignature } from "./cache/signature.js";
import type { ProcessorStore } from "./cache/redis-store.js";
import { isEmptyContext } from "./context/context-builder.js";
import type { DiagnosisContext } from "./context/context-builder.js";
import type { DiagnosisRepository } from "./diagnosis-repository.js";
import { KEEPALIVE_INTERVAL_MS } from "./lib/bullmq-options.js";
import { createKeepalive } from "./lib/keepalive.js";
import type { LivenessTracker } from "./lib/liveness.js";
import type { MetricsCollector } from "./lib/metrics-collector.js";
import { parseResult } from "./lib/parse-result.js";
import { DIAGNOSIS_RESULT_JSON_SCHEMA } from "./lib/zod-json-schema.js";

/**
 * 診斷 job processor（自 main.ts 抽出，以依賴注入讓並發／重試語意可單元測試）。
 *
 * 流程：冪等短路（`ai-result:<jobId>` → `diagnoses`，命中即補寫並回 ai/done(cached:false)）
 *   → context → signature → cache 命中寫 trigger 後回 ai/done(cached:true)；未命中取 `ai-lock` 去重
 *   → 取鎖後**再查一次 cache**（等待者搶到鎖時，前一個持鎖者多半已寫好結果）→ LLM 限流窗
 *   → AiProvider 串流（token → Pub/Sub `ai-stream:<jobId>`，逾時以 AbortSignal 真正中止）
 *   → parseResult → 暫存 ai-result → 寫 diagnoses → DEL 暫存 → 寫 cache → 寫 trigger → ai/done(cached:false)。
 * 取鎖迴圈每輪開頭與取鎖後（限流前）查 `ai-fail:<sig>`：同簽章剛在 LLM 階段失敗就以同 code 失敗、不再打 LLM（D5）。
 * 每次執行以 keepalive 保證閒置 10 s 至少補送一則 progress（D2）。
 * 同 jobId 的任何再執行對外結果一致：同一個 result、同一筆 trigger（upsert）、hit／miss 只計一次（ADR-003 D6）。
 * 成功時兩條路徑都在 ai/done 之後回傳 `DiagnosisJobReturnValue { result, cached }`（BullMQ `returnvalue`，
 * 經 QueueEvents `completed` 成為權威完成訊號；ai/done 降為 best-effort，ADR-003 D1）。
 *
 * 重試語意：非最終嘗試的失敗只記 log 後 throw（交給 BullMQ 退避重試），**不** publish
 * `ai/error`——否則前端收到錯誤即轉 failed，之後重試即使成功畫面也停在錯誤。最終嘗試（或
 * 不可重試的錯誤）才 publish `ai/error`。所有事件都帶 `attempt`，前端據此在換輪時清空 token。
 * 終態事件（`ai/done`、`ai/error`）一律 await 到 PUBLISH 完成才收尾，`ai/token` 維持 fire-and-forget
 * （見 `publishTerminalEvent`）。
 * worker 不直接 emit WebSocket（憲章 IV）：一律經 Redis Pub/Sub 由 Gateway 轉發。
 */

/** processor 用到的 BullMQ Job 子集（BullMQ 的 `Job<DiagnosisJobPayload>` 結構上相容）。 */
export interface ProcessorJob {
  readonly data: DiagnosisJobPayload;
  readonly attemptsMade: number;
  /**
   * BullMQ 於每次 `moveToActive` 遞增（含 stalled 重派與 `moveToDelayed` 後再執行），處理中的值 ≥ 1；
   * 012 用作 `DiagnosisJobProgress.execution`（讀到 0 時以 1 代入，research R8）。
   */
  readonly attemptsStarted: number;
  readonly opts: { attempts?: number };
  /**
   * 只接受 `DiagnosisJobProgress` 物件（012 FR-020）：型別擋下退回純數字的寫法——api relay 與 GET 雖仍相容舊 worker 的數字，
   * 但數字不帶 attempt／execution，web 就無法判斷換輪。BullMQ 的 `Job.updateProgress(JobProgress)` 結構上相容。
   */
  updateProgress(progress: DiagnosisJobProgress): Promise<void>;
  moveToDelayed(timestamp: number, token?: string): Promise<void>;
}

/** 與 pino Logger 結構相容的最小介面（測試可用 fake）。 */
export interface ProcessorLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
  child(bindings: Record<string, unknown>): ProcessorLogger;
}

export interface Publisher {
  publish(channel: string, message: string): Promise<unknown>;
}

export interface ProcessorConfig {
  aiTimeoutMs: number;
  lockTtlSeconds: number;
  cacheTtlSeconds: number;
  /** 每分鐘實際 LLM 呼叫上限。 */
  aiRpm: number;
  /** dedupe 等待輪詢間隔（預設 300ms）。 */
  pollIntervalMs?: number;
}

export interface ProcessorDeps {
  store: ProcessorStore;
  publisher: Publisher;
  repo: DiagnosisRepository;
  ai: AiProvider;
  buildContext: (args: { machineId: string; windowMinutes: number }) => Promise<DiagnosisContext>;
  logger: ProcessorLogger;
  metrics: Pick<MetricsCollector, "recordCacheHit" | "recordCacheMiss" | "recordLatency">;
  config: ProcessorConfig;
  /** worker 收到關閉訊號後為 true：dedupe 等待迴圈據此提早把 job 交回佇列。 */
  isClosing?: () => boolean;
  liveness?: LivenessTracker;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_POLL_INTERVAL_MS = 300;
const RATE_WINDOW_MS = 60_000;
const RATE_JITTER_MS = 2000;
/** 關閉中交回佇列時的延遲：給其他副本（或重啟後的本副本）接手的緩衝。 */
const CLOSING_REQUEUE_DELAY_MS = 1000;

/**
 * `diagnoses` 寫入失敗（012 FR-027；代理裁決第 18 條）：訊息為固定英文句，Mongo 原始錯誤只進日誌的 `err` 欄位——
 * 這句會成為 BullMQ `failedReason` 與 `ai/error.message`，web 以 `persist_failed` 字樣對應文案。
 */
export const PERSIST_FAILED_CODE = "persist_failed";
export const PERSIST_FAILED_MESSAGE = "persist_failed: diagnosis record could not be written";

/**
 * `ai-fail:<sig>` 負向標記（012 FR-028；ADR-003 D5；research R7）。寫讀都在 worker 同一份程式碼，不是 api↔worker 傳輸，
 * 故不進 contracts（P9）。讀回不合法 → DEL 並視為無標記。
 */
export const AiFailMarkerSchema = z.object({
  code: z.string().min(1),
  message: z.string(),
  jobId: z.string().min(1),
  at: z.string(),
});
export type AiFailMarker = z.infer<typeof AiFailMarkerSchema>;

/** 冪等短路命中的來源（info `idempotent short-circuit` 的 `source` 欄位；e2e 場景 7 印出）。 */
export type IdempotentSource = "ai-result" | "diagnoses";

/** 空脈絡短路的錯誤碼與訊息（前端 humanizeError 對短訊息原文照顯）。 */
export const NO_CONTEXT_CODE = "no_context";
export const NO_CONTEXT_MESSAGE = "此機台近期沒有遙測、異常事件或維修紀錄，無資料可供診斷（未呼叫 AI）";

/**
 * 是否為空脈絡短路的終態失敗（main.ts failed handler 據此降為 warn）。以訊息比對而非自訂子類別：
 * 子類別會改掉 `name`，BullMQ 的 `err.name == 'UnrecoverableError'` 後備判斷就失效。
 */
export function isNoContextFailure(err: Error): boolean {
  return err.message === NO_CONTEXT_MESSAGE;
}

/**
 * 發布 AI 串流事件到 Redis Pub/Sub。參數型別是契約的 `AiStreamEvent`，漏帶 `attempt`
 * 之類的必填欄位會在 typecheck 就被擋下。
 *
 * fire-and-forget（只給 `ai/token` 用），但在源頭接住 publish 失敗並記 log：單筆 token 發布失敗不該拖垮整個 worker
 * ——若放任成浮空 rejection，會觸發全域致命守門（let it crash → exit(1) 重啟），把 job 級
 * 小故障放大成行程級重啟。真正的 Redis 中斷會由後續被 await 的 cache 指令拋出，走錯誤路徑收尾。
 */
export function publishEvent(publisher: Publisher, event: AiStreamEvent, jl: ProcessorLogger): void {
  void publisher.publish(`ai-stream:${event.jobId}`, JSON.stringify(event)).catch((err: unknown) => {
    jl.warn({ eventType: event.type, err }, "publish 失敗");
  });
}

/**
 * 發布終態事件（`ai/done`、`ai/error`）：await 到 PUBLISH 完成才 resolve。
 *
 * fire-and-forget 時 processor 可能先 return／throw，BullMQ 隨即把 job 標成 completed／failed，api 的
 * QueueEvents 收到後解除 jobId 綁定——此時才落地的 PUBLISH 會被 relay 丟棄，前端停在「已完成卻沒結果」，
 * 或只收到泛用的 `worker_failed` 而看不到具體錯誤碼。await 保證終態事件先於 BullMQ 狀態轉移送出。
 * publish 失敗只記 warn、不拋：診斷結果已落地，不能因通知失敗把成功的 job 轉成失敗重試（會重複寫入）。
 */
export async function publishTerminalEvent(
  publisher: Publisher,
  event: AiStreamEvent,
  jl: ProcessorLogger,
): Promise<void> {
  try {
    await publisher.publish(`ai-stream:${event.jobId}`, JSON.stringify(event));
  } catch (err) {
    jl.warn({ eventType: event.type, err }, "終態事件 publish 失敗（job 結果不變）");
  }
}

/**
 * 讓 provider 的 promise 在 signal 中止時立即 reject。
 *
 * 這不是舊的 `Promise.race` 逾時：真正的取消靠 signal 傳進 SDK 中止 HTTP 串流；這層只保證
 * 即使某個 adapter 沒有正確處理 signal，核心也不會跟著卡住（其遲到的 token 另由
 * onToken 的 `signal.aborted` 閘門丟棄）。
 */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

export function createProcessor(deps: ProcessorDeps) {
  const { store, publisher, repo, ai, buildContext, logger, metrics, config, liveness } = deps;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const isClosing = deps.isClosing ?? (() => false);
  const pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  return async (job: ProcessorJob, token?: string): Promise<DiagnosisJobReturnValue> => {
    const { jobId, machineId, requestedBy, windowMinutes } = job.data;
    // `attemptsMade` 於一次嘗試結束（完成／失敗）時才遞增，故處理第 N 次嘗試時其值為 N-1。
    const attempt = job.attemptsMade + 1;
    const isFinalAttempt = attempt >= (job.opts.attempts ?? 1);
    // 長流程以 child logger 綁定一次（contracts/log-fields.md §2 規則 3）。
    const jl = logger.child({ jobId, machineId, attempt });
    const emit = (event: AiStreamEvent): void => publishEvent(publisher, event, jl);
    const emitTerminal = (event: AiStreamEvent): Promise<void> => publishTerminalEvent(publisher, event, jl);
    const slot = randomUUID();
    const touch = (): void => liveness?.touch(slot);
    liveness?.begin(slot);

    /** 把 job 交回佇列（不消耗 attempts）；沒有 token 時（非 BullMQ 呼叫）退回一般 throw。 */
    const requeueAt = async (timestamp: number, reason: string): Promise<never> => {
      // 交回佇列前先停 keepalive（冪等，finally 會再停一次）：moveToDelayed 之後若還補送 progress，api 會把已延後的 job
      // 轉成 `active` 送到前端，蓋掉 relay 的 waiting 語意。
      keepalive.stop();
      if (token === undefined) throw new Error(reason);
      await job.moveToDelayed(timestamp, token);
      throw new DelayedError(reason);
    };

    /**
     * 失敗收尾：最終嘗試或不可重試才 publish ai/error；否則只記 log，交給 BullMQ 重試。
     * 不可重試者轉 `UnrecoverableError`，BullMQ 就不會再退避重試同一個必然失敗的請求。
     * async：終態 ai/error 必須 await 送出後才 throw，具體錯誤碼才會先於 BullMQ `failed` 到達前端。
     */
    const fail = async (code: string, message: string, retryable: boolean, cause: unknown): Promise<never> => {
      const terminal = !retryable || isFinalAttempt;
      if (terminal) {
        jl.error({ err: cause, code, retryable }, "AI 診斷失敗（終態，通知前端）");
        await emitTerminal({ type: "ai/error", jobId, attempt, code, message });
      } else {
        jl.warn({ err: cause, code }, "AI 診斷失敗（將重試，不通知前端）");
      }
      throw retryable ? new Error(message, { cause }) : new UnrecoverableError(message);
    };

    /**
     * 快取命中／未命中**每個 jobId 只計一次**（012 FR-026）：hitRate 的語意是「每個診斷請求恰好一筆」。以
     * `SET ai-metric:<jobId> NX` 取代原本的「只在第一次嘗試計」——stalled 重派與 moveToDelayed 不遞增 attemptsMade，
     * 只看嘗試次數會讓同一個 job 記兩筆。Redis 錯誤照常拋出走重試（與其他 cache 指令一致）。
     */
    const claimMetric = (): Promise<boolean> => store.setIfAbsent(aiMetricKey(jobId), "1", AI_METRIC_TTL_SECONDS);

    /** 讀回 JSON 並過 `DiagnosisResultSchema`；不合法回 null（呼叫端決定是否 DEL）。 */
    const parseStoredResult = (raw: string): DiagnosisResult | null => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = undefined;
      }
      const checked = DiagnosisResultSchema.safeParse(parsed);
      return checked.success ? checked.data : null;
    };

    /** `insertDiagnosis` 失敗一律轉 `persist_failed`（可重試；Mongo 原始錯誤只進 `err`）。 */
    const persistDiagnosis = async (result: DiagnosisResult): Promise<void> => {
      try {
        await repo.insertDiagnosis({ machineId, jobId, result });
      } catch (err) {
        await fail(PERSIST_FAILED_CODE, PERSIST_FAILED_MESSAGE, true, err);
      }
    };

    /**
     * 冪等短路（012 FR-024；ADR-003 D6；data-model §5 步驟 2～4）：同 jobId 的再執行（重試、stalled 重派、延後後再跑）
     * 若前一次已拿到 LLM 結果，就只補做未完成的寫入，不建 context、不查快取、不取鎖、不打 LLM。
     * (i) `ai-result:<jobId>`：前一次 LLM 成功但 `diagnoses` 未確認落地 → 補寫 diagnoses 後 DEL 暫存；
     * (ii) `diagnoses` 已有該 jobId → 直接沿用。
     * 不回填 `ai-cache:<sig>`、不動 `ai-fail:<sig>`（短路不建 context，沒有簽章；P11）。
     */
    const replayCompleted = async (): Promise<{ result: DiagnosisResult; source: IdempotentSource } | null> => {
      const resultKey = aiResultKey(jobId);
      const raw = await store.get(resultKey);
      if (raw !== null) {
        const staged = parseStoredResult(raw);
        if (staged) {
          await persistDiagnosis(staged);
          // 暫存刪不掉只 warn：diagnoses 已落地，下次會由 (i) 再補寫一次（jobId unique，視為成功），TTL 兜底。
          await store.del(resultKey).catch((err: unknown) => {
            jl.warn({ err }, "ai-result 暫存刪除失敗（將由 TTL 過期回收）");
          });
          return { result: staged, source: "ai-result" };
        }
        jl.warn({ source: "ai-result" }, "ai-result 暫存內容不符 schema，已刪除並視為無");
        await store.del(resultKey);
      }
      const persisted = await repo.findDiagnosisResult(jobId, () => {
        jl.warn({ source: "diagnoses" }, "diagnoses 既有紀錄的 result 不符 schema，視為查無");
      });
      return persisted ? { result: persisted, source: "diagnoses" } : null;
    };

    /** 短路命中後的收尾：與 LLM 路徑同一順序（trigger → 100 → ai/done → return），一律 cached:false。 */
    const finishReplay = async ({
      result,
      source,
    }: {
      result: DiagnosisResult;
      source: IdempotentSource;
    }): Promise<DiagnosisJobReturnValue> => {
      await repo.upsertTrigger({ machineId, jobId, requestedBy, cached: false });
      await report(100);
      await emitTerminal({ type: "ai/done", jobId, attempt, cached: false, result });
      jl.info({ source }, "idempotent short-circuit");
      return { result, cached: false };
    };

    /**
     * 同 jobId 的再執行（重試、stalled 重派、延後後再跑）。開頭短路沒命中、但之後在快取命中時，前一次執行可能剛好
     * 在這段期間寫完 diagnoses（例如等鎖期間舊執行完成）——回 cached:true 會與舊執行的 cached:false 不一致（ADR-003 D3）。
     */
    const isReExecution = job.attemptsStarted > 1 || job.attemptsMade > 0;

    /**
     * 進度回報（012 FR-020；data-model §5）：一律送 `DiagnosisJobProgress` 物件，帶本次的 attempt 與 execution，
     * 並記下目前里程碑、重設 keepalive。`execution`＝`attemptsStarted`（BullMQ 於 moveToActive 遞增）；讀到 0
     * （非 BullMQ 呼叫）以 1 代入。
     */
    const execution = Math.max(1, job.attemptsStarted);
    let milestone = 0;
    /**
     * keepalive（012 FR-019；ADR-003 D2）：任何對外事件（report、ai/token）重設；閒置 `KEEPALIVE_INTERVAL_MS` 就以目前
     * 里程碑補送一次 progress——涵蓋等待去重鎖、首 token 前、寫庫期間。補送失敗吞掉、本次執行至多 warn 一則（P12）；
     * 成功的補送不記日誌（FR-047）。
     */
    const keepalive = createKeepalive({
      intervalMs: KEEPALIVE_INTERVAL_MS,
      onIdle: () => job.updateProgress({ value: milestone, attempt, execution }),
      onError: (err) => jl.warn({ err, milestone }, "keepalive 進度補送失敗（本次執行不再重複記錄）"),
    });
    const report = (value: number): Promise<void> => {
      milestone = value;
      keepalive.touch();
      return job.updateProgress({ value, attempt, execution });
    };

    try {
      // 進度里程碑綁真實階段（而非計時估算），前端進度條才反映實際卡在哪一步：0=job active、20=context 返回、40=取鎖將呼叫 LLM、
      // 60=首個 token、80=parseResult 成功、100=寫庫/快取（cached 直接 100）。
      jl.info("job active");
      await report(0);

      // 冪等短路必須在 buildContext／readCache 之前：重派那次若先查到快取，會記一筆 hit、標成 cached:true（SC-004）。
      const replayed = await replayCompleted();
      if (replayed) return await finishReplay(replayed);

      const context = await buildContext({ machineId, windowMinutes });
      touch();
      await report(20);

      // 空脈絡短路：不查 cache、不取鎖、不吃 AI_RPM 額度、不打 LLM。重試結果也不會變 → 不可重試，
      // 第一次嘗試就通知前端；UnrecoverableError 讓 BullMQ 不退避重試，main.ts 的 failed handler
      // 依 isTerminalFailure 補寫 trigger(cached:false)——與其他不可重試失敗的稽核一致。
      // 快取命中率不計這筆（沒有做 cache 查詢），與 context 讀取失敗等 LLM 前的失敗同一語意。
      if (isEmptyContext(context)) {
        jl.warn({ code: NO_CONTEXT_CODE }, "空脈絡，不呼叫 LLM（終態，通知前端）");
        await emitTerminal({ type: "ai/error", jobId, attempt, code: NO_CONTEXT_CODE, message: NO_CONTEXT_MESSAGE });
        throw new UnrecoverableError(NO_CONTEXT_MESSAGE);
      }
      const sig = buildDiagnosisSignature({
        machineId,
        state: context.latestState,
        topErrorCodes: context.topErrorCodes,
        promptVersion: PROMPT_VERSION,
        providerId: ai.id,
        model: ai.model,
      });
      const cacheKey = `ai-cache:${sig}`;
      const lockKey = `ai-lock:${sig}`;
      const failKey = aiFailKey(sig);

      /**
       * LLM 階段失敗（ai_timeout、provider 錯誤、schema_invalid 含 safety／max_tokens）：先寫 `ai-fail:<sig>`（EX 10）再
       * `fail()`，讓同簽章的等待者與新 job 不再各自打 LLM（ADR-003 D5）。不可重試者也寫：同簽章＝同一份 prompt。
       * 寫入失敗只 warn——標記只是減少重複呼叫，不該蓋掉原本的失敗。no_context、persist_failed、限流延後不走這裡。
       */
      const failLlm = async (code: string, message: string, retryable: boolean, cause: unknown): Promise<never> => {
        const marker: AiFailMarker = { code, message, jobId, at: new Date(now()).toISOString() };
        try {
          await store.setWithTtl(failKey, JSON.stringify(marker), AI_FAIL_TTL_SECONDS);
          jl.info({ sig, code }, "ai-fail written");
        } catch (err) {
          jl.warn({ err, sig, code }, "ai-fail 標記寫入失敗");
        }
        return await fail(code, message, retryable, cause);
      };

      /**
       * 讀 `ai-fail:<sig>`（P13）：取鎖迴圈每輪開頭，與取得鎖、double-check 之後、限流 INCR 之前兩處。標記是自己寫的
       * （`jobId` 相同）→ 忽略：持鎖者自己的重試要能真的再試一次。看到別人的標記 → 以同 code 失敗：非最終 attempt
       * 只拋可重試錯誤（消耗一次 attempt），最終 attempt 送同 code 的 ai/error。
       */
      const checkFailMarker = async (): Promise<void> => {
        const raw = await store.get(failKey);
        if (raw === null) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = undefined;
        }
        const marker = AiFailMarkerSchema.safeParse(parsed);
        if (!marker.success) {
          jl.warn({ sig }, "ai-fail 標記內容不符 schema，已刪除並視為無");
          await store.del(failKey);
          return;
        }
        if (marker.data.jobId === jobId) return;
        jl.warn({ sig, code: marker.data.code }, "ai-fail hit");
        await fail(marker.data.code, marker.data.message, true, null);
      };

      /**
       * cache 讀回也要過 schema：任何能寫 Redis 的一方都能塞進畸形或惡意內容，不驗證就等於
       * 繞過「AI 結果必經 DiagnosisResultSchema」。不合法者刪除並視為未命中，讓本次重算覆蓋。
       */
      const readCache = async (): Promise<DiagnosisResult | null> => {
        const raw = await store.get(cacheKey);
        if (raw === null) return null;
        const cached = parseStoredResult(raw);
        if (cached) return cached;
        jl.warn({ sig }, "cache 內容不符 schema，已刪除並視為未命中");
        await store.del(cacheKey);
        return null;
      };

      /**
       * cache 命中：回 ai/done(cached:true)、記 trigger、**不**寫 diagnoses——diagnoses 只收
       * 真正由 LLM 產生的結果（避免同一份結果被複製成多筆），但每次觸發仍要留稽核紀錄。
       * 順序與 LLM 路徑一致：先寫 trigger、進度 100，最後才 await ai/done——寫入失敗時照常 throw
       * 走重試，前端不會先收到 ai/done、之後又看到同一個 job 失敗。
       * 命中時回傳 BullMQ `returnvalue`（ADR-003 D1），未命中回 null。
       * 再執行時先重跑一次冪等短路：前一次執行若已落地（diagnoses 或 ai-result），照短路語意回 cached:false。
       */
      const replyCached = async (): Promise<DiagnosisJobReturnValue | null> => {
        const result = await readCache();
        if (!result) return null;
        if (isReExecution) {
          const late = await replayCompleted();
          if (late) return await finishReplay(late);
        }
        // 命中在此計、未命中在真正呼叫 LLM 前計：等待迴圈每輪都會查 cache，於此計未命中會失真。
        if (await claimMetric()) metrics.recordCacheHit();
        await repo.upsertTrigger({ machineId, jobId, requestedBy, cached: true });
        await report(100);
        await emitTerminal({ type: "ai/done", jobId, attempt, cached: true, result });
        jl.info({ sig }, "cache hit");
        return { result, cached: true };
      };

      /** LLM 路徑；成功時回傳 BullMQ `returnvalue`（ADR-003 D1），失敗一律經 `fail()` 拋出。 */
      const callLlmAndReply = async (): Promise<DiagnosisJobReturnValue> => {
        await report(40);
        if (await claimMetric()) metrics.recordCacheMiss();
        jl.info({ sig, provider: ai.id, model: ai.model }, "LLM call");

        // 逾時在核心統一處理：signal 交給 adapter 中止底層串流，逾時後不再有任何 token 外送。
        const signal = AbortSignal.timeout(config.aiTimeoutMs);
        let seq = 0;
        // 首個 token 的 60 里程碑非致命：吞掉更新失敗、保留 promise 供後續 await，確保 60 先於 80。
        let firstTokenProgress: Promise<void> = Promise.resolve();
        // 延遲以呼叫外圍計時（含首 token 前等待），只記成功樣本；不設 ai-metric 閘門——
        // 樣本單位是「一次成功的 LLM 呼叫」而非「一個 job」。
        const startedAt = now();
        let out: AiStreamResult;
        try {
          out = await abortable(
            ai.streamDiagnosis({
              prompt: buildPrompt({ machineId, context }),
              signal,
              responseJsonSchema: DIAGNOSIS_RESULT_JSON_SCHEMA,
              onToken: (text) => {
                if (signal.aborted) return;
                touch();
                keepalive.touch();
                const s = seq++;
                emit({ type: "ai/token", jobId, attempt, seq: s, text });
                if (s === 0) firstTokenProgress = report(60).catch(() => {});
              },
            }),
            signal,
          );
        } catch (err) {
          if (signal.aborted) {
            return await failLlm("ai_timeout", `AI streaming timeout after ${config.aiTimeoutMs}ms`, true, err);
          }
          const pe = err instanceof AiProviderError ? err : null;
          const message = err instanceof Error ? err.message : String(err);
          return await failLlm(pe?.code ?? "provider_error", message, pe?.retryable ?? true, err);
        }
        const latencyMs = now() - startedAt;
        jl.info({ finishReason: out.finishReason, usage: out.usage }, "LLM stream finished");

        // 截斷或安全攔截時輸出多半不是完整 JSON；明確歸類為格式失敗並留下原因，比讓
        // parseResult 丟一個看不出原因的 SyntaxError 好查。兩者都不可重試：安全攔截重試也不會變；
        // 截斷代表同一輸入在同一 AI_MAX_OUTPUT_TOKENS 下多半陷入重複輸出，退避重試只會再燒兩次
        // 上限額度的 token、延後使用者看到失敗。
        if (out.finishReason === "safety") {
          return await failLlm("schema_invalid", "AI 回應遭供應商安全機制攔截（finishReason=safety）", false, null);
        }
        if (out.finishReason === "max_tokens") {
          return await failLlm("schema_invalid", "AI 回應達輸出上限被截斷（finishReason=max_tokens）", false, null);
        }
        // 延遲只記完整回應的樣本：截斷／安全攔截的時間長短取決於在哪裡被切，混進來會扭曲 avg／p95。
        metrics.recordLatency(latencyMs);

        let result: DiagnosisResult;
        try {
          result = parseResult(out.text);
        } catch (err) {
          return await failLlm("schema_invalid", err instanceof Error ? err.message : String(err), true, err);
        }
        await firstTokenProgress;
        await report(80);

        // 寫庫順序（012 FR-027；data-model §5 步驟 10）：
        // 1. 先把結果暫存到 `ai-result:<jobId>`：之後任何一步失敗而重試（或被 stalled 重派），開頭的冪等短路 (i)
        //    會命中暫存、只補做寫庫，不再打 LLM。
        // 2. 再落地 diagnoses：失敗轉 persist_failed（可重試，重試時由短路 (i) 只重做這一步）。
        // 3. 落地後 DEL 暫存（失敗只 warn，TTL 兜底）。
        // 4. 最後才寫 cache——不變量「快取有值就代表已落庫」：反過來的順序會讓重試命中 cache、診斷永不落地。
        // 暫存是 best-effort：寫不進去只 warn、照常寫 diagnoses——diagnoses 一旦落地，之後任何一步失敗都能由短路 (ii) 回收；
        // 讓暫存失敗中斷流程反而會讓已拿到的 LLM 結果作廢、重試再打一次 LLM。
        await store.setWithTtl(aiResultKey(jobId), JSON.stringify(result), AI_RESULT_TTL_SECONDS).catch((err: unknown) => {
          jl.warn({ err }, "ai-result 暫存寫入失敗（照常寫 diagnoses）");
        });
        await persistDiagnosis(result);
        await store.del(aiResultKey(jobId)).catch((err: unknown) => {
          jl.warn({ err }, "ai-result 暫存刪除失敗（將由 TTL 過期回收）");
        });
        await store.setWithTtl(cacheKey, JSON.stringify(result), config.cacheTtlSeconds);
        // 成功即清除負向標記（含自己前一次嘗試留下的）；刪不掉只 warn，TTL 10 s 兜底。
        await store.del(failKey).catch((err: unknown) => {
          jl.warn({ err, sig }, "ai-fail 標記刪除失敗（將由 TTL 過期回收）");
        });
        await repo.upsertTrigger({ machineId, jobId, requestedBy, cached: false });
        await report(100);
        await emitTerminal({ type: "ai/done", jobId, attempt, cached: false, result });
        jl.info("job completed");
        return { result, cached: false };
      };

      // returnvalue 由 QueueEvents `completed` 帶給 api relay，作為權威完成訊號（ADR-003 D1）；ai/done 仍照送（best-effort）。
      // 五個 return 點（冪等短路、首查命中、取鎖後 double-check 命中、LLM 成功、等待者輪詢命中）都回同一形狀。
      const firstHit = await replyCached();
      if (firstHit) return firstHit;

      // 「取鎖或等待」迴圈：lock TTL（≥ AI_TIMEOUT_MS + LOCK_TTL_MARGIN_MS，啟動時驗證）保證進度——持鎖者崩潰時
      // 最遲於 TTL 後鎖過期，某個等待者搶到鎖改走計算路徑。
      const deadline = now() + config.aiTimeoutMs + config.lockTtlSeconds * 1000 + 5000;
      for (;;) {
        touch();
        // (a) 每輪開頭（新 job 第一輪與等待者每次輪詢）：同簽章剛失敗就不再取鎖、不打 LLM。
        await checkFailMarker();
        const lockToken = randomUUID();
        if (await store.tryAcquireLock(lockKey, lockToken, config.lockTtlSeconds)) {
          let rateLimitedUntil: number;
          try {
            // double-check：等待者搶到鎖時，前一個持鎖者多半剛寫好 cache 並放鎖——不回頭查就會
            // 對同一 signature 再打一次 LLM，去重形同虛設。
            const lockedHit = await replyCached();
            if (lockedHit) return lockedHit;
            // 再執行且快取未命中：前一次執行可能已落地 diagnoses 卻在之後失敗（例如 SET ai-cache 失敗）並放鎖——不再查一次
            // 冪等短路就會吃 AI_RPM、重打 LLM（ADR-003 D3／D6；裁決 49 延伸到未命中路徑）。
            if (isReExecution) {
              const late = await replayCompleted();
              if (late) return await finishReplay(late);
            }
            // (b) 取鎖後、限流 INCR 前：擋「持鎖者寫標記放鎖、等待者恰好在 (a) 與取鎖之間」的窗口，被擋下的 job 不吃 AI_RPM。
            await checkFailMarker();

            // LLM 限流放在取鎖且確認未命中之後：只有「真的要打 LLM」才計數，cache 命中與
            // 等待者不吃額度（BullMQ 的 limiter 只能計 job 啟動數，做不到這點）。
            const windowIndex = Math.floor(now() / RATE_WINDOW_MS);
            // key 帶窗序號，TTL 取兩個窗長：首次 INCR 可能發生在窗中段，TTL 只設一窗會提早歸零。
            const used = await store.incrementWindow(`ai-rpm:${windowIndex}`, (RATE_WINDOW_MS / 1000) * 2);
            // `return await`：finally 的放鎖必須等 LLM 路徑整個結束（含寫庫、ai/done）才執行。
            if (used <= config.aiRpm) return await callLlmAndReply();
            // 加 0–2 秒隨機抖動：同一窗被擋下的 job 若全部在窗起點同時醒來，會一起搶鎖、一起打滿新窗。
            rateLimitedUntil = (windowIndex + 1) * RATE_WINDOW_MS + Math.floor(Math.random() * RATE_JITTER_MS);
            jl.warn({ used, limit: config.aiRpm, until: rateLimitedUntil }, "超過每分鐘 LLM 呼叫上限，延後到下一個窗");
          } finally {
            // compare-and-del：只刪自己的鎖。釋放失敗（Redis 斷線）不可蓋掉原本的錯誤——鎖會靠 TTL 自然過期。
            await store.releaseLock(lockKey, lockToken).catch((err: unknown) => {
              jl.warn({ err }, "釋放去重鎖失敗（將由 TTL 過期回收）");
            });
          }
          // 延後而非失敗：不消耗 attempts、不打擾前端；放鎖後才延後，其他 job 仍可取鎖或命中 cache。
          return await requeueAt(rateLimitedUntil, "LLM rate limited");
        }

        // 取不到鎖：他人正在算 → 輪詢共用其結果。
        const waitHit = await replyCached();
        if (waitHit) return waitHit;
        if (isClosing()) {
          // 關閉中不再空等：等待上限遠長於 compose 的 stop_grace_period，空等只會被 SIGKILL，
          // 再靠 stalled 重派（還吃掉一次 maxStalledCount）。直接交回佇列，由重啟後的行程接手。
          jl.info("worker 關閉中，放棄等待並把 job 交回佇列");
          return await requeueAt(now() + CLOSING_REQUEUE_DELAY_MS, "worker closing");
        }
        if (now() > deadline) {
          throw new Error(`dedupe wait exceeded for ${jobId}`); // 最終保護：交還 attempts 重試
        }
        await sleep(pollIntervalMs);
      }
    } finally {
      keepalive.stop();
      liveness?.end(slot);
    }
  };
}

/**
 * 終態判定（worker `failed` handler 用）：BullMQ 不會再重試這個 job。
 * 除了 attempts 用盡，還包含 `UnrecoverableError`（此時 attemptsMade < attempts）——只看
 * attemptsMade 會漏掉後者，導致最終失敗的 trigger 沒被補寫。
 * stalled 次數用盡（maxStalledCount）同樣涵蓋在內：BullMQ（5.79+）的 stalled 檢查腳本把 job 標上
 * deferred failure（"job stalled more than allowable limit"）放回 wait，下一個取到它的 worker 不執行
 * processor、直接以 `UnrecoverableError` 走 `handleFailed` 並 emit `failed`——本函式因此判 true、
 * trigger 照常補寫；前端通知仍由 api 側 QueueEvents `failed` 送出。
 */
export function isTerminalFailure(
  job: { attemptsMade: number; opts: { attempts?: number } },
  err: Error,
): boolean {
  if (err instanceof UnrecoverableError || err.name === "UnrecoverableError") return true;
  return job.attemptsMade >= (job.opts.attempts ?? 1);
}
