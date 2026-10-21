import { afterEach, describe, expect, it, vi } from "vitest";
import type { DiagnosisResult } from "@flow-gatekeeper/contracts";
import {
  DIAGNOSE_REQUEST_TIMEOUT_MS,
  DiagnoseLookupError,
  DiagnoseRequestError,
  getDiagnosis,
  messageForStatus,
  postDiagnose,
} from "./diagnose-api.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("messageForStatus — 狀態碼對映中文訊息", () => {
  it.each([
    [404, "此機台不在名冊中"],
    [429, "診斷請求過於頻繁，請稍後再試"],
    [409, "連線已中斷或未授權，請等待重連後再試"],
    [503, "診斷佇列暫時無法使用，請稍後再試"],
    [400, "請求格式不被接受（前端版本可能過舊）"],
    [500, "診斷服務暫時發生錯誤，請稍後再試"],
    [418, "診斷請求失敗，請重試"],
  ])("%i → %s", (status, message) => {
    expect(messageForStatus(status)).toBe(message);
  });
});

describe("postDiagnose — 非 2xx 回應", () => {
  it("409 WebSocket 連線不存在或未授權：有後端中文 message 顯示原句，無 body 走 409 對映句", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ statusCode: 409, message: "WebSocket 連線不存在或未授權" }), {
            status: 409,
          }),
      ),
    );
    const withBody = await postDiagnose("j1", "mixer-01", "stale-client").catch((e: unknown) => e);
    expect(withBody).toMatchObject({ message: "WebSocket 連線不存在或未授權", status: 409 });

    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 409 })));
    const noBody = await postDiagnose("j2", "mixer-01", "stale-client").catch((e: unknown) => e);
    expect(noBody).toBeInstanceOf(DiagnoseRequestError);
    expect(noBody).toMatchObject({ message: "連線已中斷或未授權，請等待重連後再試", status: 409 });
  });

  it("nginx 限流 429（HTML 錯誤頁、無中文 message）→ 走狀態碼對映", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>429 Too Many Requests</html>", { status: 429 })),
    );
    const err = await postDiagnose("j1", "mixer-01", "c1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DiagnoseRequestError);
    expect(err).toMatchObject({ message: "診斷請求過於頻繁，請稍後再試", status: 429 });
  });

  it("404 帶英文 message → 走狀態碼對映；帶中文 message → 用後端訊息", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ message: "Not Found" }, { status: 404 })),
    );
    await expect(postDiagnose("j1", "ghost-99", "c1")).rejects.toMatchObject({
      message: "此機台不在名冊中",
      status: 404,
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ message: "機台 ghost-99 不在名冊" }, { status: 404 })),
    );
    await expect(postDiagnose("j1", "ghost-99", "c1")).rejects.toMatchObject({
      message: "機台 ghost-99 不在名冊",
    });
  });
});

