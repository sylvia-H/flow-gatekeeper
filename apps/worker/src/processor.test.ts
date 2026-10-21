import { DelayedError, UnrecoverableError } from "bullmq";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AiStreamEventSchema, DiagnosisJobProgressSchema, DiagnosisJobReturnValueSchema } from "@flow-gatekeeper/contracts";
import type { AiStreamEvent, DiagnosisJobPayload, DiagnosisJobProgress, DiagnosisResult } from "@flow-gatekeeper/contracts";
import { GeminiProvider } from "./ai/gemini-provider.js";
import { PROMPT_VERSION } from "./ai/prompt.js";
import { AiProviderError } from "./ai/provider.js";
import type { AiProvider, AiStreamRequest, AiStreamResult } from "./ai/provider.js";
import type { ProcessorStore } from "./cache/redis-store.js";
import { buildDiagnosisSignature } from "./cache/signature.js";
import type { DiagnosisContext } from "./context/context-builder.js";
import type { DiagnosisRepository } from "./diagnosis-repository.js";
import type { LivenessTracker } from "./lib/liveness.js";
import {
  AiFailMarkerSchema,
  createProcessor,
  isNoContextFailure,
  isTerminalFailure,
  NO_CONTEXT_CODE,
  NO_CONTEXT_MESSAGE,
  PERSIST_FAILED_CODE,
  PERSIST_FAILED_MESSAGE,
} from "./processor.js";
import type { ProcessorConfig, ProcessorJob, ProcessorLogger } from "./processor.js";

// ---------------------------------------------------------------------------
// fakes
// ---------------------------------------------------------------------------

const VALID_RESULT: DiagnosisResult = {
  summary: "主軸振動偏高",
  severity: "warning",
  likelyCauses: ["軸承磨損"],
  suggestedActions: [{ label: "安排檢修", priority: "medium" }],
  evidence: [{ source: "telemetry", excerpt: "振動 max 9.1" }],
};
const RESULT_TEXT = JSON.stringify(VALID_RESULT);

/** 每次帶 TTL 的寫入（cache SET EX／鎖 SET NX EX／限流窗首次 EXPIRE）都記下來，TTL 參數接錯才測得出。 */
interface TtlRecord {
  op: "cache" | "lock" | "window" | "marker";
  key: string;
  ttlSeconds: number;
}

class FakeStore implements ProcessorStore {
  readonly data = new Map<string, string>();
  readonly counters = new Map<string, number>();
  readonly deleted: string[] = [];
  readonly ttls: TtlRecord[] = [];
  /** true＝所有 setWithTtl 失敗；函式＝依 key 決定（例如只讓 ai-cache 寫入失敗）。 */
  failSetWithTtl: boolean | ((key: string) => boolean) = false;

  async get(key: string) {
    return this.data.get(key) ?? null;
  }
  async setWithTtl(key: string, value: string, ttlSeconds: number) {
    const shouldFail = typeof this.failSetWithTtl === "function" ? this.failSetWithTtl(key) : this.failSetWithTtl;
    if (shouldFail) throw new Error("redis down");
    this.ttls.push({ op: "cache", key, ttlSeconds });
    this.data.set(key, value);
  }
  async del(key: string) {
    this.deleted.push(key);
    this.data.delete(key);
  }
  async tryAcquireLock(key: string, token: string, ttlSeconds: number) {
    if (this.data.has(key)) return false;
    this.ttls.push({ op: "lock", key, ttlSeconds });
    this.data.set(key, token);
    return true;
  }
  async releaseLock(key: string, token: string) {
    if (this.data.get(key) !== token) return false;
    this.data.delete(key);
    return true;
  }
  async incrementWindow(key: string, windowSeconds: number) {
    const n = (this.counters.get(key) ?? 0) + 1;
    if (n === 1) this.ttls.push({ op: "window", key, ttlSeconds: windowSeconds });
    this.counters.set(key, n);
    return n;
  }
  async setIfAbsent(key: string, value: string, ttlSeconds: number) {
    if (this.data.has(key)) return false;
    this.ttls.push({ op: "marker", key, ttlSeconds });
    this.data.set(key, value);
    return true;
  }
  cacheKeys() {
    return [...this.data.keys()].filter((k) => k.startsWith("ai-cache:"));
  }
  lockKeys() {
    return [...this.data.keys()].filter((k) => k.startsWith("ai-lock:"));
  }
  ttlsOf(op: TtlRecord["op"]) {
    return this.ttls.filter((t) => t.op === op);
  }
}

class FakePublisher {
  readonly events: AiStreamEvent[] = [];
  /** 自訂 PUBLISH 的落定方式（延遲／失敗）；未設定時立即成功。事件於呼叫當下就記入 `events`。 */
  respond: ((event: AiStreamEvent) => Promise<unknown>) | undefined;
  /** 呼叫順序紀錄（與 repo／job 共用時可斷言跨元件的先後）。 */
  order: string[] | undefined;
  publish(_channel: string, message: string): Promise<unknown> {
    // 送出的每則事件都必須通過契約（含必填 attempt）。
    const event = AiStreamEventSchema.parse(JSON.parse(message));
    this.events.push(event);
    this.order?.push(`publish:${event.type}`);
    return this.respond ? this.respond(event) : Promise.resolve(1);
  }
  ofType<T extends AiStreamEvent["type"]>(type: T) {
    return this.events.filter((e): e is Extract<AiStreamEvent, { type: T }> => e.type === type);
  }
}

interface TriggerDoc {
  machineId: string;
  jobId: string;
  requestedBy: string;
  cached: boolean;
}

/** 模擬 Mongo 拒寫的錯誤：訊息帶連線細節，斷言它不會外洩到 ai/error 或 throw 的訊息（裁決第 18 條）。 */
const MONGO_WRITE_ERROR_TEXT = "MongoServerError: not primary (mongodb://admin:s3cret@mongo:27017)";

/**
 * 與真 repository 同語意的 fake：`insertDiagnosis` 以 jobId 冪等（重複視為成功、不覆寫）、`upsertTrigger` 先寫者勝
 * （`$setOnInsert`）、`findDiagnosisResult` 讀回已落地者。
 */
class FakeRepo implements DiagnosisRepository {
  readonly diagnoses: { machineId: string; jobId: string; result: DiagnosisResult }[] = [];
  /** 實際存在的 trigger（每個 jobId 至多一筆）。 */
  readonly triggers: TriggerDoc[] = [];
  /** 每次 upsertTrigger 呼叫（含被 $setOnInsert 吸收者）。 */
  readonly upsertCalls: TriggerDoc[] = [];
  failUpsertTrigger = false;
  /** 接下來幾次 insertDiagnosis 要失敗（每次遞減）。 */
  failInsertDiagnosis = 0;
  insertDiagnosisCalls = 0;
  findCalls = 0;
  order: string[] | undefined;
  async insertDiagnosis(doc: { machineId: string; jobId: string; result: DiagnosisResult }) {
    this.insertDiagnosisCalls += 1;
    this.order?.push("insertDiagnosis");
    if (this.failInsertDiagnosis > 0) {
      this.failInsertDiagnosis -= 1;
      throw new Error(MONGO_WRITE_ERROR_TEXT);
    }
    if (this.diagnoses.some((d) => d.jobId === doc.jobId)) return;
    this.diagnoses.push(doc);
  }
  async upsertTrigger(doc: TriggerDoc) {
    this.order?.push("upsertTrigger");
    if (this.failUpsertTrigger) throw new Error("mongo down");
    this.upsertCalls.push(doc);
    if (this.triggers.some((t) => t.jobId === doc.jobId)) return;
    this.triggers.push(doc);
  }
  /** 這些 jobId 的 diagnoses 紀錄視為「存在但不合法」。 */
  readonly invalidJobIds = new Set<string>();
  async findDiagnosisResult(jobId: string, onInvalid?: () => void) {
    this.findCalls += 1;
    if (this.invalidJobIds.has(jobId)) {
      onInvalid?.();
      return null;
    }
    return this.diagnoses.find((d) => d.jobId === jobId)?.result ?? null;
  }
}

type Script = (req: AiStreamRequest) => Promise<AiStreamResult>;

/** 依呼叫順序執行 scripts；最後一個 script 重複使用。 */
class FakeAiProvider implements AiProvider {
  readonly id = "fake";
  readonly model = "fake-model";
  readonly calls: AiStreamRequest[] = [];
  constructor(private readonly scripts: Script[]) {}
  streamDiagnosis(req: AiStreamRequest) {
    this.calls.push(req);
    const script = this.scripts[Math.min(this.calls.length - 1, this.scripts.length - 1)];
    if (!script) throw new Error("no script");
    return script(req);
  }
}

/**
 * 可推進的虛擬時鐘，注入 `ProcessorDeps.now`／`sleep`：dedupe 等待迴圈的輪詢與 deadline 由測試
 * 決定「過了多久」，不再靠真實 setTimeout 的相對時序（負載高時會假綠）。
 */
class FakeClock {
  private t: number;
  private sleepers: { until: number; resolve: () => void }[] = [];
  /** 每次 sleep 的參數（驗輪詢間隔用）。 */
  readonly sleeps: number[] = [];
  constructor(start: number) {
    this.t = start;
  }
  readonly now = (): number => this.t;
  readonly sleep = (ms: number): Promise<void> => {
    this.sleeps.push(ms);
    return new Promise<void>((resolve) => this.sleepers.push({ until: this.t + ms, resolve }));
  };
  /** 目前掛著、尚未被喚醒的 sleep 數。 */
  get pending(): number {
    return this.sleepers.length;
  }
  /** 推進虛擬時間並喚醒所有到期的 sleep。 */
  advance(ms: number): void {
    this.t += ms;
    const due = this.sleepers.filter((s) => s.until <= this.t);
    this.sleepers = this.sleepers.filter((s) => s.until > this.t);
    for (const s of due) s.resolve();
  }
}

/** 虛擬時鐘起點：刻意非 0，讓限流窗序號與 requeue 時間戳可精確斷言。 */
const CLOCK_START = 1_000_000;

/**
 * 讓所有已排入的 microtask 跑完（fake store／repo／publisher 全是 microtask，沒有真實 I/O）。
 * 不是「睡一段時間等它好」：setImmediate 在 microtask 佇列清空後才執行，結果是確定的。
 */
const flush = () => new Promise<void>((r) => setImmediate(r));

/** 追蹤 promise 是否已落定（不吞掉 rejection，之後仍可 await／expect）。 */
function track<T>(promise: Promise<T>) {
  const state = { settled: false };
  promise.then(
    () => {
      state.settled = true;
    },
    () => {
      state.settled = true;
    },
  );
  return { promise, state };
}

/** 正常串流：分兩段吐出合法 JSON，中間讓出一次 microtask（可在兩段之間插入動作，例如推進時鐘）。 */
const okScript =
  (between?: () => void): Script =>
  async ({ onToken }) => {
    onToken(RESULT_TEXT.slice(0, 10));
    await Promise.resolve();
    between?.();
    onToken(RESULT_TEXT.slice(10));
    return { text: RESULT_TEXT, finishReason: "stop" };
  };

/** 持鎖者用：串流卡在閘門上直到測試呼叫 `release()`；給 error 則放行後拋出。 */
function gatedScript(error?: Error) {
  let open: () => void = () => {};
  const gate = new Promise<void>((r) => {
    open = r;
  });
  const script: Script = async (req) => {
    await gate;
    if (error) throw error;
    return okScript()(req);
  };
  return { script, release: () => open() };
}

const silentLogger: ProcessorLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};

/** 記下 warn／error 的 fake logger（斷言 publish 失敗有留紀錄）。 */
function recordingLogger() {
  const warns: { obj: unknown; msg?: string }[] = [];
  const errors: { obj: unknown; msg?: string }[] = [];
  const logger: ProcessorLogger = {
    info: () => {},
    warn: (obj, msg) => warns.push({ obj, msg }),
    error: (obj, msg) => errors.push({ obj, msg }),
    child: () => logger,
  };
  return { logger, warns, errors };
}

const CONTEXT: DiagnosisContext = {
  machineId: "press-02",
  windowMinutes: 5,
  latestState: "warning",
  telemetry: null,
  recentErrors: [],
  topErrorCodes: ["warning"],
  maintenance: [],
};

