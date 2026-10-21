import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { effectScope, watchEffect } from "vue";
import type { DiagnosisResult } from "@flow-gatekeeper/contracts";
import { UNDELIVERED_GRACE_MS, lookupFailureMessage, useCopilotStore } from "./copilot.store.js";
import { DiagnoseLookupError } from "../lib/diagnose-api.js";

const UNDELIVERED = "診斷已在後端完成，但結果未送達畫面，請重試";
const WATCHDOG = "超過 45 秒沒有收到進度，結果未知，請重試";

const RESULT: DiagnosisResult = {
  summary: "s",
  severity: "ok",
  likelyCauses: [],
  suggestedActions: [],
  evidence: [],
};

const SOCKET = "11111111-1111-4111-8111-111111111111";
/** 重連後的新連線 clientId。 */
const SOCKET_2 = "22222222-2222-4222-8222-222222222222";

/** 讓 fetch／Response.json 的 promise 鏈跑完（GET 退路是 fire-and-forget）。 */
async function flushAsync(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise<void>((r) => setTimeout(r, 0));
}

interface SentBody {
  jobId: string;
  machineId: string;
}

/** 取 POST body（jobId 由前端產生，後端照原樣回傳）。 */
function bodyOf(init: RequestInit | undefined): SentBody {
  return JSON.parse(init?.body as string) as SentBody;
}

function okResponse(body: SentBody): Response {
  return new Response(JSON.stringify({ jobId: body.jobId, machineId: body.machineId, status: "waiting" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** 模擬 POST /diagnoses 成功：回傳前端送出的同一個 jobId（idempotency key）。 */
function mockDiagnoseOk(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => okResponse(bodyOf(init))),
  );
}

/** 模擬尚未回應的 POST：由測試控制 HTTP 回應抵達的時機（重現「WS 事件比 HTTP 早到」）。 */
function mockDiagnosePending(): { respond: () => void; fail: () => void } {
  let resolve: ((res: Response) => void) | undefined;
  let lastBody: SentBody | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: string, init?: RequestInit) => {
      lastBody = bodyOf(init);
      return new Promise<Response>((r) => {
        resolve = r;
      });
    }),
  );
  return {
    respond: () => {
      if (resolve && lastBody) resolve(okResponse(lastBody));
    },
    fail: () => resolve?.(new Response("nope", { status: 503 })),
  };
}

/** 取該台目前 jobId（前端產生，測試無法預知）。 */
function jobIdOf(store: ReturnType<typeof useCopilotStore>, machineId = "mixer-01"): string {
  const s = store.stateFor(machineId);
  if (!("jobId" in s) || !s.jobId) throw new Error(`no jobId for ${machineId}`);
  return s.jobId;
}

describe("copilot store（contracts/copilot-store）", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("canDiagnose：無選台/無連線 → false；active 期間去重 → false（FR-008/FR-014）", async () => {
    mockDiagnoseOk();
    const store = useCopilotStore();
    expect(store.canDiagnose(null, true)).toBe(false);
    expect(store.canDiagnose("mixer-01", false)).toBe(false);
    expect(store.canDiagnose("mixer-01", true)).toBe(true);

    await store.diagnose("mixer-01", SOCKET);
    expect(store.stateFor("mixer-01").status).toBe("active");
    expect(store.canDiagnose("mixer-01", true)).toBe(false); // active 去重
  });

  it("diagnose：前端產生 uuid jobId 放進 body，並建 active（SC-001）", async () => {
    mockDiagnoseOk();
    const store = useCopilotStore();
    await store.diagnose("mixer-01", SOCKET);
    expect(store.stateFor("mixer-01")).toMatchObject({
      status: "active",
      machineId: "mixer-01",
      attempt: 1,
      progress: null,
      streamText: "",
    });
    const sent = bodyOf(vi.mocked(fetch).mock.calls[0]?.[1]);
    expect(sent.jobId).toMatch(/^[0-9a-f-]{36}$/);
    expect(jobIdOf(store)).toBe(sent.jobId);
  });

  it("非 secure context（無 crypto.randomUUID）→ 退回 getRandomValues 仍產生合法 UUID v4", async () => {
    const real = globalThis.crypto;
    vi.stubGlobal("crypto", { getRandomValues: real.getRandomValues.bind(real) });
    mockDiagnoseOk();
    const store = useCopilotStore();
    await store.diagnose("mixer-01", SOCKET);
    expect(jobIdOf(store)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("in-flight：POST 往返期間已是 active、canDiagnose=false，連點不會送第二筆", async () => {
    const http = mockDiagnosePending();
    const store = useCopilotStore();
    const p = store.diagnose("mixer-01", SOCKET);
    expect(store.stateFor("mixer-01").status).toBe("active");
    expect(store.canDiagnose("mixer-01", true)).toBe(false);
    void store.diagnose("mixer-01", SOCKET); // 另一個入口連點
    expect(fetch).toHaveBeenCalledTimes(1);
    http.respond();
    await p;
    expect(store.canDiagnose("mixer-01", true)).toBe(false); // 仍 active
  });

  it("in-flight 期間中止：狀態回 idle，但回應抵達前仍不可再送出", async () => {
    const http = mockDiagnosePending();
    const store = useCopilotStore();
    const p = store.diagnose("mixer-01", SOCKET);
    store.cancel("mixer-01");
    expect(store.stateFor("mixer-01").status).toBe("idle");
    expect(store.canDiagnose("mixer-01", true)).toBe(false);
    http.respond();
    await p;
    expect(store.stateFor("mixer-01").status).toBe("idle"); // 回應不復活被中止的任務
    expect(store.canDiagnose("mixer-01", true)).toBe(true);
  });

  it("早到事件：HTTP 回應前抵達的 job/status、ai/token、ai/done 皆被接受", async () => {
    const http = mockDiagnosePending();
    const store = useCopilotStore();
    const p = store.diagnose("mixer-01", SOCKET);
    const jobId = jobIdOf(store);
    store.applyEvent({ type: "job/status", jobId, machineId: "mixer-01", status: "waiting", progress: 0 });
    store.applyEvent({ type: "ai/token", jobId, attempt: 1, seq: 0, text: "快取" });
    store.applyEvent({ type: "ai/done", jobId, attempt: 1, cached: true, result: RESULT });
    expect(store.stateFor("mixer-01")).toMatchObject({ status: "completed", cached: true, streamText: "快取" });
    http.respond();
    await p;
    // HTTP 回應晚到不得把已完成的結果蓋回 active
    expect(store.stateFor("mixer-01").status).toBe("completed");
  });

  it("diagnose 期間再送出被去重，不建第二任務（FR-008）", async () => {
    mockDiagnoseOk();
    const store = useCopilotStore();
    await store.diagnose("mixer-01", SOCKET);
    const before = store.stateFor("mixer-01");
    await store.diagnose("mixer-01", SOCKET); // active → 去重
    expect(store.stateFor("mixer-01")).toBe(before);
  });

  it("diagnose 失敗（HTTP 500）→ 回滾為 failed 附可讀中文訊息，可再送出", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    const store = useCopilotStore();
    await store.diagnose("mixer-01", SOCKET);
    const s = store.stateFor("mixer-01");
    expect(s.status).toBe("failed");
    if (s.status === "failed") expect(s.error).toBe("診斷服務暫時發生錯誤，請稍後再試");
    expect(store.canDiagnose("mixer-01", true)).toBe(true);
  });

  it("diagnose 409（jobId 已失效）→ 優先顯示後端中文 message；無 message 時用對映句", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ statusCode: 409, message: "jobId 已使用過，請以新的 jobId 重新發起診斷" }), {
          status: 409,
        }),
      ),
    );
    const store = useCopilotStore();
    await store.diagnose("mixer-01", SOCKET);
    expect(store.stateFor("mixer-01")).toMatchObject({
      status: "failed",
      error: "jobId 已使用過，請以新的 jobId 重新發起診斷",
    });

    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 409 })));
    await store.diagnose("mixer-01", SOCKET);
    expect(store.stateFor("mixer-01")).toMatchObject({ status: "failed", error: "連線已中斷或未授權，請等待重連後再試" });
  });

  it("diagnose 503（英文 body）→ 狀態碼對映的中文句，不露出 HTTP 字樣", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ message: "Service Unavailable" }), { status: 503 })),
    );
    const store = useCopilotStore();
    await store.diagnose("mixer-01", SOCKET);
    expect(store.stateFor("mixer-01")).toMatchObject({ status: "failed", error: "診斷佇列暫時無法使用，請稍後再試" });
  });

  it("diagnose fetch reject（網路錯誤）→ 固定中文句，不露出 Failed to fetch", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
    const store = useCopilotStore();
    await store.diagnose("mixer-01", SOCKET);
    expect(store.stateFor("mixer-01")).toMatchObject({ status: "failed", error: "無法連線診斷服務，請檢查網路後重試" });
    expect(store.canDiagnose("mixer-01", true)).toBe(true); // inFlight 已釋放，可 Retry
  });

  it("diagnose 逾時（AbortSignal.timeout 觸發）→ 「診斷請求逾時，請重試」，inFlight 釋放", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        expect(init?.signal).toBeInstanceOf(AbortSignal); // 確實帶了逾時訊號
        return Promise.reject(new DOMException("signal timed out", "TimeoutError"));
      }),
    );
    const store = useCopilotStore();
    await store.diagnose("mixer-01", SOCKET);
    expect(store.stateFor("mixer-01")).toMatchObject({ status: "failed", error: "診斷請求逾時，請重試" });
    expect(store.canDiagnose("mixer-01", true)).toBe(true);
  });

  it("diagnose 回應不合契約（缺 jobId）→ failed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ status: "waiting" }), { status: 200 })),
    );
    const store = useCopilotStore();
    await store.diagnose("mixer-01", SOCKET);
    const s = store.stateFor("mixer-01");
    expect(s.status).toBe("failed");
    if (s.status === "failed") expect(s.error).toBe("診斷請求回應格式不符");
  });

  it("POST 失敗但事件已先把任務推進到 completed → 不覆寫為 failed", async () => {
    const http = mockDiagnosePending();
    const store = useCopilotStore();
    const p = store.diagnose("mixer-01", SOCKET);
    store.applyEvent({ type: "ai/done", jobId: jobIdOf(store), attempt: 1, cached: true, result: RESULT });
    http.fail();
    await p;
    expect(store.stateFor("mixer-01").status).toBe("completed");
  });

  it("applyEvent 委派 reducer：ai/done → completed（依 jobId 反查該台）", async () => {
    mockDiagnoseOk();
    const store = useCopilotStore();
    await store.diagnose("mixer-01", SOCKET);
    store.applyEvent({ type: "ai/done", jobId: jobIdOf(store), attempt: 1, cached: true, result: RESULT });
    const s = store.stateFor("mixer-01");
    expect(s.status).toBe("completed");
    if (s.status === "completed") expect(s.cached).toBe(true);
  });

  it("畸形 ai/done（result 缺 suggestedActions/evidence）→ failed，不進 completed", async () => {
    mockDiagnoseOk();
    const store = useCopilotStore();
    await store.diagnose("mixer-01", SOCKET);
    const malformed = {
      type: "ai/done",
      jobId: jobIdOf(store),
      attempt: 1,
      cached: false,
      result: { summary: "s", severity: "ok", likelyCauses: [] },
    } as unknown as Parameters<typeof store.applyEvent>[0];
    store.applyEvent(malformed);
    const s = store.stateFor("mixer-01");
    expect(s.status).toBe("failed");
    if (s.status === "failed") expect(s.error).toBe("AI 回傳格式不符，請重試。");
  });

  it("applyEvent 過期 jobId → 忽略，不影響任何台（FR-011）", async () => {
    mockDiagnoseOk();
    const store = useCopilotStore();
    await store.diagnose("mixer-01", SOCKET);
    store.applyEvent({ type: "ai/error", jobId: "job-OLD", attempt: 1, code: "x", message: "舊" });
    expect(store.stateFor("mixer-01").status).toBe("active");
  });

  it("多台狀態獨立、可並存 active（FR-010）", async () => {
    const store = useCopilotStore();
    mockDiagnoseOk();
    await store.diagnose("mixer-01", SOCKET);
    await store.diagnose("press-02", SOCKET);
    expect(store.stateFor("mixer-01").status).toBe("active");
    expect(store.stateFor("press-02").status).toBe("active");
    // 結束 A 不影響 B
    store.applyEvent({ type: "ai/done", jobId: jobIdOf(store), attempt: 1, cached: false, result: RESULT });
    expect(store.stateFor("mixer-01").status).toBe("completed");
    expect(store.stateFor("press-02").status).toBe("active");
  });

  it("cancel：中止 active → idle，Diagnose 立即可再按", async () => {
    mockDiagnoseOk();
    const store = useCopilotStore();
    await store.diagnose("mixer-01", SOCKET);
    expect(store.stateFor("mixer-01").status).toBe("active");
    store.cancel("mixer-01");
    expect(store.stateFor("mixer-01").status).toBe("idle");
    expect(store.canDiagnose("mixer-01", true)).toBe(true);
  });

  it("cancel 後：被放棄任務的遲到事件被忽略，不復活畫面", async () => {
    mockDiagnoseOk();
    const store = useCopilotStore();
    await store.diagnose("mixer-01", SOCKET);
    const jobId = jobIdOf(store);
    store.cancel("mixer-01");
    store.applyEvent({ type: "ai/done", jobId, attempt: 1, cached: false, result: RESULT });
    expect(store.stateFor("mixer-01").status).toBe("idle");
  });

  it("checkStalls watchdog：逾時無進展且沒有 clientId 可 GET → 「結果未知」失敗（可重試）；未逾時不動（FR-022）", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    mockDiagnoseOk();
    const store = useCopilotStore();
    await store.diagnose("mixer-01", SOCKET); // 記活動時刻 @1_000_000
    store.checkStalls(1_000_000 + 10_000, 45_000); // 未逾時
    expect(store.stateFor("mixer-01").status).toBe("active");
    store.checkStalls(1_000_000 + 46_000, 45_000); // 逾時
    const s = store.stateFor("mixer-01");
    expect(s.status).toBe("failed");
    if (s.status === "failed") expect(s.error).toBe("超過 45 秒沒有收到進度，結果未知，請重試");
  });

  it("checkStalls：屬當前 job 的進度事件會重置逾時計時", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    mockDiagnoseOk();
    const store = useCopilotStore();
    await store.diagnose("mixer-01", SOCKET); // 活動 @1_000_000
    nowSpy.mockReturnValue(1_040_000);
    store.applyEvent({
      type: "job/status",
      jobId: jobIdOf(store),
      machineId: "mixer-01",
      status: "active",
      progress: 60,
    }); // 進度更新 → 重置活動 @1_040_000
    store.checkStalls(1_046_000, 45_000); // 距重置僅 6s → 不逾時
    expect(store.stateFor("mixer-01").status).toBe("active");
    store.checkStalls(1_040_000 + 46_000, 45_000); // 距重置 46s → 逾時
    expect(store.stateFor("mixer-01").status).toBe("failed");
  });

  it("onReconnect：clientId 變更時 active 台不轉失敗，標「正在取回」與重連旗標；首次/同 id 不動（012 FR-016）", async () => {
    mockDiagnoseOk();
    const store = useCopilotStore();
    store.onReconnect("client-1"); // 首次連線，僅記錄
    await store.diagnose("mixer-01", SOCKET);
    store.onReconnect("client-1"); // 同 id，不動
    expect(store.stateFor("mixer-01")).not.toHaveProperty("resume");
    store.onReconnect("client-2"); // 重連（新 id）→ 待續接
    expect(store.stateFor("mixer-01")).toMatchObject({ status: "active", resume: "pending", reconnected: true });
    expect(store.lastClientId).toBe("client-2");
  });
});

