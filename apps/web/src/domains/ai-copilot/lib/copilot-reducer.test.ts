import { describe, expect, it } from "vitest";
import type { DiagnosisResult } from "@flow-gatekeeper/contracts";
import {
  copilotReducer,
  humanizeError,
  isStaleJobEvent,
  progressLabel,
  startActiveState,
  type CopilotJobState,
} from "./copilot-reducer.js";

const RESULT: DiagnosisResult = {
  summary: "溫度偏高導致節流",
  severity: "warning",
  likelyCauses: ["冷卻不足"],
  suggestedActions: [{ label: "檢查冷卻風扇", priority: "high" }],
  evidence: [{ source: "telemetry", excerpt: "temp 92°C" }],
};

function active(jobId = "job-1", over: Partial<Extract<CopilotJobState, { status: "active" }>> = {}) {
  return { status: "active", machineId: "mixer-01", jobId, progress: null, streamText: "", ...over } as CopilotJobState;
}

describe("copilotReducer — 狀態轉移（data-model 轉移表）", () => {
  it("startActiveState：新 active、progress=null、streamText 空（FR-004）", () => {
    expect(startActiveState("mixer-01", "job-1")).toEqual({
      status: "active",
      machineId: "mixer-01",
      jobId: "job-1",
      progress: null,
      streamText: "",
    });
  });

  it("waiting→active：job/status 更新進度、維持 active（FR-004）", () => {
    const s1 = copilotReducer(active(), {
      type: "job/status",
      jobId: "job-1",
      machineId: "mixer-01",
      status: "active",
      progress: 40,
    });
    expect(s1).toMatchObject({ status: "active", progress: 40 });
  });

  it("job/status 未帶 progress → 維持既值（indeterminate 不被清成 0）", () => {
    const s1 = copilotReducer(active("job-1", { progress: 20 }), {
      type: "job/status",
      jobId: "job-1",
      machineId: "mixer-01",
      status: "active",
    });
    expect(s1).toMatchObject({ status: "active", progress: 20 });
  });

  it("ai/token 依 seq 保序 append 至 streamText（FR-005）", () => {
    let s = active();
    s = copilotReducer(s, { type: "ai/token", jobId: "job-1", seq: 0, text: "診斷" });
    s = copilotReducer(s, { type: "ai/token", jobId: "job-1", seq: 1, text: "推理" });
    s = copilotReducer(s, { type: "ai/token", jobId: "job-1", seq: 2, text: "中" });
    expect(s).toMatchObject({ status: "active", streamText: "診斷推理中" });
  });

  it("ai/done → completed（含 cached:true、保留 streamText）（FR-006/FR-009）", () => {
    const s = copilotReducer(active("job-1", { streamText: "分析…" }), {
      type: "ai/done",
      jobId: "job-1",
      cached: true,
      result: RESULT,
    });
    expect(s).toEqual({
      status: "completed",
      machineId: "mixer-01",
      jobId: "job-1",
      cached: true,
      streamText: "分析…",
      result: RESULT,
    });
  });

  it("ai/error → failed（保留 streamText、可讀訊息經 humanize）（FR-007）", () => {
    const s = copilotReducer(active("job-1", { streamText: "分析…" }), {
      type: "ai/error",
      jobId: "job-1",
      code: "schema_invalid",
      message: "ZodError: invalid_type ...很長的原始堆疊",
    });
    expect(s).toEqual({
      status: "failed",
      machineId: "mixer-01",
      jobId: "job-1",
      streamText: "分析…",
      error: "AI 回傳格式不符，請重試。",
    });
  });

  it("job/status:failed → failed（無 error 用預設可讀訊息）（FR-007）", () => {
    const s = copilotReducer(active(), {
      type: "job/status",
      jobId: "job-1",
      machineId: "mixer-01",
      status: "failed",
    });
    expect(s).toMatchObject({ status: "failed", error: "診斷失敗，請重試。" });
  });

  it("過期 jobId 片段被忽略、不覆蓋當前呈現（FR-011）", () => {
    const s0 = active("job-2", { streamText: "新任務" });
    const stale = copilotReducer(s0, { type: "ai/token", jobId: "job-1", seq: 9, text: "舊殘留" });
    expect(stale).toBe(s0); // 原狀態不變
    const staleDone = copilotReducer(s0, { type: "ai/done", jobId: "job-1", cached: false, result: RESULT });
    expect(staleDone).toBe(s0);
  });

  it("非 active 狀態（idle/completed）不消費事件", () => {
    const idle: CopilotJobState = { status: "idle", machineId: "mixer-01" };
    expect(copilotReducer(idle, { type: "ai/token", jobId: "job-1", seq: 0, text: "x" })).toBe(idle);
    const done: CopilotJobState = {
      status: "completed",
      machineId: "mixer-01",
      jobId: "job-1",
      cached: false,
      streamText: "",
      result: RESULT,
    };
    expect(copilotReducer(done, { type: "ai/token", jobId: "job-1", seq: 1, text: "y" })).toBe(done);
  });
});

