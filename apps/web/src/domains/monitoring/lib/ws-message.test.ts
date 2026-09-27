import { describe, expect, it } from "vitest";
import type { DiagnosisResult, TelemetryPoint } from "@flow-gatekeeper/contracts";
import { classifyWsMessage } from "./ws-message.js";

function point(machineId = "mixer-01"): TelemetryPoint {
  return {
    type: "machine/data",
    machineId,
    timestamp: "2026-09-27T00:00:00.000Z",
    telemetry: { temperature: 60, vibration: 1.2, throughput: 100, errorRate: 0.01 },
    state: "healthy",
  };
}

const RESULT: DiagnosisResult = {
  summary: "溫度偏高",
  severity: "warning",
  likelyCauses: ["冷卻風扇效率下降"],
  suggestedActions: [{ label: "檢查風扇", priority: "medium" }],
  evidence: [{ source: "telemetry", excerpt: "temperature 88" }],
};

/** 每種診斷事件各一則完整、合法的樣本。 */
const DIAGNOSIS_SAMPLES = [
  { type: "job/status", jobId: "j1", machineId: "mixer-01", status: "active", progress: 40 },
  { type: "ai/token", jobId: "j1", attempt: 1, seq: 0, text: "溫" },
  { type: "ai/done", jobId: "j1", attempt: 1, cached: false, result: RESULT },
  { type: "ai/error", jobId: "j1", attempt: 2, code: "timeout", message: "LLM timeout" },
] as const;

const METRICS = {
  type: "system/metrics",
  windowMs: 60_000,
  collectedAt: "2026-09-27T00:00:00.000Z",
  queue: { waiting: 0, active: 1, failed: 0 },
  wsConnections: 2,
  worker: null,
};

describe("classifyWsMessage — WS 分流分類（憲章 IV）", () => {
  it("陣列 → telemetry（唯一進 buffer 的類別）", () => {
    const r = classifyWsMessage([point("mixer-01"), point("press-02")]);
    expect(r.kind).toBe("telemetry");
    if (r.kind === "telemetry") {
      expect(r.points).toHaveLength(2);
      expect(r.rejected).toBe(0);
    }
  });

  it("陣列中的畸形點逐筆剔除並計數，其他機台照常放行", () => {
    const bad = [null, { type: "machine/data" }, { ...point(), telemetry: { ...point().telemetry, temperature: "hot" } }];
    const r = classifyWsMessage([point("mixer-01"), ...bad, point("press-02")]);
    expect(r.kind).toBe("telemetry");
    if (r.kind === "telemetry") {
      expect(r.points.map((p) => p.machineId)).toEqual(["mixer-01", "press-02"]);
      expect(r.rejected).toBe(3);
    }
  });

  it("未知 state 不得進 buffer", () => {
    const r = classifyWsMessage([{ ...point(), state: "exploded" }]);
    expect(r.kind === "telemetry" && r.points.length === 0 && r.rejected === 1).toBe(true);
  });

  it("診斷事件 → diagnosis，且**永不**歸為 telemetry（不進遙測 buffer）", () => {
    for (const sample of DIAGNOSIS_SAMPLES) {
      const r = classifyWsMessage(sample);
      expect(r.kind).toBe("diagnosis");
      if (r.kind === "diagnosis") expect(r.event.type).toBe(sample.type);
    }
  });

  it("診斷事件缺欄位或結構畸形 → ignore（附原因），不交給 copilot store", () => {
    const malformed = [
      { type: "job/status", jobId: "j1" },
      { type: "ai/token", jobId: "j1", seq: 0, text: "x" }, // 缺 attempt
      { type: "ai/done", jobId: "j1", attempt: 1, cached: false, result: { summary: 1 } },
      { type: "ai/error", jobId: "j1", attempt: 0, code: "x", message: "y" }, // attempt 從 1 起
    ];
    for (const sample of malformed) {
      const r = classifyWsMessage(sample);
      expect(r.kind).toBe("ignore");
      if (r.kind === "ignore") expect(r.reason).toContain(sample.type);
    }
  });

  it("控制訊息 → control（不進 buffer、不當診斷）", () => {
    const samples = [
      { type: "system/connected", clientId: "c1" },
      { type: "pong", ts: 1 },
      { type: "machine/subscribed", machineIds: ["mixer-01"] },
      { type: "system/unauthorized" },
    ];
    for (const sample of samples) {
      expect(classifyWsMessage(sample).kind).toBe("control");
    }
  });

  it("system/connected 缺 clientId → ignore", () => {
    expect(classifyWsMessage({ type: "system/connected" }).kind).toBe("ignore");
  });

  it("system/metrics → metrics，且**永不**歸為 telemetry（009：不進 rAF buffer）", () => {
    const r = classifyWsMessage(METRICS);
    expect(r.kind).toBe("metrics");
    if (r.kind === "metrics") {
      expect(r.metrics.windowMs).toBe(60_000);
      expect(r.metrics.worker).toBeNull();
    }
  });

  it("system/metrics 帶完整 worker 快照 → 放行；worker 畸形或外層缺欄 → ignore", () => {
    const worker = {
      snapshotAt: "2026-09-27T00:00:00.000Z",
      llmLatency: { count: 0, avgMs: null, p95Ms: null, maxMs: null },
      cache: { hits: 0, misses: 0, hitRate: null },
    };
    expect(classifyWsMessage({ ...METRICS, worker }).kind).toBe("metrics");
    expect(classifyWsMessage({ ...METRICS, worker: { snapshotAt: 1 } }).kind).toBe("ignore");
    expect(classifyWsMessage({ ...METRICS, queue: { waiting: 0 } }).kind).toBe("ignore");
    expect(classifyWsMessage({ ...METRICS, windowMs: 0 }).kind).toBe("ignore");
    // 規則來自契約 SystemMetricsSchema：計數不得為負、須為整數；collectedAt 須為 RFC 3339
    expect(classifyWsMessage({ ...METRICS, wsConnections: -1 }).kind).toBe("ignore");
    expect(classifyWsMessage({ ...METRICS, queue: { waiting: 0, active: -1, failed: 0 } }).kind).toBe("ignore");
    expect(classifyWsMessage({ ...METRICS, windowMs: 1.5 }).kind).toBe("ignore");
    expect(classifyWsMessage({ ...METRICS, collectedAt: "yesterday" }).kind).toBe("ignore");
  });

  it("未知 type 與非物件 → ignore", () => {
    expect(classifyWsMessage({ type: "unknown/thing" }).kind).toBe("ignore");
    expect(classifyWsMessage("not-json-object").kind).toBe("ignore");
    expect(classifyWsMessage(42).kind).toBe("ignore");
    expect(classifyWsMessage(null).kind).toBe("ignore");
  });
});
