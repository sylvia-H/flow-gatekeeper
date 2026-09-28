import { randomUUID } from "node:crypto";
import { DelayedError, UnrecoverableError } from "bullmq";
import { DiagnosisResultSchema } from "@flow-gatekeeper/contracts";
import type { AiStreamEvent, DiagnosisJobPayload, DiagnosisResult } from "@flow-gatekeeper/contracts";
import { AiProviderError } from "./ai/provider.js";
import type { AiProvider, AiStreamResult } from "./ai/provider.js";
import { buildPrompt, PROMPT_VERSION } from "./ai/prompt.js";
import { buildDiagnosisSignature } from "./cache/signature.js";
import type { ProcessorStore } from "./cache/redis-store.js";
import { isEmptyContext } from "./context/context-builder.js";
import type { DiagnosisContext } from "./context/context-builder.js";
import type { DiagnosisRepository } from "./diagnosis-repository.js";
import type { LivenessTracker } from "./lib/liveness.js";
import type { MetricsCollector } from "./lib/metrics-collector.js";
import { parseResult } from "./lib/parse-result.js";
import { DIAGNOSIS_RESULT_JSON_SCHEMA } from "./lib/zod-json-schema.js";

/**
 * 診斷 job processor（自 main.ts 抽出，以依賴注入讓並發／重試語意可單元測試）。
 *
 * 流程：context → signature → cache 命中直接 ai/done(cached:true)；未命中取 `ai-lock` 去重
 *   → 取鎖後**再查一次 cache**（等待者搶到鎖時，前一個持鎖者多半已寫好結果）→ LLM 限流窗
 *   → AiProvider 串流（token → Pub/Sub `ai-stream:<jobId>`，逾時以 AbortSignal 真正中止）
 *   → parseResult → 寫 diagnoses → 寫 cache → 寫 trigger → ai/done(cached:false)。
 *
 * 重試語意：非最終嘗試的失敗只記 log 後 throw（交給 BullMQ 退避重試），**不** publish
 * `ai/error`——否則前端收到錯誤即轉 failed，之後重試即使成功畫面也停在錯誤。最終嘗試（或
 * 不可重試的錯誤）才 publish `ai/error`。所有事件都帶 `attempt`，前端據此在換輪時清空 token。
 * worker 不直接 emit WebSocket（憲章 IV）：一律經 Redis Pub/Sub 由 Gateway 轉發。
 */