describe("copilot store 診斷耗時量測（T044、data-model §8、research R7）", () => {
  /** 以 spy 控制 `performance.now()`（store 不注入時鐘）。 */
  let perfNow: MockInstance<() => number>;
  beforeEach(() => {
    setActivePinia(createPinia());
    perfNow = vi.spyOn(performance, "now").mockReturnValue(1_000);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("從未診斷 → timingFor／completedAtFor 皆為 undefined", () => {
    const store = useCopilotStore();
    expect(store.timingFor("mixer-01")).toBeUndefined();
    expect(store.completedAtFor("mixer-01")).toBeUndefined();
  });

  it("POST 送出前就以前端 jobId 開始量測（送出當下 fetch 被呼叫時 pending 已存在）", async () => {
    const store = useCopilotStore();
    let pendingAtSend: unknown;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        pendingAtSend = store.timingFor("mixer-01")?.pending;
        return okResponse(bodyOf(init));
      }),
    );
    await store.diagnose("mixer-01", SOCKET);
    expect(pendingAtSend).toEqual({ jobId: jobIdOf(store), startedAt: 1_000 });
  });

  it("ai/done（非快取）→ 寫入 lastUncachedMs、清 pending、記完成時刻", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_760_000_000_000);
    mockDiagnoseOk();
    const store = useCopilotStore();
    await store.diagnose("mixer-01", SOCKET);
    perfNow.mockReturnValue(9_200);
    store.applyEvent({ type: "ai/done", jobId: jobIdOf(store), attempt: 1, cached: false, result: RESULT });
    expect(store.timingFor("mixer-01")).toEqual({
      pending: null,
      lastUncachedMs: 8_200,
      lastCachedMs: null,
      lastKind: "uncached",
    });
    expect(store.completedAtFor("mixer-01")).toBe(1_760_000_000_000);
  });

  it("再次診斷命中快取 → 寫入 lastCachedMs 並保留上一次非快取耗時（供並列對比）", async () => {
    mockDiagnoseOk();
    const store = useCopilotStore();
    await store.diagnose("mixer-01", SOCKET);
    perfNow.mockReturnValue(9_200);
    store.applyEvent({ type: "ai/done", jobId: jobIdOf(store), attempt: 1, cached: false, result: RESULT });

    perfNow.mockReturnValue(20_000);
    await store.diagnose("mixer-01", SOCKET);
    perfNow.mockReturnValue(20_014);
    store.applyEvent({ type: "ai/done", jobId: jobIdOf(store), attempt: 1, cached: true, result: RESULT });
    expect(store.timingFor("mixer-01")).toEqual({
      pending: null,
      lastUncachedMs: 8_200,
      lastCachedMs: 14,
      lastKind: "cached",
    });
  });

  it("cache 命中的 ai/done 早於 HTTP 回應抵達仍能結算（量測在 POST 前開始）", async () => {
    const http = mockDiagnosePending();
    const store = useCopilotStore();
    const p = store.diagnose("mixer-01", SOCKET);
    perfNow.mockReturnValue(1_012);
    store.applyEvent({ type: "ai/done", jobId: jobIdOf(store), attempt: 1, cached: true, result: RESULT });
    http.respond();
    await p;
    expect(store.timingFor("mixer-01")).toMatchObject({ pending: null, lastCachedMs: 12, lastKind: "cached" });
  });

  it("ai/error、中止、POST 失敗、watchdog 逾時、重連中斷 → 清 pending，保留歷史耗時", async () => {
    mockDiagnoseOk();
    const store = useCopilotStore();
    // 先有一筆非快取紀錄
    await store.diagnose("mixer-01", SOCKET);
    perfNow.mockReturnValue(9_200);
    store.applyEvent({ type: "ai/done", jobId: jobIdOf(store), attempt: 1, cached: false, result: RESULT });
    const history = { lastUncachedMs: 8_200, lastCachedMs: null, lastKind: "uncached" };

    // ai/error
    await store.diagnose("mixer-01", SOCKET);
    expect(store.timingFor("mixer-01")?.pending).not.toBeNull();
    store.applyEvent({ type: "ai/error", jobId: jobIdOf(store), attempt: 1, code: "timeout", message: "timed out" });
    expect(store.timingFor("mixer-01")).toEqual({ pending: null, ...history });

    // 中止
    await store.diagnose("mixer-01", SOCKET);
    store.cancel("mixer-01");
    expect(store.timingFor("mixer-01")).toEqual({ pending: null, ...history });

    // watchdog 逾時
    vi.spyOn(Date, "now").mockReturnValue(5_000_000);
    await store.diagnose("mixer-01", SOCKET);
    store.checkStalls(5_000_000 + 46_000, 45_000);
    expect(store.stateFor("mixer-01").status).toBe("failed");
    expect(store.timingFor("mixer-01")).toEqual({ pending: null, ...history });

    // 重連後續接 GET 取不到（404）
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) =>
        init?.method === "POST" ? okResponse(bodyOf(init)) : new Response("", { status: 404 }),
      ),
    );
    store.onReconnect("client-1");
    await store.diagnose("mixer-01", SOCKET);
    store.onReconnect(SOCKET_2);
    store.onAuthorized(SOCKET_2);
    await flushAsync();
    expect(store.stateFor("mixer-01").status).toBe("failed");
    expect(store.timingFor("mixer-01")).toEqual({ pending: null, ...history });

    // POST 失敗
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    await store.diagnose("mixer-01", SOCKET);
    expect(store.stateFor("mixer-01").status).toBe("failed");
    expect(store.timingFor("mixer-01")).toEqual({ pending: null, ...history });
  });

  it("中止後被放棄任務的遲到 ai/done 不結算、不記完成時刻", async () => {
    mockDiagnoseOk();
    const store = useCopilotStore();
    await store.diagnose("mixer-01", SOCKET);
    const jobId = jobIdOf(store);
    store.cancel("mixer-01");
    store.applyEvent({ type: "ai/done", jobId, attempt: 1, cached: false, result: RESULT });
    expect(store.timingFor("mixer-01")).toMatchObject({ pending: null, lastUncachedMs: null, lastKind: null });
    expect(store.completedAtFor("mixer-01")).toBeUndefined();
  });

  it("cancel → 再診斷 → 舊 job 的 ai/done 晚到：新 pending 不變、不記完成；之後新 job 正確結算", async () => {
    mockDiagnoseOk();
    const store = useCopilotStore();
    await store.diagnose("mixer-01", SOCKET);
    const oldJob = jobIdOf(store);
    store.cancel("mixer-01");

    perfNow.mockReturnValue(5_000);
    await store.diagnose("mixer-01", SOCKET);
    const newJob = jobIdOf(store);
    expect(newJob).not.toBe(oldJob);
    const pending = store.timingFor("mixer-01")?.pending;
    expect(pending).toEqual({ jobId: newJob, startedAt: 5_000 });

    perfNow.mockReturnValue(6_000);
    store.applyEvent({ type: "ai/done", jobId: oldJob, attempt: 1, cached: false, result: RESULT });
    expect(store.stateFor("mixer-01").status).toBe("active");
    expect(store.timingFor("mixer-01")?.pending).toEqual(pending);
    expect(store.timingFor("mixer-01")?.lastUncachedMs).toBeNull();
    expect(store.completedAtFor("mixer-01")).toBeUndefined();

    perfNow.mockReturnValue(7_300);
    store.applyEvent({ type: "ai/done", jobId: newJob, attempt: 1, cached: false, result: RESULT });
    expect(store.timingFor("mixer-01")).toEqual({
      pending: null,
      lastUncachedMs: 2_300,
      lastCachedMs: null,
      lastKind: "uncached",
    });
    expect(store.completedAtFor("mixer-01")).toBeDefined();
  });

  it("完成 A → 診斷 B → A 的 ai/done 重送被忽略：B 的 pending、A 的耗時與完成時刻都不變", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_760_000_000_000);
    mockDiagnoseOk();
    const store = useCopilotStore();
    await store.diagnose("mixer-01", SOCKET);
    const jobA = jobIdOf(store);
    perfNow.mockReturnValue(9_200);
    store.applyEvent({ type: "ai/done", jobId: jobA, attempt: 1, cached: false, result: RESULT });

    perfNow.mockReturnValue(20_000);
    await store.diagnose("mixer-01", SOCKET);
    const jobB = jobIdOf(store);
    nowSpy.mockReturnValue(1_760_000_099_999);
    perfNow.mockReturnValue(20_500);
    store.applyEvent({ type: "ai/done", jobId: jobA, attempt: 1, cached: true, result: RESULT });

    expect(store.stateFor("mixer-01").status).toBe("active");
    expect(store.timingFor("mixer-01")).toEqual({
      pending: { jobId: jobB, startedAt: 20_000 },
      lastUncachedMs: 8_200,
      lastCachedMs: null,
      lastKind: "uncached",
    });
    expect(store.completedAtFor("mixer-01")).toBe(1_760_000_000_000);
  });

  it("每台各自量測：一台完成不影響另一台的 pending", async () => {
    mockDiagnoseOk();
    const store = useCopilotStore();
    await store.diagnose("mixer-01", SOCKET);
    perfNow.mockReturnValue(2_000);
    await store.diagnose("press-02", SOCKET);
    perfNow.mockReturnValue(3_500);
    store.applyEvent({ type: "ai/done", jobId: jobIdOf(store, "mixer-01"), attempt: 1, cached: false, result: RESULT });
    expect(store.timingFor("mixer-01")).toMatchObject({ pending: null, lastUncachedMs: 2_500 });
    expect(store.timingFor("press-02")?.pending).toEqual({ jobId: jobIdOf(store, "press-02"), startedAt: 2_000 });
  });
});

