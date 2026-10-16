// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import type { DiagnosisResult } from "@flow-gatekeeper/contracts";
import DiagnosisResultView from "./DiagnosisResultView.vue";
import type { TimingLabel } from "../lib/diagnosis-timing.js";

/** DiagnosisResultView（T046）：區段順序、證據合併與收合、嚴重度色條、完成 meta 與快取對比。 */

const RESULT: DiagnosisResult = {
  summary: "主軸軸承磨耗導致振動升高",
  severity: "warning",
  likelyCauses: ["軸承潤滑不足"],
  suggestedActions: [{ label: "排程潤滑", priority: "medium" }],
  evidence: [
    { source: "telemetry", excerpt: "[10:00:01] vibration 2.4 > 2.0" },
    { source: "telemetry", excerpt: "[10:00:09]  Vibration 2.4 > 2.0 " },
    { source: "telemetry", excerpt: "[10:00:15] vibration 2.4 > 2.0" },
    { source: "errorlog", excerpt: "E42 overheat" },
    { source: "maintenance", excerpt: "上次保養 30 天前" },
    { source: "errorlog", excerpt: "E17 pressure drop" },
  ],
};

type Meta = { cached: boolean; completedAt: number | null; elapsed: TimingLabel | null };

function mountView(result: DiagnosisResult = RESULT, meta?: Meta) {
  return mount(DiagnosisResultView, { props: { result, ...(meta ? { meta } : {}) } });
}

