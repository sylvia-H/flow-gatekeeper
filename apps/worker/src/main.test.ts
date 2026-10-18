import { UnrecoverableError } from "bullmq";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DiagnosisJobPayload } from "@flow-gatekeeper/contracts";
import { FakeAiProvider } from "./ai/fake-provider.js";
import { GeminiProvider } from "./ai/gemini-provider.js";
import { parseWorkerEnv } from "./lib/env-schema.js";
import * as mod from "./main.js";
import { NO_CONTEXT_CODE, NO_CONTEXT_MESSAGE } from "./processor.js";
import type { ProcessorLogger } from "./processor.js";

// 只替換 fatal()：斷言 entry 的 bootstrap 失敗路徑走同步 writeSync 的致命機制（不真的 exit）。
// vi.mock 會被 hoist 到所有 import 之前，檔頂的 `import * as mod` 拿到的已是替換後的依賴圖。
const fatalMock = vi.hoisted(() => vi.fn());
vi.mock("./lib/fatal.js", () => ({ fatal: fatalMock }));

afterEach(() => {
  vi.useRealTimers();
});

/**
 * FR-014：entry-module smoke 測試——斷言 worker entry 能乾淨 import。
 */
describe("apps/worker entry", () => {
  it("entry module 能乾淨 import 且匯出 bootstrap", () => {
    expect(typeof mod.bootstrap).toBe("function");
    // 被 import 時不得自行 bootstrap（side-effect-free），也就不會觸發任何致命路徑。
    expect(fatalMock).not.toHaveBeenCalled();
  });

  it("createAiProvider：env 的 GEMINI_MODEL／AI_MAX_OUTPUT_TOKENS／AI_TEMPERATURE 接到 provider", () => {
    const parsed = parseWorkerEnv({ GEMINI_MODEL: "gemini-2.5-flash-lite", AI_MAX_OUTPUT_TOKENS: "777", AI_TEMPERATURE: "1.3" });
    if (!parsed.ok) throw new Error(parsed.error);
    const ai = mod.createAiProvider(parsed.env);
    expect(ai.model).toBe("gemini-2.5-flash-lite");
    expect(ai.generation).toEqual({ maxOutputTokens: 777, temperature: 1.3 });
  });

  it("selectAiProvider：AI_PROVIDER=fake → FakeAiProvider，段數／延遲取自 env", () => {
    const parsed = parseWorkerEnv({ AI_PROVIDER: "fake", FAKE_AI_TOKENS: "7", FAKE_AI_TOKEN_DELAY_MS: "123" });
    if (!parsed.ok) throw new Error(parsed.error);
    const ai = mod.selectAiProvider(parsed.env);
    expect(ai).toBeInstanceOf(FakeAiProvider);
    expect(ai instanceof FakeAiProvider && ai.options).toEqual({ tokenCount: 7, tokenDelayMs: 123 });
  });

  it("selectAiProvider：未設 AI_PROVIDER → GeminiProvider（production 預設不變）", () => {
    const parsed = parseWorkerEnv({ GEMINI_MODEL: "gemini-2.5-flash-lite" });
    if (!parsed.ok) throw new Error(parsed.error);
    const ai = mod.selectAiProvider(parsed.env);
    expect(ai).toBeInstanceOf(GeminiProvider);
    expect(ai.model).toBe("gemini-2.5-flash-lite");
  });

  it("bootstrap 失敗：交給 fatal('bootstrap', err)（同步 writeSync 後 exit 1，與 api fatalExit 對齊）", () => {
    const err = new Error("Redis 連線於 10000ms 內未就緒");
    mod.handleBootstrapFailure(err);
    expect(fatalMock).toHaveBeenCalledWith("bootstrap", err);
  });
});

// ---------------------------------------------------------------------------
// failed handler（WK-19）
// ---------------------------------------------------------------------------

interface LogCall {
  level: "info" | "warn" | "error";
  obj: unknown;
  msg?: string;
  bindings: Record<string, unknown>;
}

/** 記下每則 log 與其 child bindings 的 fake logger。 */
function recordingLogger() {
  const calls: LogCall[] = [];
  const make = (bindings: Record<string, unknown>): ProcessorLogger => ({
    info: (obj, msg) => calls.push({ level: "info", obj, msg, bindings }),
    warn: (obj, msg) => calls.push({ level: "warn", obj, msg, bindings }),
    error: (obj, msg) => calls.push({ level: "error", obj, msg, bindings }),
    child: (b) => make({ ...bindings, ...b }),
  });
  return { logger: make({}), calls };
}

const PAYLOAD: DiagnosisJobPayload = {
  jobId: "j1",
  machineId: "press-02",
  requestedBy: "tester",
  requestedAt: new Date(0).toISOString(),
  windowMinutes: 5,
};