/** processor 用到的 BullMQ Job 子集（BullMQ 的 `Job<DiagnosisJobPayload>` 結構上相容）。 */
export interface ProcessorJob {
  readonly data: DiagnosisJobPayload;
  readonly attemptsMade: number;
  readonly opts: { attempts?: number };
  updateProgress(progress: number): Promise<void>;
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

/** 空脈絡短路的錯誤碼與訊息（前端 humanizeError 對短訊息原文照顯）。 */
export const NO_CONTEXT_CODE = "no_context";
export const NO_CONTEXT_MESSAGE = "此機台近期沒有遙測、異常事件或維修紀錄，無資料可供診斷（未呼叫 AI）";

/**
 * 發布 AI 串流事件到 Redis Pub/Sub。參數型別是契約的 `AiStreamEvent`，漏帶 `attempt`
 * 之類的必填欄位會在 typecheck 就被擋下。
 *
 * fire-and-forget，但在源頭接住 publish 失敗並記 log：單筆 token 發布失敗不該拖垮整個 worker
 * ——若放任成浮空 rejection，會觸發全域致命守門（let it crash → exit(1) 重啟），把 job 級
 * 小故障放大成行程級重啟。真正的 Redis 中斷會由後續被 await 的 cache 指令拋出，走錯誤路徑收尾。
 */
export function publishEvent(publisher: Publisher, event: AiStreamEvent, jl: ProcessorLogger): void {
  void publisher.publish(`ai-stream:${event.jobId}`, JSON.stringify(event)).catch((err: unknown) => {
    jl.warn({ eventType: event.type, err }, "publish 失敗");
  });
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

  return async (job: ProcessorJob, token?: string): Promise<void> => {
    const { jobId, machineId, requestedBy, windowMinutes } = job.data;
    // `attemptsMade` 於一次嘗試結束（完成／失敗）時才遞增，故處理第 N 次嘗試時其值為 N-1。
    const attempt = job.attemptsMade + 1;
    const isFinalAttempt = attempt >= (job.opts.attempts ?? 1);
    // 快取命中／未命中**只在第一次嘗試計**：hitRate 的語意是「每個診斷請求恰好一筆」。否則一次 LLM 逾時的診斷會記多筆
    // 未命中，在 LLM 不穩期間系統性壓低回報的 hitRate，也破壞「每個 job 恰好一筆」的不變量。
    const isFirstAttempt = job.attemptsMade === 0;
    // 長流程以 child logger 綁定一次（contracts/log-fields.md §2 規則 3）。
    const jl = logger.child({ jobId, machineId, attempt });
    const emit = (event: AiStreamEvent): void => publishEvent(publisher, event, jl);
    const slot = randomUUID();
    const touch = (): void => liveness?.touch(slot);
    liveness?.begin(slot);

    /** 把 job 交回佇列（不消耗 attempts）；沒有 token 時（非 BullMQ 呼叫）退回一般 throw。 */
    const requeueAt = async (timestamp: number, reason: string): Promise<never> => {
      if (token === undefined) throw new Error(reason);
      await job.moveToDelayed(timestamp, token);
      throw new DelayedError(reason);
    };

    /**
     * 失敗收尾：最終嘗試或不可重試才 publish ai/error；否則只記 log，交給 BullMQ 重試。
     * 不可重試者轉 `UnrecoverableError`，BullMQ 就不會再退避重試同一個必然失敗的請求。
     */
    const fail = (code: string, message: string, retryable: boolean, cause: unknown): never => {
      const terminal = !retryable || isFinalAttempt;
      if (terminal) {
        jl.error({ err: cause, code, retryable }, "AI 診斷失敗（終態，通知前端）");
        emit({ type: "ai/error", jobId, attempt, code, message });
      } else {
        jl.warn({ err: cause, code }, "AI 診斷失敗（將重試，不通知前端）");
      }
      throw retryable ? new Error(message, { cause }) : new UnrecoverableError(message);
    };

    try {
      // 進度里程碑綁真實階段（而非計時估算），前端進度條才反映實際卡在哪一步：0=job active、20=context 返回、40=取鎖將呼叫 LLM、
      // 60=首個 token、80=parseResult 成功、100=寫庫/快取（cached 直接 100）。
      jl.info("job active");
      await job.updateProgress(0);

      const context = await buildContext({ machineId, windowMinutes });
      touch();
      await job.updateProgress(20);

      // 空脈絡短路：不查 cache、不取鎖、不吃 AI_RPM 額度、不打 LLM。重試結果也不會變 → 不可重試，
      // 第一次嘗試就通知前端；UnrecoverableError 讓 BullMQ 不退避重試，main.ts 的 failed handler
      // 依 isTerminalFailure 補寫 trigger(cached:false)——與其他不可重試失敗的稽核一致。
      // 快取命中率不計這筆（沒有做 cache 查詢），與 context 讀取失敗等 LLM 前的失敗同一語意。
      if (isEmptyContext(context)) {
        jl.warn({ code: NO_CONTEXT_CODE }, "空脈絡，不呼叫 LLM（終態，通知前端）");
        emit({ type: "ai/error", jobId, attempt, code: NO_CONTEXT_CODE, message: NO_CONTEXT_MESSAGE });
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

      /**
       * cache 讀回也要過 schema：任何能寫 Redis 的一方都能塞進畸形或惡意內容，不驗證就等於
       * 繞過「AI 結果必經 DiagnosisResultSchema」。不合法者刪除並視為未命中，讓本次重算覆蓋。
       */
      const readCache = async (): Promise<DiagnosisResult | null> => {
        const raw = await store.get(cacheKey);
        if (raw === null) return null;
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = undefined;
        }
        const checked = DiagnosisResultSchema.safeParse(parsed);
        if (checked.success) return checked.data;
        jl.warn({ sig }, "cache 內容不符 schema，已刪除並視為未命中");
        await store.del(cacheKey);
        return null;
      };

      /**
       * cache 命中：回 ai/done(cached:true)、記 trigger、**不**寫 diagnoses——diagnoses 只收
       * 真正由 LLM 產生的結果（避免同一份結果被複製成多筆），但每次觸發仍要留稽核紀錄。
       */
      const replyCached = async (): Promise<boolean> => {
        const result = await readCache();
        if (!result) return false;
        // 命中在此計、未命中在真正呼叫 LLM 前計：等待迴圈每輪都會查 cache，於此計未命中會失真。
        if (isFirstAttempt) metrics.recordCacheHit();
        emit({ type: "ai/done", jobId, attempt, cached: true, result });
        await repo.insertTrigger({ machineId, jobId, requestedBy, cached: true });
        await job.updateProgress(100);
        jl.info({ sig }, "cache hit");
        return true;
      };

      const callLlmAndReply = async (): Promise<void> => {
        await job.updateProgress(40);
        if (isFirstAttempt) metrics.recordCacheMiss();
        jl.info({ sig, provider: ai.id, model: ai.model }, "LLM call");

        // 逾時在核心統一處理：signal 交給 adapter 中止底層串流，逾時後不再有任何 token 外送。
        const signal = AbortSignal.timeout(config.aiTimeoutMs);
        let seq = 0;
        // 首個 token 的 60 里程碑非致命：吞掉更新失敗、保留 promise 供後續 await，確保 60 先於 80。
        let firstTokenProgress: Promise<void> = Promise.resolve();
        // 延遲以呼叫外圍計時（含首 token 前等待），只記成功樣本；不設 isFirstAttempt 閘門——
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
                const s = seq++;
                emit({ type: "ai/token", jobId, attempt, seq: s, text });
                if (s === 0) firstTokenProgress = job.updateProgress(60).catch(() => {});
              },
            }),
            signal,
          );
        } catch (err) {
          if (signal.aborted) {
            return fail("ai_timeout", `AI streaming timeout after ${config.aiTimeoutMs}ms`, true, err);
          }
          const pe = err instanceof AiProviderError ? err : null;
          const message = err instanceof Error ? err.message : String(err);
          return fail(pe?.code ?? "provider_error", message, pe?.retryable ?? true, err);
        }
        const latencyMs = now() - startedAt;
        jl.info({ finishReason: out.finishReason, usage: out.usage }, "LLM stream finished");

        // 截斷或安全攔截時輸出多半不是完整 JSON；明確歸類為格式失敗並留下原因，比讓
        // parseResult 丟一個看不出原因的 SyntaxError 好查。兩者都不可重試：安全攔截重試也不會變；
        // 截斷代表同一輸入在同一 AI_MAX_OUTPUT_TOKENS 下多半陷入重複輸出，退避重試只會再燒兩次
        // 上限額度的 token、延後使用者看到失敗。
        if (out.finishReason === "safety") {
          return fail("schema_invalid", "AI 回應遭供應商安全機制攔截（finishReason=safety）", false, null);
        }
        if (out.finishReason === "max_tokens") {
          return fail("schema_invalid", "AI 回應達輸出上限被截斷（finishReason=max_tokens）", false, null);
        }
        // 延遲只記完整回應的樣本：截斷／安全攔截的時間長短取決於在哪裡被切，混進來會扭曲 avg／p95。
        metrics.recordLatency(latencyMs);

        let result: DiagnosisResult;
        try {
          result = parseResult(out.text);
        } catch (err) {
          return fail("schema_invalid", err instanceof Error ? err.message : String(err), true, err);
        }
        await firstTokenProgress;
        await job.updateProgress(80);

        // 先落地 diagnoses 再寫 cache：若中途失敗而重試，cache 仍是空的 → 重算並再 insert
        // （jobId unique，重複 insert 視為成功）。反過來的順序會讓重試命中 cache、診斷永不落地。
        await repo.insertDiagnosis({ machineId, jobId, result });
        await store.setWithTtl(cacheKey, JSON.stringify(result), config.cacheTtlSeconds);
        await repo.insertTrigger({ machineId, jobId, requestedBy, cached: false });
        await job.updateProgress(100);
        emit({ type: "ai/done", jobId, attempt, cached: false, result });
        jl.info("job completed");
      };

      if (await replyCached()) return;

      // 「取鎖或等待」迴圈：lock TTL（≥ AI_TIMEOUT_MS + LOCK_TTL_MARGIN_MS，啟動時驗證）保證進度——持鎖者崩潰時
      // 最遲於 TTL 後鎖過期，某個等待者搶到鎖改走計算路徑。
      const deadline = now() + config.aiTimeoutMs + config.lockTtlSeconds * 1000 + 5000;
      for (;;) {
        touch();
        const lockToken = randomUUID();
        if (await store.tryAcquireLock(lockKey, lockToken, config.lockTtlSeconds)) {
          let rateLimitedUntil: number | null = null;
          try {
            // double-check：等待者搶到鎖時，前一個持鎖者多半剛寫好 cache 並放鎖——不回頭查就會
            // 對同一 signature 再打一次 LLM，去重形同虛設。
            if (await replyCached()) return;

            // LLM 限流放在取鎖且確認未命中之後：只有「真的要打 LLM」才計數，cache 命中與
            // 等待者不吃額度（BullMQ 的 limiter 只能計 job 啟動數，做不到這點）。
            const windowIndex = Math.floor(now() / RATE_WINDOW_MS);
            // key 帶窗序號，TTL 取兩個窗長：首次 INCR 可能發生在窗中段，TTL 只設一窗會提早歸零。
            const used = await store.incrementWindow(`ai-rpm:${windowIndex}`, (RATE_WINDOW_MS / 1000) * 2);
            if (used > config.aiRpm) {
              // 加 0–2 秒隨機抖動：同一窗被擋下的 job 若全部在窗起點同時醒來，會一起搶鎖、一起打滿新窗。
              rateLimitedUntil = (windowIndex + 1) * RATE_WINDOW_MS + Math.floor(Math.random() * RATE_JITTER_MS);
              jl.warn(
                { used, limit: config.aiRpm, until: rateLimitedUntil },
                "超過每分鐘 LLM 呼叫上限，延後到下一個窗",
              );
            } else {
              await callLlmAndReply();
            }
          } finally {
            // compare-and-del：只刪自己的鎖。釋放失敗（Redis 斷線）不可蓋掉原本的錯誤——鎖會靠 TTL 自然過期。
            await store.releaseLock(lockKey, lockToken).catch((err: unknown) => {
              jl.warn({ err }, "釋放去重鎖失敗（將由 TTL 過期回收）");
            });
          }
          // 延後而非失敗：不消耗 attempts、不打擾前端；放鎖後才延後，其他 job 仍可取鎖或命中 cache。
          if (rateLimitedUntil !== null) await requeueAt(rateLimitedUntil, "LLM rate limited");
          return;
        }

        // 取不到鎖：他人正在算 → 輪詢共用其結果。
        if (await replyCached()) return;
        if (isClosing()) {
          // 關閉中不再空等：等待上限遠長於 compose 的 stop_grace_period，空等只會被 SIGKILL，
          // 再靠 stalled 重派（還吃掉一次 maxStalledCount）。直接交回佇列，由重啟後的行程接手。
          jl.info("worker 關閉中，放棄等待並把 job 交回佇列");
          await requeueAt(now() + CLOSING_REQUEUE_DELAY_MS, "worker closing");
        }
        if (now() > deadline) {
          throw new Error(`dedupe wait exceeded for ${jobId}`); // 最終保護：交還 attempts 重試
        }
        await sleep(pollIntervalMs);
      }
    } finally {
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
