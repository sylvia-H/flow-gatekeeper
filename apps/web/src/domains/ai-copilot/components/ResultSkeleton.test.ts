// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import ResultSkeleton from "./ResultSkeleton.vue";
import { parsePartialDiagnosis, type PartialResult } from "../lib/partial-json.js";

/** ResultSkeleton（T045）：三態（missing／streaming／complete）、狀態文字與區段順序。 */

function mountSkeleton(partial: PartialResult) {
  return mount(ResultSkeleton, { props: { partial } });
}

const FULL = JSON.stringify({
  summary: "主軸軸承磨耗導致振動升高",
  severity: "critical",
  likelyCauses: ["軸承潤滑不足", "負載過高"],
  evidence: [
    { source: "telemetry", excerpt: "[10:00:01] vibration 2.4" },
    { source: "telemetry", excerpt: "[10:00:05] vibration   2.4" },
    { source: "errorlog", excerpt: "E42 overheat" },
    { source: "maintenance", excerpt: "上次保養 30 天前" },
  ],
  suggestedActions: [{ label: "停機檢查軸承", priority: "high" }],
});

describe("ResultSkeleton", () => {
  it("根節點 data-fg=result-skeleton；欄位順序 摘要＋嚴重度 → 建議動作 → 可能原因 → 證據", () => {
    const w = mountSkeleton(parsePartialDiagnosis(""));
    expect(w.find('[data-fg="result-skeleton"]').exists()).toBe(true);
    expect(w.findAll("[data-field]").map((f) => f.attributes("data-field"))).toEqual([
      "summary",
      "severity",
      "suggestedActions",
      "likelyCauses",
      "evidence",
    ]);
    expect(w.findAll("h3").map((h) => h.text().replace(/（.*）$/, ""))).toEqual([
      "摘要",
      "建議動作",
      "可能原因",
      "證據",
    ]);
  });

  it("missing：每欄位佔位條、視覺隱藏「尚未產生」，不顯示錯誤也不顯示游標", () => {
    const w = mountSkeleton(parsePartialDiagnosis("模型正在思考"));
    for (const f of w.findAll("[data-field]")) {
      expect(f.attributes("data-field-state")).toBe("missing");
      expect(f.text()).toContain("尚未產生");
    }
    // 四個區段各兩條佔位（包在 aria-hidden 容器內）；嚴重度另有一個 aria-hidden 佔位 pill
    expect(w.findAll('[aria-hidden="true"] .bg-ink\\/20').length).toBe(8);
    expect(w.get('[data-field="severity"] .bg-ink\\/20').attributes("aria-hidden")).toBe("true");
    expect(w.find(".animate-stream-caret").exists()).toBe(false);
    expect(w.text()).not.toMatch(/錯誤|失敗/);
  });

  it("streaming：截斷中的欄位顯示已解析內容＋游標與「生成中」；之前的欄位為「已完成」", () => {
    const w = mountSkeleton(parsePartialDiagnosis('{"summary":"主軸軸承'));
    const summary = w.get('[data-field="summary"]');
    expect(summary.attributes("data-field-state")).toBe("streaming");
    expect(summary.text()).toContain("主軸軸承");
    expect(summary.text()).toContain("生成中");
    const caret = summary.get(".animate-stream-caret");
    expect(caret.attributes("aria-hidden")).toBe("true");

    const w2 = mountSkeleton(
      parsePartialDiagnosis('{"summary":"過熱","severity":"warning","suggestedActions":[{"label":"降速","priority":"medium"},{"label":"停'),
    );
    expect(w2.get('[data-field="summary"]').attributes("data-field-state")).toBe("complete");
    expect(w2.get('[data-field="summary"]').text()).toContain("已完成");
    expect(w2.get('[data-field="severity"]').text()).toBe("嚴重度：警告（已完成）"); // 有值時同樣附狀態字
    const actions = w2.get('[data-field="suggestedActions"]');
    expect(actions.attributes("data-field-state")).toBe("streaming");
    expect(actions.text()).toContain("降速");
    expect(actions.text()).not.toContain("停"); // 半截物件元素丟掉，不顯示半截動作
    expect(actions.find(".animate-stream-caret").exists()).toBe(true);
    expect(w2.get('[data-field="likelyCauses"]').attributes("data-field-state")).toBe("missing");
  });

  it("severity 串流中尚未拼出合法等級 → 佔位 pill 與「嚴重度：生成中」", () => {
    const w = mountSkeleton(parsePartialDiagnosis('{"summary":"x","severity":"warn'));
    const sev = w.get('[data-field="severity"]');
    expect(sev.attributes("data-field-state")).toBe("streaming");
    expect(sev.text()).toBe("嚴重度：生成中");
  });

  it("complete：五欄正常顯示、無游標；證據合併 ×N 並只列前 2 筆，其餘以「還有 N 筆」標出", () => {
    const w = mountSkeleton(parsePartialDiagnosis(FULL));
    for (const f of w.findAll("[data-field]")) {
      expect(f.attributes("data-field-state")).toBe("complete");
    }
    expect(w.text()).toContain("已完成");
    expect(w.find(".animate-stream-caret").exists()).toBe(false);
    expect(w.get('[data-field="severity"]').text()).toContain("嚴重");
    expect(w.get('[data-field="likelyCauses"]').text()).toContain("負載過高");

    const evidence = w.get('[data-field="evidence"]');
    const rows = evidence.findAll("[data-evidence]");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.get("[data-evidence-count]").text()).toBe("共 2 次×2");
    expect(evidence.text()).toContain("還有 1 筆");
    expect(evidence.find("button").exists()).toBe(false); // 串流中不提供展開，完成後才可展開
  });

  it("欄位完成但為空陣列 → 空狀態文字（與完成態一致）", () => {
    const w = mountSkeleton(
      parsePartialDiagnosis('{"summary":"x","severity":"ok","suggestedActions":[],"likelyCauses":[],"evidence":[]}'),
    );
    expect(w.text()).toContain("無建議動作。");
    expect(w.text()).toContain("未提供可能原因。");
    expect(w.text()).toContain("無佐證資料。");
  });
});