/** 讓 failed handler 內 fire-and-forget 的 insertTrigger（及其 catch）跑完。 */
const flush = () => new Promise<void>((r) => setImmediate(r));

describe("createFailedHandler", () => {
  function setup(insertTrigger: () => Promise<void> = async () => {}) {
    const { logger, calls } = recordingLogger();
    const repo = { insertTrigger: vi.fn(insertTrigger) };
    const handler = mod.createFailedHandler({ logger, repo });
    return { handler, repo, calls };
  }

  it("no_context 終態：記 warn、不帶 err（無 stack），trigger 照常補寫 cached:false", async () => {
    const { handler, repo, calls } = setup();
    handler({ data: PAYLOAD, attemptsMade: 1, opts: { attempts: 3 } }, new UnrecoverableError(NO_CONTEXT_MESSAGE));
    await flush();

    expect(calls).toEqual([
      {
        level: "warn",
        obj: { code: NO_CONTEXT_CODE },
        msg: "job failed (final, no_context)",
        bindings: { jobId: "j1", machineId: "press-02", attempt: 1 },
      },
    ]);
    expect(repo.insertTrigger).toHaveBeenCalledWith({ machineId: "press-02", jobId: "j1", requestedBy: "tester", cached: false });
  });

  it("其他終態失敗（不可重試）：維持 error 帶 err，trigger 補寫", async () => {
    const { handler, repo, calls } = setup();
    const err = new UnrecoverableError("API key not valid");
    handler({ data: PAYLOAD, attemptsMade: 1, opts: { attempts: 3 } }, err);
    await flush();

    expect(calls).toEqual([expect.objectContaining({ level: "error", obj: { err }, msg: "job failed (final)" })]);
    expect(repo.insertTrigger).toHaveBeenCalledTimes(1);
  });

  it("attempts 用盡的一般錯誤：error 帶 err，trigger 補寫", async () => {
    const { handler, repo, calls } = setup();
    const err = new Error("503 overloaded");
    handler({ data: PAYLOAD, attemptsMade: 3, opts: { attempts: 3 } }, err);
    await flush();

    expect(calls).toEqual([expect.objectContaining({ level: "error", obj: { err } })]);
    expect(repo.insertTrigger).toHaveBeenCalledTimes(1);
  });

  it("尚可重試：只記 warn、不補寫 trigger", async () => {
    const { handler, repo, calls } = setup();
    const err = new Error("503 overloaded");
    handler({ data: PAYLOAD, attemptsMade: 1, opts: { attempts: 3 } }, err);
    await flush();

    expect(calls).toEqual([expect.objectContaining({ level: "warn", obj: { err }, msg: "job attempt failed (will retry)" })]);
    expect(repo.insertTrigger).not.toHaveBeenCalled();
  });

  it("trigger 寫入失敗：記 error、不拋出（不變成浮空 rejection）", async () => {
    const boom = new Error("mongo down");
    const { handler, calls } = setup(() => Promise.reject(boom));
    handler({ data: PAYLOAD, attemptsMade: 0, opts: { attempts: 3 } }, new UnrecoverableError(NO_CONTEXT_MESSAGE));
    await flush();

    expect(calls.map((c) => [c.level, c.msg])).toEqual([
      ["warn", "job failed (final, no_context)"],
      ["error", "failure trigger write failed"],
    ]);
    expect(calls[1]?.obj).toEqual({ err: boom });
  });

  it("job 為 undefined（BullMQ 取不到 job）：什麼都不做", () => {
    const { handler, repo, calls } = setup();
    handler(undefined, new Error("x"));
    expect(calls).toEqual([]);
    expect(repo.insertTrigger).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 優雅關閉（WK-21）
// ---------------------------------------------------------------------------

describe("createShutdown", () => {
  /** 可由測試決定何時結束的收尾步驟。 */
  function deferredRun() {
    let finish: () => void = () => {};
    let failWith: (err: Error) => void = () => {};
    const run = vi.fn(
      () =>
        new Promise<void>((resolve, reject) => {
          finish = resolve;
          failWith = reject;
        }),
    );
    return { run, finish: () => finish(), fail: (err: Error) => failWith(err) };
  }

  /** 由 env 走與 bootstrap 相同的推導：parseWorkerEnv → shutdownDeadlineMs(AI_TIMEOUT_MS)。 */
  function deadlineFromEnv(raw: Record<string, string>): number {
    const parsed = parseWorkerEnv(raw);
    if (!parsed.ok) throw new Error(parsed.error);
    return mod.shutdownDeadlineMs(parsed.env.AI_TIMEOUT_MS);
  }

  function setup(run: () => Promise<void>, deadlineMs: number = deadlineFromEnv({})) {
    const { logger, calls } = recordingLogger();
    const exit = vi.fn<(code: number) => void>();
    const onSignal = vi.fn();
    const shutdown = mod.createShutdown({ logger, run, exit, onSignal, deadlineMs });
    return { shutdown, exit, onSignal, calls };
  }

  it("總時限＝AI_TIMEOUT_MS＋10 秒：預設 env 算出 40 秒（compose stop_grace_period 45s 多留 5 秒）", () => {
    expect(mod.SHUTDOWN_WRITE_MARGIN_MS).toBe(10_000);
    expect(deadlineFromEnv({})).toBe(40_000);
  });

  it("總時限跟著 AI_TIMEOUT_MS 走：60000 → 70 秒", () => {
    // 鎖 TTL 必須 ≥ AI_TIMEOUT_MS＋5s（env 啟動驗證），一併調高。
    expect(deadlineFromEnv({ AI_TIMEOUT_MS: "60000", AI_DEDUPE_LOCK_SECONDS: "65" })).toBe(70_000);
  });

  it.each([
    ["預設 env", {}, 40_000],
    ["AI_TIMEOUT_MS=60000", { AI_TIMEOUT_MS: "60000", AI_DEDUPE_LOCK_SECONDS: "65" }, 70_000],
  ] as const)("%s：createShutdown 依推導出的 deadline 逾時", async (_label, raw, expected) => {
    vi.useFakeTimers();
    const d = deferredRun();
    const { shutdown, exit, calls } = setup(d.run, deadlineFromEnv(raw));
    const done = shutdown("SIGTERM");

    await vi.advanceTimersByTimeAsync(expected - 1);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(calls).toContainEqual(expect.objectContaining({ level: "warn", obj: { signal: "SIGTERM", deadlineMs: expected } }));
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it("正常收尾：先 onSignal 再跑 run，run 完成後 exit(0)", async () => {
    const d = deferredRun();
    const { shutdown, exit, onSignal } = setup(d.run);
    const done = shutdown("SIGTERM");
    expect(onSignal).toHaveBeenCalledTimes(1);
    expect(d.run).toHaveBeenCalledTimes(1);
    expect(onSignal.mock.invocationCallOrder[0]).toBeLessThan(d.run.mock.invocationCallOrder[0] ?? 0);
    await flush();
    expect(exit).not.toHaveBeenCalled(); // run 未完成前不結束

    d.finish();
    await done;
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it("run 拋錯：記 error 後仍 exit(0)", async () => {
    const d = deferredRun();
    const { shutdown, exit, calls } = setup(d.run);
    const done = shutdown("SIGTERM");
    const boom = new Error("quit failed");
    d.fail(boom);
    await done;
    expect(calls).toContainEqual(expect.objectContaining({ level: "error", obj: { err: boom }, msg: "shutdown error" }));
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it("run 超過總時限：恰好在時限前仍等待，到時限記 warn 後 exit(0)", async () => {
    vi.useFakeTimers();
    const d = deferredRun();
    const { shutdown, exit, calls } = setup(d.run);
    const done = shutdown("SIGTERM");

    await vi.advanceTimersByTimeAsync(40_000 - 1);
    expect(exit).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(calls).toContainEqual(
      expect.objectContaining({ level: "warn", obj: { signal: "SIGTERM", deadlineMs: 40_000 }, msg: "優雅關閉超過總時限，強制結束" }),
    );
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);

    // 逾時後 run 才遲到完成：不再重複 exit
    d.finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("run 在時限內完成：清掉計時器，不留逾時 warn", async () => {
    vi.useFakeTimers();
    const d = deferredRun();
    const { shutdown, exit, calls } = setup(d.run);
    const done = shutdown("SIGTERM");
    d.finish();
    await done;
    expect(vi.getTimerCount()).toBe(0);
    expect(calls.filter((c) => c.level === "warn")).toEqual([]);
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it("關閉途中再收到訊號：立即 exit(0)，不重跑 onSignal／run", async () => {
    const d = deferredRun();
    const { shutdown, exit, onSignal, calls } = setup(d.run);
    const first = shutdown("SIGTERM");
    await shutdown("SIGINT");

    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
    expect(d.run).toHaveBeenCalledTimes(1);
    expect(onSignal).toHaveBeenCalledTimes(1);
    expect(calls).toContainEqual(expect.objectContaining({ level: "warn", obj: { signal: "SIGINT" } }));

    d.finish();
    await first;
    expect(exit).toHaveBeenCalledTimes(2); // 真實環境第一次 exit 即結束行程；fake exit 不會，故第一輪收尾仍會呼叫
  });
});
