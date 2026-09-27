import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
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
  return JSON.parse(String(init?.body)) as SentBody;
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
    expect(store.stateFor("mixer-01")).toMatchObject({ status: "failed", error: "此診斷請求已失效，請重新發起" });
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