/** 與 processor 同算法推得的 cache／lock 鍵（用來預置「他人持鎖」「他人已寫好 cache」）。 */
function keysFor(ctx: DiagnosisContext) {
  const sig = buildDiagnosisSignature({
    machineId: ctx.machineId,
    state: ctx.latestState,
    topErrorCodes: ctx.topErrorCodes,
    promptVersion: PROMPT_VERSION,
    providerId: "fake",
    model: "fake-model",
  });
  return { sig, cacheKey: `ai-cache:${sig}`, lockKey: `ai-lock:${sig}`, failKey: `ai-fail:${sig}` };
}

function makeJob(jobId: string, opts: { attemptsMade?: number; attempts?: number; attemptsStarted?: number } = {}) {
  const data: DiagnosisJobPayload = {
    jobId,
    machineId: "press-02",
    requestedBy: "tester",
    requestedAt: new Date(0).toISOString(),
    windowMinutes: 5,
  };
  const job: ProcessorJob & {
    /** 每次 progress 的 value（里程碑序列斷言用）。 */
    progress: number[];
    /** 原始參數（形狀斷言用：012 起一律為 DiagnosisJobProgress 物件）。 */
    progressRaw: DiagnosisJobProgress[];
    /** 每次 progress 的時間（Date.now；fake timer 下為虛擬時間）。 */
    progressAt: number[];
    /** 測試掛勾：記錄順序或讓某次 progress 失敗（拋錯即 reject）。 */
    progressHook: ((value: number) => void) | undefined;
    moveToDelayed: ReturnType<typeof vi.fn>;
  } = {
    data,
    attemptsMade: opts.attemptsMade ?? 0,
    // BullMQ 於 moveToActive 遞增：處理中至少為 attemptsMade + 1。
    attemptsStarted: opts.attemptsStarted ?? (opts.attemptsMade ?? 0) + 1,
    opts: { attempts: opts.attempts ?? 3 },
    progress: [],
    progressRaw: [],
    progressAt: [],
    progressHook: undefined,
    async updateProgress(p: DiagnosisJobProgress) {
      const value = p.value;
      this.progressHook?.(value);
      this.progressRaw.push(p);
      this.progressAt.push(Date.now());
      this.progress.push(value);
    },
    moveToDelayed: vi.fn(async () => {}),
  };
  return job;
}

function makeLiveness() {
  return {
    begin: vi.fn<(id: string) => void>(),
    touch: vi.fn<(id: string) => void>(),
    end: vi.fn<(id: string) => void>(),
    isAlive: () => true,
  };
}

/**
 * 活性槽必須成對：begin、end 各恰好一次且是同一個槽，touch 也只打在該槽上。
 * 只檢查一致性：touch 從未被呼叫時 `every` 恆真，「有沒有 touch」由各測試另行斷言。
 */
function expectLivenessPaired(liveness: ReturnType<typeof makeLiveness>) {
  expect(liveness.begin).toHaveBeenCalledTimes(1);
  const slot = liveness.begin.mock.calls[0]?.[0];
  expect(slot).toEqual(expect.any(String));
  expect(liveness.end).toHaveBeenCalledTimes(1);
  expect(liveness.end).toHaveBeenCalledWith(slot);
  expect(liveness.touch.mock.calls.every(([id]) => id === slot)).toBe(true);
}

/** 完全沒有資料的脈絡（不存在的 machineId 的典型樣貌）。 */
const EMPTY_CONTEXT: DiagnosisContext = {
  machineId: "ghost-99",
  windowMinutes: 5,
  latestState: "unknown",
  telemetry: null,
  recentErrors: [],
  topErrorCodes: [],
  maintenance: [],
};

/** 測試用設定：各 TTL／時長刻意兩兩不同，參數接錯才看得出來。 */
const CONFIG = {
  aiTimeoutMs: 1000,
  lockTtlSeconds: 45,
  cacheTtlSeconds: 600,
  aiRpm: 100,
  pollIntervalMs: 5,
} satisfies ProcessorConfig;

