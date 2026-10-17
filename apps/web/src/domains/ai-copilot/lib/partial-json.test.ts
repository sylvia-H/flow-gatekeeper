import { describe, expect, it } from "vitest";
import type { DiagnosisResult } from "@flow-gatekeeper/contracts";
import { parsePartialDiagnosis, type PartialResult } from "./partial-json.js";

const RESULT: DiagnosisResult = {
  summary: "溫度偏高導致節流",
  severity: "warning",
  likelyCauses: ["冷卻不足", "環境溫度高"],
  evidence: [
    { source: "telemetry", excerpt: "temp 92°C" },
    { source: "errorlog", id: "e-1", excerpt: "THERMAL_THROTTLE" },
  ],
  suggestedActions: [{ label: "檢查冷卻風扇", priority: "high", command: "fan --check" }],
};
const FULL = JSON.stringify(RESULT);

const states = (r: PartialResult) =>
  Object.fromEntries(Object.entries(r.fields).map(([k, f]) => [k, f.state]));

/** 取 `FULL` 在 `marker` 首次出現處之後再多 `extra` 個字元的前綴（模擬截斷）。 */
const cutAfter = (marker: string, extra = 0): string => {
  const at = FULL.indexOf(marker);
  if (at < 0) throw new Error(`marker not found: ${marker}`);
  return FULL.slice(0, at + marker.length + extra);
};

describe("parsePartialDiagnosis — 完整 JSON", () => {
  it("五欄全部 complete，值與原結果一致", () => {
    const r = parsePartialDiagnosis(FULL);
    expect(states(r)).toEqual({
      summary: "complete",
      severity: "complete",
      likelyCauses: "complete",
      evidence: "complete",
      suggestedActions: "complete",
    });
    expect(r.fields.summary.value).toBe(RESULT.summary);
    expect(r.fields.severity.value).toBe("warning");
    expect(r.fields.likelyCauses.value).toEqual(RESULT.likelyCauses);
    expect(r.fields.evidence.value).toEqual(RESULT.evidence);
    expect(r.fields.suggestedActions.value).toEqual(RESULT.suggestedActions);
    expect(r.raw).toBe(FULL);
  });

  it("排版過的 JSON（含換行縮排）同樣可解析", () => {
    const pretty = JSON.stringify(RESULT, null, 2);
    expect(states(parsePartialDiagnosis(pretty)).suggestedActions).toBe("complete");
  });

  it("根物件已閉合但缺欄位：缺的 missing、有的 complete", () => {
    const r = parsePartialDiagnosis('{"summary":"x","severity":"ok"}');
    expect(states(r)).toEqual({
      summary: "complete",
      severity: "complete",
      likelyCauses: "missing",
      evidence: "missing",
      suggestedActions: "missing",
    });
  });

  it("型別不符的欄位視為 missing；陣列中型別不對的元素丟掉", () => {
    const r = parsePartialDiagnosis(
      JSON.stringify({
        summary: 42,
        severity: "fatal",
        likelyCauses: ["a", 1, null, "b"],
        evidence: [{ source: "telemetry" }, { source: "bogus", excerpt: "x" }, { source: "maintenance", excerpt: "ok" }],
        suggestedActions: "not-array",
      }),
    );
    expect(r.fields.summary).toEqual({ value: "", state: "missing" });
    expect(r.fields.severity).toEqual({ value: null, state: "missing" });
    expect(r.fields.likelyCauses).toEqual({ value: ["a", "b"], state: "complete" });
    expect(r.fields.evidence).toEqual({ value: [{ source: "maintenance", excerpt: "ok" }], state: "complete" });
    expect(r.fields.suggestedActions).toEqual({ value: [], state: "missing" });
  });
});

