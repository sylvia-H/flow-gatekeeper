import { DelayedError, UnrecoverableError } from "bullmq";
import { describe, expect, it, vi } from "vitest";
import { AiStreamEventSchema } from "@flow-gatekeeper/contracts";
import type { AiStreamEvent, DiagnosisJobPayload, DiagnosisResult } from "@flow-gatekeeper/contracts";
import { GeminiProvider } from "./ai/gemini-provider.js";
import { AiProviderError } from "./ai/provider.js";
import type { AiProvider, AiStreamRequest, AiStreamResult } from "./ai/provider.js";
import type { ProcessorStore } from "./cache/redis-store.js";
import type { DiagnosisContext } from "./context/context-builder.js";
import type { DiagnosisRepository } from "./diagnosis-repository.js";
import { createProcessor, isTerminalFailure } from "./processor.js";
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

class FakeStore implements ProcessorStore {
  readonly data = new Map<string, string>();
  readonly counters = new Map<string, number>();
  readonly deleted: string[] = [];
  failSetWithTtl = false;

  async get(key: string) {
    return this.data.get(key) ?? null;
  }
  async setWithTtl(key: string, value: string) {
    if (this.failSetWithTtl) throw new Error("redis down");
    this.data.set(key, value);
  }
  async del(key: string) {
    this.deleted.push(key);
    this.data.delete(key);
  }
  async tryAcquireLock(key: string, token: string) {
    if (this.data.has(key)) return false;
    this.data.set(key, token);
    return true;
  }
  async releaseLock(key: string, token: string) {
    if (this.data.get(key) !== token) return false;
    this.data.delete(key);
    return true;
  }
  async incrementWindow(key: string) {
    const n = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, n);
    return n;
  }
  cacheKeys() {
    return [...this.data.keys()].filter((k) => k.startsWith("ai-cache:"));
  }
  lockKeys() {
    return [...this.data.keys()].filter((k) => k.startsWith("ai-lock:"));
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

class FakeRepo implements DiagnosisRepository {
  readonly diagnoses: { jobId: string }[] = [];
  readonly triggers: { jobId: string; cached: boolean }[] = [];
  async insertDiagnosis(doc: { machineId: string; jobId: string; result: DiagnosisResult }) {
    this.diagnoses.push(doc);
  }
  async insertTrigger(doc: { machineId: string; jobId: string; requestedBy: string; cached: boolean }) {
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

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 正常串流：分兩段吐出合法 JSON。 */
const okScript =
  (delayMs = 20): Script =>
  async ({ onToken }) => {
    const text = JSON.stringify(VALID_RESULT);
    onToken(text.slice(0, 10));
    await sleep(delayMs);
    onToken(text.slice(10));
    return { text, finishReason: "stop" };
  };

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

function setup(scripts: Script[], overrides: Partial<ProcessorConfig> & { isClosing?: () => boolean } = {}) {
  const store = new FakeStore();
  const publisher = new FakePublisher();
  const repo = new FakeRepo();
  const ai = new FakeAiProvider(scripts);
  const metrics = { recordCacheHit: vi.fn(), recordCacheMiss: vi.fn(), recordLatency: vi.fn() };
  const { isClosing, ...config } = overrides;
  const processor = createProcessor({
    store,
    publisher,
    repo,
    ai,
    buildContext: async () => CONTEXT,
    logger: silentLogger,
    metrics,
    config: {
      aiTimeoutMs: 1000,
      lockTtlSeconds: 45,
      cacheTtlSeconds: 600,
      aiRpm: 100,
      pollIntervalMs: 5,
      ...config,
    },
    isClosing,
  });
  return { store, publisher, repo, ai, metrics, processor };
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

describe("createProcessor：去重", () => {
  it("兩個 processor 並發同 signature，LLM 只被呼叫一次", async () => {
    const { ai, publisher, repo, processor } = setup([okScript(30)]);
    await Promise.all([processor(makeJob("a")), processor(makeJob("b"))]);

    expect(ai.calls).toHaveLength(1);
    const done = publisher.ofType("ai/done");
    expect(done.map((e) => [e.jobId, e.cached]).sort()).toEqual([
      ["a", false],
      ["b", true],
    ]);
    expect(repo.diagnoses).toHaveLength(1);
  });

  it("等待者搶到鎖時先 double-check cache（持鎖者剛寫完並放鎖）", async () => {
    // 持鎖者在等待者 sleep 期間完成並放鎖：等待者醒來一定是「SET NX 成功」那條路。
    const { ai, store, publisher, processor } = setup([okScript(5)], { pollIntervalMs: 50 });
    await Promise.all([processor(makeJob("a")), sleep(1).then(() => processor(makeJob("b")))]);
    expect(ai.calls).toHaveLength(1);
    expect(publisher.ofType("ai/done").find((e) => e.jobId === "b")?.cached).toBe(true);
    expect(store.lockKeys()).toEqual([]); // 兩者都只刪自己的鎖，最後沒有殘留
  });

  it("持鎖者失敗後，等待者接手重算", async () => {
    const { ai, publisher, processor } = setup([
      async () => {
        await sleep(20);
        throw new AiProviderError("503 overloaded", { retryable: true, code: "provider_error" });
      },
      okScript(5),
    ]);
    const [a, b] = await Promise.allSettled([processor(makeJob("a")), processor(makeJob("b"))]);

    expect(a.status).toBe("rejected");
    expect(b.status).toBe("fulfilled");
    expect(ai.calls).toHaveLength(2);
    expect(publisher.ofType("ai/done")).toEqual([
      expect.objectContaining({ jobId: "b", cached: false, attempt: 1 }),
    ]);
    // a 是非最終嘗試：不送 ai/error
    expect(publisher.ofType("ai/error")).toEqual([]);
  });

  it("鎖值不是自己的就不刪（compare-and-del）", async () => {
    const { store, processor } = setup([
      async (req) => {
        // 模擬鎖在串流途中過期並被別人取得
        for (const k of store.lockKeys()) store.data.set(k, "someone-else");
        return okScript(1)(req);
      },
    ]);
    await processor(makeJob("a"));
    expect(store.lockKeys().map((k) => store.data.get(k))).toEqual(["someone-else"]);
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
    expect(publisher.ofType("ai/error")).toEqual([
      expect.objectContaining({ code: "provider_error", attempt: 1 }),
    ]);
    expect(publisher.ofType("ai/error")[0]?.message.toLowerCase()).toContain("api key");
    expect(publisher.ofType("ai/token")).toEqual([]);
  });

  it("finishReason=safety：視為格式失敗且不可重試", async () => {
    const { publisher, processor } = setup([async () => ({ text: "", finishReason: "safety" })]);
    await expect(processor(makeJob("a"))).rejects.toBeInstanceOf(UnrecoverableError);
    expect(publisher.ofType("ai/error")[0]?.code).toBe("schema_invalid");
  });

  it("finishReason=max_tokens：視為格式失敗、可重試（非最終不送 ai/error）", async () => {
    const text = JSON.stringify(VALID_RESULT);
    const { publisher, processor } = setup([async () => ({ text, finishReason: "max_tokens" })]);
    const err = await processor(makeJob("a")).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(UnrecoverableError);
    expect(publisher.ofType("ai/error")).toEqual([]);
  });
});

describe("createProcessor：逾時", () => {
  it("逾時後 AbortSignal 觸發、不再有 ai/token，最終嘗試送 ai/error(ai_timeout)", async () => {
    let seenSignal: AbortSignal | undefined;
    const { publisher, processor } = setup(
      [
        // 刻意「不理會 signal」的 adapter：核心仍須中止等待並丟棄遲到的 token。
        async ({ onToken, signal }) => {
          seenSignal = signal;
          onToken("{");
          await sleep(120);
          onToken("late");
          return { text: "{late", finishReason: "stop" };
        },
      ],
      { aiTimeoutMs: 30 },
    );
    await expect(processor(makeJob("a", { attemptsMade: 2, attempts: 3 }))).rejects.toThrow(/timeout/);
    expect(seenSignal?.aborted).toBe(true);
    await sleep(150); // 等殭屍串流跑完
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
    expect(publisher.ofType("ai/done").at(-1)).toEqual(
      expect.objectContaining({ jobId: "hit", cached: true, attempt: 1 }),
    );
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
    const { store, repo, processor } = setup([okScript(1)]);
    store.failSetWithTtl = true;
    await expect(processor(makeJob("a"))).rejects.toThrow("redis down");
    expect(repo.diagnoses).toHaveLength(1);
    expect(store.cacheKeys()).toHaveLength(0);
  });

  it("provider 收到由 DiagnosisResultSchema 推導的 responseJsonSchema", async () => {
    const { ai, processor } = setup([okScript(1)]);
    await processor(makeJob("a"));
    expect(ai.calls[0]?.responseJsonSchema).toEqual(expect.objectContaining({ type: "object" }));
  });
});

describe("createProcessor：LLM 限流與關閉", () => {
  it("超過每分鐘上限：不呼叫 LLM、放鎖、moveToDelayed 後丟 DelayedError", async () => {
    const { ai, store, processor } = setup([okScript(1)], { aiRpm: 1 });
    await processor(makeJob("first"));
    // 讓 cache 失效，第二筆必須打 LLM
    for (const k of store.cacheKeys()) store.data.delete(k);

    const job = makeJob("second");
    await expect(processor(job, "bull-token")).rejects.toBeInstanceOf(DelayedError);
    expect(ai.calls).toHaveLength(1);
    expect(job.moveToDelayed).toHaveBeenCalledWith(expect.any(Number), "bull-token");
    expect(store.lockKeys()).toEqual([]);
  });

  it("關閉中：等待者不再空等，把 job 交回佇列", async () => {
    let closing = false;
    const { processor } = setup(
      [
        async (req) => {
          closing = true; // 持鎖者串流途中收到 SIGTERM
          await sleep(40);
          return okScript(1)(req);
        },
      ],
      { isClosing: () => closing },
    );
    const waiter = makeJob("waiter");
    const [holder, waiting] = await Promise.allSettled([
      processor(makeJob("holder"), "t1"),
      sleep(5).then(() => processor(waiter, "t2")),
    ]);
    expect(holder.status).toBe("fulfilled");
    expect(waiting.status).toBe("rejected");
    if (waiting.status === "rejected") expect(waiting.reason).toBeInstanceOf(DelayedError);
    expect(waiter.moveToDelayed).toHaveBeenCalledWith(expect.any(Number), "t2");
  });
});

describe("isTerminalFailure", () => {
  it("UnrecoverableError 即使 attempts 未用盡也是終態", () => {
    expect(isTerminalFailure({ attemptsMade: 1, opts: { attempts: 3 } }, new UnrecoverableError("x"))).toBe(true);
  });
  it("attempts 用盡是終態；尚可重試則否", () => {
    expect(isTerminalFailure({ attemptsMade: 3, opts: { attempts: 3 } }, new Error("x"))).toBe(true);
    expect(isTerminalFailure({ attemptsMade: 1, opts: { attempts: 3 } }, new Error("x"))).toBe(false);
  });
});
