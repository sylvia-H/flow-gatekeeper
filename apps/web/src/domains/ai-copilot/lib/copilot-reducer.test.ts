import { describe, expect, it } from "vitest";
import type { DiagnosisResult, JobStatus } from "@flow-gatekeeper/contracts";
import {
  STREAM_LABEL_INCOMPLETE,
  UNDELIVERED_ERROR,
  copilotReducer,
  humanizeError,
  isStaleJobEvent,
  isUndeliveredFailure,
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
  return { status: "active", machineId: "mixer-01", jobId, attempt: 1, lastSeq: -1, progress: null, streamText: "", ...over } as CopilotJobState;
}

describe("copilotReducer — 狀態轉移（data-model 轉移表）", () => {
  it("startActiveState：新 active、progress=null、streamText 空、尚無 token（lastSeq -1）（FR-004）", () => {
    expect(startActiveState("mixer-01", "job-1")).toEqual({
      status: "active",
      machineId: "mixer-01",
      jobId: "job-1",
      attempt: 1,
      lastSeq: -1,
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
    s = copilotReducer(s, { type: "ai/token", jobId: "job-1", attempt: 1, seq: 0, text: "診斷" });
    s = copilotReducer(s, { type: "ai/token", jobId: "job-1", attempt: 1, seq: 1, text: "推理" });
    s = copilotReducer(s, { type: "ai/token", jobId: "job-1", attempt: 1, seq: 2, text: "中" });
    expect(s).toMatchObject({ status: "active", streamText: "診斷推理中" });
  });

  it("attempt 換輪：先清空上一輪 streamText 再接新 token（重試不再疊加）", () => {
    let s = active();
    s = copilotReducer(s, { type: "ai/token", jobId: "job-1", attempt: 1, seq: 0, text: "第一輪" });
    s = copilotReducer(s, { type: "ai/token", jobId: "job-1", attempt: 1, seq: 1, text: "半截" });
    s = copilotReducer(s, { type: "ai/token", jobId: "job-1", attempt: 2, seq: 0, text: "第二輪" });
    s = copilotReducer(s, { type: "ai/token", jobId: "job-1", attempt: 2, seq: 1, text: "完整" });
    expect(s).toMatchObject({ status: "active", attempt: 2, streamText: "第二輪完整" });
  });

  it("stalled 重派（attempt 不變、seq 從 0 重播）：丟掉前一次的半截文字，不拼接", () => {
    let s = active("job-1");
    s = copilotReducer(s, { type: "ai/token", jobId: "job-1", attempt: 1, seq: 0, text: "崩潰前" });
    s = copilotReducer(s, { type: "ai/token", jobId: "job-1", attempt: 1, seq: 1, text: "半截" });
    s = copilotReducer(s, { type: "ai/token", jobId: "job-1", attempt: 1, seq: 0, text: "重跑" });
    s = copilotReducer(s, { type: "ai/token", jobId: "job-1", attempt: 1, seq: 1, text: "完整" });
    expect(s).toMatchObject({ status: "active", attempt: 1, streamText: "重跑完整" });
  });

  it("同一輪 seq 回頭（<= lastSeq）即視為新的一次執行：重播的 seq 0 遺失也不拼接（AR-S8）", () => {
    let s = active("job-1");
    s = copilotReducer(s, { type: "ai/token", jobId: "job-1", attempt: 1, seq: 0, text: "崩潰前" });
    s = copilotReducer(s, { type: "ai/token", jobId: "job-1", attempt: 1, seq: 1, text: "半截" });
    s = copilotReducer(s, { type: "ai/token", jobId: "job-1", attempt: 1, seq: 2, text: "再半截" });
    expect(s).toMatchObject({ lastSeq: 2 });
    // 重播的 seq 0 在 Pub/Sub 上遺失，第一個到的是 seq 1
    s = copilotReducer(s, { type: "ai/token", jobId: "job-1", attempt: 1, seq: 1, text: "重跑" });
    expect(s).toMatchObject({ streamText: "重跑", lastSeq: 1 });
    s = copilotReducer(s, { type: "ai/token", jobId: "job-1", attempt: 1, seq: 2, text: "完整" });
    expect(s).toMatchObject({ status: "active", attempt: 1, streamText: "重跑完整", lastSeq: 2 });
  });

  it("seq 跳號但仍遞增（中間 token 遺失）：照常 append，不誤判為新執行", () => {
    let s = active("job-1");
    s = copilotReducer(s, { type: "ai/token", jobId: "job-1", attempt: 1, seq: 0, text: "前" });
    s = copilotReducer(s, { type: "ai/token", jobId: "job-1", attempt: 1, seq: 3, text: "後" });
    expect(s).toMatchObject({ streamText: "前後", lastSeq: 3 });
  });

  it("換輪時 lastSeq 跟著新一輪重算：新一輪的 seq 0、1 正常接續", () => {
    let s = active("job-1");
    s = copilotReducer(s, { type: "ai/token", jobId: "job-1", attempt: 1, seq: 0, text: "a" });
    s = copilotReducer(s, { type: "ai/token", jobId: "job-1", attempt: 1, seq: 7, text: "b" });
    s = copilotReducer(s, { type: "ai/token", jobId: "job-1", attempt: 2, seq: 0, text: "新" });
    expect(s).toMatchObject({ attempt: 2, lastSeq: 0, streamText: "新" });
    s = copilotReducer(s, { type: "ai/token", jobId: "job-1", attempt: 2, seq: 1, text: "輪" });
    expect(s).toMatchObject({ attempt: 2, lastSeq: 1, streamText: "新輪" });
  });

  it("第 1 輪 token → 第 2 輪直接 done：completed 不保留舊輪文字", () => {
    let s = active();
    s = copilotReducer(s, { type: "ai/token", jobId: "job-1", attempt: 1, seq: 0, text: "舊輪半截" });
    s = copilotReducer(s, { type: "ai/done", jobId: "job-1", attempt: 2, cached: true, result: RESULT });
    expect(s).toMatchObject({ status: "completed", streamText: "" });
  });

  it("第 1 輪 token → 第 2 輪直接 error：failed 不保留舊輪文字；同輪則保留", () => {
    const s1 = copilotReducer(active("job-1", { streamText: "舊輪" }), {
      type: "ai/error", jobId: "job-1", attempt: 2, code: "worker_failed", message: "x",
    });
    expect(s1).toMatchObject({ status: "failed", streamText: "" });
    const s2 = copilotReducer(active("job-1", { streamText: "同輪" }), {
      type: "ai/error", jobId: "job-1", attempt: 1, code: "worker_failed", message: "x",
    });
    expect(s2).toMatchObject({ status: "failed", streamText: "同輪" });
  });

  it("舊輪遲到的 token 被丟棄，不混進新一輪", () => {
    const s0 = active("job-1", { attempt: 2, streamText: "第二輪" });
    const s1 = copilotReducer(s0, { type: "ai/token", jobId: "job-1", attempt: 1, seq: 5, text: "舊" });
    expect(s1).toBe(s0);
  });

  it("早到事件：pending（剛建立、尚無進度）狀態即可消費 job/status 與 ai/done", () => {
    let s = startActiveState("mixer-01", "job-1");
    s = copilotReducer(s, { type: "job/status", jobId: "job-1", machineId: "mixer-01", status: "waiting" });
    expect(s).toMatchObject({ status: "active", progress: null });
    s = copilotReducer(s, { type: "ai/done", jobId: "job-1", attempt: 1, cached: true, result: RESULT });
    expect(s).toMatchObject({ status: "completed", cached: true });
  });

  it("ai/done → completed（含 cached:true、保留 streamText）（FR-006/FR-009）", () => {
    const s = copilotReducer(active("job-1", { streamText: "分析…" }), {
      type: "ai/done",
      jobId: "job-1",
      attempt: 1,
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
      source: "ai/done",
      streamIncomplete: false,
    });
  });

  it("ai/error → failed（保留 streamText、可讀訊息經 humanize）（FR-007）", () => {
    const s = copilotReducer(active("job-1", { streamText: "分析…" }), {
      type: "ai/error",
      jobId: "job-1",
      attempt: 1,
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
    const stale = copilotReducer(s0, { type: "ai/token", jobId: "job-1", attempt: 1, seq: 9, text: "舊殘留" });
    expect(stale).toBe(s0); // 原狀態不變
    const staleDone = copilotReducer(s0, { type: "ai/done", jobId: "job-1", attempt: 1, cached: false, result: RESULT });
    expect(staleDone).toBe(s0);
  });

  it("非 active 狀態（idle/completed）不消費事件", () => {
    const idle: CopilotJobState = { status: "idle", machineId: "mixer-01" };
    expect(copilotReducer(idle, { type: "ai/token", jobId: "job-1", attempt: 1, seq: 0, text: "x" })).toBe(idle);
    const done: CopilotJobState = {
      status: "completed",
      machineId: "mixer-01",
      jobId: "job-1",
      cached: false,
      streamText: "",
      result: RESULT,
      source: "ai/done",
      streamIncomplete: false,
    };
    expect(copilotReducer(done, { type: "ai/token", jobId: "job-1", attempt: 1, seq: 1, text: "y" })).toBe(done);
  });
});

describe("copilotReducer — 結果未送達失敗的保險（AR-6）", () => {
  const undelivered: CopilotJobState = {
    status: "failed",
    machineId: "mixer-01",
    jobId: "job-1",
    streamText: "推理過程",
    error: UNDELIVERED_ERROR,
    reason: "undelivered",
    attempt: 1,
  };

  it("文案固定為使用者裁決那一句", () => {
    expect(UNDELIVERED_ERROR).toBe("診斷已在後端完成，但結果未送達畫面，請重試");
  });

  it("isUndeliveredFailure 只認帶 reason 的失敗", () => {
    expect(isUndeliveredFailure(undelivered)).toBe(true);
    expect(isUndeliveredFailure({ status: "failed", machineId: "mixer-01", jobId: "job-1", streamText: "", error: "x" })).toBe(false);
    expect(isUndeliveredFailure(active())).toBe(false);
  });

  it("同 jobId 遲到的 ai/done → 改回 completed（保留串流文字、帶 cached）", () => {
    const s = copilotReducer(undelivered, { type: "ai/done", jobId: "job-1", attempt: 1, cached: true, result: RESULT });
    expect(s).toEqual({
      status: "completed",
      machineId: "mixer-01",
      jobId: "job-1",
      cached: true,
      streamText: "推理過程",
      result: RESULT,
      source: "ai/done",
      streamIncomplete: false,
    });
  });

  it("遲到的 ai/done 來自更新一輪（重試那輪命中快取）→ 救回但不保留舊輪文字", () => {
    const s = copilotReducer(undelivered, { type: "ai/done", jobId: "job-1", attempt: 2, cached: true, result: RESULT });
    expect(s).toMatchObject({ status: "completed", cached: true, streamText: "" });
  });

  it("其他 jobId 的 ai/done、或同 jobId 的其他事件 → 原樣忽略", () => {
    expect(copilotReducer(undelivered, { type: "ai/done", jobId: "job-2", attempt: 1, cached: false, result: RESULT })).toBe(undelivered);
    expect(copilotReducer(undelivered, { type: "ai/token", jobId: "job-1", attempt: 1, seq: 9, text: "x" })).toBe(undelivered);
    expect(
      copilotReducer(undelivered, { type: "ai/error", jobId: "job-1", attempt: 1, code: "worker_failed", message: "x" }),
    ).toBe(undelivered);
    expect(
      copilotReducer(undelivered, { type: "job/status", jobId: "job-1", machineId: "mixer-01", status: "completed", progress: 100 }),
    ).toBe(undelivered);
  });

  it("其他原因的 failed 收到同 jobId 遲到的 ai/done 仍忽略", () => {
    const failed: CopilotJobState = {
      status: "failed",
      machineId: "mixer-01",
      jobId: "job-1",
      streamText: "",
      error: "診斷逾時或無回應，請重試",
    };
    expect(copilotReducer(failed, { type: "ai/done", jobId: "job-1", attempt: 1, cached: false, result: RESULT })).toBe(failed);
  });
});

describe("copilotReducer — 三來源先到者為準（012 FR-004、FR-005、FR-038、SC-006）", () => {
  const OTHER_RESULT: DiagnosisResult = { ...RESULT, summary: "另一份結果" };

  function statusCompleted(over: Partial<JobStatus> = {}): JobStatus {
    return { type: "job/status", jobId: "job-1", machineId: "mixer-01", status: "completed", progress: 100, result: RESULT, cached: true, ...over };
  }
  function done(over: { cached?: boolean; result?: DiagnosisResult; attempt?: number; jobId?: string } = {}) {
    return { type: "ai/done", jobId: "job-1", attempt: 1, cached: true, result: RESULT, ...over } as const;
  }
  /** 收斂判準（SC-006）：result、cached、jobId 相同。 */
  function converged(s: CopilotJobState) {
    expect(s.status).toBe("completed");
    if (s.status !== "completed") return;
    return { jobId: s.jobId, result: s.result, cached: s.cached };
  }

  it("文案常數：完成態不完整串流的標題", () => {
    expect(STREAM_LABEL_INCOMPLETE).toBe("原始串流（不完整）");
  });

  it("job/status completed 帶 result → completed（source status、streamIncomplete、保留串流文字）", () => {
    const s = copilotReducer(active("job-1", { streamText: "推理" }), statusCompleted());
    expect(s).toEqual({
      status: "completed",
      machineId: "mixer-01",
      jobId: "job-1",
      cached: true,
      streamText: "推理",
      result: RESULT,
      source: "status",
      streamIncomplete: true,
    });
  });

  it("job/status completed 帶 result 但缺 cached → 當 false（research P8）", () => {
    const s = copilotReducer(active(), statusCompleted({ cached: undefined }));
    expect(s).toMatchObject({ status: "completed", cached: false, source: "status" });
  });

  it("job/status completed 不帶 result → 維持 active（交給 store 的 2 s 寬限），僅更新進度", () => {
    const s = copilotReducer(active("job-1", { progress: 80 }), statusCompleted({ result: undefined, cached: undefined }));
    expect(s).toMatchObject({ status: "active", progress: 100 });
  });

  it("job/status completed 帶 result 且來自更新一輪 → 不保留舊輪文字；未帶 attempt 視為同輪", () => {
    const base = active("job-1", { streamText: "第一輪半截" });
    expect(copilotReducer(base, statusCompleted({ attempt: 2 }))).toMatchObject({ status: "completed", streamText: "" });
    expect(copilotReducer(base, statusCompleted({ attempt: 1 }))).toMatchObject({ streamText: "第一輪半截" });
    expect(copilotReducer(base, statusCompleted())).toMatchObject({ streamText: "第一輪半截" });
  });

  it("ai/done 收尾 → source ai/done、streamIncomplete false（尚無重連旗標）", () => {
    expect(copilotReducer(active(), done())).toMatchObject({ source: "ai/done", streamIncomplete: false });
  });

  it("順序 1：ai/done → completed+result：先到的 ai/done 為準，後到的 completed 原樣忽略", () => {
    const first = copilotReducer(active(), done());
    const second = copilotReducer(first, statusCompleted({ result: OTHER_RESULT, cached: false }));
    expect(second).toBe(first);
    expect(converged(second)).toEqual({ jobId: "job-1", result: RESULT, cached: true });
  });

  it("順序 2：completed+result → ai/done：先到的 completed 為準，後到的 ai/done 原樣忽略", () => {
    const first = copilotReducer(active(), statusCompleted());
    const second = copilotReducer(first, done({ result: OTHER_RESULT, cached: false }));
    expect(second).toBe(first);
    expect(converged(second)).toEqual({ jobId: "job-1", result: RESULT, cached: true });
  });

  it("順序 3：ai/done 重複兩次：第二則原樣忽略", () => {
    const first = copilotReducer(active(), done());
    expect(copilotReducer(first, done())).toBe(first);
  });

  it("三種順序收斂到相同的 result／cached／jobId（SC-006；第四種「無 result → GET」於 T039 補）", () => {
    const a = copilotReducer(copilotReducer(active(), done()), statusCompleted());
    const b = copilotReducer(copilotReducer(active(), statusCompleted()), done());
    const c = copilotReducer(copilotReducer(active(), done()), done());
    expect(converged(a)).toEqual(converged(b));
    expect(converged(b)).toEqual(converged(c));
  });

  it("completed 之後的 job/status（含 failed）與 ai/error 都不覆蓋", () => {
    const first = copilotReducer(active(), statusCompleted());
    expect(copilotReducer(first, { type: "job/status", jobId: "job-1", machineId: "mixer-01", status: "failed", error: "x" })).toBe(first);
    expect(copilotReducer(first, { type: "ai/error", jobId: "job-1", attempt: 1, code: "worker_failed", message: "x" })).toBe(first);
  });

  it("過期 jobId 的 completed+result 被忽略", () => {
    const s0 = active("job-2");
    expect(copilotReducer(s0, statusCompleted())).toBe(s0);
  });

  describe("救回規則：只有「結果未送達」可救回（FR-005、代理裁決第 15 條）", () => {
    const undelivered: CopilotJobState = {
      status: "failed",
      machineId: "mixer-01",
      jobId: "job-1",
      streamText: "推理過程",
      error: UNDELIVERED_ERROR,
      reason: "undelivered",
      attempt: 1,
    };

    it("未送達 → 遲到的 completed+result 救回（source status、streamIncomplete true）", () => {
      expect(copilotReducer(undelivered, statusCompleted({ cached: undefined }))).toEqual({
        status: "completed",
        machineId: "mixer-01",
        jobId: "job-1",
        cached: false,
        streamText: "推理過程",
        result: RESULT,
        source: "status",
        streamIncomplete: true,
      });
    });

    it("未送達 → completed+result 救回後，再到的 ai/done 被忽略（只收斂一次）", () => {
      const rescued = copilotReducer(undelivered, statusCompleted());
      expect(copilotReducer(rescued, done({ cached: false }))).toBe(rescued);
    });

    it("未送達 → 遲到的 completed+result 來自更新一輪 → 救回但不保留舊輪文字", () => {
      expect(copilotReducer(undelivered, statusCompleted({ attempt: 2 }))).toMatchObject({ status: "completed", streamText: "" });
    });

    it("ai/error 失敗：之後到的 ai/done 與 completed+result 都不救回", () => {
      const failed = copilotReducer(active(), { type: "ai/error", jobId: "job-1", attempt: 1, code: "provider_error", message: "boom" });
      expect(failed.status).toBe("failed");
      expect(copilotReducer(failed, done())).toBe(failed);
      expect(copilotReducer(failed, statusCompleted())).toBe(failed);
    });

    it("job/status failed 失敗：之後到的 ai/done 與 completed+result 都不救回", () => {
      const failed = copilotReducer(active(), { type: "job/status", jobId: "job-1", machineId: "mixer-01", status: "failed", error: "boom" });
      expect(failed.status).toBe("failed");
      expect(copilotReducer(failed, done())).toBe(failed);
      expect(copilotReducer(failed, statusCompleted())).toBe(failed);
    });
  });
});

describe("isStaleJobEvent（FR-011）", () => {
  it("jobId 相符 → 非過期", () => {
    expect(isStaleJobEvent(active("job-1"), { type: "ai/token", jobId: "job-1", attempt: 1, seq: 0, text: "x" })).toBe(false);
  });
  it("jobId 不符 → 過期", () => {
    expect(isStaleJobEvent(active("job-1"), { type: "ai/token", jobId: "job-2", attempt: 1, seq: 0, text: "x" })).toBe(true);
  });
  it("idle（無 jobId）→ 任何事件皆過期", () => {
    const idle: CopilotJobState = { status: "idle", machineId: "mixer-01" };
    expect(isStaleJobEvent(idle, { type: "ai/token", jobId: "job-1", attempt: 1, seq: 0, text: "x" })).toBe(true);
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