describe("parsePartialDiagnosis — 截斷", () => {
  it("截斷於 summary 字串中：summary streaming 且保留已到的文字，其餘 missing", () => {
    const r = parsePartialDiagnosis(cutAfter('"summary":"溫度偏高'));
    expect(r.fields.summary).toEqual({ value: "溫度偏高", state: "streaming" });
    expect(states(r)).toMatchObject({
      severity: "missing",
      likelyCauses: "missing",
      evidence: "missing",
      suggestedActions: "missing",
    });
  });

  it("summary 字串剛閉合（尚無逗號）：summary complete", () => {
    const r = parsePartialDiagnosis(cutAfter('"summary":"溫度偏高導致節流"'));
    expect(r.fields.summary).toEqual({ value: RESULT.summary, state: "complete" });
  });

  it("截斷於 severity 字串中且尚非合法等級：severity streaming、value null", () => {
    const r = parsePartialDiagnosis(cutAfter('"severity":"warn'));
    expect(r.fields.summary.state).toBe("complete");
    expect(r.fields.severity).toEqual({ value: null, state: "streaming" });
  });

  it("截斷於 likelyCauses 陣列中：已完整元素保留、截斷中的字串也保留、該欄 streaming", () => {
    const r = parsePartialDiagnosis(cutAfter('"likelyCauses":["冷卻不足","環境'));
    expect(r.fields.likelyCauses).toEqual({ value: ["冷卻不足", "環境"], state: "streaming" });
    expect(r.fields.summary.state).toBe("complete");
    expect(r.fields.severity).toEqual({ value: "warning", state: "complete" });
    expect(r.fields.evidence.state).toBe("missing");
  });

  it("截斷於 likelyCauses 元素間的懸空逗號：已完整元素保留、streaming", () => {
    const r = parsePartialDiagnosis(cutAfter('"likelyCauses":["冷卻不足",'));
    expect(r.fields.likelyCauses).toEqual({ value: ["冷卻不足"], state: "streaming" });
  });

  it("截斷於 evidence 物件中：不完整的最後一個物件元素丟掉、該欄 streaming", () => {
    const r = parsePartialDiagnosis(cutAfter('"errorlog","id":"e-1","excerpt":"THERMAL'));
    expect(r.fields.evidence).toEqual({ value: [RESULT.evidence[0]], state: "streaming" });
    expect(r.fields.likelyCauses.state).toBe("complete");
    expect(r.fields.suggestedActions.state).toBe("missing");
  });

  it("截斷於 evidence 第一個物件的 source 中：evidence streaming、value 空", () => {
    const r = parsePartialDiagnosis(cutAfter('"evidence":[{"source":"tele'));
    expect(r.fields.evidence).toEqual({ value: [], state: "streaming" });
  });

  it("截斷於 suggestedActions 的 command 中：不完整動作不外露（避免半截指令）", () => {
    const r = parsePartialDiagnosis(cutAfter('"command":"fan --'));
    expect(r.fields.suggestedActions).toEqual({ value: [], state: "streaming" });
    expect(r.fields.evidence.state).toBe("complete");
  });

  it('截斷於 "key": 之後（值未開始）：該 key 視為 missing，前面欄位 complete', () => {
    const r = parsePartialDiagnosis(cutAfter('"severity":'));
    expect(r.fields.summary.state).toBe("complete");
    expect(r.fields.severity).toEqual({ value: null, state: "missing" });
  });

  it("截斷於 key 字串中：該 key 不出現，前一欄 complete", () => {
    const r = parsePartialDiagnosis(cutAfter('"summary":"溫度偏高導致節流","sever'));
    expect(states(r)).toMatchObject({ summary: "complete", severity: "missing" });
  });

  it("只有開頭的 {：五欄 missing，但不視為非 JSON（raw 保留）", () => {
    const r = parsePartialDiagnosis("{");
    expect(Object.values(states(r)).every((s) => s === "missing")).toBe(true);
    expect(r.raw).toBe("{");
  });

  it("截斷於跳脫序列中：去掉未完成的跳脫後補齊", () => {
    expect(parsePartialDiagnosis('{"summary":"a\\').fields.summary).toEqual({ value: "a", state: "streaming" });
    expect(parsePartialDiagnosis('{"summary":"a\\u00').fields.summary).toEqual({ value: "a", state: "streaming" });
    expect(parsePartialDiagnosis('{"summary":"a\\"b').fields.summary).toEqual({ value: 'a"b', state: "streaming" });
    expect(parsePartialDiagnosis('{"summary":"a\\u0041b').fields.summary).toEqual({ value: "aAb", state: "streaming" });
  });

  it("字串內含括號不影響結構判定：截斷於 at {zo 時 evidence 只留第一筆、streaming", () => {
    const tricky: DiagnosisResult = {
      ...RESULT,
      likelyCauses: ["c1", "c2 ]"],
      evidence: [
        { source: "telemetry", excerpt: "temp 92°C" },
        { source: "errorlog", excerpt: "at {zone}" },
      ],
    };
    const text = JSON.stringify(tricky);
    const r = parsePartialDiagnosis(text.slice(0, text.indexOf("at {zo") + "at {zo".length));
    expect(r.fields.likelyCauses).toEqual({ value: ["c1", "c2 ]"], state: "complete" });
    expect(r.fields.evidence).toEqual({ value: [{ source: "telemetry", excerpt: "temp 92°C" }], state: "streaming" });
    expect(r.fields.suggestedActions.state).toBe("missing");
  });

  it("排版過（多行縮排）且有 ```json 圍欄的 JSON 被截斷", () => {
    const pretty = "```json\n" + JSON.stringify(RESULT, null, 2);
    const r = parsePartialDiagnosis(pretty.slice(0, pretty.indexOf('"環境') + '"環境'.length));
    expect(r.fields.summary).toEqual({ value: RESULT.summary, state: "complete" });
    expect(r.fields.severity).toEqual({ value: "warning", state: "complete" });
    expect(r.fields.likelyCauses).toEqual({ value: ["冷卻不足", "環境"], state: "streaming" });
    expect(r.fields.evidence.state).toBe("missing");
  });

  it("每一個前綴都不丟例外、五欄永遠存在；值與狀態只前進不倒退，同時最多一欄 streaming", () => {
    const rank = { missing: 0, streaming: 1, complete: 2 } as const;
    const keys = ["evidence", "likelyCauses", "severity", "suggestedActions", "summary"] as const;
    let prev: PartialResult | null = null;
    for (let i = 0; i <= FULL.length; i++) {
      const r = parsePartialDiagnosis(FULL.slice(0, i));
      expect(Object.keys(r.fields).sort()).toEqual([...keys]);
      expect(Object.values(states(r)).filter((s) => s === "streaming").length).toBeLessThanOrEqual(1);
      expect(RESULT.summary.startsWith(r.fields.summary.value)).toBe(true);
      if (prev) {
        for (const k of keys) {
          expect(rank[r.fields[k].state], `prefix ${i} field ${k}`).toBeGreaterThanOrEqual(rank[prev.fields[k].state]);
        }
        expect(r.fields.evidence.value.length).toBeGreaterThanOrEqual(prev.fields.evidence.value.length);
        expect(r.fields.likelyCauses.value.length).toBeGreaterThanOrEqual(prev.fields.likelyCauses.value.length);
        expect(r.fields.suggestedActions.value.length).toBeGreaterThanOrEqual(prev.fields.suggestedActions.value.length);
      }
      prev = r;
    }
    expect(prev && Object.values(states(prev)).every((s) => s === "complete")).toBe(true);
  });
});

