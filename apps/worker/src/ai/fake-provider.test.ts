import { afterEach, describe, expect, it, vi } from "vitest";
import { DiagnosisResultSchema } from "@flow-gatekeeper/contracts";
import { parseResult } from "../lib/parse-result.js";
import { FAKE_MODEL, FakeAiProvider, fakeDiagnosis, splitIntoChunks } from "./fake-provider.js";
import { AiProviderError } from "./provider.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("splitIntoChunks", () => {
  it("切成指定段數、接回等於原字串", () => {
    const chunks = splitIntoChunks("abcdefghij", 3);
    expect(chunks).toHaveLength(3);
    expect(chunks.join("")).toBe("abcdefghij");
    expect(chunks.every((c) => c.length > 0)).toBe(true);
  });

  it("段數超過字元數 → 以字元數為上限；段數 < 1 → 1 段", () => {
    expect(splitIntoChunks("abc", 10)).toEqual(["a", "b", "c"]);
    expect(splitIntoChunks("abc", 0)).toEqual(["abc"]);
  });
});

describe("FakeAiProvider", () => {
  it("固定假診斷通過 DiagnosisResultSchema（硬規則 6）", () => {
    expect(DiagnosisResultSchema.safeParse(fakeDiagnosis()).success).toBe(true);
  });

  it("id／model 與 gemini 不同（cache signature 不互相命中）", () => {
    const p = new FakeAiProvider({ tokenDelayMs: 0, tokenCount: 5 });
    expect(p.id).toBe("fake");
    expect(p.model).toBe(FAKE_MODEL);
  });

  it("依 tokenCount 逐段送出，接回的文字能被 parseResult 驗證通過", async () => {
    const tokens: string[] = [];
    const p = new FakeAiProvider({ tokenDelayMs: 0, tokenCount: 20 });
    const out = await p.streamDiagnosis({
      prompt: "ignored",
      signal: new AbortController().signal,
      onToken: (t) => tokens.push(t),
    });
    expect(tokens).toHaveLength(20);
    expect(out.usage?.outputTokens).toBe(20); // 假 token 數＝段數
    expect(tokens.join("")).toBe(out.text);
    expect(out.finishReason).toBe("stop");
    expect(parseResult(out.text)).toEqual(fakeDiagnosis());
  });

  it("段與段之間套用延遲（N 段共 N-1 次延遲）", async () => {
    vi.useFakeTimers();
    const tokens: string[] = [];
    const p = new FakeAiProvider({ tokenDelayMs: 500, tokenCount: 4 });
    const done = p.streamDiagnosis({
      prompt: "",
      signal: new AbortController().signal,
      onToken: (t) => tokens.push(t),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(tokens).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(tokens).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1000);
    await done;
    expect(tokens).toHaveLength(4);
  });

  it("abort 後立即以可重試的 AiProviderError 結束，且不再送 token", async () => {
    vi.useFakeTimers();
    const tokens: string[] = [];
    const ac = new AbortController();
    const p = new FakeAiProvider({ tokenDelayMs: 1000, tokenCount: 10 });
    const done = p.streamDiagnosis({ prompt: "", signal: ac.signal, onToken: (t) => tokens.push(t) });
    const settled = done.then(
      () => null,
      (e: unknown) => e,
    );
    await vi.advanceTimersByTimeAsync(1500);
    ac.abort(new Error("timeout"));
    const err = await settled;
    expect(err).toBeInstanceOf(AiProviderError);
    expect(err instanceof AiProviderError && err.retryable).toBe(true);
    const sent = tokens.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(tokens).toHaveLength(sent);
    expect(sent).toBe(2);
  });
});
