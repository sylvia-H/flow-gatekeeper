import { describe, expect, it } from "vitest";
import { AiStreamEventSchema } from "./ai-stream.js";

const result = {
  summary: "s",
  severity: "ok",
  likelyCauses: [],
  suggestedActions: [],
  evidence: [],
};

describe("AiStreamEventSchema", () => {
  it("接受三種事件並依 type 分派", () => {
    const events = [
      { type: "ai/token", jobId: "j", attempt: 1, seq: 0, text: "a" },
      { type: "ai/done", jobId: "j", attempt: 2, cached: false, result },
      { type: "ai/error", jobId: "j", attempt: 3, code: "schema_invalid", message: "m" },
    ];
    for (const ev of events) {
      expect(AiStreamEventSchema.safeParse(ev).success).toBe(true);
    }
  });

  it.each([
    ["缺 attempt", { type: "ai/token", jobId: "j", seq: 0, text: "a" }],
    ["attempt 為 0", { type: "ai/token", jobId: "j", attempt: 0, seq: 0, text: "a" }],
    ["attempt 非整數", { type: "ai/token", jobId: "j", attempt: 1.5, seq: 0, text: "a" }],
    [
      "ai/done.result 不符 DiagnosisResultSchema",
      { type: "ai/done", jobId: "j", attempt: 1, cached: true, result: { ...result, severity: "fatal" } },
    ],
    ["未知 type", { type: "ai/reset", jobId: "j", attempt: 1 }],
    ["非物件", "ai/token"],
  ])("拒絕：%s", (_label, value) => {
    expect(AiStreamEventSchema.safeParse(value).success).toBe(false);
  });
});
