import { ApiError } from "@google/genai";
import { describe, expect, it, vi } from "vitest";
import { classifyGeminiError, GeminiProvider, MISSING_API_KEY_MESSAGE, thinkingConfigFor } from "./gemini-provider.js";
import { AiProviderError } from "./provider.js";

describe("thinkingConfigFor", () => {
  it.each(["gemini-2.5-flash", "gemini-2.5-flash-lite", "models/gemini-2.5-flash", "gemini-2.5-flash-preview-09-2025"])(
    "%s → 關閉 thinking",
    (m) => {
      expect(thinkingConfigFor(m)).toEqual({ thinkingBudget: 0 });
    },
  );

  it.each(["gemini-2.5-pro", "gemini-2.0-flash", "gemini-3-pro-preview", "gemini-2.5-flashy"])("%s → 不送", (m) => {
    expect(thinkingConfigFor(m)).toBeUndefined();
  });
});

describe("classifyGeminiError", () => {
  it.each([400, 401, 403, 404])("HTTP %i → 不可重試", (status) => {
    const e = classifyGeminiError(new ApiError({ message: "API key not valid", status }));
    expect(e.retryable).toBe(false);
    expect(e.status).toBe(status);
    expect(e.message).toContain("API key not valid"); // 原文保留給前端 humanizeError
  });

  it.each([429, 500, 503])("HTTP %i → 可重試", (status) => {
    expect(classifyGeminiError(new ApiError({ message: "x", status })).retryable).toBe(true);
  });

  it("signal 已中止 → ai_timeout、可重試", () => {
    const ac = new AbortController();
    ac.abort();
    const e = classifyGeminiError(new Error("This operation was aborted"), ac.signal);
    expect(e.code).toBe("ai_timeout");
    expect(e.retryable).toBe(true);
    expect(e.message.toLowerCase()).toContain("timeout");
  });

  it("未知錯誤 → 可重試", () => {
    expect(classifyGeminiError(new Error("ECONNRESET")).retryable).toBe(true);
  });
});

describe("GeminiProvider 缺金鑰", () => {
  it("空金鑰：不建 SDK client、直接丟不可重試的 AiProviderError（含前端可比對的關鍵字）", async () => {
    const provider = new GeminiProvider("", "gemini-2.5-flash");
    const onToken = vi.fn();
    const err = await provider
      .streamDiagnosis({ prompt: "p", signal: new AbortController().signal, onToken })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiProviderError);
    expect(err).toMatchObject({ retryable: false, code: "provider_error", message: MISSING_API_KEY_MESSAGE });
    expect(MISSING_API_KEY_MESSAGE.toLowerCase()).toContain("api key not valid");
    expect(onToken).not.toHaveBeenCalled();
  });
});
