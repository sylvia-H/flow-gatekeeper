// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import ThemeToggle from "./ThemeToggle.vue";
import { resetThemeStateForTest, THEME_STORAGE_KEY } from "../composables/useTheme.js";

/**
 * 主題切換兩種外觀（FR-002／FR-003、FR-033a）：rail 的兩段式與手機工具列的單一圖示鈕，
 * 兩者都帶 `data-fg="theme-toggle"`，切換一律走 `useTheme().apply`（寫 `<html data-theme>`）。
 */

let wrapper: VueWrapper | null = null;

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  resetThemeStateForTest();
  delete document.documentElement.dataset["theme"];
  // 點擊切換會寫入主題偏好；不清掉會讓下一支測試一開始就讀到深色。
  // Node 26 的實驗性 localStorage 會遮蔽 happy-dom 的實作（寫入無效），所以本機看不出來，
  // CI 依 .nvmrc 跑 Node 22 時 storage 正常運作才會洩漏。storage 不可用時略過。
  try {
    globalThis.localStorage?.removeItem(THEME_STORAGE_KEY);
  } catch {
    /* storage 不可用 */
  }
});

const root = (): string | undefined => document.documentElement.dataset["theme"];

describe("ThemeToggle", () => {
  it("預設兩段式：「淺色｜深色」，目前主題那段 aria-pressed，點另一段切換", async () => {
    wrapper = mount(ThemeToggle);
    const group = wrapper.get('[data-fg="theme-toggle"]');
    expect(group.attributes("role")).toBe("group");
    expect(group.attributes("aria-label")).toBe("主題");
    const [light, dark] = group.findAll("button");
    expect([light!.text(), dark!.text()]).toEqual(["淺色", "深色"]);
    expect(light!.attributes("aria-pressed")).toBe("true");
    expect(dark!.attributes("aria-pressed")).toBe("false");

    await dark!.trigger("click");
    expect(root()).toBe("dark");
    expect(dark!.attributes("aria-pressed")).toBe("true");
  });

  it("icon 模式：單一按鈕、不用 aria-pressed，可讀名稱指向切換後的主題並隨主題翻轉", async () => {
    wrapper = mount(ThemeToggle, { props: { variant: "icon" } });
    const button = wrapper.get('[data-fg="theme-toggle"]');
    expect(button.element.tagName).toBe("BUTTON");
    expect(wrapper.findAll("button")).toHaveLength(1);
    expect(button.attributes("aria-pressed")).toBeUndefined();
    expect(button.attributes("aria-label")).toBe("切換為深色主題");
    expect(button.attributes("title")).toBe("切換為深色主題");
    expect(button.find("svg").attributes("aria-hidden")).toBe("true");

    await button.trigger("click");
    expect(root()).toBe("dark");
    expect(button.attributes("aria-label")).toBe("切換為淺色主題");

    await button.trigger("click");
    expect(root()).toBe("light");
    expect(button.attributes("aria-label")).toBe("切換為深色主題");
  });

  it("<html> 已是深色時 icon 模式一開始就是「切換為淺色主題」", () => {
    document.documentElement.dataset["theme"] = "dark";
    wrapper = mount(ThemeToggle, { props: { variant: "icon" } });
    expect(wrapper.get('[data-fg="theme-toggle"]').attributes("aria-label")).toBe("切換為淺色主題");
  });
});
