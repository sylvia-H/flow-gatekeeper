import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { effectScope, watchEffect } from "vue";
import type { DiagnosisResult } from "@flow-gatekeeper/contracts";
import { useCopilotStore } from "./copilot.store.js";

const RESULT: DiagnosisResult = {
  summary: "s",
  severity: "ok",
  likelyCauses: [],
  suggestedActions: [],
  evidence: [],
};

const SOCKET = "11111111-1111-4111-8111-111111111111";

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

  it("checkStalls watchdog：逾時無進展 → failed（可重試）；未逾時不動", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    mockDiagnoseOk();
    const store = useCopilotStore();
    await store.diagnose("mixer-01", SOCKET); // 記活動時刻 @1_000_000
    store.checkStalls(1_000_000 + 10_000, 45_000); // 未逾時
    expect(store.stateFor("mixer-01").status).toBe("active");
    store.checkStalls(1_000_000 + 46_000, 45_000); // 逾時
    const s = store.stateFor("mixer-01");
    expect(s.status).toBe("failed");
    if (s.status === "failed") expect(s.error).toBe("診斷逾時或無回應，請重試");
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

  it("onReconnect：clientId 變更使 active 台轉 failed（中斷）；首次/同 id 不動（FR-012）", async () => {
    mockDiagnoseOk();
    const store = useCopilotStore();
    store.onReconnect("client-1"); // 首次連線，僅記錄
    await store.diagnose("mixer-01", SOCKET);
    store.onReconnect("client-1"); // 同 id，不動
    expect(store.stateFor("mixer-01").status).toBe("active");
    store.onReconnect("client-2"); // 重連（新 id）→ 中斷
    const s = store.stateFor("mixer-01");
    expect(s.status).toBe("failed");
    if (s.status === "failed") expect(s.error).toBe("連線中斷，請重試");
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

    // 重連中斷
    store.onReconnect("client-1");
    await store.diagnose("mixer-01", SOCKET);
    store.onReconnect("client-2");
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
