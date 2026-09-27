import { afterEach, describe, expect, it, vi } from "vitest";
import { DiagnoseRequestError, messageForStatus, postDiagnose } from "./diagnose-api.js";

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
