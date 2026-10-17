// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import type { MachineState } from "@flow-gatekeeper/contracts";
import StateBadge from "./StateBadge.vue";
import StalePill from "./StalePill.vue";

/**
 * 合併門第 2 輪 #13：狀態徽章與「停滯」徽章抽成共用元件（卡片標頭、AI 診斷面板閒置列共用）。
 * 鎖住抽出前的 class 與文字輸出，卡片 CSS 測試與 README 截圖劇本依賴這些 class。
 */
const BASE = ["rounded-pill", "border", "px-2", "py-px", "text-xs", "font-semibold", "leading-4"];

describe("StateBadge", () => {
  it.each<[MachineState, string, string, string, string]>([
    ["healthy", "正常", "text-ok-fg", "bg-ok-bg", "border-transparent"],
    ["warning", "警告", "text-warn-fg", "bg-warn-bg", "border-transparent"],
    ["critical", "嚴重", "text-crit-fg", "bg-crit-bg", "border-crit"],
  ])("%s → 「%s」，文字色＋底色，嚴重才帶 border-crit", (state, label, text, surface, border) => {
    const w = mount(StateBadge, { props: { state } });
    expect(w.element.tagName).toBe("SPAN");
    expect(w.text()).toBe(label);
    expect(w.classes()).toEqual(expect.arrayContaining([...BASE, text, surface, border]));
    expect(w.find(".sr-only").exists()).toBe(false);
  });

  it("srPrefix：文字前加視覺隱藏的「狀態：」；呼叫端的排版 class 合併到根節點", () => {
    const w = mount(StateBadge, { props: { state: "warning", srPrefix: true }, attrs: { class: "shrink-0" } });
    expect(w.text()).toBe("狀態：警告");
    expect(w.get(".sr-only").text()).toBe("狀態：");
    expect(w.classes()).toEqual(expect.arrayContaining(["shrink-0", ...BASE]));
  });
});

describe("StalePill", () => {
  it("「停滯」文字＋停滯點（aria-hidden），不縮", () => {
    const w = mount(StalePill);
    expect(w.text()).toBe("停滯");
    expect(w.classes()).toEqual(
      expect.arrayContaining(["inline-flex", "shrink-0", "rounded-pill", "border", "border-stale", "bg-surface-strong", "text-ink-2"]),
    );
    const dot = w.get("span > span");
    expect(dot.classes()).toEqual(expect.arrayContaining(["bg-stale", "h-1.5", "w-1.5"]));
    expect(dot.attributes("aria-hidden")).toBe("true");
  });
});