function setup(
  scripts: Script[],
  overrides: Partial<ProcessorConfig> & {
    isClosing?: () => boolean;
    context?: DiagnosisContext;
    buildContext?: () => Promise<DiagnosisContext>;
    liveness?: LivenessTracker;
    clock?: FakeClock;
    logger?: ProcessorLogger;
    /** true＝用全域 Date.now 與 setTimeout（搭配 vi.useFakeTimers，讓 keepalive 與輪詢 sleep 同一條時間軸）。 */
    realClock?: boolean;
  } = {},
) {
  const store = new FakeStore();
  const publisher = new FakePublisher();
  const repo = new FakeRepo();
  const ai = new FakeAiProvider(scripts);
  const metrics = { recordCacheHit: vi.fn(), recordCacheMiss: vi.fn(), recordLatency: vi.fn() };
  const {
    isClosing,
    context = CONTEXT,
    buildContext = async () => context,
    liveness,
    clock = new FakeClock(CLOCK_START),
    logger = silentLogger,
    realClock = false,
    ...config
  } = overrides;
  const processor = createProcessor({
    store,
    publisher,
    repo,
    ai,
    buildContext,
    logger,
    metrics,
    config: { ...CONFIG, ...config },
    isClosing,
    liveness,
    ...(realClock ? {} : { now: clock.now, sleep: clock.sleep }),
  });
  return { store, publisher, repo, ai, metrics, processor, clock };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

describe("createProcessor：去重", () => {
  it("兩個 processor 並發同 signature，LLM 只被呼叫一次", async () => {
    const holder = gatedScript();
    const { ai, publisher, repo, metrics, clock, processor } = setup([holder.script]);
    const a = processor(makeJob("a"));
    const b = processor(makeJob("b"));
    await flush();
    expect(ai.calls).toHaveLength(1);
    expect(clock.pending).toBe(1); // b 取不到鎖，在等待迴圈裡 sleep

    holder.release();
    const ra = await a;
    clock.advance(CONFIG.pollIntervalMs);
    const rb = await b;

    // returnvalue（ADR-003 D1）：持鎖者回 LLM 結果、等待者回共用的快取結果
    expect(ra).toEqual({ result: VALID_RESULT, cached: false });
    expect(rb).toEqual({ result: VALID_RESULT, cached: true });
    expect(ai.calls).toHaveLength(1);
    expect(publisher.ofType("ai/done").map((e) => [e.jobId, e.cached])).toEqual([
      ["a", false],
      ["b", true],
    ]);
    expect(repo.diagnoses).toHaveLength(1);
    expect(repo.triggers.map((t) => [t.jobId, t.cached])).toEqual([
      ["a", false],
      ["b", true],
    ]);
    // 每個 job 恰好一筆 hit 或 miss：a 真的打 LLM 記未命中、b 共用結果記命中
    expect(metrics.recordCacheMiss).toHaveBeenCalledTimes(1);
    expect(metrics.recordCacheHit).toHaveBeenCalledTimes(1);
    expect(metrics.recordLatency).toHaveBeenCalledTimes(1);
  });

  it("去重鎖撐完整條 LLM 路徑：串流中途鎖仍在，processor resolve 後才釋放", async () => {
    let open: () => void = () => {};
    const gate = new Promise<void>((r) => {
      open = r;
    });
    const midStream: Script = async ({ onToken }) => {
      onToken(RESULT_TEXT.slice(0, 10));
      await gate; // 串流停在中途
      onToken(RESULT_TEXT.slice(10));
      return { text: RESULT_TEXT, finishReason: "stop" };
    };
    const { store, publisher, processor } = setup([midStream]);
    const run = track(processor(makeJob("a")));
    await flush();

    // `return await callLlmAndReply()` 少了 await 時，finally 會在串流途中就放鎖——這裡會抓到。
    expect(publisher.ofType("ai/token")).toHaveLength(1);
    expect(run.state.settled).toBe(false);
    expect(store.lockKeys()).toHaveLength(1);

    open();
    expect(await run.promise).toEqual({ result: VALID_RESULT, cached: false });
    expect(store.lockKeys()).toEqual([]);
  });

  it("等待者搶到鎖時先 double-check cache（持鎖者剛寫完並放鎖）", async () => {
    const holder = gatedScript();
    const { ai, store, publisher, clock, processor } = setup([holder.script]);
    const acquire = vi.spyOn(store, "tryAcquireLock");
    const a = processor(makeJob("a"));
    const b = processor(makeJob("b"));
    await flush();
    expect(clock.pending).toBe(1);

    // 持鎖者在等待者 sleep 期間完成並放鎖：等待者醒來一定走「SET NX 成功」那條路。
    holder.release();
    await a;
    expect(store.lockKeys()).toEqual([]);
    clock.advance(CONFIG.pollIntervalMs);
    expect(await b).toEqual({ result: VALID_RESULT, cached: true }); // 持鎖下 double-check 命中也回 returnvalue

    // a 取鎖成功、b 第一次失敗、b 醒來第二次成功——b 是在持鎖狀態下 double-check 命中的
    expect(await Promise.all(acquire.mock.results.map((r) => r.value))).toEqual([true, false, true]);
    expect(ai.calls).toHaveLength(1);
    expect(publisher.ofType("ai/done").find((e) => e.jobId === "b")?.cached).toBe(true);
    expect(store.lockKeys()).toEqual([]); // 兩者都只刪自己的鎖，最後沒有殘留
  });

  it("鎖被他人持有時，等待者輪詢到他人寫入的 cache 即回 cached:true（不取鎖、不打 LLM）", async () => {
    const liveness = makeLiveness();
    const { ai, store, publisher, repo, metrics, clock, processor } = setup([okScript()], { liveness });
    const { cacheKey, lockKey } = keysFor(CONTEXT);
    store.data.set(lockKey, "other-replica");
    const job = makeJob("w");
    const run = track(processor(job));
    await flush();
    expect(clock.pending).toBe(1);
    expect(run.state.settled).toBe(false);

    store.data.set(cacheKey, RESULT_TEXT); // 另一副本寫好結果，但鎖仍在它手上
    clock.advance(CONFIG.pollIntervalMs);
    await flush();
    expect(run.state.settled).toBe(true);
    expect(await run.promise).toEqual({ result: VALID_RESULT, cached: true });

    expect(ai.calls).toHaveLength(0);
    expect(store.data.get(lockKey)).toBe("other-replica");
    expect(publisher.events).toEqual([{ type: "ai/done", jobId: "w", attempt: 1, cached: true, result: VALID_RESULT }]);
    expect(repo.triggers).toEqual([{ machineId: "press-02", jobId: "w", requestedBy: "tester", cached: true }]);
    expect(job.progress).toEqual([0, 20, 100]);
    expect(clock.sleeps).toEqual([CONFIG.pollIntervalMs]);
    expect(metrics.recordCacheHit).toHaveBeenCalledTimes(1);
    expect(metrics.recordCacheMiss).not.toHaveBeenCalled();
    expectLivenessPaired(liveness);
    // context 後 1 次＋等待迴圈每輪開頭 1 次（輪詢 1 輪 → 迴圈跑 2 輪）：漏掉迴圈內的 touch 會少計
    expect(liveness.touch).toHaveBeenCalledTimes(1 + (clock.sleeps.length + 1));
  });

  it("持鎖者失敗後：等待者看到 ai-fail 標記即以同 code 失敗（不接手重打）；標記過期後的重試才重算", async () => {
    const holder = gatedScript(new AiProviderError("503 overloaded", { retryable: true, code: "provider_error" }));
    const { ai, store, publisher, metrics, clock, processor } = setup([holder.script, okScript()]);
    const a = processor(makeJob("a")).catch((e: unknown) => e);
    const b = processor(makeJob("b")).catch((e: unknown) => e);
    await flush();
    expect(clock.pending).toBe(1);

    holder.release();
    expect(await a).toBeInstanceOf(Error);
    clock.advance(CONFIG.pollIntervalMs);
    const errB = await b;
    expect(errB).toBeInstanceOf(Error);
    expect(errB).not.toBeInstanceOf(UnrecoverableError);
    expect((errB as Error).message).toBe("503 overloaded");
    expect(ai.calls).toHaveLength(1);
    // 兩者都是非最終嘗試：不送 ai/error
    expect(publisher.ofType("ai/error")).toEqual([]);

    // 標記 TTL（10 s）過期後，b 的重試照常打 LLM 並成功。
    store.data.delete(`ai-fail:${keysFor(CONTEXT).sig}`);
    await expect(processor(makeJob("b", { attemptsMade: 1, attempts: 3 }))).resolves.toEqual({
      result: VALID_RESULT,
      cached: false,
    });
    expect(ai.calls).toHaveLength(2);
    // a 打過 LLM 記一筆未命中；b 第一次被標記擋在取鎖前（未記），重試打 LLM 時記一筆
    expect(metrics.recordCacheMiss).toHaveBeenCalledTimes(2);
    expect(metrics.recordLatency).toHaveBeenCalledTimes(1);
  });

  it("鎖值不是自己的就不刪（compare-and-del）", async () => {
    const { store, processor } = setup([
      async (req) => {
        // 模擬鎖在串流途中過期並被別人取得
        for (const k of store.lockKeys()) store.data.set(k, "someone-else");
        return okScript()(req);
      },
    ]);
    await processor(makeJob("a"));
    expect(store.lockKeys().map((k) => store.data.get(k))).toEqual(["someone-else"]);
  });
});

describe("createProcessor：dedupe 等待 deadline（注入時間）", () => {
  it("鎖一直被他人持有：恰好到 deadline 仍等待，超過才丟一般錯誤交還 attempts（不 requeue、不送 ai/error）", async () => {
    // deadline = 起點 + aiTimeoutMs + lockTtlSeconds*1000 + 5000 = 起點 + 51_000
    const poll = 17_000; // 17k × 3 = 51k：第三次醒來恰好落在 deadline 上
    const liveness = makeLiveness();
    const { ai, store, publisher, clock, processor } = setup([okScript()], {
      pollIntervalMs: poll,
      aiTimeoutMs: 1000,
      lockTtlSeconds: 45,
      liveness,
    });
    const { lockKey } = keysFor(CONTEXT);
    store.data.set(lockKey, "stuck-holder");
    const job = makeJob("w");
    const run = track(processor(job, "bull-token"));

    for (let i = 0; i < 3; i++) {
      await flush();
      expect(run.state.settled).toBe(false);
      expect(clock.pending).toBe(1);
      clock.advance(poll);
    }
    await flush();
    // now == deadline：條件是「超過」才放棄，這一輪仍繼續等
    expect(clock.now()).toBe(CLOCK_START + 51_000);
    expect(run.state.settled).toBe(false);
    expect(clock.pending).toBe(1);

    clock.advance(poll);
    const err = await run.promise.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("dedupe wait exceeded for w");
    expect(err).not.toBeInstanceOf(DelayedError);
    expect(err).not.toBeInstanceOf(UnrecoverableError);
    expect(clock.sleeps).toEqual([poll, poll, poll, poll]);
    expect(job.moveToDelayed).not.toHaveBeenCalled();
    expect(ai.calls).toHaveLength(0);
    expect(publisher.events).toEqual([]);
    expect(store.data.get(lockKey)).toBe("stuck-holder");
    expectLivenessPaired(liveness);
    // context 後 1 次＋等待迴圈每輪開頭 1 次（sleep 4 次 → 迴圈跑 5 輪）：touch 次數須隨輪詢輪數增加
    expect(liveness.touch).toHaveBeenCalledTimes(1 + (clock.sleeps.length + 1));
  });
});

describe("createProcessor：全欄位斷言（進度／trigger／metrics／活性／TTL）", () => {
  it("cache 未命中完整路徑：進度 0→20→40→60→80→100、trigger cached:false、metrics 各一次、活性成對、TTL 各用其值", async () => {
    const clock = new FakeClock(CLOCK_START);
    const liveness = makeLiveness();
    const { store, publisher, repo, metrics, processor } = setup(
      [okScript(() => clock.advance(1234))], // 串流途中過了 1234 ms
      { clock, liveness },
    );
    const job = makeJob("m");
    await processor(job);

    expect(job.progress).toEqual([0, 20, 40, 60, 80, 100]);
    expect(repo.triggers).toEqual([{ machineId: "press-02", jobId: "m", requestedBy: "tester", cached: false }]);
    expect(repo.diagnoses).toEqual([{ machineId: "press-02", jobId: "m", result: VALID_RESULT }]);
    expect(publisher.events.map((e) => e.type)).toEqual(["ai/token", "ai/token", "ai/done"]);
    expect(publisher.ofType("ai/done")).toEqual([
      { type: "ai/done", jobId: "m", attempt: 1, cached: false, result: VALID_RESULT },
    ]);

    expect(metrics.recordCacheMiss).toHaveBeenCalledTimes(1);
    expect(metrics.recordCacheHit).not.toHaveBeenCalled();
    expect(metrics.recordLatency).toHaveBeenCalledTimes(1);
    expect(metrics.recordLatency).toHaveBeenCalledWith(1234);
    expectLivenessPaired(liveness);
    // context 後 1 次＋取鎖迴圈 1 次＋每個 token 1 次：漏掉 onToken 或迴圈內的 touch 都會少計
    expect(liveness.touch).toHaveBeenCalledTimes(1 + 1 + publisher.ofType("ai/token").length);

    const { cacheKey, lockKey } = keysFor(CONTEXT);
    // setWithTtl 兩次：先暫存 ai-result（3600 s），寫庫後才寫 ai-cache；暫存於寫庫成功後刪除。
    expect(store.ttlsOf("cache")).toEqual([
      { op: "cache", key: "ai-result:m", ttlSeconds: 3600 },
      { op: "cache", key: cacheKey, ttlSeconds: CONFIG.cacheTtlSeconds },
    ]);
    expect(store.data.has("ai-result:m")).toBe(false);
    expect(store.ttlsOf("marker")).toEqual([{ op: "marker", key: "ai-metric:m", ttlSeconds: 86_400 }]);
    expect(store.ttlsOf("lock")).toEqual([{ op: "lock", key: lockKey, ttlSeconds: CONFIG.lockTtlSeconds }]);
    // 限流窗：key 帶窗序號、TTL 取兩個窗長（120 秒）
    expect(store.ttlsOf("window")).toEqual([
      { op: "window", key: `ai-rpm:${Math.floor(CLOCK_START / 60_000)}`, ttlSeconds: 120 },
    ]);
  });

  it("cache 命中路徑：進度 0→20→100、trigger cached:true、只記一筆命中、不取鎖不寫 cache、活性成對", async () => {
    const liveness = makeLiveness();
    const { store, repo, publisher, metrics, processor } = setup([okScript()], { liveness });
    store.data.set(keysFor(CONTEXT).cacheKey, RESULT_TEXT);
    const job = makeJob("hit");
    await processor(job);

    expect(job.progress).toEqual([0, 20, 100]);
    expect(repo.triggers).toEqual([{ machineId: "press-02", jobId: "hit", requestedBy: "tester", cached: true }]);
    expect(repo.diagnoses).toEqual([]);
    expect(publisher.events).toEqual([{ type: "ai/done", jobId: "hit", attempt: 1, cached: true, result: VALID_RESULT }]);
    expect(metrics.recordCacheHit).toHaveBeenCalledTimes(1);
    expect(metrics.recordCacheMiss).not.toHaveBeenCalled();
    expect(metrics.recordLatency).not.toHaveBeenCalled();
    // 不取鎖、不寫 cache、不吃限流額度；只有 hit／miss 的一次性標記
    expect(store.ttls).toEqual([{ op: "marker", key: "ai-metric:hit", ttlSeconds: 86_400 }]);
    expectLivenessPaired(liveness);
    // 命中於迴圈前：只有 context 後那 1 次
    expect(liveness.touch).toHaveBeenCalledTimes(1);
  });

  it("同 jobId 已計過 hit／miss（ai-metric 標記存在）不重複計，但成功的 LLM 呼叫仍記延遲樣本", async () => {
    const { store, metrics, processor } = setup([okScript()]);
    // 前一次嘗試（失敗）已計過：標記由 SET NX 留下。
    store.data.set("ai-metric:r", "1");
    store.data.set("ai-metric:r2", "1");
    await processor(makeJob("r", { attemptsMade: 1, attempts: 3 })); // 未命中路徑
    expect(store.cacheKeys()).toHaveLength(1);
    await processor(makeJob("r2", { attemptsMade: 2, attempts: 3 })); // 命中路徑

    expect(metrics.recordCacheMiss).not.toHaveBeenCalled();
    expect(metrics.recordCacheHit).not.toHaveBeenCalled();
    expect(metrics.recordLatency).toHaveBeenCalledTimes(1);
  });

  it("LLM 失敗路徑：進度停在 40、不寫 trigger、不記延遲，但活性槽仍成對釋放", async () => {
    const liveness = makeLiveness();
    const { repo, metrics, processor } = setup(
      [
        async () => {
          throw new AiProviderError("503 overloaded", { retryable: true, code: "provider_error" });
        },
      ],
      { liveness },
    );
    const job = makeJob("f");
    await expect(processor(job)).rejects.toThrow("503 overloaded");

    expect(job.progress).toEqual([0, 20, 40]);
    expect(repo.triggers).toEqual([]);
    expect(metrics.recordCacheMiss).toHaveBeenCalledTimes(1);
    expect(metrics.recordLatency).not.toHaveBeenCalled();
    expectLivenessPaired(liveness);
    // context 後 1 次＋取鎖迴圈 1 次（失敗前沒有 token）
    expect(liveness.touch).toHaveBeenCalledTimes(2);
  });

  it("buildContext 拋錯（最早的失敗點）：活性槽仍成對釋放、不計 hit／miss", async () => {
    const liveness = makeLiveness();
    const { metrics, processor } = setup([okScript()], {
      liveness,
      buildContext: async () => {
        throw new Error("mongo down");
      },
    });
    const job = makeJob("c");
    await expect(processor(job)).rejects.toThrow("mongo down");

    expect(job.progress).toEqual([0]);
    expect(metrics.recordCacheHit).not.toHaveBeenCalled();
    expect(metrics.recordCacheMiss).not.toHaveBeenCalled();
    expectLivenessPaired(liveness);
    expect(liveness.touch).not.toHaveBeenCalled(); // 拋在第一次 touch 之前
  });
});

describe("createProcessor：重試語意", () => {
  const badJson: Script = async ({ onToken }) => {
    onToken("not json");
    return { text: "not json", finishReason: "stop" };
  };

  it("非最終嘗試的 schema 錯誤：不送 ai/error、throw 可重試錯誤", async () => {
    const { publisher, processor } = setup([badJson]);
    const err = await processor(makeJob("a", { attemptsMade: 0, attempts: 3 })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(UnrecoverableError);
    expect(publisher.ofType("ai/error")).toEqual([]);
    // token 仍帶 attempt，前端可據以換輪清空
    expect(publisher.ofType("ai/token").every((e) => e.attempt === 1)).toBe(true);
  });

  it("非最終嘗試的 ai_timeout：丟一般 Error（非 UnrecoverableError，交給 BullMQ 重試）且不送 ai/error", async () => {
    const { publisher, processor } = setup([async () => new Promise<AiStreamResult>(() => {})], { aiTimeoutMs: 30 });
    const err = await processor(makeJob("t", { attemptsMade: 0, attempts: 3 })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(UnrecoverableError);
    expect((err as Error).message).toBe("AI streaming timeout after 30ms");
    expect(publisher.ofType("ai/error")).toEqual([]);
  });

  it("非 AiProviderError 的一般錯誤：第一次嘗試視為可重試（不送 ai/error、非 UnrecoverableError）", async () => {
    const { publisher, processor } = setup([
      async () => {
        throw new TypeError("fetch failed");
      },
    ]);
    const err = await processor(makeJob("g", { attemptsMade: 0, attempts: 3 })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(UnrecoverableError);
    expect((err as Error).message).toBe("fetch failed");
    expect(publisher.ofType("ai/error")).toEqual([]);
  });

  it("最終嘗試的 schema 錯誤：送 ai/error(schema_invalid) 並帶 attempt", async () => {
    const { publisher, processor } = setup([badJson]);
    await expect(processor(makeJob("a", { attemptsMade: 2, attempts: 3 }))).rejects.toThrow();
    expect(publisher.ofType("ai/error")).toEqual([
      expect.objectContaining({ jobId: "a", code: "schema_invalid", attempt: 3 }),
    ]);
  });

  it("不可重試的 provider 錯誤：第一次嘗試就送 ai/error 並轉 UnrecoverableError", async () => {
    const { publisher, processor } = setup([
      async () => {
        throw new AiProviderError("API key not valid", { retryable: false, code: "provider_error", status: 400 });
      },
    ]);
    await expect(processor(makeJob("a"))).rejects.toBeInstanceOf(UnrecoverableError);
    expect(publisher.ofType("ai/error")).toEqual([
      expect.objectContaining({ code: "provider_error", message: "API key not valid", attempt: 1 }),
    ]);
  });

  it("缺金鑰（真的 GeminiProvider）：第一次嘗試就 UnrecoverableError + ai/error，不打 LLM", async () => {
    const { publisher, processor, ai } = setup([okScript()]);
    const gemini = new GeminiProvider("", "gemini-2.5-flash");
    ai.streamDiagnosis = (req) => gemini.streamDiagnosis(req);
    await expect(processor(makeJob("a", { attemptsMade: 0, attempts: 3 }))).rejects.toBeInstanceOf(UnrecoverableError);
    expect(publisher.ofType("ai/error")).toEqual([expect.objectContaining({ code: "provider_error", attempt: 1 })]);
    expect(publisher.ofType("ai/error")[0]?.message.toLowerCase()).toContain("api key");
    expect(publisher.ofType("ai/token")).toEqual([]);
  });

  it("finishReason=stop 的完整回應：記一筆延遲樣本", async () => {
    const { processor, metrics } = setup([okScript()]);
    await processor(makeJob("ok"));
    expect(metrics.recordLatency).toHaveBeenCalledTimes(1);
  });

  it("finishReason=safety：視為格式失敗且不可重試，不記延遲樣本", async () => {
    const { publisher, processor, metrics } = setup([async () => ({ text: "", finishReason: "safety" })]);
    await expect(processor(makeJob("a"))).rejects.toBeInstanceOf(UnrecoverableError);
    expect(publisher.ofType("ai/error")[0]?.code).toBe("schema_invalid");
    expect(metrics.recordLatency).not.toHaveBeenCalled();
  });

  it("finishReason=max_tokens：視為格式失敗且不可重試（第一次嘗試就送 ai/error，不再燒 token 重試）", async () => {
    const { publisher, processor, repo, store, metrics } = setup([
      async () => ({ text: RESULT_TEXT, finishReason: "max_tokens" }),
    ]);
    await expect(processor(makeJob("a", { attemptsMade: 0, attempts: 3 }))).rejects.toBeInstanceOf(UnrecoverableError);
    expect(publisher.ofType("ai/error")).toEqual([
      expect.objectContaining({ code: "schema_invalid", attempt: 1, message: expect.stringContaining("max_tokens") }),
    ]);
    // 截斷的輸出即使剛好是合法 JSON 也不落地、不進 cache、不寫 trigger（終態 trigger 由 failed handler 補寫）
    expect(repo.diagnoses).toEqual([]);
    expect(store.cacheKeys()).toEqual([]);
    expect(repo.triggers).toEqual([]);
    // 截斷樣本不進延遲統計（avg／p95 只反映完整回應）
    expect(metrics.recordLatency).not.toHaveBeenCalled();
  });
});

describe("createProcessor：ai/token 序號", () => {
  it("同一次嘗試內 seq 由 0 起逐一遞增（前端以 seq 0 重設串流文字）", async () => {
    const { publisher, processor } = setup([
      async ({ onToken }) => {
        onToken(RESULT_TEXT.slice(0, 5));
        onToken(RESULT_TEXT.slice(5, 20));
        onToken(RESULT_TEXT.slice(20));
        return { text: RESULT_TEXT, finishReason: "stop" };
      },
    ]);
    await processor(makeJob("a"));
    expect(publisher.ofType("ai/token").map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(publisher.ofType("ai/token").map((e) => e.text).join("")).toBe(RESULT_TEXT);
  });

  it("每次嘗試的 seq 各自從 0 開始（重試換輪）", async () => {
    const { publisher, processor } = setup([okScript()]);
    await processor(makeJob("r", { attemptsMade: 1, attempts: 3 }));
    expect(publisher.ofType("ai/token").map((e) => [e.attempt, e.seq])).toEqual([
      [2, 0],
      [2, 1],
    ]);
  });
});

describe("createProcessor：空脈絡短路", () => {
  it("無遙測／異常事件／維修紀錄：不查 cache、不取鎖、不打 LLM，第一次嘗試就送不可重試的 ai/error(no_context)", async () => {
    const liveness = makeLiveness();
    const { ai, publisher, repo, store, metrics, processor } = setup([okScript()], {
      context: EMPTY_CONTEXT,
      liveness,
    });
    const job = makeJob("ghost", { attemptsMade: 0, attempts: 3 });
    const err = await processor(job).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(UnrecoverableError);
    // main.ts 的 failed handler 據此判終態並補寫 trigger(cached:false)
    expect(isTerminalFailure(job, err as Error)).toBe(true);
    expect(ai.calls).toHaveLength(0);
    expect(publisher.events).toEqual([
      { type: "ai/error", jobId: "ghost", attempt: 1, code: NO_CONTEXT_CODE, message: NO_CONTEXT_MESSAGE },
    ]);
    expect(store.counters.size).toBe(0); // 不吃 AI_RPM 額度
    expect(store.lockKeys()).toEqual([]);
    expect(store.cacheKeys()).toEqual([]);
    expect(repo.diagnoses).toEqual([]);
    expect(repo.triggers).toEqual([]); // trigger 由 failed handler 補寫，processor 不重複寫
    expect(metrics.recordCacheHit).not.toHaveBeenCalled();
    expect(metrics.recordCacheMiss).not.toHaveBeenCalled();
    expect(job.progress).toEqual([0, 20]);
    // 短路路徑同樣成對釋放活性槽：漏 end 會讓槽永遠被佔，最終被判定為卡死
    expectLivenessPaired(liveness);
    // 短路於 cache／迴圈前：只有 context 後那 1 次
    expect(liveness.touch).toHaveBeenCalledTimes(1);
  });

  it.each<[string, Partial<DiagnosisContext>]>([
    ["有窗口內遙測", { telemetry: { count: 1, avgTemperature: 1, maxTemperature: 1, avgVibration: 1, maxVibration: 1, avgErrorRate: 0, maxErrorRate: 0 } }],
    ["只有最近 state", { latestState: "healthy" }],
    ["只有異常事件", { recentErrors: [{ state: "critical", message: "x", timestamp: "" }], topErrorCodes: ["critical"] }],
    ["只有維修紀錄", { maintenance: [{ summary: "換軸承" }] }],
  ])("%s → 照常呼叫 LLM", async (_label, patch) => {
    const { ai, processor } = setup([okScript()], { context: { ...EMPTY_CONTEXT, ...patch } });
    await processor(makeJob("x"));
    expect(ai.calls).toHaveLength(1);
  });
});

describe("createProcessor：逾時", () => {
  it("逾時後 AbortSignal 觸發、不再有 ai/token，最終嘗試送 ai/error(ai_timeout)", async () => {
    let seenSignal: AbortSignal | undefined;
    const { publisher, processor } = setup(
      [
        // 刻意「不理會 signal」的 adapter：中止後仍硬吐一個遲到的 token、且串流永不自行結束。
        // 核心仍須中止等待並丟棄遲到的 token。（逾時本身走真實 AbortSignal.timeout，非注入時間。）
        async ({ onToken, signal }) => {
          seenSignal = signal;
          onToken("{");
          signal.addEventListener("abort", () => onToken("late"), { once: true });
          return new Promise<AiStreamResult>(() => {});
        },
      ],
      { aiTimeoutMs: 30 },
    );
    await expect(processor(makeJob("a", { attemptsMade: 2, attempts: 3 }))).rejects.toThrow(/timeout/);
    expect(seenSignal?.aborted).toBe(true);
    expect(publisher.ofType("ai/token").map((e) => e.text)).toEqual(["{"]);
    expect(publisher.ofType("ai/error")).toEqual([expect.objectContaining({ code: "ai_timeout", attempt: 3 })]);
  });
});

describe("createProcessor：cache", () => {
  it("cache 命中：不呼叫 LLM、不寫 diagnoses，trigger 記 cached:true", async () => {
    const { ai, repo, publisher, processor, store, metrics } = setup([okScript()]);
    await processor(makeJob("seed"));
    ai.calls.length = 0;
    repo.diagnoses.length = 0;
    repo.triggers.length = 0;

    await processor(makeJob("hit"));
    expect(ai.calls).toHaveLength(0);
    expect(repo.diagnoses).toHaveLength(0);
    expect(repo.triggers).toEqual([expect.objectContaining({ jobId: "hit", cached: true })]);
    expect(publisher.ofType("ai/done").at(-1)).toEqual(expect.objectContaining({ jobId: "hit", cached: true, attempt: 1 }));
    expect(store.cacheKeys()).toHaveLength(1);
    expect(metrics.recordCacheHit).toHaveBeenCalledTimes(1);
  });

  it("cache 讀回畸形：del 並視為 miss，重算後覆寫為合法值", async () => {
    const { ai, store, processor } = setup([okScript()]);
    await processor(makeJob("seed"));
    const [key] = store.cacheKeys();
    if (!key) throw new Error("cache 未寫入");
    store.data.set(key, JSON.stringify({ summary: "缺欄位" }));
    ai.calls.length = 0;

    await processor(makeJob("again"));
    expect(store.deleted).toContain(key);
    expect(ai.calls).toHaveLength(1);
    expect(JSON.parse(store.data.get(key) ?? "null")).toEqual(VALID_RESULT);
  });

  it("先寫 diagnoses 再寫 cache：寫 cache 失敗時 diagnoses 已落地、cache 仍空；重試由冪等短路沿用，不重打 LLM", async () => {
    const { ai, store, repo, processor } = setup([okScript()]);
    store.failSetWithTtl = (key) => key.startsWith("ai-cache:");
    await expect(processor(makeJob("a"))).rejects.toThrow("redis down");
    expect(repo.diagnoses).toHaveLength(1);
    expect(store.cacheKeys()).toHaveLength(0);
    expect(store.data.has("ai-result:a")).toBe(false); // 寫庫成功後暫存已刪

    await expect(processor(makeJob("a", { attemptsMade: 1, attempts: 3 }))).resolves.toEqual({
      result: VALID_RESULT,
      cached: false,
    });
    expect(ai.calls).toHaveLength(1);
    expect(store.cacheKeys()).toHaveLength(0); // 短路不回填 ai-cache（P11）
  });

  it("暫存 ai-result 寫入失敗（Redis 錯誤）只 warn：照常寫 diagnoses、快取與 trigger，job 成功", async () => {
    const { logger, warns } = recordingLogger();
    const { store, repo, processor } = setup([okScript()], { logger });
    store.failSetWithTtl = (key) => key.startsWith("ai-result:");
    await expect(processor(makeJob("a"))).resolves.toEqual({ result: VALID_RESULT, cached: false });
    expect(repo.diagnoses).toHaveLength(1);
    expect(store.cacheKeys()).toHaveLength(1);
    expect(repo.triggers.map((t) => t.cached)).toEqual([false]);
    expect(warns.map((w) => w.msg)).toContain("ai-result 暫存寫入失敗（照常寫 diagnoses）");
  });

  it("暫存寫入失敗且之後的步驟也失敗：diagnoses 已落地者由短路 (ii) 回收，不重打 LLM", async () => {
    const { ai, store, processor } = setup([okScript()]);
    store.failSetWithTtl = () => true; // ai-result 與 ai-cache 都寫不進去
    await expect(processor(makeJob("a"))).rejects.toThrow("redis down"); // 卡在 SET ai-cache

    store.failSetWithTtl = false;
    await expect(processor(makeJob("a", { attemptsMade: 1, attempts: 3 }))).resolves.toEqual({
      result: VALID_RESULT,
      cached: false,
    });
    expect(ai.calls).toHaveLength(1);
  });

  it("provider 收到由 DiagnosisResultSchema 推導的 responseJsonSchema", async () => {
    const { ai, processor } = setup([okScript()]);
    await processor(makeJob("a"));
    expect(ai.calls[0]?.responseJsonSchema).toEqual(expect.objectContaining({ type: "object" }));
  });
});

describe("createProcessor：LLM 限流與關閉", () => {
  it("超過每分鐘上限：不呼叫 LLM、放鎖、moveToDelayed 到下一窗起點＋抖動後丟 DelayedError", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const { ai, store, processor } = setup([okScript()], { aiRpm: 1 });
    await processor(makeJob("first"));
    // 讓 cache 失效，第二筆必須打 LLM
    for (const k of store.cacheKeys()) store.data.delete(k);

    const job = makeJob("second");
    await expect(processor(job, "bull-token")).rejects.toBeInstanceOf(DelayedError);
    expect(ai.calls).toHaveLength(1);
    const windowIndex = Math.floor(CLOCK_START / 60_000);
    expect(store.counters.get(`ai-rpm:${windowIndex}`)).toBe(2);
    // 下一窗起點 + 0.5 × 2000 ms 抖動
    expect(job.moveToDelayed).toHaveBeenCalledWith((windowIndex + 1) * 60_000 + 1000, "bull-token");
    expect(store.lockKeys()).toEqual([]);
  });

  it("關閉中：等待者不再空等，把 job 交回佇列（1 秒後）", async () => {
    let closing = false;
    const holder = gatedScript();
    const { clock, processor } = setup([holder.script], { isClosing: () => closing });
    const holding = processor(makeJob("holder"), "t1");
    await flush();

    closing = true; // 持鎖者串流途中收到 SIGTERM
    const waiter = makeJob("waiter");
    const waiting = track(processor(waiter, "t2"));
    await flush();
    expect(waiting.state.settled).toBe(true);
    await expect(waiting.promise).rejects.toBeInstanceOf(DelayedError);
    expect(waiter.moveToDelayed).toHaveBeenCalledWith(clock.now() + 1000, "t2");
    expect(clock.sleeps).toEqual([]); // 沒有空等任何一輪

    holder.release();
    await expect(holding).resolves.toEqual({ result: VALID_RESULT, cached: false });
  });
});

/** 可由測試放行的 PUBLISH 回應（模擬 Redis 回覆尚未到達）。 */
function gatedPublish() {
  let open: () => void = () => {};
  const gate = new Promise<number>((r) => {
    open = () => r(1);
  });
  return { gate, release: () => open() };
}

describe("createProcessor：終態事件 await 送出（AR-5／WK-14）", () => {
  it("LLM 路徑：ai/done 的 PUBLISH 未完成前 processor 不 resolve；ai/token 不被等待", async () => {
    const { publisher, repo, processor } = setup([okScript()]);
    const done = gatedPublish();
    // token 的 PUBLISH 永不完成：若被 await，processor 會永遠卡住。
    publisher.respond = (e) => (e.type === "ai/done" ? done.gate : new Promise(() => {}));
    const run = track(processor(makeJob("a")));
    await flush();

    expect(publisher.events.map((e) => e.type)).toEqual(["ai/token", "ai/token", "ai/done"]);
    expect(repo.triggers).toHaveLength(1); // 落地已完成，只差終態通知
    expect(run.state.settled).toBe(false);

    done.release();
    await expect(run.promise).resolves.toEqual({ result: VALID_RESULT, cached: false });
  });

  it("cache 命中路徑：ai/done 的 PUBLISH 未完成前 processor 不 resolve", async () => {
    const { store, publisher, processor } = setup([okScript()]);
    store.data.set(keysFor(CONTEXT).cacheKey, RESULT_TEXT);
    const done = gatedPublish();
    publisher.respond = () => done.gate;
    const run = track(processor(makeJob("hit")));
    await flush();
    expect(publisher.ofType("ai/done")).toHaveLength(1);
    expect(run.state.settled).toBe(false);

    done.release();
    await expect(run.promise).resolves.toEqual({ result: VALID_RESULT, cached: true });
  });

  it("終態 ai/error（最終嘗試）：PUBLISH 完成前不 throw——具體錯誤先於 BullMQ failed", async () => {
    const { publisher, processor } = setup([
      async () => {
        throw new AiProviderError("API key not valid", { retryable: false, code: "provider_error", status: 400 });
      },
    ]);
    const pending = gatedPublish();
    publisher.respond = () => pending.gate;
    const run = track(processor(makeJob("e")));
    await flush();
    expect(publisher.ofType("ai/error")).toHaveLength(1);
    expect(run.state.settled).toBe(false);

    pending.release();
    await expect(run.promise).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it("no_context：ai/error 的 PUBLISH 完成前不 throw", async () => {
    const { publisher, processor } = setup([okScript()], { context: EMPTY_CONTEXT });
    const pending = gatedPublish();
    publisher.respond = () => pending.gate;
    const run = track(processor(makeJob("ghost")));
    await flush();
    expect(publisher.ofType("ai/error")).toEqual([expect.objectContaining({ code: NO_CONTEXT_CODE })]);
    expect(run.state.settled).toBe(false);

    pending.release();
    await expect(run.promise).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it("ai/done 的 PUBLISH 失敗：記 warn，job 仍成功並照常回傳 returnvalue（不轉失敗重試、不重複落地）", async () => {
    const { logger, warns } = recordingLogger();
    const { publisher, repo, store, processor } = setup([okScript()], { logger });
    const boom = new Error("redis down");
    publisher.respond = (e) => (e.type === "ai/done" ? Promise.reject(boom) : Promise.resolve(1));

    await expect(processor(makeJob("a"))).resolves.toEqual({ result: VALID_RESULT, cached: false });
    expect(repo.diagnoses).toHaveLength(1);
    expect(repo.triggers).toHaveLength(1);
    expect(store.cacheKeys()).toHaveLength(1);
    expect(warns).toEqual([{ obj: { eventType: "ai/done", err: boom }, msg: "終態事件 publish 失敗（job 結果不變）" }]);
  });

  it("cache 命中時 ai/done 的 PUBLISH 失敗：記 warn，job 仍成功並照常回傳 returnvalue", async () => {
    const { logger, warns } = recordingLogger();
    const { store, publisher, repo, processor } = setup([okScript()], { logger });
    store.data.set(keysFor(CONTEXT).cacheKey, RESULT_TEXT);
    publisher.respond = () => Promise.reject(new Error("redis down"));

    await expect(processor(makeJob("hit"))).resolves.toEqual({ result: VALID_RESULT, cached: true });
    expect(repo.triggers).toEqual([expect.objectContaining({ jobId: "hit", cached: true })]);
    expect(warns).toEqual([expect.objectContaining({ obj: expect.objectContaining({ eventType: "ai/done" }) })]);
  });

  it("終態 ai/error 的 PUBLISH 失敗：記 warn，原本的錯誤照常拋出（不被通知失敗蓋掉）", async () => {
    const { logger, warns, errors } = recordingLogger();
    const { publisher, processor } = setup([async () => ({ text: "", finishReason: "safety" })], { logger });
    publisher.respond = () => Promise.reject(new Error("redis down"));

    const err = await processor(makeJob("s")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnrecoverableError);
    expect((err as Error).message).toContain("finishReason=safety");
    expect(errors).toEqual([expect.objectContaining({ msg: "AI 診斷失敗（終態，通知前端）" })]);
    expect(warns).toEqual([expect.objectContaining({ obj: expect.objectContaining({ eventType: "ai/error" }) })]);
  });

  it("no_context 的 PUBLISH 失敗：仍拋 UnrecoverableError（failed handler 照常補寫 trigger）", async () => {
    const { logger, warns } = recordingLogger();
    const { publisher, processor } = setup([okScript()], { context: EMPTY_CONTEXT, logger });
    publisher.respond = () => Promise.reject(new Error("redis down"));

    await expect(processor(makeJob("ghost"))).rejects.toBeInstanceOf(UnrecoverableError);
    expect(warns).toContainEqual(expect.objectContaining({ obj: expect.objectContaining({ eventType: "ai/error" }) }));
  });

  it("ai/token 的 PUBLISH 失敗：記 warn、不中斷串流，ai/done 照常送出", async () => {
    const { logger, warns } = recordingLogger();
    const { publisher, processor } = setup([okScript()], { logger });
    publisher.respond = (e) => (e.type === "ai/token" ? Promise.reject(new Error("redis down")) : Promise.resolve(1));

    await expect(processor(makeJob("a"))).resolves.toEqual({ result: VALID_RESULT, cached: false });
    await flush(); // token 的 catch 是 fire-and-forget，等它落定
    expect(publisher.ofType("ai/done")).toHaveLength(1);
    expect(warns.filter((w) => w.msg === "publish 失敗")).toHaveLength(2);
  });
});

/** 記下 info 的 fake logger（斷言 `idempotent short-circuit` 的 source）。 */
function infoLogger() {
  const infos: { obj: unknown; msg?: string }[] = [];
  const logger: ProcessorLogger = {
    info: (obj, msg) => infos.push({ obj, msg }),
    warn: () => {},
    error: () => {},
    child: () => logger,
  };
  const shortCircuits = () =>
    infos.filter((i) => i.msg === "idempotent short-circuit").map((i) => (i.obj as { source?: unknown }).source);
  return { logger, infos, shortCircuits };
}

describe("createProcessor：冪等短路（012 T049；FR-024、D6）", () => {
  it("(i) ai-result 暫存命中：補寫 diagnoses、DEL 暫存、trigger cached:false、ai/done 與回傳值，不建 context／不查快取／不取鎖／不打 LLM", async () => {
    const buildContext = vi.fn(async () => CONTEXT);
    const { logger, shortCircuits } = infoLogger();
    const { ai, store, repo, publisher, metrics, processor } = setup([okScript()], { buildContext, logger });
    store.data.set("ai-result:j", RESULT_TEXT);
    store.data.set(keysFor(CONTEXT).cacheKey, RESULT_TEXT); // 快取也有值：短路必須先於快取查詢
    const getSpy = vi.spyOn(store, "get");
    const acquire = vi.spyOn(store, "tryAcquireLock");
    const job = makeJob("j", { attemptsMade: 1, attempts: 3 });

    const ret = await processor(job);

    expect(ret).toEqual({ result: VALID_RESULT, cached: false });
    expect(shortCircuits()).toEqual(["ai-result"]);
    expect(repo.diagnoses).toEqual([{ machineId: "press-02", jobId: "j", result: VALID_RESULT }]);
    expect(store.data.has("ai-result:j")).toBe(false);
    expect(repo.triggers).toEqual([{ machineId: "press-02", jobId: "j", requestedBy: "tester", cached: false }]);
    expect(job.progress).toEqual([0, 100]);
    expect(publisher.events).toEqual([{ type: "ai/done", jobId: "j", attempt: 2, cached: false, result: VALID_RESULT }]);
    expect(ai.calls).toHaveLength(0);
    expect(buildContext).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
    expect(getSpy.mock.calls.map((c) => c[0])).toEqual(["ai-result:j"]); // 沒讀 ai-cache
    expect(repo.findCalls).toBe(0); // (i) 命中就不查 (ii)
    expect(metrics.recordCacheHit).not.toHaveBeenCalled();
    expect(metrics.recordCacheMiss).not.toHaveBeenCalled();
    expect(store.ttls).toEqual([]); // 不寫 ai-metric、不回填 ai-cache
  });

  it("(ii) diagnoses 已有該 jobId：沿用結果、trigger cached:false，不打 LLM、不取鎖、不再 insertDiagnosis", async () => {
    const buildContext = vi.fn(async () => CONTEXT);
    const { logger, shortCircuits } = infoLogger();
    const { ai, store, repo, publisher, processor } = setup([okScript()], { buildContext, logger });
    repo.diagnoses.push({ machineId: "press-02", jobId: "j", result: VALID_RESULT });
    const acquire = vi.spyOn(store, "tryAcquireLock");

    const ret = await processor(makeJob("j", { attemptsMade: 1, attempts: 3 }));

    expect(ret).toEqual({ result: VALID_RESULT, cached: false });
    expect(shortCircuits()).toEqual(["diagnoses"]);
    expect(repo.insertDiagnosisCalls).toBe(0);
    expect(repo.triggers.map((t) => t.cached)).toEqual([false]);
    expect(publisher.ofType("ai/done").map((e) => e.cached)).toEqual([false]);
    expect(ai.calls).toHaveLength(0);
    expect(buildContext).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
  });

  it("ai-result 暫存不合法：DEL 並視為無，續查 diagnoses；兩者皆無走一般路徑", async () => {
    const { logger, shortCircuits } = infoLogger();
    const { ai, store, repo, processor } = setup([okScript()], { logger });
    store.data.set("ai-result:j", JSON.stringify({ summary: 42 }));

    const ret = await processor(makeJob("j"));

    expect(store.deleted).toContain("ai-result:j");
    expect(repo.findCalls).toBe(1);
    expect(shortCircuits()).toEqual([]);
    expect(ai.calls).toHaveLength(1);
    expect(ret).toEqual({ result: VALID_RESULT, cached: false });
  });

  it("(i) 補寫 diagnoses 失敗：走 persist_failed（非最終 attempt 不送 ai/error），暫存保留給下次重試", async () => {
    const { ai, store, repo, publisher, processor } = setup([okScript()]);
    store.data.set("ai-result:j", RESULT_TEXT);
    repo.failInsertDiagnosis = 1;

    const err = await processor(makeJob("j", { attemptsMade: 0, attempts: 3 })).catch((e: unknown) => e);
    expect((err as Error).message).toBe(PERSIST_FAILED_MESSAGE);
    expect(err).not.toBeInstanceOf(UnrecoverableError);
    expect(publisher.events).toEqual([]);
    expect(store.data.get("ai-result:j")).toBe(RESULT_TEXT);
    expect(ai.calls).toHaveLength(0);
  });

  it("短路後 trigger 寫入失敗：拋出走重試，下次仍短路（不打 LLM）", async () => {
    const { ai, repo, publisher, processor } = setup([okScript()]);
    repo.diagnoses.push({ machineId: "press-02", jobId: "j", result: VALID_RESULT });
    repo.failUpsertTrigger = true;
    await expect(processor(makeJob("j"))).rejects.toThrow("mongo down");
    expect(publisher.events).toEqual([]);

    repo.failUpsertTrigger = false;
    await expect(processor(makeJob("j", { attemptsMade: 1, attempts: 3 }))).resolves.toEqual({
      result: VALID_RESULT,
      cached: false,
    });
    expect(ai.calls).toHaveLength(0);
  });
});

describe("createProcessor：再執行在快取命中時先重查短路（M1；ADR-003 D3）", () => {
  it("exec1 寫完快取後，等鎖迴圈中的 exec2（stalled 重派）命中快取：照短路語意回 cached:false、trigger 1 筆、ai/done cached:false", async () => {
    const holder = gatedScript();
    const { logger, shortCircuits } = infoLogger();
    const { ai, repo, publisher, metrics, clock, processor } = setup([holder.script], { logger });
    const exec1 = processor(makeJob("re"));
    await flush();
    expect(ai.calls).toHaveLength(1);

    // 舊執行仍持 ai-lock 時被判 stalled、重派：attemptsMade 不變、attemptsStarted 遞增。
    const exec2 = processor(makeJob("re", { attemptsStarted: 2 }));
    await flush();
    expect(clock.pending).toBe(1); // exec2 開頭短路未命中（舊執行尚未落地），取不到鎖而等待

    holder.release();
    expect(await exec1).toEqual({ result: VALID_RESULT, cached: false });
    clock.advance(CONFIG.pollIntervalMs);
    expect(await exec2).toEqual({ result: VALID_RESULT, cached: false });

    expect(shortCircuits()).toEqual(["diagnoses"]);
    expect(ai.calls).toHaveLength(1);
    expect(repo.triggers).toEqual([{ machineId: "press-02", jobId: "re", requestedBy: "tester", cached: false }]);
    expect(publisher.ofType("ai/done").map((e) => [e.jobId, e.cached])).toEqual([
      ["re", false],
      ["re", false],
    ]);
    expect(metrics.recordCacheHit).not.toHaveBeenCalled();
    expect(metrics.recordCacheMiss).toHaveBeenCalledTimes(1);
  });

  it("第一次執行（非再執行）命中他人寫的快取：不重查短路，照常 cached:true", async () => {
    const { store, repo, processor } = setup([okScript()]);
    store.data.set(keysFor(CONTEXT).cacheKey, RESULT_TEXT);
    await expect(processor(makeJob("fresh"))).resolves.toEqual({ result: VALID_RESULT, cached: true });
    expect(repo.findCalls).toBe(1); // 只有開頭那一次
  });

  it("再執行但前一次未落地（只有他人的快取）：重查短路未命中，照常 cached:true", async () => {
    const { store, repo, processor } = setup([okScript()]);
    store.data.set(keysFor(CONTEXT).cacheKey, RESULT_TEXT);
    await expect(processor(makeJob("retry", { attemptsMade: 1, attempts: 3 }))).resolves.toEqual({
      result: VALID_RESULT,
      cached: true,
    });
    expect(repo.findCalls).toBe(2); // 開頭一次＋命中快取前重查一次
  });
});

describe("createProcessor：diagnoses 紀錄不合法（L4）", () => {
  it("短路 (ii) 讀到不合法紀錄：由 processor 的 logger 記 warn、視為查無，走一般路徑", async () => {
    const { logger, warns } = recordingLogger();
    const { ai, repo, processor } = setup([okScript()], { logger });
    repo.invalidJobIds.add("bad");
    await expect(processor(makeJob("bad"))).resolves.toEqual({ result: VALID_RESULT, cached: false });
    expect(warns.map((w) => w.msg)).toContain("diagnoses 既有紀錄的 result 不符 schema，視為查無");
    expect(ai.calls).toHaveLength(1);
  });
});

describe("createProcessor：hit／miss 每個 jobId 只計一次（012 T050；FR-026）", () => {
  it("stalled 重派（attemptsMade 不變）的第二次執行命中快取：不再記 hit，trigger 仍只一筆", async () => {
    const { store, repo, metrics, processor } = setup([okScript()]);
    store.data.set(keysFor(CONTEXT).cacheKey, RESULT_TEXT);
    await processor(makeJob("s")); // 第一次執行：記 hit
    // 第一次執行被判 stalled 重派：attemptsMade 仍為 0（BullMQ 只遞增 attemptsStarted）。
    await processor(makeJob("s"));

    expect(metrics.recordCacheHit).toHaveBeenCalledTimes(1);
    expect(metrics.recordCacheMiss).not.toHaveBeenCalled();
    expect(repo.triggers).toHaveLength(1);
    expect(repo.upsertCalls).toHaveLength(2);
  });

  it("限流延後後才打 LLM：延後那次不記、真的打 LLM 的那次記 miss 一次", async () => {
    const { store, metrics, processor } = setup([okScript()], { aiRpm: 1 });
    const windowIndex = Math.floor(CLOCK_START / 60_000);
    store.counters.set(`ai-rpm:${windowIndex}`, 1); // 本窗已用完
    const delayed = makeJob("d");
    await expect(processor(delayed, "bull-token")).rejects.toBeInstanceOf(DelayedError);
    expect(metrics.recordCacheMiss).not.toHaveBeenCalled();

    store.counters.clear(); // 下一窗：moveToDelayed 後再執行（attemptsMade 不變）
    await processor(makeJob("d"), "bull-token");
    expect(metrics.recordCacheMiss).toHaveBeenCalledTimes(1);
    expect(metrics.recordCacheHit).not.toHaveBeenCalled();
  });

  it("ai-metric 的 SET NX 失敗（Redis 錯誤）：照常拋出走重試", async () => {
    const { store, processor } = setup([okScript()]);
    store.data.set(keysFor(CONTEXT).cacheKey, RESULT_TEXT);
    vi.spyOn(store, "setIfAbsent").mockRejectedValue(new Error("redis down"));
    await expect(processor(makeJob("x"))).rejects.toThrow("redis down");
  });
});

describe("createProcessor：寫庫暫存與 persist_failed（012 T051；FR-027、裁決 5／18）", () => {
  it("diagnoses 連續拒寫 3 次：LLM 只打 1 次、只有最終 attempt 送 ai/error(persist_failed)，訊息皆為固定句", async () => {
    const { ai, store, repo, publisher, processor } = setup([okScript()]);
    repo.failInsertDiagnosis = 3;
    const errors: unknown[] = [];
    for (const attemptsMade of [0, 1, 2]) {
      errors.push(await processor(makeJob("p", { attemptsMade, attempts: 3 })).catch((e: unknown) => e));
    }

    expect(ai.calls).toHaveLength(1); // 第 2、3 次由短路 (i) 只重做寫庫
    expect(repo.insertDiagnosisCalls).toBe(3);
    for (const err of errors) {
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(UnrecoverableError);
      expect((err as Error).message).toBe(PERSIST_FAILED_MESSAGE);
      expect((err as Error).message).not.toContain("s3cret");
    }
    expect(publisher.ofType("ai/error")).toEqual([
      { type: "ai/error", jobId: "p", attempt: 3, code: PERSIST_FAILED_CODE, message: PERSIST_FAILED_MESSAGE },
    ]);
    expect(publisher.ofType("ai/done")).toEqual([]);
    expect(repo.triggers).toEqual([]); // 終態 trigger 由 main.ts failed handler 補
    expect(store.cacheKeys()).toHaveLength(0); // 快取有值就代表已落庫
    expect(store.data.get("ai-result:p")).toBe(RESULT_TEXT); // 暫存保留至 TTL
    expect(PERSIST_FAILED_MESSAGE).toContain(PERSIST_FAILED_CODE);
  });

  it("拒寫一次後恢復：重試命中暫存只重做寫庫，回 cached:false、ai-result 刪除", async () => {
    const { logger, shortCircuits } = infoLogger();
    const { ai, store, repo, publisher, metrics, processor } = setup([okScript()], { logger });
    repo.failInsertDiagnosis = 1;
    await expect(processor(makeJob("p"))).rejects.toThrow(PERSIST_FAILED_MESSAGE);
    expect(store.data.get("ai-result:p")).toBe(RESULT_TEXT);

    const ret = await processor(makeJob("p", { attemptsMade: 1, attempts: 3 }));
    expect(ret).toEqual({ result: VALID_RESULT, cached: false });
    expect(shortCircuits()).toEqual(["ai-result"]);
    expect(ai.calls).toHaveLength(1);
    expect(repo.diagnoses).toHaveLength(1);
    expect(store.data.has("ai-result:p")).toBe(false);
    expect(repo.triggers.map((t) => t.cached)).toEqual([false]);
    expect(publisher.ofType("ai/done").map((e) => e.cached)).toEqual([false]);
    expect(metrics.recordCacheMiss).toHaveBeenCalledTimes(1);
  });

  it("寫庫順序：暫存 → diagnoses → DEL 暫存 → ai-cache → trigger → 進度 100 → ai/done", async () => {
    const order: string[] = [];
    const { store, publisher, repo, processor } = setup([okScript()]);
    publisher.order = order;
    repo.order = order;
    const setWithTtl = store.setWithTtl.bind(store);
    vi.spyOn(store, "setWithTtl").mockImplementation(async (key, value, ttl) => {
      order.push(`set:${key.split(":")[0] ?? ""}`);
      await setWithTtl(key, value, ttl);
    });
    const del = store.del.bind(store);
    vi.spyOn(store, "del").mockImplementation(async (key) => {
      order.push(`del:${key.split(":")[0] ?? ""}`);
      await del(key);
    });
    const job = makeJob("o");
    job.progressHook = (p) => {
      if (p >= 80) order.push(`progress:${p}`);
    };

    await processor(job);
    expect(order.slice(order.indexOf("progress:80"))).toEqual([
      "progress:80",
      "set:ai-result",
      "insertDiagnosis",
      "del:ai-result",
      "set:ai-cache",
      "del:ai-fail",
      "upsertTrigger",
      "progress:100",
      "publish:ai/done",
    ]);
  });

  it("DEL 暫存失敗只 warn：job 照常成功", async () => {
    const { store, processor } = setup([okScript()]);
    const del = store.del.bind(store);
    vi.spyOn(store, "del").mockImplementation(async (key) => {
      if (key.startsWith("ai-result:")) throw new Error("redis down");
      await del(key);
    });
    await expect(processor(makeJob("w"))).resolves.toEqual({ result: VALID_RESULT, cached: false });
    expect(store.cacheKeys()).toHaveLength(1);
  });
});

describe("createProcessor：Redis 停頓造成雙重執行（012 T051；US4 情境 1、SC-004）", () => {
  it("exec1 停在寫庫前、exec2（stalled 重派）開跑：exec2 命中暫存短路——LLM 1 次、trigger 1 筆、hit／miss 1 次、不標 cached", async () => {
    let releaseInsert: () => void = () => {};
    const insertGate = new Promise<void>((r) => {
      releaseInsert = r;
    });
    const { logger, shortCircuits } = infoLogger();
    const { ai, repo, publisher, metrics, processor } = setup([okScript()], { logger });
    // exec1 的 insertDiagnosis 卡住（模擬停頓）；ai-result 已寫入。
    const insert = repo.insertDiagnosis.bind(repo);
    let first = true;
    vi.spyOn(repo, "insertDiagnosis").mockImplementation(async (doc) => {
      if (first) {
        first = false;
        await insertGate;
      }
      await insert(doc);
    });
    const exec1 = track(processor(makeJob("dup")));
    await flush();
    expect(exec1.state.settled).toBe(false);

    // lock 過期 → stalled 重派：attemptsMade 不變，同 jobId 第二次執行。
    const ret2 = await processor(makeJob("dup"));
    expect(ret2).toEqual({ result: VALID_RESULT, cached: false });
    expect(shortCircuits()).toEqual(["ai-result"]);

    releaseInsert();
    const ret1 = await exec1.promise;
    expect(ret1).toEqual({ result: VALID_RESULT, cached: false });

    expect(ai.calls).toHaveLength(1);
    expect(repo.diagnoses).toHaveLength(1);
    expect(repo.triggers).toEqual([{ machineId: "press-02", jobId: "dup", requestedBy: "tester", cached: false }]);
    expect(metrics.recordCacheHit.mock.calls.length + metrics.recordCacheMiss.mock.calls.length).toBe(1);
    expect(publisher.ofType("ai/done").every((e) => !e.cached)).toBe(true);
  });

  it("exec1 已完成全部寫入後才重派：exec2 由 diagnoses 短路，同樣只一筆 trigger、不記 hit", async () => {
    const { logger, shortCircuits } = infoLogger();
    const { ai, store, repo, metrics, processor } = setup([okScript()], { logger });
    await processor(makeJob("dup"));
    expect(store.cacheKeys()).toHaveLength(1); // 快取已有值：exec2 若先查快取就會誤標 cached:true

    const ret2 = await processor(makeJob("dup"));
    expect(ret2).toEqual({ result: VALID_RESULT, cached: false });
    expect(shortCircuits()).toEqual(["diagnoses"]);
    expect(ai.calls).toHaveLength(1);
    expect(repo.triggers).toHaveLength(1);
    expect(metrics.recordCacheHit).not.toHaveBeenCalled();
    expect(metrics.recordCacheMiss).toHaveBeenCalledTimes(1);
  });
});

describe("createProcessor：keepalive 與 progress 物件（012 T055；FR-019、FR-020、SC-009）", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** 相鄰 progress 的最大間隔（含起點與終點）。 */
  const maxGap = (at: number[], from: number, to: number): number => {
    const points = [from, ...at.filter((t) => t >= from && t <= to), to];
    let gap = 0;
    for (let i = 1; i < points.length; i++) gap = Math.max(gap, (points[i] ?? 0) - (points[i - 1] ?? 0));
    return gap;
  };

  it("等待去重鎖 25 s 期間：每 10 s（± 1 s）至少一次 progress，補送值為目前里程碑 20", async () => {
    vi.useFakeTimers();
    const { store, processor } = setup([okScript()], { realClock: true, pollIntervalMs: 300, aiTimeoutMs: 60_000 });
    const { cacheKey, lockKey } = keysFor(CONTEXT);
    store.data.set(lockKey, "other-replica");
    const job = makeJob("w");
    const start = Date.now();
    const run = processor(job);
    await vi.advanceTimersByTimeAsync(25_000);
    store.data.set(cacheKey, RESULT_TEXT); // 25 s 後持鎖者寫好結果
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(run).resolves.toEqual({ result: VALID_RESULT, cached: true });

    expect(maxGap(job.progressAt, start, start + 25_000)).toBeLessThanOrEqual(11_000);
    const keepalives = job.progress.filter((v, i) => v === 20 && i > 1);
    expect(keepalives.length).toBeGreaterThanOrEqual(2);
    // 也不能補送過密：25 s 內至多 3 則，相鄰補送間隔 ≥ 9 s（keepalive 是閒置補送，不是輪詢頻率）。
    expect(keepalives.length).toBeLessThanOrEqual(3);
    const keepaliveAt = job.progressAt.filter((_, i) => job.progress[i] === 20 && i > 1);
    for (let i = 1; i < keepaliveAt.length; i++) {
      expect((keepaliveAt[i] ?? 0) - (keepaliveAt[i - 1] ?? 0)).toBeGreaterThanOrEqual(9_000);
    }
    expect(job.progress.at(-1)).toBe(100);
  });

  it("首 token 前 20 s 等待：至少補送兩次（值為 40）", async () => {
    vi.useFakeTimers();
    const slowFirst: Script = async (req) => {
      await new Promise<void>((r) => setTimeout(r, 20_500)); // 首 token 前約 20 s
      return okScript()(req);
    };
    const { processor } = setup([slowFirst], { realClock: true, aiTimeoutMs: 60_000 });
    const job = makeJob("f");
    const run = processor(job);
    await vi.advanceTimersByTimeAsync(22_000);
    await run;

    const i40 = job.progress.indexOf(40);
    const i60 = job.progress.indexOf(60);
    expect(job.progress.slice(i40 + 1, i60).filter((v) => v === 40).length).toBeGreaterThanOrEqual(2);
  });

  it("insertDiagnosis 慢 15 s 期間：至少補送一次（值為 80）", async () => {
    vi.useFakeTimers();
    const { repo, processor } = setup([okScript()], { realClock: true, aiTimeoutMs: 60_000 });
    const insert = repo.insertDiagnosis.bind(repo);
    vi.spyOn(repo, "insertDiagnosis").mockImplementation(async (doc) => {
      await new Promise<void>((r) => setTimeout(r, 15_000));
      await insert(doc);
    });
    const job = makeJob("s");
    const run = processor(job);
    await vi.advanceTimersByTimeAsync(16_000);
    await run;

    const i80 = job.progress.indexOf(80);
    const i100 = job.progress.indexOf(100);
    expect(job.progress.slice(i80 + 1, i100).filter((v) => v === 80).length).toBeGreaterThanOrEqual(1);
  });

  it("串流中 token 每 5 s 一則、持續 30 s：不補送（只有里程碑）", async () => {
    vi.useFakeTimers();
    const steady: Script = async ({ onToken }) => {
      const parts = 7;
      for (let i = 0; i < parts; i++) {
        if (i > 0) await new Promise<void>((r) => setTimeout(r, 5_000));
        onToken(RESULT_TEXT.slice((i * RESULT_TEXT.length) / parts, ((i + 1) * RESULT_TEXT.length) / parts));
      }
      return { text: RESULT_TEXT, finishReason: "stop" };
    };
    const { processor } = setup([steady], { realClock: true, aiTimeoutMs: 60_000 });
    const job = makeJob("t");
    const run = processor(job);
    await vi.advanceTimersByTimeAsync(31_000);
    await run;
    expect(job.progress).toEqual([0, 20, 40, 60, 80, 100]);
  });

  it("所有 progress 皆為 DiagnosisJobProgress 物件、attempt＝attemptsMade＋1、execution ≥ 1（attemptsStarted 為 0 時以 1 代入）", async () => {
    vi.useFakeTimers();
    const { store, processor } = setup([okScript()], { realClock: true, pollIntervalMs: 300, aiTimeoutMs: 60_000 });
    const { cacheKey, lockKey } = keysFor(CONTEXT);
    store.data.set(lockKey, "other-replica");
    const job = makeJob("x", { attemptsMade: 1, attemptsStarted: 0 });
    const run = processor(job);
    await vi.advanceTimersByTimeAsync(12_000); // 含一次 keepalive 補送
    store.data.set(cacheKey, RESULT_TEXT);
    await vi.advanceTimersByTimeAsync(1_000);
    await run;

    expect(job.progressRaw.length).toBeGreaterThanOrEqual(4);
    for (const p of job.progressRaw) {
      expect(DiagnosisJobProgressSchema.safeParse(p).success).toBe(true);
      expect(p).toMatchObject({ attempt: 2, execution: 1 });
    }
    const stalled = makeJob("y", { attemptsStarted: 3 });
    store.data.delete(lockKey);
    await processor(stalled);
    expect(stalled.progressRaw.every((p) => p.execution === 3)).toBe(true);
  });

  it("執行結束（成功或失敗）後不再補送；計時器全部清除", async () => {
    vi.useFakeTimers();
    const { processor } = setup([okScript()], { realClock: true, aiTimeoutMs: 60_000 });
    const job = makeJob("done");
    await processor(job);
    const count = job.progress.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(job.progress).toHaveLength(count);

    const failing = setup([async () => Promise.reject(new AiProviderError("bad", { retryable: false, code: "provider_error" }))], {
      realClock: true,
      aiTimeoutMs: 60_000,
    });
    const job2 = makeJob("fail");
    await expect(failing.processor(job2)).rejects.toBeInstanceOf(UnrecoverableError);
    const count2 = job2.progress.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(job2.progress).toHaveLength(count2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("補送失敗：吞掉、本次執行只 warn 一則，job 照常完成", async () => {
    vi.useFakeTimers();
    const { logger, warns } = recordingLogger();
    const { store, processor } = setup([okScript()], { realClock: true, pollIntervalMs: 300, aiTimeoutMs: 60_000, logger });
    const { cacheKey, lockKey } = keysFor(CONTEXT);
    store.data.set(lockKey, "other-replica");
    const job = makeJob("k");
    let failing = false;
    job.progressHook = () => {
      if (failing) throw new Error("redis down");
    };
    const run = processor(job);
    await vi.advanceTimersByTimeAsync(1_000);
    failing = true; // 之後的 keepalive 補送都失敗
    await vi.advanceTimersByTimeAsync(35_000);
    failing = false;
    store.data.set(cacheKey, RESULT_TEXT);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(run).resolves.toEqual({ result: VALID_RESULT, cached: true });
    expect(warns.filter((w) => w.msg === "keepalive 進度補送失敗（本次執行不再重複記錄）")).toHaveLength(1);
  });
});

describe("createProcessor：ai-fail 負向標記（012 T062／T063；FR-028、SC-007、D5）", () => {
  const failing = (code = "provider_error", retryable = true): Script =>
    async () => Promise.reject(new AiProviderError("503 overloaded", { retryable, code }));

  it("LLM 階段失敗：寫 ai-fail:<sig>（EX 10，{ code, message, jobId, at }），info 記 ai-fail written", async () => {
    const { logger, infos } = infoLogger();
    const { store, processor } = setup([failing()], { logger });
    await expect(processor(makeJob("a"))).rejects.toThrow("503 overloaded");
    const { failKey } = keysFor(CONTEXT);
    const marker = JSON.parse(store.data.get(failKey) ?? "null") as unknown;
    expect(AiFailMarkerSchema.parse(marker)).toEqual({
      code: "provider_error",
      message: "503 overloaded",
      jobId: "a",
      at: new Date(CLOCK_START).toISOString(),
    });
    expect(store.ttls.filter((t) => t.key === failKey)).toEqual([{ op: "cache", key: failKey, ttlSeconds: 10 }]);
    expect(infos.some((i) => i.msg === "ai-fail written")).toBe(true);
  });

  it.each([
    ["ai_timeout（逾時）", "ai_timeout"],
    ["schema_invalid（safety，不可重試）", "schema_invalid"],
    ["schema_invalid（parse 失敗）", "schema_invalid"],
  ])("%s 也寫標記", async (label, code) => {
    const scripts: Record<string, Script> = {
      "ai_timeout（逾時）": () => new Promise<AiStreamResult>(() => {}),
      "schema_invalid（safety，不可重試）": async () => ({ text: "", finishReason: "safety" }),
      "schema_invalid（parse 失敗）": async () => ({ text: "not json", finishReason: "stop" }),
    };
    const script = scripts[label];
    if (!script) throw new Error(label);
    const { store, processor } = setup([script], { aiTimeoutMs: 20 });
    await expect(processor(makeJob("a"))).rejects.toThrow();
    const marker = AiFailMarkerSchema.parse(JSON.parse(store.data.get(keysFor(CONTEXT).failKey) ?? "null"));
    expect(marker.code).toBe(code);
  });

  it("no_context、persist_failed、限流延後不寫標記", async () => {
    const empty = setup([okScript()], { context: EMPTY_CONTEXT });
    await expect(empty.processor(makeJob("n"))).rejects.toBeInstanceOf(UnrecoverableError);
    expect([...empty.store.data.keys()].some((k) => k.startsWith("ai-fail:"))).toBe(false);

    const persist = setup([okScript()]);
    persist.repo.failInsertDiagnosis = 1;
    await expect(persist.processor(makeJob("p"))).rejects.toThrow(PERSIST_FAILED_MESSAGE);
    expect(persist.store.data.has(keysFor(CONTEXT).failKey)).toBe(false);

    const limited = setup([okScript()], { aiRpm: 1 });
    limited.store.counters.set(`ai-rpm:${Math.floor(CLOCK_START / 60_000)}`, 1);
    await expect(limited.processor(makeJob("r"), "tok")).rejects.toBeInstanceOf(DelayedError);
    expect(limited.store.data.has(keysFor(CONTEXT).failKey)).toBe(false);
  });

  it("SC-007：兩個同簽章 job、供應商持續失敗——LLM 總數 ≤ 4、第二個 job 最終錯誤碼相同、ai-rpm 不因第二個 job 增加", async () => {
    const holderGate = gatedScript(new AiProviderError("503 overloaded", { retryable: true, code: "provider_error" }));
    const { ai, store, publisher, clock, processor } = setup([holderGate.script, failing()]);
    const windowKey = `ai-rpm:${Math.floor(CLOCK_START / 60_000)}`;
    // 第 1 輪：A 持鎖打 LLM、B 等待；A 失敗寫標記後 B 被擋。
    const a1 = processor(makeJob("A")).catch((e: unknown) => e);
    const b1 = processor(makeJob("B")).catch((e: unknown) => e);
    await flush();
    holderGate.release();
    await a1;
    clock.advance(CONFIG.pollIntervalMs);
    await b1;
    // 第 2、3 輪（退避後重試，標記仍在 10 s 內）：A 忽略自己的標記再打；B 每次都被擋。
    for (const attemptsMade of [1, 2]) {
      await processor(makeJob("A", { attemptsMade })).catch(() => {});
      await processor(makeJob("B", { attemptsMade })).catch(() => {});
    }

    expect(ai.calls.length).toBeLessThanOrEqual(4);
    expect(ai.calls).toHaveLength(3); // 全部來自 A
    expect(store.counters.get(windowKey)).toBe(3); // B 從未吃 AI_RPM
    const errors = publisher.ofType("ai/error");
    expect(errors.map((e) => [e.jobId, e.code, e.attempt])).toEqual([
      ["A", "provider_error", 3],
      ["B", "provider_error", 3],
    ]);
  });

  it("ai-fail 標記寫入失敗：只 warn、持鎖者原本的錯誤不變；等待者看不到標記而接手重打（ai.calls === 2）", async () => {
    const holder = gatedScript(new AiProviderError("503 overloaded", { retryable: true, code: "provider_error" }));
    const { logger, warns } = recordingLogger();
    const { ai, store, clock, processor } = setup([holder.script, okScript()], { logger });
    store.failSetWithTtl = (key) => key.startsWith("ai-fail:");
    const a = processor(makeJob("a")).catch((e: unknown) => e);
    const b = processor(makeJob("b"));
    await flush();
    holder.release();
    const errA = await a;
    expect(errA).toBeInstanceOf(Error);
    expect((errA as Error).message).toBe("503 overloaded");
    expect(warns.map((w) => w.msg)).toContain("ai-fail 標記寫入失敗");

    clock.advance(CONFIG.pollIntervalMs);
    await expect(b).resolves.toEqual({ result: VALID_RESULT, cached: false });
    expect(ai.calls).toHaveLength(2);
  });

  it("成功路徑 DEL ai-fail 拋錯：只 warn，job 照常完成", async () => {
    const { logger, warns } = recordingLogger();
    const { store, processor } = setup([okScript()], { logger });
    const del = store.del.bind(store);
    vi.spyOn(store, "del").mockImplementation(async (key) => {
      if (key.startsWith("ai-fail:")) throw new Error("redis down");
      await del(key);
    });
    await expect(processor(makeJob("ok"))).resolves.toEqual({ result: VALID_RESULT, cached: false });
    expect(warns.map((w) => w.msg)).toContain("ai-fail 標記刪除失敗（將由 TTL 過期回收）");
    expect(store.cacheKeys()).toHaveLength(1);
  });

  it("持鎖者自己的重試忽略自己的標記；成功時 DEL 標記", async () => {
    const { ai, store, processor } = setup([okScript()]);
    const { failKey } = keysFor(CONTEXT);
    store.data.set(failKey, JSON.stringify({ code: "provider_error", message: "x", jobId: "self", at: "t" }));
    await expect(processor(makeJob("self", { attemptsMade: 1 }))).resolves.toEqual({ result: VALID_RESULT, cached: false });
    expect(ai.calls).toHaveLength(1);
    expect(store.data.has(failKey)).toBe(false);
  });

  it("新 job 看到別人的標記：取鎖前就失敗、不取鎖、不吃 AI_RPM；最終 attempt 送同 code 的 ai/error", async () => {
    const { logger, warns } = recordingLogger();
    const { ai, store, publisher, processor } = setup([okScript()], { logger });
    const { failKey } = keysFor(CONTEXT);
    store.data.set(failKey, JSON.stringify({ code: "ai_timeout", message: "AI streaming timeout", jobId: "other", at: "t" }));
    const acquire = vi.spyOn(store, "tryAcquireLock");

    const err = await processor(makeJob("n", { attemptsMade: 2, attempts: 3 })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(UnrecoverableError);
    expect(publisher.ofType("ai/error")).toEqual([
      { type: "ai/error", jobId: "n", attempt: 3, code: "ai_timeout", message: "AI streaming timeout" },
    ]);
    expect(acquire).not.toHaveBeenCalled();
    expect(store.counters.size).toBe(0);
    expect(ai.calls).toHaveLength(0);
    expect(warns.some((w) => w.msg === "ai-fail hit")).toBe(true);
  });

  it("標記過期（不存在）後新 job 照常呼叫 LLM", async () => {
    const { ai, store, processor } = setup([okScript()]);
    const { failKey } = keysFor(CONTEXT);
    store.data.set(failKey, JSON.stringify({ code: "provider_error", message: "x", jobId: "other", at: "t" }));
    store.data.delete(failKey); // TTL 到期
    await expect(processor(makeJob("n"))).resolves.toEqual({ result: VALID_RESULT, cached: false });
    expect(ai.calls).toHaveLength(1);
  });

  it("標記內容不合法：DEL 並視為無標記", async () => {
    const { ai, store, processor } = setup([okScript()]);
    const { failKey } = keysFor(CONTEXT);
    store.data.set(failKey, "{oops");
    await expect(processor(makeJob("n"))).resolves.toEqual({ result: VALID_RESULT, cached: false });
    expect(store.deleted).toContain(failKey);
    expect(ai.calls).toHaveLength(1);
  });

  it("「持鎖者寫標記放鎖、等待者恰好在 (a) 與取鎖之間」：第二處讀取（取鎖後、限流前）擋下，不吃 AI_RPM", async () => {
    const { ai, store, processor } = setup([okScript()]);
    const { failKey, lockKey } = keysFor(CONTEXT);
    const acquire = store.tryAcquireLock.bind(store);
    vi.spyOn(store, "tryAcquireLock").mockImplementation(async (key, token, ttl) => {
      // 等待者剛通過 (a)：此刻持鎖者寫好標記並放鎖。
      store.data.set(failKey, JSON.stringify({ code: "provider_error", message: "503", jobId: "holder", at: "t" }));
      return acquire(key, token, ttl);
    });
    const err = await processor(makeJob("w")).catch((e: unknown) => e);
    expect((err as Error).message).toBe("503");
    expect(ai.calls).toHaveLength(0);
    expect(store.counters.size).toBe(0);
    expect(store.data.has(lockKey)).toBe(false); // 擋下後照常放鎖
  });
});

describe("createProcessor：回傳值 DiagnosisJobReturnValue（012 T023；ADR-003 D1）", () => {
  it("LLM 路徑：回 { result, cached: false }，通過 DiagnosisJobReturnValueSchema，且與 ai/done 同一份結果", async () => {
    const { publisher, processor } = setup([okScript()]);
    const ret = await processor(makeJob("m"));

    expect(ret).toEqual({ result: VALID_RESULT, cached: false });
    expect(DiagnosisJobReturnValueSchema.safeParse(ret).success).toBe(true);
    const done = publisher.ofType("ai/done");
    expect(done).toHaveLength(1);
    expect(done[0]?.result).toEqual(ret.result);
  });

  it("快取命中路徑：回 { result, cached: true }，通過 DiagnosisJobReturnValueSchema", async () => {
    const { store, publisher, processor } = setup([okScript()]);
    store.data.set(keysFor(CONTEXT).cacheKey, RESULT_TEXT);
    const ret = await processor(makeJob("hit"));

    expect(ret).toEqual({ result: VALID_RESULT, cached: true });
    expect(DiagnosisJobReturnValueSchema.safeParse(ret).success).toBe(true);
    expect(publisher.ofType("ai/done")[0]?.result).toEqual(ret.result);
  });

  it("回傳的 result 是通過 DiagnosisResultSchema 後的值：快取裡多出的欄位不會帶進 returnvalue", async () => {
    const { store, processor } = setup([okScript()]);
    store.data.set(keysFor(CONTEXT).cacheKey, JSON.stringify({ ...VALID_RESULT, injected: "<script>" }));
    const ret = await processor(makeJob("hit"));

    expect(ret.cached).toBe(true);
    expect(ret.result).toEqual(VALID_RESULT);
    expect(ret.result).not.toHaveProperty("injected");
  });

  it("LLM 輸出夾雜前後文字：returnvalue 只帶解析並驗證後的物件", async () => {
    const text = `以下是診斷：\n${RESULT_TEXT}\n（完）`;
    const wrapped: Script = async ({ onToken }) => {
      onToken(text);
      return { text, finishReason: "stop" };
    };
    const { processor } = setup([wrapped]);
    const ret = await processor(makeJob("m"));
    expect(ret).toEqual({ result: VALID_RESULT, cached: false });
  });
});

describe("createProcessor：cache 命中路徑順序（AR-A12）", () => {
  // 「ai/done 送出後才 return」由「終態事件 await 送出」組的兩支（PUBLISH 未完成前 processor 不 resolve）鎖住。
  it("先寫 trigger、再進度 100，最後才送 ai/done（與 LLM 路徑一致）", async () => {
    const order: string[] = [];
    const { store, publisher, repo, processor } = setup([okScript()]);
    store.data.set(keysFor(CONTEXT).cacheKey, RESULT_TEXT);
    publisher.order = order;
    repo.order = order;
    const job = makeJob("hit");
    job.progressHook = (p) => order.push(`progress:${p}`);

    await processor(job);
    expect(order).toEqual(["progress:0", "progress:20", "upsertTrigger", "progress:100", "publish:ai/done"]);
  });

  it("LLM 路徑同樣是 trigger → 進度 100 → ai/done", async () => {
    const order: string[] = [];
    const { publisher, repo, processor } = setup([okScript()]);
    publisher.order = order;
    repo.order = order;
    const job = makeJob("m");
    job.progressHook = (p) => order.push(`progress:${p}`);

    await processor(job);
    expect(order.slice(-3)).toEqual(["upsertTrigger", "progress:100", "publish:ai/done"]);
  });

  it("cache 命中但 trigger 寫入失敗：不送 ai/done，丟可重試錯誤走既有重試路徑", async () => {
    const { store, publisher, repo, processor } = setup([okScript()]);
    store.data.set(keysFor(CONTEXT).cacheKey, RESULT_TEXT);
    repo.failUpsertTrigger = true;
    const job = makeJob("hit", { attemptsMade: 0, attempts: 3 });

    const err = await processor(job).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(UnrecoverableError);
    expect((err as Error).message).toBe("mongo down");
    expect(publisher.events).toEqual([]);
    expect(job.progress).toEqual([0, 20]);
  });

  it("LLM 路徑 trigger 寫入失敗：同樣不送 ai/done", async () => {
    const { publisher, repo, processor } = setup([okScript()]);
    repo.failUpsertTrigger = true;
    await expect(processor(makeJob("m"))).rejects.toThrow("mongo down");
    expect(publisher.ofType("ai/done")).toEqual([]);
  });
});

describe("isNoContextFailure", () => {
  it("只認空脈絡短路的訊息", () => {
    expect(isNoContextFailure(new UnrecoverableError(NO_CONTEXT_MESSAGE))).toBe(true);
    expect(isNoContextFailure(new UnrecoverableError("API key not valid"))).toBe(false);
    expect(isNoContextFailure(new UnrecoverableError("job stalled more than allowable limit"))).toBe(false);
  });
});

describe("isTerminalFailure", () => {
  it("UnrecoverableError 即使 attempts 未用盡也是終態", () => {
    expect(isTerminalFailure({ attemptsMade: 1, opts: { attempts: 3 } }, new UnrecoverableError("x"))).toBe(true);
  });
  it("stalled 用盡（BullMQ 以 UnrecoverableError 走 handleFailed）也是終態", () => {
    const err = new UnrecoverableError("job stalled more than allowable limit");
    expect(isTerminalFailure({ attemptsMade: 0, opts: { attempts: 3 } }, err)).toBe(true);
  });
  it("attempts 用盡是終態；尚可重試則否", () => {
    expect(isTerminalFailure({ attemptsMade: 3, opts: { attempts: 3 } }, new Error("x"))).toBe(true);
    expect(isTerminalFailure({ attemptsMade: 1, opts: { attempts: 3 } }, new Error("x"))).toBe(false);
  });
});