describe("isStaleJobEvent（FR-011）", () => {
  it("jobId 相符 → 非過期", () => {
    expect(isStaleJobEvent(active("job-1"), { type: "ai/token", jobId: "job-1", seq: 0, text: "x" })).toBe(false);
  });
  it("jobId 不符 → 過期", () => {
    expect(isStaleJobEvent(active("job-1"), { type: "ai/token", jobId: "job-2", seq: 0, text: "x" })).toBe(true);
  });
  it("idle（無 jobId）→ 任何事件皆過期", () => {
    const idle: CopilotJobState = { status: "idle", machineId: "mixer-01" };
    expect(isStaleJobEvent(idle, { type: "ai/token", jobId: "job-1", seq: 0, text: "x" })).toBe(true);
  });
});

describe("humanizeError（FR-007 可讀訊息，非原始堆疊）", () => {
  it("Gemini 金鑰無效原文 → 友善句", () => {
    const raw = '[GoogleGenerativeAI Error]: [400 Bad Request] API key not valid. Please pass a valid API key. reason:"API_KEY_INVALID"';
    expect(humanizeError(raw, "worker_failed")).toBe(
      "AI 服務金鑰無效或未授權——請確認 apps/worker/.env 的 GEMINI_API_KEY 已填入有效金鑰（範本見 apps/worker/.env.example）。",
    );
  });
  it("空金鑰的 Gemini 403 原文（unregistered callers）→ 金鑰友善句，非網路句（008 T016b 實測）", () => {
    // 008 implement 期實測捕獲的空金鑰供應商回應：不含 api_key_invalid/unauthorized/permission，
    // 且含 "fetching" 會誤命中網路分支——補 "unregistered" 條件後 MUST 命中金鑰條目。
    const raw =
      "[GoogleGenerativeAI Error]: Error fetching from https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse: [403 Forbidden] Method doesn't allow unregistered callers (callers without established identity). Please use API Key or other form of API consumer identity to call this API.";
    expect(humanizeError(raw, "worker_failed")).toBe(
      "AI 服務金鑰無效或未授權——請確認 apps/worker/.env 的 GEMINI_API_KEY 已填入有效金鑰（範本見 apps/worker/.env.example）。",
    );
  });
  it("速率限制（429/quota）→ 友善句", () => {
    expect(humanizeError("Error: [429] RESOURCE_EXHAUSTED quota exceeded")).toBe("AI 服務暫時繁忙（速率限制），請稍後重試。");
  });
  it("逾時 → 友善句", () => {
    expect(humanizeError("request timed out after 30000ms")).toBe("AI 診斷逾時，請重試。");
  });
  it("連線錯誤 → 友善句", () => {
    expect(humanizeError("ECONNREFUSED fetch failed")).toBe("無法連線 AI 服務，請稍後重試。");
  });
  it("schema code → 友善句（不論原文多長）", () => {
    expect(humanizeError("ZodError: ...\n at parse", "schema_invalid")).toBe("AI 回傳格式不符，請重試。");
  });
  it("未知短訊息 → 沿用原文", () => {
    expect(humanizeError("Worker crashed unexpectedly")).toBe("Worker crashed unexpectedly");
  });
  it("未知長／多行堆疊 → 通用句", () => {
    expect(humanizeError("Error x\n".repeat(30))).toBe("診斷失敗，請重試。");
    expect(humanizeError(undefined)).toBe("診斷失敗，請重試。");
  });
});

describe("progressLabel（FR-004）", () => {
  it("null → indeterminate 描述", () => {
    expect(progressLabel(null)).toBe("處理中…");
  });
  it("數值 → N%", () => {
    expect(progressLabel(0)).toBe("0%");
    expect(progressLabel(60)).toBe("60%");
    expect(progressLabel(100)).toBe("100%");
  });
});
