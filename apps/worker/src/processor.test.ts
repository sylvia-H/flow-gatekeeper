import { DelayedError, UnrecoverableError } from "bullmq";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AiStreamEventSchema } from "@flow-gatekeeper/contracts";
import type { AiStreamEvent, DiagnosisJobPayload, DiagnosisResult } from "@flow-gatekeeper/contracts";
import { GeminiProvider } from "./ai/gemini-provider.js";
import { PROMPT_VERSION } from "./ai/prompt.js";
import { AiProviderError } from "./ai/provider.js";
import type { AiProvider, AiStreamRequest, AiStreamResult } from "./ai/provider.js";
import type { ProcessorStore } from "./cache/redis-store.js";
import { buildDiagnosisSignature } from "./cache/signature.js";
import type { DiagnosisContext } from "./context/context-builder.js";
import type { DiagnosisRepository } from "./diagnosis-repository.js";
import type { LivenessTracker } from "./lib/liveness.js";
import { createProcessor, isTerminalFailure, NO_CONTEXT_CODE, NO_CONTEXT_MESSAGE } from "./processor.js";
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
  op: "cache" | "lock" | "window";
  key: string;
  ttlSeconds: number;
}

class FakeStore implements ProcessorStore {
  readonly data = new Map<string, string>();
  readonly counters = new Map<string, number>();
  readonly deleted: string[] = [];
  readonly ttls: TtlRecord[] = [];
  failSetWithTtl = false;

  async get(key: string) {
    return this.data.get(key) ?? null;
  }
  async setWithTtl(key: string, value: string, ttlSeconds: number) {
    if (this.failSetWithTtl) throw new Error("redis down");
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
  async publish(_channel: string, message: string) {
    // 送出的每則事件都必須通過契約（含必填 attempt）。
    this.events.push(AiStreamEventSchema.parse(JSON.parse(message)));
    return 1;
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

class FakeRepo implements DiagnosisRepository {
  readonly diagnoses: { machineId: string; jobId: string; result: DiagnosisResult }[] = [];
  readonly triggers: TriggerDoc[] = [];
  async insertDiagnosis(doc: { machineId: string; jobId: string; result: DiagnosisResult }) {
    this.diagnoses.push(doc);
  }
  async insertTrigger(doc: TriggerDoc) {
    this.triggers.push(doc);
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
  return { cacheKey: `ai-cache:${sig}`, lockKey: `ai-lock:${sig}` };
}

function makeJob(jobId: string, opts: { attemptsMade?: number; attempts?: number } = {}) {
  const data: DiagnosisJobPayload = {
    jobId,
    machineId: "press-02",
    requestedBy: "tester",
    requestedAt: new Date(0).toISOString(),
    windowMinutes: 5,
  };
  const job: ProcessorJob & { progress: number[]; moveToDelayed: ReturnType<typeof vi.fn> } = {
    data,
    attemptsMade: opts.attemptsMade ?? 0,
    opts: { attempts: opts.attempts ?? 3 },
    progress: [],
    async updateProgress(p: number) {
      this.progress.push(p);
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

/** 活性槽必須成對：begin、end 各恰好一次且是同一個槽，touch 也只打在該槽上。 */
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
    ...config
  } = overrides;
  const processor = createProcessor({
    store,
    publisher,
    repo,
    ai,
    buildContext,
    logger: silentLogger,
    metrics,
    config: { ...CONFIG, ...config },
    isClosing,
    liveness,
    now: clock.now,
    sleep: clock.sleep,
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
    await a;
    clock.advance(CONFIG.pollIntervalMs);
    await b;

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
    await b;

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
    await run.promise;

    expect(ai.calls).toHaveLength(0);
    expect(store.data.get(lockKey)).toBe("other-replica");
    expect(publisher.events).toEqual([{ type: "ai/done", jobId: "w", attempt: 1, cached: true, result: VALID_RESULT }]);
    expect(repo.triggers).toEqual([{ machineId: "press-02", jobId: "w", requestedBy: "tester", cached: true }]);
    expect(job.progress).toEqual([0, 20, 100]);
    expect(clock.sleeps).toEqual([CONFIG.pollIntervalMs]);
    expect(metrics.recordCacheHit).toHaveBeenCalledTimes(1);
    expect(metrics.recordCacheMiss).not.toHaveBeenCalled();
    expectLivenessPaired(liveness);
  });

  it("持鎖者失敗後，等待者接手重算", async () => {
    const holder = gatedScript(new AiProviderError("503 overloaded", { retryable: true, code: "provider_error" }));
    const { ai, publisher, metrics, clock, processor } = setup([holder.script, okScript()]);
    const a = processor(makeJob("a")).catch((e: unknown) => e);
    const b = processor(makeJob("b"));
    await flush();
    expect(clock.pending).toBe(1);

    holder.release();
    expect(await a).toBeInstanceOf(Error);
    clock.advance(CONFIG.pollIntervalMs);
    await b;

    expect(ai.calls).toHaveLength(2);
    expect(publisher.ofType("ai/done")).toEqual([expect.objectContaining({ jobId: "b", cached: false, attempt: 1 })]);
    // a 是非最終嘗試：不送 ai/error
    expect(publisher.ofType("ai/error")).toEqual([]);
    // 兩個 job 都真的要打 LLM → 各一筆未命中；延遲只記成功的那一次
    expect(metrics.recordCacheMiss).toHaveBeenCalledTimes(2);
    expect(metrics.recordCacheHit).not.toHaveBeenCalled();
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

    const { cacheKey, lockKey } = keysFor(CONTEXT);
    expect(store.ttlsOf("cache")).toEqual([{ op: "cache", key: cacheKey, ttlSeconds: CONFIG.cacheTtlSeconds }]);
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
    expect(store.ttls).toEqual([]); // 不取鎖、不寫 cache、不吃限流額度
    expectLivenessPaired(liveness);
  });

  it("重試（非第一次嘗試）不重複計 hit／miss，但成功的 LLM 呼叫仍記延遲樣本", async () => {
    const { store, metrics, processor } = setup([okScript()]);
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

  it("先寫 diagnoses 再寫 cache：寫 cache 失敗時 diagnoses 已落地、cache 仍空（重試會重算）", async () => {
    const { store, repo, processor } = setup([okScript()]);
    store.failSetWithTtl = true;
    await expect(processor(makeJob("a"))).rejects.toThrow("redis down");
    expect(repo.diagnoses).toHaveLength(1);
    expect(store.cacheKeys()).toHaveLength(0);
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
    await expect(holding).resolves.toBeUndefined();
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