describe("DiagnosisResultView", () => {
  it("區段順序：摘要＋嚴重度 → 建議動作 → 可能原因 → 證據（FR-020）", () => {
    const w = mountView();
    expect(w.findAll("h3").map((h) => h.text())).toEqual(["摘要", "建議動作", "可能原因", "證據"]);
    expect(w.findAll("[data-section]").map((s) => s.attributes("data-section"))).toEqual([
      "summary",
      "suggestedActions",
      "likelyCauses",
      "evidence",
    ]);
    expect(w.get('[data-section="summary"]').text()).toContain("警告");
  });

  it("頂部 2px 嚴重度色條依 severity 換語意色（裝飾、aria-hidden）", () => {
    const cases: [DiagnosisResult["severity"], string][] = [
      ["ok", "bg-ok"],
      ["warning", "bg-warn"],
      ["critical", "bg-crit"],
    ];
    for (const [severity, cls] of cases) {
      const w = mountView({ ...RESULT, severity });
      const bar = w.get("[data-severity]");
      expect(bar.attributes("data-severity")).toBe(severity);
      expect(bar.classes()).toEqual(expect.arrayContaining(["h-0.5", cls]));
      expect(bar.attributes("aria-hidden")).toBe("true");
      // 色條是第一個元素：在 meta 與四個區段之上
      expect(w.element.firstElementChild).toBe(bar.element);
    }
  });

  it("證據：相同來源＋正規化摘錄者合併為一列並顯示 ×N，不顯示時間；預設 2 筆，「還有 N 筆」展開、「收起」收回", async () => {
    const w = mountView();
    const section = w.get('[data-section="evidence"]');
    const rows = () => section.findAll("[data-evidence]");
    expect(rows()).toHaveLength(2);
    const count = rows()[0]!.get("[data-evidence-count]");
    expect(count.text()).toBe("共 3 次×3"); // 視覺隱藏「共 3 次」＋可見「×3」
    expect(count.get('[aria-hidden="true"]').text()).toBe("×3");
    expect(rows()[1]!.find("[data-evidence-count]").exists()).toBe(false); // 單筆不顯示 ×1
    // 只顯示第一筆原文；沒有任何時間欄位被另外呈現
    expect(rows()[0]!.text()).toContain("vibration 2.4 > 2.0");

    const more = section.get("button");
    expect(more.text()).toBe("還有 2 筆");
    expect(more.attributes("aria-expanded")).toBe("false");
    const listId = section.get("ul").attributes("id");
    expect(listId).toBeTruthy();
    expect(more.attributes("aria-controls")).toBe(listId);

    await more.trigger("click");
    expect(rows()).toHaveLength(4);
    expect(more.text()).toBe("收起");
    expect(more.attributes("aria-expanded")).toBe("true");

    await more.trigger("click");
    expect(rows()).toHaveLength(2);
  });

  it("證據 ≤ 2 筆 → 不出現展開鈕；無證據 → 空狀態文字", () => {
    const two = mountView({ ...RESULT, evidence: RESULT.evidence.slice(3, 5) });
    expect(two.get('[data-section="evidence"]').find("button").exists()).toBe(false);
    const none = mountView({ ...RESULT, evidence: [] });
    expect(none.get('[data-section="evidence"]').text()).toContain("無佐證資料。");
  });

  it("未提供 meta → 不畫 meta 列", () => {
    expect(mountView().find('[data-fg="timing"]').exists()).toBe(false);
  });

  it("非快取 meta：一行「完成 HH:mm:ss · N.N s」、data-cached=false", () => {
    const at = new Date(2026, 9, 15, 9, 5, 7).getTime();
    const w = mountView(RESULT, {
      cached: false,
      completedAt: at,
      elapsed: { primary: "8.2 s", secondary: null, cached: false },
    });
    const timing = w.get('[data-fg="timing"]');
    expect(timing.attributes("data-cached")).toBe("false");
    expect(timing.text()).toBe("完成 09:05:07 · 8.2 s");
    expect(timing.find(".text-ratio").exists()).toBe(false);
  });

  it("快取 meta：「快取 · N ms」用 text-ratio 等寬大字，並列「上一次 N.N s」與完成時刻", () => {
    const at = new Date(2026, 9, 15, 14, 10, 56).getTime();
    const w = mountView(RESULT, {
      cached: true,
      completedAt: at,
      elapsed: { primary: "快取 · 14 ms", secondary: "上一次 8.2 s", cached: true },
    });
    const timing = w.get('[data-fg="timing"][data-cached="true"]');
    const big = timing.get(".text-ratio");
    expect(big.classes()).toContain("font-mono");
    expect(big.text()).toBe("結果來自快取 · 14 ms");
    expect(timing.text()).toContain("上一次 8.2 s");
    expect(timing.text()).toContain("完成 14:10:56");
  });

  it("非快取且完成時刻缺漏 → 只顯示耗時、不出現「完成 ·」前綴；兩者皆缺 → 不畫 meta 列", () => {
    const noClock = mountView(RESULT, {
      cached: false,
      completedAt: null,
      elapsed: { primary: "8.2 s", secondary: null, cached: false },
    });
    expect(noClock.get('[data-fg="timing"]').text()).toBe("8.2 s");

    const nothing = mountView(RESULT, { cached: false, completedAt: null, elapsed: null });
    expect(nothing.find('[data-fg="timing"]').exists()).toBe(false);

    const clockOnly = mountView(RESULT, {
      cached: false,
      completedAt: new Date(2026, 9, 15, 9, 5, 7).getTime(),
      elapsed: null,
    });
    expect(clockOnly.get('[data-fg="timing"]').text()).toBe("完成 09:05:07");
  });

  it("快取但無非快取紀錄 → 只顯示本次；耗時紀錄缺漏時仍標出「快取」", () => {
    const only = mountView(RESULT, {
      cached: true,
      completedAt: null,
      elapsed: { primary: "快取 · 9 ms", secondary: null, cached: true },
    });
    expect(only.get('[data-fg="timing"]').text()).toBe("結果來自快取 · 9 ms");

    const missing = mountView(RESULT, { cached: true, completedAt: null, elapsed: null });
    expect(missing.get('[data-fg="timing"] .text-ratio').text()).toBe("結果來自快取");
  });
});
