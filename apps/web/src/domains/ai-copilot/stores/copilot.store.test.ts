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

/** 以指定 jobId 模擬 POST /diagnoses 成功回應。 */
function mockDiagnoseOk(jobId: string): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify({ jobId, machineId: "mixer-01", status: "waiting" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ),
  );
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
    mockDiagnoseOk("job-1");
    const store = useCopilotStore();
    expect(store.canDiagnose(null, true)).toBe(false);
    expect(store.canDiagnose("mixer-01", false)).toBe(false);
    expect(store.canDiagnose("mixer-01", true)).toBe(true);

    await store.diagnose("mixer-01", "sock-1");
    expect(store.stateFor("mixer-01").status).toBe("active");
    expect(store.canDiagnose("mixer-01", true)).toBe(false); // active 去重
  });

  it("diagnose：以回傳 jobId 立即建 active（SC-001）", async () => {
    mockDiagnoseOk("job-42");
    const store = useCopilotStore();
    await store.diagnose("mixer-01", "sock-1");
    expect(store.stateFor("mixer-01")).toEqual({
      status: "active",
      machineId: "mixer-01",
      jobId: "job-42",
      progress: null,
      streamText: "",
    });
  });

  it("diagnose 期間再送出被去重，不建第二任務（FR-008）", async () => {
    mockDiagnoseOk("job-1");
    const store = useCopilotStore();
    await store.diagnose("mixer-01", "sock-1");
    const before = store.stateFor("mixer-01");
    await store.diagnose("mixer-01", "sock-1"); // active → 去重
    expect(store.stateFor("mixer-01")).toBe(before);
  });

  it("diagnose 失敗（HTTP 500）→ 該台 failed 附可讀訊息", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    const store = useCopilotStore();
    await store.diagnose("mixer-01", "sock-1");
    const s = store.stateFor("mixer-01");
    expect(s.status).toBe("failed");
    if (s.status === "failed") expect(s.error).toContain("500");
  });

  it("applyEvent 委派 reducer：ai/done → completed（依 jobId 反查該台）", async () => {
    mockDiagnoseOk("job-1");
    const store = useCopilotStore();
    await store.diagnose("mixer-01", "sock-1");
    store.applyEvent({ type: "ai/done", jobId: "job-1", cached: true, result: RESULT });
    const s = store.stateFor("mixer-01");
    expect(s.status).toBe("completed");
    if (s.status === "completed") expect(s.cached).toBe(true);
  });

  it("applyEvent 過期 jobId → 忽略，不影響任何台（FR-011）", async () => {
    mockDiagnoseOk("job-1");
    const store = useCopilotStore();
    await store.diagnose("mixer-01", "sock-1");
    store.applyEvent({ type: "ai/error", jobId: "job-OLD", code: "x", message: "舊" });
    expect(store.stateFor("mixer-01").status).toBe("active");
  });

  it("多台狀態獨立、可並存 active（FR-010）", async () => {
    const store = useCopilotStore();
    mockDiagnoseOk("job-A");
    await store.diagnose("mixer-01", "sock-1");
    mockDiagnoseOk("job-B");
    await store.diagnose("press-02", "sock-1");
    expect(store.stateFor("mixer-01").status).toBe("active");
    expect(store.stateFor("press-02").status).toBe("active");
    // 結束 A 不影響 B
    store.applyEvent({ type: "ai/done", jobId: "job-A", cached: false, result: RESULT });
    expect(store.stateFor("mixer-01").status).toBe("completed");
    expect(store.stateFor("press-02").status).toBe("active");
  });

  it("cancel：中止 active → idle，Diagnose 立即可再按", async () => {
    mockDiagnoseOk("job-1");
    const store = useCopilotStore();
    await store.diagnose("mixer-01", "sock-1");
    expect(store.stateFor("mixer-01").status).toBe("active");
    store.cancel("mixer-01");
    expect(store.stateFor("mixer-01").status).toBe("idle");
    expect(store.canDiagnose("mixer-01", true)).toBe(true);
  });

  it("cancel 後：被放棄任務的遲到事件被忽略，不復活畫面", async () => {
    mockDiagnoseOk("job-1");
    const store = useCopilotStore();
    await store.diagnose("mixer-01", "sock-1");
    store.cancel("mixer-01");
    store.applyEvent({ type: "ai/done", jobId: "job-1", cached: false, result: RESULT });
    expect(store.stateFor("mixer-01").status).toBe("idle");
  });

  it("checkStalls watchdog：逾時無進展 → failed（可重試）；未逾時不動", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    mockDiagnoseOk("job-1");
    const store = useCopilotStore();
    await store.diagnose("mixer-01", "sock-1"); // 記活動時刻 @1_000_000
    store.checkStalls(1_000_000 + 10_000, 45_000); // 未逾時
    expect(store.stateFor("mixer-01").status).toBe("active");
    store.checkStalls(1_000_000 + 46_000, 45_000); // 逾時
    const s = store.stateFor("mixer-01");
    expect(s.status).toBe("failed");
    if (s.status === "failed") expect(s.error).toBe("診斷逾時或無回應，請重試");
  });

  it("checkStalls：屬當前 job 的進度事件會重置逾時計時", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    mockDiagnoseOk("job-1");
    const store = useCopilotStore();
    await store.diagnose("mixer-01", "sock-1"); // 活動 @1_000_000
    nowSpy.mockReturnValue(1_040_000);
    store.applyEvent({
      type: "job/status",
      jobId: "job-1",
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
    mockDiagnoseOk("job-1");
    const store = useCopilotStore();
    store.onReconnect("client-1"); // 首次連線，僅記錄
    await store.diagnose("mixer-01", "sock-1");
    store.onReconnect("client-1"); // 同 id，不動
    expect(store.stateFor("mixer-01").status).toBe("active");
    store.onReconnect("client-2"); // 重連（新 id）→ 中斷
    const s = store.stateFor("mixer-01");
    expect(s.status).toBe("failed");
    if (s.status === "failed") expect(s.error).toBe("連線中斷，請重試");
  });
});
