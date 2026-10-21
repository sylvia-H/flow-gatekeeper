import { describe, expect, it } from "vitest";
import type { DiagnosisResult } from "@flow-gatekeeper/contracts";
import {
  NO_DIAGNOSIS_BADGE,
  diagnosisBadgeOf,
  diagnosisBadgeText,
  sameDiagnosisBadge,
  type DiagnosisBadge,
} from "./diagnosis-badge.js";

const RESULT: DiagnosisResult = {
  summary: "s",
  severity: "critical",
  likelyCauses: [],
  suggestedActions: [],
  evidence: [],
};

describe("diagnosisBadgeOf（data-model §7）", () => {
  it("無狀態與 idle → 共用的 NO_DIAGNOSIS_BADGE（同一物件）", () => {
    expect(diagnosisBadgeOf(undefined)).toBe(NO_DIAGNOSIS_BADGE);
    expect(diagnosisBadgeOf({ status: "idle", machineId: "m" })).toBe(NO_DIAGNOSIS_BADGE);
    expect(NO_DIAGNOSIS_BADGE).toEqual({ kind: "none" });
  });

  it("active → 帶進度（null 保留為 null）", () => {
    const base = { status: "active", machineId: "m", jobId: "j", attempt: 1, lastSeq: -1, execution: 1, streamText: "" } as const;
    expect(diagnosisBadgeOf({ ...base, progress: 60 })).toEqual({ kind: "active", progress: 60 });
    expect(diagnosisBadgeOf({ ...base, progress: null })).toEqual({ kind: "active", progress: null });
  });

  it("completed → 帶 result.severity 與 cached", () => {
    const state = { status: "completed", machineId: "m", jobId: "j", streamText: "", result: RESULT, source: "ai/done", streamIncomplete: false } as const;
    expect(diagnosisBadgeOf({ ...state, cached: false })).toEqual({ kind: "completed", severity: "critical", cached: false });
    expect(diagnosisBadgeOf({ ...state, cached: true })).toEqual({ kind: "completed", severity: "critical", cached: true });
  });

  it("failed → { kind: 'failed' }", () => {
    expect(diagnosisBadgeOf({ status: "failed", machineId: "m", streamText: "", error: "x" })).toEqual({ kind: "failed" });
  });
});

describe("sameDiagnosisBadge", () => {
  it("同 kind 且欄位相同才相同", () => {
    expect(sameDiagnosisBadge({ kind: "active", progress: 1 }, { kind: "active", progress: 1 })).toBe(true);
    expect(sameDiagnosisBadge({ kind: "active", progress: 1 }, { kind: "active", progress: 2 })).toBe(false);
    expect(
      sameDiagnosisBadge(
        { kind: "completed", severity: "ok", cached: true },
        { kind: "completed", severity: "ok", cached: false },
      ),
    ).toBe(false);
    expect(sameDiagnosisBadge({ kind: "failed" }, { kind: "failed" })).toBe(true);
    expect(sameDiagnosisBadge({ kind: "none" }, { kind: "failed" })).toBe(false);
  });
});

describe("diagnosisBadgeText（FR-028）", () => {
  const CASES: readonly [DiagnosisBadge, string | null][] = [
    [{ kind: "none" }, null],
    [{ kind: "active", progress: 60 }, "診斷中 60%"],
    [{ kind: "active", progress: null }, "診斷中"],
    [{ kind: "completed", severity: "critical", cached: false }, "AI：嚴重"],
    [{ kind: "completed", severity: "warning", cached: false }, "AI：警告"],
    [{ kind: "completed", severity: "ok", cached: true }, "AI：正常 · 快取"],
    [{ kind: "completed", severity: "warning", cached: true }, "AI：警告 · 快取"],
    [{ kind: "failed" }, "AI 失敗"],
  ];
  it.each(CASES)("%o → %s", (badge, text) => {
    expect(diagnosisBadgeText(badge)).toBe(text);
  });
});
