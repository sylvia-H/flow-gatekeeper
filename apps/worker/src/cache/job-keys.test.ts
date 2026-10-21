import { describe, expect, it } from "vitest";
import {
  AI_FAIL_TTL_SECONDS,
  AI_METRIC_TTL_SECONDS,
  AI_RESULT_TTL_SECONDS,
  aiFailKey,
  aiMetricKey,
  aiResultKey,
} from "./job-keys.js";

/** processor 內既有的前綴（`processor.ts` 組字串）。 */
const EXISTING_PREFIXES = ["ai-cache:", "ai-lock:", "ai-rpm:"];

describe("012 Redis 鍵（data-model §3）", () => {
  it("鍵格式：ai-result:<jobId>、ai-metric:<jobId>、ai-fail:<sig>", () => {
    expect(aiResultKey("j-1")).toBe("ai-result:j-1");
    expect(aiMetricKey("j-1")).toBe("ai-metric:j-1");
    expect(aiFailKey("abc123")).toBe("ai-fail:abc123");
  });

  it("TTL：ai-result 3600 s、ai-metric 86400 s、ai-fail 10 s", () => {
    expect(AI_RESULT_TTL_SECONDS).toBe(3600);
    expect(AI_METRIC_TTL_SECONDS).toBe(86_400);
    expect(AI_FAIL_TTL_SECONDS).toBe(10);
  });

  it("新前綴彼此不同，且與既有 ai-cache:／ai-lock:／ai-rpm: 互不為前綴", () => {
    const id = "same-id";
    const fresh = [aiResultKey(id), aiMetricKey(id), aiFailKey(id)];
    expect(new Set(fresh).size).toBe(3);
    for (const key of fresh) {
      const freshPrefix = key.slice(0, key.indexOf(":") + 1);
      for (const existing of EXISTING_PREFIXES) {
        expect(freshPrefix.startsWith(existing)).toBe(false);
        expect(existing.startsWith(freshPrefix)).toBe(false);
      }
    }
  });
});
