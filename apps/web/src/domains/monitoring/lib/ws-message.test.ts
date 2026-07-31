import { describe, expect, it } from "vitest";
import { classifyWsMessage } from "./ws-message.js";

describe("classifyWsMessage — WS 分流分類（憲章 IV／FR-017）", () => {
  it("陣列 → telemetry（唯一進 buffer 的類別）", () => {
    const r = classifyWsMessage([{ type: "machine/data" }, { type: "machine/data" }]);
    expect(r.kind).toBe("telemetry");
    if (r.kind === "telemetry") expect(r.points).toHaveLength(2);
  });

  it("診斷事件 → diagnosis，且**永不**歸為 telemetry（不進遙測 buffer）", () => {
    for (const type of ["job/status", "ai/token", "ai/done", "ai/error"] as const) {
      const r = classifyWsMessage({ type, jobId: "j1" });
      expect(r.kind).toBe("diagnosis");
      expect(r.kind).not.toBe("telemetry");
    }
  });

  it("控制訊息 → control（不進 buffer、不當診斷）", () => {
    for (const type of ["system/connected", "pong", "machine/subscribed", "system/unauthorized"] as const) {
      const r = classifyWsMessage({ type });
      expect(r.kind).toBe("control");
    }
  });

  it("system/metrics → metrics，且**永不**歸為 telemetry（009：不進 rAF buffer）", () => {
    const r = classifyWsMessage({ type: "system/metrics", windowMs: 60_000 });
    expect(r.kind).toBe("metrics");
    expect(r.kind).not.toBe("telemetry");
    if (r.kind === "metrics") expect(r.metrics.windowMs).toBe(60_000);
  });

  it("未知 type 與非物件 → ignore", () => {
    expect(classifyWsMessage({ type: "unknown/thing" }).kind).toBe("ignore");
    expect(classifyWsMessage("not-json-object").kind).toBe("ignore");
    expect(classifyWsMessage(42).kind).toBe("ignore");
    expect(classifyWsMessage(null).kind).toBe("ignore");
  });
});