describe("parsePartialDiagnosis — 非 JSON 與前綴雜訊", () => {
  it("非 JSON：五欄 missing、raw 保留原文", () => {
    const text = "模型正在思考，稍後輸出結果";
    const r = parsePartialDiagnosis(text);
    expect(r).toEqual({
      fields: {
        summary: { value: "", state: "missing" },
        severity: { value: null, state: "missing" },
        likelyCauses: { value: [], state: "missing" },
        evidence: { value: [], state: "missing" },
        suggestedActions: { value: [], state: "missing" },
      },
      raw: text,
    });
  });

  it("含 { 但不是 JSON：五欄 missing、不丟例外", () => {
    const r = parsePartialDiagnosis("hello {world} and more");
    expect(Object.values(states(r)).every((s) => s === "missing")).toBe(true);
  });

  it("空字串：五欄 missing、raw 為空", () => {
    const r = parsePartialDiagnosis("");
    expect(Object.values(states(r)).every((s) => s === "missing")).toBe(true);
    expect(r.raw).toBe("");
  });

  it("```json 圍欄前綴與尾端圍欄：忽略雜訊，五欄 complete", () => {
    const text = "```json\n" + FULL + "\n```";
    const r = parsePartialDiagnosis(text);
    expect(Object.values(states(r)).every((s) => s === "complete")).toBe(true);
    expect(r.raw).toBe(text);
  });

  it("說明文字後接截斷 JSON：從第一個 { 起解析", () => {
    const r = parsePartialDiagnosis('以下是診斷結果：\n{"summary":"溫度');
    expect(r.fields.summary).toEqual({ value: "溫度", state: "streaming" });
  });
});