describe("copilot store 結果未送達（AR-6：job/status completed 後等不到 ai/done）", () => {
  const T0 = 1_760_000_000_000;
  /** 單調時鐘起點（`performance.now()`）；2 s 寬限以它計時，45 s watchdog 以牆上時鐘 T0 計時。 */
  const P0 = 1_000;
  let dateNow: MockInstance<() => number>;
  let perfNow: MockInstance<() => number>;
  beforeEach(() => {
    setActivePinia(createPinia());
    dateNow = vi.spyOn(Date, "now").mockReturnValue(T0);
    perfNow = vi.spyOn(performance, "now").mockReturnValue(P0);
    mockDiagnoseOk();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** 診斷 mixer-01 並在 T0 送出 job/status completed；回傳 jobId。 */
  async function diagnoseThenBackendCompleted(store: ReturnType<typeof useCopilotStore>): Promise<string> {
    await store.diagnose("mixer-01", SOCKET);
    const jobId = jobIdOf(store);
    store.applyEvent({ type: "ai/token", jobId, attempt: 1, seq: 0, text: "推理" });
    store.applyEvent({ type: "job/status", jobId, machineId: "mixer-01", status: "completed", progress: 100 });
    return jobId;
  }

  it("寬限 2 s 內維持進行中；超過即轉「結果未送達」失敗，保留串流文字、chip 為失敗", async () => {
    const store = useCopilotStore();
    await diagnoseThenBackendCompleted(store);
    store.checkStalls(T0 + UNDELIVERED_GRACE_MS, 45_000, P0 + UNDELIVERED_GRACE_MS); // 剛好 2 s：還不算逾時
    expect(store.stateFor("mixer-01").status).toBe("active");
    store.checkStalls(T0 + UNDELIVERED_GRACE_MS + 1, 45_000, P0 + UNDELIVERED_GRACE_MS + 1);
    expect(store.stateFor("mixer-01")).toMatchObject({
      status: "failed",
      reason: "undelivered",
      attempt: 1, // 記下當時輪次，救回時據以判斷文字是否屬於舊輪
      error: "診斷已在後端完成，但結果未送達畫面，請重試",
      streamText: "推理",
    });
    expect(store.badgeFor("mixer-01")).toEqual({ kind: "failed" });
    // 失敗後重試鈕照常可用（沿用既有 canDiagnose）
    expect(store.canDiagnose("mixer-01", true)).toBe(true);
  });

  it("寬限期內 ai/done 抵達 → 正常完成，之後的 tick 不會再轉失敗", async () => {
    const store = useCopilotStore();
    const jobId = await diagnoseThenBackendCompleted(store);
    store.applyEvent({ type: "ai/done", jobId, attempt: 1, cached: false, result: RESULT });
    store.checkStalls(T0 + 10_000, 45_000, P0 + 10_000);
    expect(store.stateFor("mixer-01").status).toBe("completed");
  });

  it("重複的 job/status completed 不重置寬限起點", async () => {
    const store = useCopilotStore();
    const jobId = await diagnoseThenBackendCompleted(store);
    perfNow.mockReturnValue(P0 + 1_500);
    store.applyEvent({ type: "job/status", jobId, machineId: "mixer-01", status: "completed", progress: 100 });
    store.checkStalls(T0 + 2_100, 45_000, P0 + 2_100);
    expect(store.stateFor("mixer-01")).toMatchObject({ status: "failed", reason: "undelivered" });
  });

  it("寬限以單調時鐘計：牆上時鐘往前跳 ≥ 2 s 不會誤判未送達；單調時鐘真的過了 2 s 才轉失敗", async () => {
    const store = useCopilotStore();
    await diagnoseThenBackendCompleted(store);
    // 牆上時鐘被校時往前跳 10 s（≥ 2 s；刻意小於 45 s，不碰仍用牆上時鐘的 45 s watchdog），單調時鐘只過了 100 ms
    dateNow.mockReturnValue(T0 + 10_000);
    store.checkStalls(T0 + 10_000, 45_000, P0 + 100);
    expect(store.stateFor("mixer-01").status).toBe("active");
    store.checkStalls(T0 + 10_000, 45_000, P0 + UNDELIVERED_GRACE_MS + 1);
    expect(store.stateFor("mixer-01")).toMatchObject({ status: "failed", reason: "undelivered" });
  });

  it("checkStalls 未傳單調時刻時預設讀 performance.now()（App 的每秒 tick 只傳牆上時刻）", async () => {
    const store = useCopilotStore();
    await diagnoseThenBackendCompleted(store);
    perfNow.mockReturnValue(P0 + UNDELIVERED_GRACE_MS);
    store.checkStalls(T0, 45_000);
    expect(store.stateFor("mixer-01").status).toBe("active");
    perfNow.mockReturnValue(P0 + UNDELIVERED_GRACE_MS + 1);
    store.checkStalls(T0, 45_000);
    expect(store.stateFor("mixer-01").status).toBe("failed");
  });

  it("沒有 job/status completed 的 active 不套用 2 s 寬限（仍是 45 s watchdog）", async () => {
    const store = useCopilotStore();
    await store.diagnose("mixer-01", SOCKET);
    store.applyEvent({ type: "job/status", jobId: jobIdOf(store), machineId: "mixer-01", status: "active", progress: 60 });
    store.checkStalls(T0 + 10_000, 45_000, P0 + 10_000);
    expect(store.stateFor("mixer-01").status).toBe("active");
  });

  it("保險：同 jobId 遲到的 ai/done 改回 completed，耗時、完成時刻、chip 與準時路徑一致", async () => {
    const store = useCopilotStore();
    const jobId = await diagnoseThenBackendCompleted(store);
    store.checkStalls(T0 + 3_000, 45_000, P0 + 3_000);
    expect(store.stateFor("mixer-01").status).toBe("failed");
    // 失敗期間保留 pending，晚到的結果才能結算
    expect(store.timingFor("mixer-01")?.pending).toEqual({ jobId, startedAt: 1_000 });

    dateNow.mockReturnValue(T0 + 4_000);
    perfNow.mockReturnValue(9_000);
    store.applyEvent({ type: "ai/done", jobId, attempt: 1, cached: false, result: RESULT });
    expect(store.stateFor("mixer-01")).toMatchObject({ status: "completed", jobId, cached: false, streamText: "推理" });
    expect(store.timingFor("mixer-01")).toEqual({
      pending: null,
      lastUncachedMs: 8_000,
      lastCachedMs: null,
      lastKind: "uncached",
    });
    expect(store.completedAtFor("mixer-01")).toBe(T0 + 4_000);
    expect(store.badgeFor("mixer-01")).toEqual({ kind: "completed", severity: "ok", cached: false });
  });

  it("遲到的 ai/done 仍經 guardDone 驗證：畸形結果不救回，維持未送達失敗", async () => {
    const store = useCopilotStore();
    const jobId = await diagnoseThenBackendCompleted(store);
    store.checkStalls(T0 + 3_000, 45_000, P0 + 3_000);
    store.applyEvent({
      type: "ai/done",
      jobId,
      attempt: 1,
      cached: false,
      result: { summary: "s", severity: "ok", likelyCauses: [] } as unknown as DiagnosisResult,
    });
    expect(store.stateFor("mixer-01")).toMatchObject({ status: "failed", reason: "undelivered" });
    expect(store.completedAtFor("mixer-01")).toBeUndefined();
  });

  it("其他失敗（45 s watchdog）不受保險影響：遲到的 ai/done 照舊忽略", async () => {
    const store = useCopilotStore();
    await store.diagnose("mixer-01", SOCKET);
    const jobId = jobIdOf(store);
    store.checkStalls(T0 + 46_000, 45_000, P0 + 46_000);
    store.applyEvent({ type: "ai/done", jobId, attempt: 1, cached: false, result: RESULT });
    expect(store.stateFor("mixer-01")).toMatchObject({ status: "failed", error: "超過 45 秒沒有收到進度，結果未知，請重試" });
    expect(store.completedAtFor("mixer-01")).toBeUndefined();
  });

  it("其他失敗（45 s watchdog）後到 completed+result：狀態物件不變、耗時不結算（FR-005 只救回未送達）", async () => {
    const store = useCopilotStore();
    await store.diagnose("mixer-01", SOCKET);
    const jobId = jobIdOf(store);
    store.checkStalls(T0 + 46_000, 45_000, P0 + 46_000);
    const failed = store.stateFor("mixer-01");
    const timing = store.timingFor("mixer-01");
    expect(failed.status).toBe("failed");
    store.applyEvent({
      type: "job/status",
      jobId,
      machineId: "mixer-01",
      status: "completed",
      progress: 100,
      result: RESULT,
      cached: false,
    });
    expect(store.stateFor("mixer-01")).toBe(failed);
    expect(store.timingFor("mixer-01")).toBe(timing);
    expect(store.completedAtFor("mixer-01")).toBeUndefined();
  });

  it("未送達後按重試：新任務開始，舊 job 遲到的 ai/done 不覆蓋新任務", async () => {
    const store = useCopilotStore();
    const oldJob = await diagnoseThenBackendCompleted(store);
    store.checkStalls(T0 + 3_000, 45_000, P0 + 3_000);
    await store.retry("mixer-01", SOCKET);
    const newJob = jobIdOf(store);
    expect(newJob).not.toBe(oldJob);
    store.applyEvent({ type: "ai/done", jobId: oldJob, attempt: 1, cached: false, result: RESULT });
    expect(store.stateFor("mixer-01")).toMatchObject({ status: "active", jobId: newJob });
    // 新任務沒有收到 job/status completed，不套用 2 s 寬限
    store.checkStalls(T0 + 10_000, 45_000, P0 + 10_000);
    expect(store.stateFor("mixer-01").status).toBe("active");
  });
});

describe("copilot store 三來源先到者收尾（012 T027、FR-004、SC-006）", () => {
  const T0 = 1_760_000_000_000;
  const P0 = 1_000;
  let dateNow: MockInstance<() => number>;
  let perfNow: MockInstance<() => number>;
  beforeEach(() => {
    setActivePinia(createPinia());
    dateNow = vi.spyOn(Date, "now").mockReturnValue(T0);
    perfNow = vi.spyOn(performance, "now").mockReturnValue(P0);
    mockDiagnoseOk();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function completedWithResult(jobId: string, cached?: boolean) {
    return {
      type: "job/status",
      jobId,
      machineId: "mixer-01",
      status: "completed",
      progress: 100,
      result: RESULT,
      ...(cached === undefined ? {} : { cached }),
    } as const;
  }

  it("帶 result 的 completed 直接收尾：結算耗時與完成時刻、chip 為完成", async () => {
    const store = useCopilotStore();
    await store.diagnose("mixer-01", SOCKET);
    const jobId = jobIdOf(store);
    perfNow.mockReturnValue(P0 + 4_000);
    dateNow.mockReturnValue(T0 + 4_000);
    store.applyEvent(completedWithResult(jobId, false));
    expect(store.stateFor("mixer-01")).toMatchObject({ status: "completed", jobId, source: "status", streamIncomplete: true });
    expect(store.timingFor("mixer-01")).toEqual({ pending: null, lastUncachedMs: 4_000, lastCachedMs: null, lastKind: "uncached" });
    expect(store.completedAtFor("mixer-01")).toBe(T0 + 4_000);
    expect(store.badgeFor("mixer-01")).toEqual({ kind: "completed", severity: "ok", cached: false });
  });

  it("帶 result 的 completed 缺 cached → 當 false 結算（非快取欄位）", async () => {
    const store = useCopilotStore();
    await store.diagnose("mixer-01", SOCKET);
    perfNow.mockReturnValue(P0 + 3_000);
    store.applyEvent(completedWithResult(jobIdOf(store)));
    expect(store.stateFor("mixer-01")).toMatchObject({ status: "completed", cached: false });
    expect(store.timingFor("mixer-01")).toMatchObject({ lastUncachedMs: 3_000, lastKind: "uncached" });
  });

  it("帶 result 的 completed 不觸發 2 s 未送達：先收不帶 result 的 completed（記寬限起點）→ 再收帶 result 的 → tick 跨過 2 s 也不轉失敗", async () => {
    const store = useCopilotStore();
    await store.diagnose("mixer-01", SOCKET);
    const jobId = jobIdOf(store);
    store.applyEvent({ type: "job/status", jobId, machineId: "mixer-01", status: "completed", progress: 100 });
    perfNow.mockReturnValue(P0 + 500);
    dateNow.mockReturnValue(T0 + 500);
    store.applyEvent(completedWithResult(jobId, true));
    const done = store.stateFor("mixer-01");
    const settled = store.timingFor("mixer-01");
    expect(done).toMatchObject({ status: "completed", cached: true, source: "status" });
    expect(settled).toMatchObject({ pending: null, lastCachedMs: 500, lastKind: "cached" });

    store.checkStalls(T0 + UNDELIVERED_GRACE_MS + 1, 45_000, P0 + UNDELIVERED_GRACE_MS + 1);
    store.checkStalls(T0 + 60_000, 45_000, P0 + 60_000);
    expect(store.stateFor("mixer-01")).toBe(done);
    expect(store.timingFor("mixer-01")).toBe(settled);
    expect(store.completedAtFor("mixer-01")).toBe(T0 + 500);
  });

  it("completed+result → ai/done：兩來源都到，耗時與完成時刻只結算一次（以先到者為準）", async () => {
    const store = useCopilotStore();
    await store.diagnose("mixer-01", SOCKET);
    const jobId = jobIdOf(store);
    perfNow.mockReturnValue(P0 + 4_000);
    dateNow.mockReturnValue(T0 + 4_000);
    store.applyEvent(completedWithResult(jobId, false));
    const settled = store.timingFor("mixer-01");
    const first = store.stateFor("mixer-01");

    perfNow.mockReturnValue(P0 + 9_000);
    dateNow.mockReturnValue(T0 + 9_000);
    store.applyEvent({ type: "ai/done", jobId, attempt: 1, cached: true, result: RESULT });
    expect(store.stateFor("mixer-01")).toBe(first);
    expect(store.timingFor("mixer-01")).toBe(settled);
    expect(store.completedAtFor("mixer-01")).toBe(T0 + 4_000);
  });

  it("ai/done → completed+result：兩來源都到，耗時與完成時刻只結算一次", async () => {
    const store = useCopilotStore();
    await store.diagnose("mixer-01", SOCKET);
    const jobId = jobIdOf(store);
    perfNow.mockReturnValue(P0 + 2_000);
    dateNow.mockReturnValue(T0 + 2_000);
    store.applyEvent({ type: "ai/done", jobId, attempt: 1, cached: false, result: RESULT });
    const settled = store.timingFor("mixer-01");

    perfNow.mockReturnValue(P0 + 7_000);
    dateNow.mockReturnValue(T0 + 7_000);
    store.applyEvent(completedWithResult(jobId, true));
    store.applyEvent({ type: "ai/done", jobId, attempt: 1, cached: false, result: RESULT }); // 重複的 ai/done
    expect(store.stateFor("mixer-01")).toMatchObject({ status: "completed", cached: false, source: "ai/done" });
    expect(store.timingFor("mixer-01")).toBe(settled);
    expect(store.timingFor("mixer-01")).toMatchObject({ lastUncachedMs: 2_000, lastCachedMs: null });
    expect(store.completedAtFor("mixer-01")).toBe(T0 + 2_000);
  });

  it("結果未送達後，遲到的 completed+result 救回：照常結算耗時與完成時刻（FR-005）", async () => {
    const store = useCopilotStore();
    await store.diagnose("mixer-01", SOCKET);
    const jobId = jobIdOf(store);
    store.applyEvent({ type: "job/status", jobId, machineId: "mixer-01", status: "completed", progress: 100 });
    store.checkStalls(T0 + 3_000, 45_000, P0 + 3_000);
    expect(store.stateFor("mixer-01")).toMatchObject({ status: "failed", reason: "undelivered" });

    perfNow.mockReturnValue(P0 + 5_000);
    dateNow.mockReturnValue(T0 + 5_000);
    store.applyEvent(completedWithResult(jobId, false));
    expect(store.stateFor("mixer-01")).toMatchObject({ status: "completed", source: "status", streamIncomplete: true });
    expect(store.timingFor("mixer-01")).toMatchObject({ pending: null, lastUncachedMs: 5_000 });
    expect(store.completedAtFor("mixer-01")).toBe(T0 + 5_000);
  });

  // 驗的是 store 的第二道防線 `guardStatusResult`：正式路徑在 WS 入口（ws-message.ts 的 JobStatusSchema.safeParse）
  // 已把這種 job/status 整則丟棄，這裡直接呼叫 applyEvent 繞過入口。
  it("job/status 的 result 不合 schema → 不當成結果：維持進行中並走 2 s 寬限（工程硬規則 6）", async () => {
    const store = useCopilotStore();
    await store.diagnose("mixer-01", SOCKET);
    const jobId = jobIdOf(store);
    store.applyEvent({
      ...completedWithResult(jobId, false),
      result: { summary: "s", severity: "ok", likelyCauses: [] } as unknown as DiagnosisResult,
    });
    expect(store.stateFor("mixer-01")).toMatchObject({ status: "active", progress: 100 });
    store.checkStalls(T0 + 3_000, 45_000, P0 + 3_000);
    expect(store.stateFor("mixer-01")).toMatchObject({ status: "failed", reason: "undelivered" });
    expect(store.completedAtFor("mixer-01")).toBeUndefined();
  });
});

describe("copilot store 重連續接與 GET 退路（012 T041／T042、FR-005、FR-016、FR-022、contracts/ui-copy §3）", () => {
  const T0 = 1_760_000_000_000;
  const P0 = 1_000;
  let dateNow: MockInstance<() => number>;
  let perfNow: MockInstance<() => number>;
  /** 每次 GET 的 URL（依序）。 */
  let lookups: URL[];
  /** 下一個 GET 的回應；可換成 pending promise 模擬往返中。 */
  let reply: () => Response | Promise<Response>;

  beforeEach(() => {
    setActivePinia(createPinia());
    dateNow = vi.spyOn(Date, "now").mockReturnValue(T0);
    perfNow = vi.spyOn(performance, "now").mockReturnValue(P0);
    lookups = [];
    reply = () => new Response("", { status: 404 });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "POST") return okResponse(bodyOf(init));
        lookups.push(new URL(url, "http://localhost"));
        return reply();
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const completedBody = (jobId: string, cached = false) => ({ status: "completed", jobId, result: RESULT, cached });
  const json = (body: unknown, status = 200) => () => Response.json(body, { status });

  /** 首次連線 SOCKET → 診斷 mixer-01；回傳 jobId。 */
  async function connectAndDiagnose(store: ReturnType<typeof useCopilotStore>): Promise<string> {
    store.onReconnect(SOCKET);
    await store.diagnose("mixer-01", SOCKET);
    return jobIdOf(store);
  }

  /** 重連到 SOCKET_2 並授權成功，等續接 GET 跑完。 */
  async function reconnectAndAuthorize(store: ReturnType<typeof useCopilotStore>): Promise<void> {
    store.onReconnect(SOCKET_2);
    store.onAuthorized(SOCKET_2);
    await flushAsync();
  }

  describe("續接（resume）", () => {
    it("重連後維持 active 並標待續接：chip 仍是診斷中、watchdog 重設；授權前不發 GET", async () => {
      const store = useCopilotStore();
      await connectAndDiagnose(store);
      store.applyEvent({ type: "job/status", jobId: jobIdOf(store), machineId: "mixer-01", status: "active", progress: 40 });
      dateNow.mockReturnValue(T0 + 30_000);
      store.onReconnect(SOCKET_2);
      expect(store.stateFor("mixer-01")).toMatchObject({ status: "active", resume: "pending", reconnected: true, progress: 40 });
      expect(store.badgeFor("mixer-01")).toEqual({ kind: "active", progress: 40 });
      store.checkStalls(T0 + 30_000 + 44_000, 45_000, P0); // 自重連起算未滿 45 s
      await flushAsync();
      expect(store.stateFor("mixer-01").status).toBe("active");
      expect(lookups).toHaveLength(0);
    });

    it("授權成功 → 以新 socketId GET，previousSocketId 帶 POST 的 socketId；回 completed → 完成（source lookup、不完整、耗時記為 recovered）", async () => {
      const store = useCopilotStore();
      const jobId = await connectAndDiagnose(store);
      reply = json(completedBody(jobId));
      perfNow.mockReturnValue(P0 + 30_000);
      dateNow.mockReturnValue(T0 + 30_000);
      await reconnectAndAuthorize(store);
      expect(lookups).toHaveLength(1);
      expect(lookups[0]!.pathname).toBe(`/diagnoses/${jobId}`);
      expect(lookups[0]!.searchParams.get("socketId")).toBe(SOCKET_2);
      expect(lookups[0]!.searchParams.get("previousSocketId")).toBe(SOCKET);
      expect(store.stateFor("mixer-01")).toMatchObject({ status: "completed", jobId, source: "lookup", streamIncomplete: true, result: RESULT });
      expect(store.timingFor("mixer-01")).toMatchObject({
        pending: null,
        lastUncachedMs: null,
        lastCachedMs: null,
        lastRecoveredMs: 30_000,
        lastRecoveredCached: false,
        lastKind: "recovered",
      });
      expect(store.completedAtFor("mixer-01")).toBe(T0 + 30_000);
    });

    it("SC-006 第四種順序（store）：GET completed 收尾後遲到的 ai/done 被忽略，耗時與完成時刻不再結算", async () => {
      const store = useCopilotStore();
      const jobId = await connectAndDiagnose(store);
      reply = json(completedBody(jobId, true));
      await reconnectAndAuthorize(store);
      const done = store.stateFor("mixer-01");
      const timing = store.timingFor("mixer-01");
      dateNow.mockReturnValue(T0 + 99_000);
      store.applyEvent({ type: "ai/done", jobId, attempt: 1, cached: true, result: RESULT });
      expect(store.stateFor("mixer-01")).toBe(done);
      expect(store.timingFor("mixer-01")).toBe(timing);
      expect(store.completedAtFor("mixer-01")).toBe(T0);
    });

    it("回 failed → humanizeError 轉失敗", async () => {
      const store = useCopilotStore();
      const jobId = await connectAndDiagnose(store);
      reply = json({ status: "failed", jobId, error: "request timed out" });
      await reconnectAndAuthorize(store);
      expect(store.stateFor("mixer-01")).toMatchObject({ status: "failed", error: "AI 診斷逾時，請重試。" });
      expect(store.stateFor("mixer-01")).not.toHaveProperty("reason");
    });

    it("回 active（rebound）→ 留在 active、清待續接、更新進度、保留重連旗標；之後的 GET 以本次 socketId 當 previousSocketId", async () => {
      const store = useCopilotStore();
      const jobId = await connectAndDiagnose(store);
      reply = json({ status: "active", jobId, progress: 60, rebound: true });
      dateNow.mockReturnValue(T0 + 10_000);
      await reconnectAndAuthorize(store);
      const s = store.stateFor("mixer-01");
      expect(s).toMatchObject({ status: "active", progress: 60, reconnected: true });
      expect(s).not.toHaveProperty("resume");

      // 45 s watchdog 的 GET 帶上改綁後的 socketId
      reply = json(completedBody(jobId));
      store.checkStalls(T0 + 10_000 + 46_000, 45_000, P0);
      await flushAsync();
      expect(lookups).toHaveLength(2);
      expect(lookups[1]!.searchParams.get("previousSocketId")).toBe(SOCKET_2);
      expect(store.stateFor("mixer-01")).toMatchObject({ status: "completed", source: "lookup" });
    });

    it("回 waiting → 留在 active、重設 watchdog（自 GET 回應起算）", async () => {
      const store = useCopilotStore();
      const jobId = await connectAndDiagnose(store);
      reply = json({ status: "waiting", jobId, rebound: true });
      dateNow.mockReturnValue(T0 + 40_000);
      await reconnectAndAuthorize(store);
      store.checkStalls(T0 + 40_000 + 44_000, 45_000, P0);
      await flushAsync();
      expect(store.stateFor("mixer-01").status).toBe("active");
      expect(lookups).toHaveLength(1);
    });

    it.each<[string, () => Response | Promise<Response>, string]>([
      ["404", () => new Response("", { status: 404 }), "連線中斷期間的診斷結果已無法取回，請重試"],
      ["409 job_bound_elsewhere", json({ code: "job_bound_elsewhere" }, 409), "這個診斷正由另一個視窗接收，請在該視窗查看或重試"],
      ["409 socket_unauthorized", json({ code: "socket_unauthorized" }, 409), "連線中斷，請重試"],
      ["429", () => new Response("<html>429</html>", { status: 429 }), "連線中斷，請重試"],
      ["503", json({ message: "x" }, 503), "連線中斷，請重試"],
      ["網路錯誤", () => Promise.reject(new TypeError("Failed to fetch")), "連線中斷，請重試"],
      ["格式不符", json({ status: "completed", jobId: "not-this-job", result: RESULT, cached: false }), "連線中斷，請重試"],
    ])("回 %s → 「%s」失敗", async (_name, r, message) => {
      const store = useCopilotStore();
      await connectAndDiagnose(store);
      reply = r;
      await reconnectAndAuthorize(store);
      expect(store.stateFor("mixer-01")).toMatchObject({ status: "failed", error: message });
      expect(store.timingFor("mixer-01")?.pending).toBeNull();
    });

    it("同一連線多次授權只續接一次；GET 往返中再授權也不重發", async () => {
      const store = useCopilotStore();
      const jobId = await connectAndDiagnose(store);
      let resolve: ((res: Response) => void) | undefined;
      reply = () => new Promise<Response>((r) => (resolve = r));
      store.onReconnect(SOCKET_2);
      store.onAuthorized(SOCKET_2);
      store.onAuthorized(SOCKET_2);
      await flushAsync();
      store.onAuthorized(SOCKET_2);
      expect(lookups).toHaveLength(1);
      resolve?.(Response.json(completedBody(jobId)));
      await flushAsync();
      expect(store.stateFor("mixer-01").status).toBe("completed");
      store.onAuthorized(SOCKET_2);
      await flushAsync();
      expect(lookups).toHaveLength(1);
    });

    it("續接 GET 往返中收到同任務的 token → 清「正在取回」；GET 之後逾時也不轉失敗，最後由 ai/done 收尾（合併門第 2 輪 L2）", async () => {
      const store = useCopilotStore();
      const jobId = await connectAndDiagnose(store);
      let fail: ((err: Error) => void) | undefined;
      reply = () => new Promise<Response>((_resolve, reject) => (fail = reject));
      store.onReconnect(SOCKET_2);
      store.onAuthorized(SOCKET_2);
      await flushAsync();
      store.applyEvent({ type: "ai/token", jobId, attempt: 1, seq: 0, text: "新連線收到的" });
      expect(store.stateFor("mixer-01")).toMatchObject({ status: "active", streamText: "新連線收到的" });
      expect(store.stateFor("mixer-01")).not.toHaveProperty("resume");

      fail?.(new DOMException("signal timed out", "TimeoutError"));
      await flushAsync();
      expect(store.stateFor("mixer-01").status).toBe("active");
      store.applyEvent({ type: "ai/done", jobId, attempt: 1, cached: false, result: RESULT });
      expect(store.stateFor("mixer-01")).toMatchObject({ status: "completed", source: "ai/done", streamIncomplete: true });
    });

    it("重連後到授權前，任務已由 ai/done 收尾 → 不 GET；收尾仍標不完整（重連旗標）", async () => {
      const store = useCopilotStore();
      const jobId = await connectAndDiagnose(store);
      store.onReconnect(SOCKET_2);
      store.applyEvent({ type: "ai/done", jobId, attempt: 1, cached: false, result: RESULT });
      expect(store.stateFor("mixer-01")).toMatchObject({ status: "completed", source: "ai/done", streamIncomplete: true });
      store.onAuthorized(SOCKET_2);
      await flushAsync();
      expect(lookups).toHaveLength(0);
    });

    it("GET 往返中任務被中止 → 回應丟棄，不復活畫面", async () => {
      const store = useCopilotStore();
      const jobId = await connectAndDiagnose(store);
      let resolve: ((res: Response) => void) | undefined;
      reply = () => new Promise<Response>((r) => (resolve = r));
      store.onReconnect(SOCKET_2);
      store.onAuthorized(SOCKET_2);
      await flushAsync();
      store.cancel("mixer-01");
      resolve?.(Response.json(completedBody(jobId)));
      await flushAsync();
      expect(store.stateFor("mixer-01").status).toBe("idle");
      expect(store.completedAtFor("mixer-01")).toBeUndefined();
    });

    it("多台 active：逐台續接，各自依回應收尾", async () => {
      const store = useCopilotStore();
      store.onReconnect(SOCKET);
      await store.diagnose("mixer-01", SOCKET);
      await store.diagnose("press-02", SOCKET);
      const a = jobIdOf(store, "mixer-01");
      const b = jobIdOf(store, "press-02");
      reply = () => {
        const jobId = lookups.at(-1)!.pathname.split("/").at(-1)!;
        return jobId === a ? Response.json(completedBody(a)) : Response.json({ status: "active", jobId: b, rebound: true });
      };
      await reconnectAndAuthorize(store);
      expect(lookups).toHaveLength(2);
      expect(store.stateFor("mixer-01").status).toBe("completed");
      expect(store.stateFor("press-02")).toMatchObject({ status: "active", reconnected: true });
    });

    it("重連後授權失敗（不呼叫 onAuthorized）→ 留在「正在取回」，交給 45 s watchdog（GET 409 → 結果未知；代理裁決第 47 條）", async () => {
      const store = useCopilotStore();
      await connectAndDiagnose(store);
      store.onReconnect(SOCKET_2);
      reply = json({ code: "socket_unauthorized" }, 409);
      store.checkStalls(T0 + 46_000, 45_000, P0);
      await flushAsync();
      expect(lookups[0]!.searchParams.get("socketId")).toBe(SOCKET_2);
      expect(store.stateFor("mixer-01")).toMatchObject({ status: "failed", error: "超過 45 秒沒有收到進度，結果未知，請重試" });
    });
  });

  describe("GET 往返期間重連（交叉審查 L1）與重連過的收尾（裁決 52、53）", () => {
    /** 下一個 GET 掛著不回，回傳讓測試決定回應的函式（之後的 GET 用測試另設的 `reply`）。 */
    function holdNextLookup(): (res: Response | Error) => void {
      let settle: ((res: Response | Error) => void) | undefined;
      reply = () =>
        new Promise<Response>((resolve, reject) => {
          settle = (r) => (r instanceof Error ? reject(r) : resolve(r));
        });
      return (r) => settle?.(r);
    }

    it("watchdog GET 往返中 → 重連＋授權 → 舊 GET 回 409：作廢並以新 socket 重查，任務不轉失敗", async () => {
      const store = useCopilotStore();
      const jobId = await connectAndDiagnose(store);
      const settle = holdNextLookup();
      store.checkStalls(T0 + 46_000, 45_000, P0);
      await flushAsync();
      expect(lookups).toHaveLength(1);
      expect(lookups[0]!.searchParams.get("socketId")).toBe(SOCKET);

      store.onReconnect(SOCKET_2);
      store.onAuthorized(SOCKET_2); // 舊 GET 仍在往返：這裡不重發
      await flushAsync();
      expect(lookups).toHaveLength(1);

      reply = json({ status: "active", jobId, progress: 70, rebound: true });
      settle(Response.json({ code: "socket_unauthorized" }, { status: 409 }));
      await flushAsync();
      expect(lookups).toHaveLength(2);
      expect(lookups[1]!.searchParams.get("socketId")).toBe(SOCKET_2);
      expect(store.stateFor("mixer-01")).toMatchObject({ status: "active", progress: 70, reconnected: true });
      expect(store.stateFor("mixer-01")).not.toHaveProperty("resume");
    });

    it("續接 GET 往返中再重連並授權 → 舊 GET 回 active（rebound）→ 補發的 GET 以剛被改綁到的 socket 當 previousSocketId（交叉審查 M1）", async () => {
      const store = useCopilotStore();
      const jobId = await connectAndDiagnose(store);
      const SOCKET_3 = "33333333-3333-4333-8333-333333333333";
      const settle = holdNextLookup();
      store.onReconnect(SOCKET_2);
      store.onAuthorized(SOCKET_2);
      await flushAsync();
      expect(lookups).toHaveLength(1);
      expect(lookups[0]!.searchParams.get("socketId")).toBe(SOCKET_2);
      expect(lookups[0]!.searchParams.get("previousSocketId")).toBe(SOCKET);

      store.onReconnect(SOCKET_3);
      store.onAuthorized(SOCKET_3); // 舊 GET 仍在往返：略過
      await flushAsync();
      expect(lookups).toHaveLength(1);

      reply = json({ status: "active", jobId, progress: 50, rebound: true });
      settle(Response.json({ status: "active", jobId, rebound: true }));
      await flushAsync();
      expect(lookups).toHaveLength(2);
      expect(lookups[1]!.searchParams.get("socketId")).toBe(SOCKET_3);
      expect(lookups[1]!.searchParams.get("previousSocketId")).toBe(SOCKET_2);
      expect(store.stateFor("mixer-01")).toMatchObject({ status: "active", progress: 50 });
    });

    it("重連＋授權發生在 POST 往返中 → 不先發（會 404 的）GET；POST 成功後才續接（合併門第 1 輪 L1）", async () => {
      const store = useCopilotStore();
      store.onReconnect(SOCKET);
      let respondPost: (() => void) | undefined;
      vi.stubGlobal(
        "fetch",
        vi.fn((url: string, init?: RequestInit) => {
          if (init?.method === "POST") {
            return new Promise<Response>((resolve) => (respondPost = () => resolve(okResponse(bodyOf(init)))));
          }
          lookups.push(new URL(url, "http://localhost"));
          return Promise.resolve(reply());
        }),
      );
      const posting = store.diagnose("mixer-01", SOCKET);
      const jobId = jobIdOf(store);
      store.onReconnect(SOCKET_2);
      store.onAuthorized(SOCKET_2);
      await flushAsync();
      expect(lookups).toHaveLength(0);
      expect(store.stateFor("mixer-01")).toMatchObject({ status: "active", resume: "pending" });

      reply = json({ status: "waiting", jobId, rebound: true });
      respondPost?.();
      await posting;
      await flushAsync();
      expect(lookups).toHaveLength(1);
      expect(lookups[0]!.searchParams.get("socketId")).toBe(SOCKET_2);
      expect(lookups[0]!.searchParams.get("previousSocketId")).toBe(SOCKET);
      expect(store.stateFor("mixer-01")).toMatchObject({ status: "active", reconnected: true });
      expect(store.stateFor("mixer-01")).not.toHaveProperty("resume");
    });

    it("POST 往返中重連但尚未授權 → POST 結束時不續接；授權後才 GET", async () => {
      const store = useCopilotStore();
      store.onReconnect(SOCKET);
      let respondPost: (() => void) | undefined;
      vi.stubGlobal(
        "fetch",
        vi.fn((url: string, init?: RequestInit) => {
          if (init?.method === "POST") {
            return new Promise<Response>((resolve) => (respondPost = () => resolve(okResponse(bodyOf(init)))));
          }
          lookups.push(new URL(url, "http://localhost"));
          return Promise.resolve(reply());
        }),
      );
      const posting = store.diagnose("mixer-01", SOCKET);
      const jobId = jobIdOf(store);
      store.onReconnect(SOCKET_2);
      respondPost?.();
      await posting;
      await flushAsync();
      expect(lookups).toHaveLength(0);
      reply = json(completedBody(jobId));
      store.onAuthorized(SOCKET_2);
      await flushAsync();
      expect(lookups).toHaveLength(1);
      expect(store.stateFor("mixer-01")).toMatchObject({ status: "completed", source: "lookup" });
    });

    it("舊 GET 在新連線授權前就回來 → 只作廢；授權時才以新 socket 續接", async () => {
      const store = useCopilotStore();
      const jobId = await connectAndDiagnose(store);
      const settle = holdNextLookup();
      store.checkStalls(T0 + 46_000, 45_000, P0);
      await flushAsync();
      store.onReconnect(SOCKET_2);
      settle(new TypeError("Failed to fetch"));
      await flushAsync();
      expect(lookups).toHaveLength(1);
      expect(store.stateFor("mixer-01")).toMatchObject({ status: "active", resume: "pending" });

      reply = json(completedBody(jobId));
      store.onAuthorized(SOCKET_2);
      await flushAsync();
      expect(lookups).toHaveLength(2);
      expect(lookups[1]!.searchParams.get("socketId")).toBe(SOCKET_2);
      expect(store.stateFor("mixer-01")).toMatchObject({ status: "completed", source: "lookup" });
    });

    it("舊 GET 往返中重連，但它回的是 completed → 照常採用（結果與 socket 無關），不重查", async () => {
      const store = useCopilotStore();
      const jobId = await connectAndDiagnose(store);
      const settle = holdNextLookup();
      store.checkStalls(T0 + 46_000, 45_000, P0);
      await flushAsync();
      store.onReconnect(SOCKET_2);
      store.onAuthorized(SOCKET_2);
      settle(Response.json(completedBody(jobId)));
      await flushAsync();
      expect(lookups).toHaveLength(1);
      expect(store.stateFor("mixer-01")).toMatchObject({ status: "completed", source: "lookup", reconnected: true });
    });

    it("重連過、以 ai/done 收尾 → 耗時記為 recovered，不動非快取／快取兩欄（裁決 52）", async () => {
      const store = useCopilotStore();
      const jobId = await connectAndDiagnose(store);
      store.onReconnect(SOCKET_2);
      perfNow.mockReturnValue(P0 + 20_000);
      store.applyEvent({ type: "ai/done", jobId, attempt: 1, cached: false, result: RESULT });
      expect(store.stateFor("mixer-01")).toMatchObject({ status: "completed", source: "ai/done", reconnected: true });
      expect(store.timingFor("mixer-01")).toMatchObject({
        lastUncachedMs: null,
        lastCachedMs: null,
        lastRecoveredMs: 20_000,
        lastKind: "recovered",
      });
    });

    it("沒有重連的 2 s 退路以 GET 收尾 → 完成態不帶重連旗標（取回小字不顯示，裁決 53）", async () => {
      const store = useCopilotStore();
      const jobId = await connectAndDiagnose(store);
      store.applyEvent({ type: "job/status", jobId, machineId: "mixer-01", status: "completed", progress: 100 });
      reply = json(completedBody(jobId));
      store.checkStalls(T0 + 3_000, 45_000, P0 + UNDELIVERED_GRACE_MS + 1);
      await flushAsync();
      expect(store.stateFor("mixer-01")).toMatchObject({ status: "completed", source: "lookup" });
      expect(store.stateFor("mixer-01")).not.toHaveProperty("reconnected");
    });
  });

  describe("2 s 未送達退路（undelivered）", () => {
    /** 連線、診斷並收到不帶 result 的 completed；回傳 jobId。 */
    async function backendCompleted(store: ReturnType<typeof useCopilotStore>): Promise<string> {
      const jobId = await connectAndDiagnose(store);
      store.applyEvent({ type: "ai/token", jobId, attempt: 1, seq: 0, text: "推理" });
      store.applyEvent({ type: "job/status", jobId, machineId: "mixer-01", status: "completed", progress: 100 });
      return jobId;
    }
    const tickPastGrace = (store: ReturnType<typeof useCopilotStore>) =>
      store.checkStalls(T0 + 3_000, 45_000, P0 + UNDELIVERED_GRACE_MS + 1);

    it("寬限內不 GET；到期先 GET 一次，回 completed → 完成（source lookup）", async () => {
      const store = useCopilotStore();
      const jobId = await backendCompleted(store);
      reply = json(completedBody(jobId));
      store.checkStalls(T0, 45_000, P0 + UNDELIVERED_GRACE_MS);
      await flushAsync();
      expect(lookups).toHaveLength(0);
      tickPastGrace(store);
      await flushAsync();
      expect(lookups).toHaveLength(1);
      expect(lookups[0]!.searchParams.get("socketId")).toBe(SOCKET);
      expect(lookups[0]!.searchParams.get("previousSocketId")).toBe(SOCKET);
      expect(store.stateFor("mixer-01")).toMatchObject({ status: "completed", source: "lookup", streamText: "推理" });
      expect(store.timingFor("mixer-01")?.lastKind).toBe("recovered");
    });

    it("GET 往返期間每秒 tick 不重發、也不轉失敗", async () => {
      const store = useCopilotStore();
      const jobId = await backendCompleted(store);
      let resolve: ((res: Response) => void) | undefined;
      reply = () => new Promise<Response>((r) => (resolve = r));
      tickPastGrace(store);
      await flushAsync();
      for (let i = 1; i <= 3; i++) store.checkStalls(T0 + 3_000 + i * 1_000, 45_000, P0 + 3_000 + i * 1_000);
      await flushAsync();
      expect(lookups).toHaveLength(1);
      expect(store.stateFor("mixer-01").status).toBe("active");
      resolve?.(Response.json(completedBody(jobId)));
      await flushAsync();
      expect(store.stateFor("mixer-01").status).toBe("completed");
    });

    it("回 failed → humanizeError 轉失敗（不標未送達）；之後遲到的 ai/done 不救回", async () => {
      const store = useCopilotStore();
      const jobId = await backendCompleted(store);
      reply = json({ status: "failed", jobId, error: "request timed out" });
      tickPastGrace(store);
      await flushAsync();
      const failed = store.stateFor("mixer-01");
      expect(failed).toMatchObject({ status: "failed", error: "AI 診斷逾時，請重試。" });
      expect(failed).not.toHaveProperty("reason");
      store.applyEvent({ type: "ai/done", jobId, attempt: 1, cached: false, result: RESULT });
      expect(store.stateFor("mixer-01")).toBe(failed);
    });

    it.each<[string, (jobId: string) => () => Response | Promise<Response>]>([
      ["active（P21）", (jobId) => json({ status: "active", jobId, progress: 90, rebound: true })],
      ["waiting（P21）", (jobId) => json({ status: "waiting", jobId, rebound: true })],
      ["404", () => () => new Response("", { status: 404 })],
      ["409", () => json({ code: "job_bound_elsewhere" }, 409)],
      ["503", () => json({}, 503)],
      ["429", () => () => new Response("", { status: 429 })],
      ["網路錯誤", () => () => Promise.reject(new TypeError("Failed to fetch"))],
      ["格式不符", () => json({ status: "completed" })],
    ])("回 %s → 「結果未送達」（可救回、保留耗時 pending）", async (_name, r) => {
      const store = useCopilotStore();
      const jobId = await backendCompleted(store);
      reply = r(jobId);
      tickPastGrace(store);
      await flushAsync();
      expect(store.stateFor("mixer-01")).toMatchObject({
        status: "failed",
        reason: "undelivered",
        error: "診斷已在後端完成，但結果未送達畫面，請重試",
        attempt: 1,
        streamText: "推理",
      });
      expect(store.timingFor("mixer-01")?.pending).toEqual({ jobId, startedAt: P0 });
      // 遲到的結果仍救回
      store.applyEvent({ type: "ai/done", jobId, attempt: 1, cached: false, result: RESULT });
      expect(store.stateFor("mixer-01")).toMatchObject({ status: "completed", source: "ai/done", streamIncomplete: false });
    });

    it("重連過的任務轉未送達時帶重連旗標：之後以 ai/done 救回仍標不完整（FR-038）", async () => {
      const store = useCopilotStore();
      const jobId = await connectAndDiagnose(store);
      reply = json({ status: "active", jobId, rebound: true });
      await reconnectAndAuthorize(store);
      store.applyEvent({ type: "job/status", jobId, machineId: "mixer-01", status: "completed", progress: 100 });
      reply = () => new Response("", { status: 503 });
      tickPastGrace(store);
      await flushAsync();
      expect(store.stateFor("mixer-01")).toMatchObject({ status: "failed", reason: "undelivered", reconnected: true });
      store.applyEvent({ type: "ai/done", jobId, attempt: 1, cached: false, result: RESULT });
      expect(store.stateFor("mixer-01")).toMatchObject({ status: "completed", source: "ai/done", streamIncomplete: true });
    });

    it("斷線期間寬限到期 → 不發 GET、不轉失敗，任務維持進行中（代理裁決第 63 條）", async () => {
      const store = useCopilotStore();
      await backendCompleted(store);
      store.checkStalls(T0 + 3_000, 45_000, P0 + UNDELIVERED_GRACE_MS + 1, false);
      await flushAsync();
      expect(lookups).toHaveLength(0);
      expect(store.stateFor("mixer-01")).toMatchObject({ status: "active", progress: 100 });
    });

    it("completed 無 result 後重連到 B → 寬限起點作廢：B 授權前不以它發 GET（合併門第 2 輪 L1）", async () => {
      const store = useCopilotStore();
      const jobId = await backendCompleted(store);
      store.onReconnect(SOCKET_2);
      store.checkStalls(T0 + 2_100, 45_000, P0 + 2_100);
      await flushAsync();
      expect(lookups).toHaveLength(0);
      expect(store.stateFor("mixer-01")).toMatchObject({ status: "active", resume: "pending" });
      // 授權後由續接 GET 處理 completed
      reply = json(completedBody(jobId));
      store.onAuthorized(SOCKET_2);
      await flushAsync();
      expect(lookups).toHaveLength(1);
      expect(store.stateFor("mixer-01")).toMatchObject({ status: "completed", source: "lookup", reconnected: true });
    });
  });

  describe("45 s watchdog 退路", () => {
    const tickWatchdog = (store: ReturnType<typeof useCopilotStore>) => store.checkStalls(T0 + 46_000, 45_000, P0);

    it("斷線期間 46 s 無進展 → 不發 GET、任務維持進行中；重連並授權後才續接（代理裁決第 63 條）", async () => {
      const store = useCopilotStore();
      const jobId = await connectAndDiagnose(store);
      store.checkStalls(T0 + 46_000, 45_000, P0, false);
      store.checkStalls(T0 + 90_000, 45_000, P0, false);
      await flushAsync();
      expect(lookups).toHaveLength(0);
      expect(store.stateFor("mixer-01").status).toBe("active");

      dateNow.mockReturnValue(T0 + 90_000);
      store.onReconnect(SOCKET_2);
      store.checkStalls(T0 + 91_000, 45_000, P0, true); // 重連重設了 watchdog：不觸發
      await flushAsync();
      expect(lookups).toHaveLength(0);
      reply = json({ status: "active", jobId, progress: 60, rebound: true });
      store.onAuthorized(SOCKET_2);
      await flushAsync();
      expect(lookups).toHaveLength(1);
      expect(lookups[0]!.searchParams.get("socketId")).toBe(SOCKET_2);
      expect(store.stateFor("mixer-01")).toMatchObject({ status: "active", progress: 60, reconnected: true });
    });

    it("回 completed → 照常完成", async () => {
      const store = useCopilotStore();
      const jobId = await connectAndDiagnose(store);
      reply = json(completedBody(jobId, true));
      tickWatchdog(store);
      await flushAsync();
      expect(store.stateFor("mixer-01")).toMatchObject({ status: "completed", cached: true, source: "lookup" });
    });

    it("回 active／waiting → 維持 active、重設 watchdog、console.warn 一則", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const store = useCopilotStore();
      const jobId = await connectAndDiagnose(store);
      reply = json({ status: "active", jobId, progress: 80, rebound: true });
      dateNow.mockReturnValue(T0 + 46_000);
      tickWatchdog(store);
      await flushAsync();
      expect(store.stateFor("mixer-01")).toMatchObject({ status: "active", progress: 80 });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain(jobId);
      // 重設後 44 s 內不再觸發
      store.checkStalls(T0 + 46_000 + 44_000, 45_000, P0);
      await flushAsync();
      expect(lookups).toHaveLength(1);
    });

    it("回 failed → humanizeError 轉失敗", async () => {
      const store = useCopilotStore();
      const jobId = await connectAndDiagnose(store);
      reply = json({ status: "failed", jobId, error: "quota exceeded" });
      tickWatchdog(store);
      await flushAsync();
      expect(store.stateFor("mixer-01")).toMatchObject({ status: "failed", error: "AI 服務暫時繁忙（速率限制），請稍後重試。" });
    });

    it.each<[string, () => Response | Promise<Response>]>([
      ["404", () => new Response("", { status: 404 })],
      ["409 job_bound_elsewhere", json({ code: "job_bound_elsewhere" }, 409)],
      ["429", () => new Response("", { status: 429 })],
      ["503", json({}, 503)],
      ["網路錯誤", () => Promise.reject(new TypeError("Failed to fetch"))],
      ["格式不符", json({ nope: true })],
    ])("回 %s → 「結果未知」失敗、清耗時 pending", async (_name, r) => {
      const store = useCopilotStore();
      await connectAndDiagnose(store);
      reply = r;
      tickWatchdog(store);
      await flushAsync();
      expect(store.stateFor("mixer-01")).toMatchObject({ status: "failed", error: "超過 45 秒沒有收到進度，結果未知，請重試" });
      expect(store.stateFor("mixer-01")).not.toHaveProperty("reason");
      expect(store.timingFor("mixer-01")?.pending).toBeNull();
    });

    it("GET 往返期間每秒 tick 不重發（lookupInFlight 去重）", async () => {
      const store = useCopilotStore();
      await connectAndDiagnose(store);
      reply = () => new Promise<Response>(() => {});
      for (let i = 0; i < 4; i++) store.checkStalls(T0 + 46_000 + i * 1_000, 45_000, P0);
      await flushAsync();
      expect(lookups).toHaveLength(1);
      expect(store.stateFor("mixer-01").status).toBe("active");
    });
  });
});

describe("lookupFailureMessage（contracts/ui-copy §3）", () => {
  const http = (status: number, code?: "socket_unauthorized" | "job_bound_elsewhere") =>
    new DiagnoseLookupError("http", status, code);

  it.each<[string, unknown, string, string, string]>([
    ["404", http(404), "連線中斷期間的診斷結果已無法取回，請重試", UNDELIVERED, WATCHDOG],
    ["409 job_bound_elsewhere", http(409, "job_bound_elsewhere"), "這個診斷正由另一個視窗接收，請在該視窗查看或重試", UNDELIVERED, WATCHDOG],
    ["409 socket_unauthorized", http(409, "socket_unauthorized"), "連線中斷，請重試", UNDELIVERED, WATCHDOG],
    ["409 無 code", http(409), "連線中斷，請重試", UNDELIVERED, WATCHDOG],
    ["429", http(429), "連線中斷，請重試", UNDELIVERED, WATCHDOG],
    ["503", http(503), "連線中斷，請重試", UNDELIVERED, WATCHDOG],
    ["網路錯誤", new DiagnoseLookupError("network"), "連線中斷，請重試", UNDELIVERED, WATCHDOG],
    ["逾時", new DiagnoseLookupError("timeout"), "連線中斷，請重試", UNDELIVERED, WATCHDOG],
    ["格式不符", new DiagnoseLookupError("invalid"), "連線中斷，請重試", UNDELIVERED, WATCHDOG],
    ["沒有 socketId", null, "連線中斷，請重試", UNDELIVERED, WATCHDOG],
  ])("%s → resume／undelivered／watchdog 各自的文案", (_name, err, resume, undelivered, watchdog) => {
    expect(lookupFailureMessage("resume", err)).toBe(resume);
    expect(lookupFailureMessage("undelivered", err)).toBe(undelivered);
    expect(lookupFailureMessage("watchdog", err)).toBe(watchdog);
  });
});

describe("copilot store 診斷狀態 chip badgeFor（T051、data-model §7、FR-028）", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("none：從未診斷、或中止回 idle → { kind: 'none' }", async () => {
    mockDiagnoseOk();
    const store = useCopilotStore();
    expect(store.badgeFor("mixer-01")).toEqual({ kind: "none" });
    await store.diagnose("mixer-01", SOCKET);
    store.cancel("mixer-01");
    expect(store.badgeFor("mixer-01")).toEqual({ kind: "none" });
  });

  it("active：帶進度（尚無進度為 null，job/status 帶入後更新）", async () => {
    mockDiagnoseOk();
    const store = useCopilotStore();
    await store.diagnose("mixer-01", SOCKET);
    expect(store.badgeFor("mixer-01")).toEqual({ kind: "active", progress: null });
    store.applyEvent({ type: "job/status", jobId: jobIdOf(store), machineId: "mixer-01", status: "active", progress: 60 });
    expect(store.badgeFor("mixer-01")).toEqual({ kind: "active", progress: 60 });
  });

  it("completed：帶結果嚴重度與是否快取（非快取／快取兩種）", async () => {
    mockDiagnoseOk();
    const store = useCopilotStore();
    await store.diagnose("mixer-01", SOCKET);
    store.applyEvent({
      type: "ai/done",
      jobId: jobIdOf(store),
      attempt: 1,
      cached: false,
      result: { ...RESULT, severity: "critical" },
    });
    expect(store.badgeFor("mixer-01")).toEqual({ kind: "completed", severity: "critical", cached: false });

    await store.diagnose("mixer-01", SOCKET);
    store.applyEvent({ type: "ai/done", jobId: jobIdOf(store), attempt: 1, cached: true, result: RESULT });
    expect(store.badgeFor("mixer-01")).toEqual({ kind: "completed", severity: "ok", cached: true });
  });

  it("failed：ai/error 終態 → { kind: 'failed' }", async () => {
    mockDiagnoseOk();
    const store = useCopilotStore();
    await store.diagnose("mixer-01", SOCKET);
    store.applyEvent({ type: "ai/error", jobId: jobIdOf(store), attempt: 1, code: "x", message: "壞了" });
    expect(store.badgeFor("mixer-01")).toEqual({ kind: "failed" });
  });

  it("多台各自衍生，互不影響（US5 Acceptance 3）", async () => {
    mockDiagnoseOk();
    const store = useCopilotStore();
    await store.diagnose("mixer-01", SOCKET);
    await store.diagnose("press-02", SOCKET);
    store.applyEvent({ type: "ai/done", jobId: jobIdOf(store, "press-02"), attempt: 1, cached: true, result: RESULT });
    expect(store.badgeFor("mixer-01")).toEqual({ kind: "active", progress: null });
    expect(store.badgeFor("press-02")).toEqual({ kind: "completed", severity: "ok", cached: true });
    expect(store.badgeFor("oven-04")).toEqual({ kind: "none" });
  });

  it("整份 chip 都沒變時回傳舊 Map：依賴 badgeFor 的副作用在 token 期間不重跑，進度改變才 +1", async () => {
    mockDiagnoseOk();
    const store = useCopilotStore();
    await store.diagnose("mixer-01", SOCKET);
    await store.diagnose("press-02", SOCKET);
    const jobId = jobIdOf(store);
    let runs = 0;
    const scope = effectScope();
    scope.run(() => {
      // 只讀別台（press-02）的 chip：若 Map 每次都換新，mixer-01 的 token 也會讓它重跑
      watchEffect(
        () => {
          store.badgeFor("press-02");
          runs += 1;
        },
        { flush: "sync" },
      );
    });
    expect(runs).toBe(1);
    store.applyEvent({ type: "ai/token", jobId, attempt: 1, seq: 0, text: "溫" });
    store.applyEvent({ type: "ai/token", jobId, attempt: 1, seq: 1, text: "度" });
    expect(runs).toBe(1);
    store.applyEvent({ type: "job/status", jobId, machineId: "mixer-01", status: "active", progress: 30 });
    expect(runs).toBe(2);
    scope.stop();
  });

  it("串流 token 只改 streamText 時 chip 物件身分不變（依賴 chip 的卡片不因 token 重繪）；進度變了才換新物件", async () => {
    mockDiagnoseOk();
    const store = useCopilotStore();
    await store.diagnose("mixer-01", SOCKET);
    const jobId = jobIdOf(store);
    const before = store.badgeFor("mixer-01");
    store.applyEvent({ type: "ai/token", jobId, attempt: 1, seq: 0, text: "溫" });
    store.applyEvent({ type: "ai/token", jobId, attempt: 1, seq: 1, text: "度" });
    expect(store.badgeFor("mixer-01")).toBe(before);
    store.applyEvent({ type: "job/status", jobId, machineId: "mixer-01", status: "active", progress: 30 });
    expect(store.badgeFor("mixer-01")).not.toBe(before);
    expect(store.badgeFor("mixer-01")).toEqual({ kind: "active", progress: 30 });
  });
});

describe("copilot store 面板偏好 panelOpen（T059、data-model §2、FR-033）", () => {
  /** 以 Map 模擬 localStorage（新版 Node 的實驗性 localStorage 不可靠），跨 store 重建保留內容。 */
  let storage: Map<string, string>;
  const KEY = "fg.copilot-panel";

  beforeEach(() => {
    storage = new Map();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => void storage.set(k, v),
      removeItem: (k: string) => void storage.delete(k),
    });
    setActivePinia(createPinia());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** 模擬重新載入：新的 pinia＋新的 store，從 storage 讀回偏好。 */
  function reload(): ReturnType<typeof useCopilotStore> {
    setActivePinia(createPinia());
    return useCopilotStore();
  }

  it("載入一律收合；無偏好時 manuallyCollapsed 為 false、不寫 storage", () => {
    const store = useCopilotStore();
    expect(store.panelOpen).toBe(false);
    expect(store.panel.manuallyCollapsed).toBe(false);
    expect(storage.has(KEY)).toBe(false);
  });

  it("有手動收合偏好時載入仍收合，且讀回 manuallyCollapsed = true", () => {
    storage.set(KEY, JSON.stringify({ manuallyCollapsed: true }));
    const store = useCopilotStore();
    expect(store.panelOpen).toBe(false);
    expect(store.panel.manuallyCollapsed).toBe(true);
  });

  it.each(["not-json", "{}", '{"manuallyCollapsed":"yes"}', "null"])(
    "偏好內容不合法（%s）→ 退回預設 false",
    (raw) => {
      storage.set(KEY, raw);
      expect(useCopilotStore().panel.manuallyCollapsed).toBe(false);
    },
  );

  it("localStorage 拋錯時以預設運作、不拋錯", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    const store = reload();
    expect(store.panel.manuallyCollapsed).toBe(false);
    expect(() => store.collapsePanel()).not.toThrow();
    expect(store.panelOpen).toBe(false);
  });

  it("無偏好時選台展開；取消選取收合且偏好不變", () => {
    const store = useCopilotStore();
    store.onMachineSelected("mixer-01");
    expect(store.panelOpen).toBe(true);
    store.onMachineSelected(null);
    expect(store.panelOpen).toBe(false);
    expect(store.panel.manuallyCollapsed).toBe(false);
  });

  it("收合鈕（collapsePanel）收合並寫入偏好；之後選台不展開", () => {
    const store = useCopilotStore();
    store.onMachineSelected("mixer-01");
    store.collapsePanel();
    expect(store.panelOpen).toBe(false);
    expect(store.panel.manuallyCollapsed).toBe(true);
    expect(JSON.parse(storage.get(KEY) ?? "null")).toEqual({ manuallyCollapsed: true });

    store.onMachineSelected("press-02");
    expect(store.panelOpen).toBe(false);
  });

  it("Escape／遮罩（dismissPanel）只收合當次、不寫偏好；之後選台照樣展開", () => {
    const store = useCopilotStore();
    store.onMachineSelected("mixer-01");
    store.dismissPanel();
    expect(store.panelOpen).toBe(false);
    expect(store.panel.manuallyCollapsed).toBe(false);
    expect(storage.has(KEY)).toBe(false);

    store.onMachineSelected("press-02");
    expect(store.panelOpen).toBe(true);
  });

  it("有偏好時 Escape 收合也不動偏好", () => {
    storage.set(KEY, JSON.stringify({ manuallyCollapsed: true }));
    const store = useCopilotStore();
    store.openPanel();
    store.collapsePanel();
    store.dismissPanel();
    expect(store.panel.manuallyCollapsed).toBe(true);
  });

  it("偏好值沒變就不寫 storage：無偏好時 openPanel 不寫；已收合時再按收合鈕不重寫", () => {
    const store = useCopilotStore();
    const setItem = vi.spyOn(globalThis.localStorage, "setItem");
    store.openPanel();
    expect(store.panelOpen).toBe(true);
    expect(storage.has(KEY)).toBe(false);
    expect(setItem).not.toHaveBeenCalled();

    store.collapsePanel();
    store.openPanel();
    store.dismissPanel();
    store.openPanel();
    expect(setItem).toHaveBeenCalledTimes(2); // true 一次、false 一次
    store.collapsePanel();
    store.collapsePanel();
    expect(setItem).toHaveBeenCalledTimes(3);
  });

  it("展開把手（openPanel）展開並清除偏好", () => {
    storage.set(KEY, JSON.stringify({ manuallyCollapsed: true }));
    const store = useCopilotStore();
    store.onMachineSelected("mixer-01");
    expect(store.panelOpen).toBe(false);
    store.openPanel();
    expect(store.panelOpen).toBe(true);
    expect(store.panel.manuallyCollapsed).toBe(false);
    expect(JSON.parse(storage.get(KEY) ?? "null")).toEqual({ manuallyCollapsed: false });
  });

  it("觸發診斷展開並清除偏好；前置條件擋下（無連線）時同樣展開，面板才看得到停用原因", async () => {
    mockDiagnoseOk();
    storage.set(KEY, JSON.stringify({ manuallyCollapsed: true }));
    const store = useCopilotStore();
    store.onMachineSelected("mixer-01");
    await store.diagnose("mixer-01", SOCKET);
    expect(store.panelOpen).toBe(true);
    expect(store.panel.manuallyCollapsed).toBe(false);

    store.collapsePanel();
    await store.diagnose("press-02", null);
    expect(store.stateFor("press-02").status).toBe("idle");
    expect(store.panelOpen).toBe(true);
    expect(store.panel.manuallyCollapsed).toBe(false);
  });

  it("偏好跨重新載入保留：收合鈕寫入後重建 store 讀回 true；展開把手清除後讀回 false", () => {
    useCopilotStore().collapsePanel();
    let store = reload();
    expect(store.panelOpen).toBe(false);
    expect(store.panel.manuallyCollapsed).toBe(true);
    store.onMachineSelected("mixer-01");
    expect(store.panelOpen).toBe(false);

    store.openPanel();
    store = reload();
    expect(store.panel.manuallyCollapsed).toBe(false);
  });
});