describe("getDiagnosis — GET /diagnoses/:jobId（contracts/diagnosis-lookup §8）", () => {
  const JOB = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const OTHER_JOB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const SOCKET = "11111111-1111-4111-8111-111111111111";
  const PREV_SOCKET = "22222222-2222-4222-8222-222222222222";
  const RESULT: DiagnosisResult = {
    summary: "s",
    severity: "ok",
    likelyCauses: [],
    suggestedActions: [],
    evidence: [],
  };

  /** stub fetch 回指定回應，並回傳 mock 以檢查請求。 */
  function stubFetch(res: () => Response | Promise<Response>) {
    const fn = vi.fn(async (_url: string, _init?: RequestInit) => res());
    vi.stubGlobal("fetch", fn);
    return fn;
  }

  /** 讓 promise 拋出並回傳該錯誤（斷言用）。 */
  async function lookupError(p: Promise<unknown>): Promise<DiagnoseLookupError> {
    const err = await p.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(DiagnoseLookupError);
    return err as DiagnoseLookupError;
  }

  it("同源 GET、query 帶 socketId；有 previousSocketId 時一併帶上；帶逾時 signal", async () => {
    const fn = stubFetch(() => Response.json({ status: "waiting", jobId: JOB, rebound: true }));
    await getDiagnosis(JOB, SOCKET);
    const [url1, init1] = fn.mock.calls[0]!;
    expect(url1).toBe(`/diagnoses/${JOB}?socketId=${SOCKET}`);
    expect(init1?.method).toBe("GET");
    expect(init1?.signal).toBeInstanceOf(AbortSignal);

    await getDiagnosis(JOB, SOCKET, PREV_SOCKET);
    const url2 = new URL(fn.mock.calls[1]![0], "http://localhost");
    expect(url2.pathname).toBe(`/diagnoses/${JOB}`);
    expect(url2.searchParams.get("socketId")).toBe(SOCKET);
    expect(url2.searchParams.get("previousSocketId")).toBe(PREV_SOCKET);
  });

  it("逾時沿用 POST 的上限（AbortSignal.timeout(DIAGNOSE_REQUEST_TIMEOUT_MS)）", async () => {
    const spy = vi.spyOn(AbortSignal, "timeout");
    stubFetch(() => Response.json({ status: "waiting", jobId: JOB, rebound: true }));
    await getDiagnosis(JOB, SOCKET);
    expect(spy).toHaveBeenCalledWith(DIAGNOSE_REQUEST_TIMEOUT_MS);
    spy.mockRestore();
  });

  it.each([
    ["completed", { status: "completed", jobId: JOB, result: RESULT, cached: false }],
    ["failed", { status: "failed", jobId: JOB, error: "persist_failed: diagnosis record could not be written" }],
    ["waiting", { status: "waiting", jobId: JOB, rebound: true }],
    ["active", { status: "active", jobId: JOB, progress: 60, attempt: 1, execution: 2, rebound: true }],
  ])("200 %s → 回傳通過 schema 的回應", async (_name, body) => {
    stubFetch(() => Response.json(body));
    await expect(getDiagnosis(JOB, SOCKET)).resolves.toEqual(body);
  });

  it("200 但 jobId 與查詢的不一致 → invalid（proxy 錯路由不把別人的結果當成這筆）", async () => {
    stubFetch(() => Response.json({ status: "completed", jobId: OTHER_JOB, result: RESULT, cached: true }));
    const err = await lookupError(getDiagnosis(JOB, SOCKET));
    expect(err).toMatchObject({ kind: "invalid", status: undefined, code: undefined });
  });

  it("200 但格式不符（result 缺欄位、未知 status、非 JSON）→ invalid", async () => {
    stubFetch(() => Response.json({ status: "completed", jobId: JOB, result: { summary: "s" }, cached: false }));
    expect((await lookupError(getDiagnosis(JOB, SOCKET))).kind).toBe("invalid");
    stubFetch(() => Response.json({ status: "delayed", jobId: JOB }));
    expect((await lookupError(getDiagnosis(JOB, SOCKET))).kind).toBe("invalid");
    stubFetch(() => new Response("<html>ok</html>", { status: 200 }));
    expect((await lookupError(getDiagnosis(JOB, SOCKET))).kind).toBe("invalid");
  });

  it("404 → http 404，無 code", async () => {
    stubFetch(() => Response.json({ statusCode: 404, message: "查無此診斷（可能已過期）" }, { status: 404 }));
    expect(await lookupError(getDiagnosis(JOB, SOCKET))).toMatchObject({ kind: "http", status: 404, code: undefined });
  });

  it.each(["socket_unauthorized", "job_bound_elsewhere"] as const)("409 code=%s → http 409 帶 code", async (code) => {
    stubFetch(() => Response.json({ statusCode: 409, error: "Conflict", code, message: "x" }, { status: 409 }));
    expect(await lookupError(getDiagnosis(JOB, SOCKET))).toMatchObject({ kind: "http", status: 409, code });
  });

  it("409 但 body 無 code、code 為未知值或非 JSON → http 409，code undefined", async () => {
    stubFetch(() => Response.json({ statusCode: 409, message: "x" }, { status: 409 }));
    expect(await lookupError(getDiagnosis(JOB, SOCKET))).toMatchObject({ status: 409, code: undefined });
    stubFetch(() => Response.json({ statusCode: 409, code: "something_else" }, { status: 409 }));
    expect(await lookupError(getDiagnosis(JOB, SOCKET))).toMatchObject({ status: 409, code: undefined });
    stubFetch(() => new Response("<html>409</html>", { status: 409 }));
    expect(await lookupError(getDiagnosis(JOB, SOCKET))).toMatchObject({ status: 409, code: undefined });
  });

  it.each([
    [400, "Bad Request"],
    [429, "<html>429 Too Many Requests</html>"],
    [503, "Service Unavailable"],
  ])("%i → http 帶狀態碼、無 code", async (status, body) => {
    stubFetch(() => new Response(body, { status }));
    expect(await lookupError(getDiagnosis(JOB, SOCKET))).toMatchObject({ kind: "http", status, code: undefined });
  });

  it("fetch reject（網路錯誤）→ network；逾時（TimeoutError／AbortError）→ timeout", async () => {
    stubFetch(() => Promise.reject(new TypeError("Failed to fetch")));
    expect(await lookupError(getDiagnosis(JOB, SOCKET))).toMatchObject({ kind: "network", status: undefined });
    stubFetch(() => Promise.reject(new DOMException("signal timed out", "TimeoutError")));
    expect((await lookupError(getDiagnosis(JOB, SOCKET))).kind).toBe("timeout");
    stubFetch(() => Promise.reject(new DOMException("aborted", "AbortError")));
    expect((await lookupError(getDiagnosis(JOB, SOCKET))).kind).toBe("timeout");
  });
});
