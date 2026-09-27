import { describe, expect, it, vi } from "vitest";

// 只替換 fatal()：斷言 entry 的 bootstrap 失敗路徑走同步 writeSync 的致命機制（不真的 exit）。
const fatalMock = vi.hoisted(() => vi.fn());
vi.mock("./lib/fatal.js", () => ({ fatal: fatalMock }));

/**
 * FR-014：entry-module smoke 測試——斷言 worker entry 能乾淨 import。
 */
describe("apps/worker entry", () => {
  // import 會 transform 整個依賴圖（bullmq/mongodb/gemini SDK），本機基線即 4–6s，
  // 高於 vitest 預設 5s——給足額度，避免機器負載造成的邊界性 flake。
  it("entry module 能乾淨 import 且匯出 bootstrap", { timeout: 20_000 }, async () => {
    const mod = await import("./main.js");
    expect(typeof mod.bootstrap).toBe("function");
    // 被 import 時不得自行 bootstrap（side-effect-free），也就不會觸發任何致命路徑。
    expect(fatalMock).not.toHaveBeenCalled();
  });

  it("createAiProvider：env 的 GEMINI_MODEL／AI_MAX_OUTPUT_TOKENS／AI_TEMPERATURE 接到 provider", { timeout: 20_000 }, async () => {
    const mod = await import("./main.js");
    const { parseWorkerEnv } = await import("./lib/env-schema.js");
    const parsed = parseWorkerEnv({ GEMINI_MODEL: "gemini-2.5-flash-lite", AI_MAX_OUTPUT_TOKENS: "777", AI_TEMPERATURE: "1.3" });
    if (!parsed.ok) throw new Error(parsed.error);
    const ai = mod.createAiProvider(parsed.env);
    expect(ai.model).toBe("gemini-2.5-flash-lite");
    expect(ai.generation).toEqual({ maxOutputTokens: 777, temperature: 1.3 });
  });

  it("bootstrap 失敗：交給 fatal('bootstrap', err)（同步 writeSync 後 exit 1，與 api fatalExit 對齊）", { timeout: 20_000 }, async () => {
    const mod = await import("./main.js");
    const err = new Error("Redis 連線於 10000ms 內未就緒");
    mod.handleBootstrapFailure(err);
    expect(fatalMock).toHaveBeenCalledWith("bootstrap", err);
  });
});
