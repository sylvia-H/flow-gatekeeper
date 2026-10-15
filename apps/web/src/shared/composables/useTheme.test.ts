// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applySavedTheme, resetThemeStateForTest, THEME_STORAGE_KEY, useTheme } from "./useTheme.js";

const root = (): HTMLElement => document.documentElement;

/** 收集 requestAnimationFrame 回呼，手動逐幀推進。 */
let frames: FrameRequestCallback[] = [];
function nextFrame(): void {
  const pending = frames;
  frames = [];
  for (const cb of pending) cb(performance.now());
}

/**
 * 以 Map 模擬 localStorage：新版 Node 內建的實驗性 `localStorage` 會遮蔽 happy-dom 的實作
 * （未帶 `--localstorage-file` 時為 undefined），所以不依賴環境提供的 storage。
 */
let storage: Map<string, string>;

beforeEach(() => {
  storage = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
    removeItem: (k: string) => void storage.delete(k),
  });
  root().removeAttribute("data-theme");
  root().removeAttribute("data-theme-switching");
  resetThemeStateForTest();
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    frames.push(cb);
    return frames.length;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("applySavedTheme", () => {
  it("無偏好時預設 light，且不讀 prefers-color-scheme", () => {
    const matchMedia = vi.fn(() => ({ matches: true }));
    vi.stubGlobal("matchMedia", matchMedia);
    expect(applySavedTheme()).toBe("light");
    expect(root().dataset.theme).toBe("light");
    expect(matchMedia).not.toHaveBeenCalled();
  });

  it("讀 fg.theme 並套到 <html>", () => {
    storage.set(THEME_STORAGE_KEY, "dark");
    expect(applySavedTheme()).toBe("dark");
    expect(root().dataset.theme).toBe("dark");
  });

  it("壞值退回 light", () => {
    storage.set(THEME_STORAGE_KEY, "sepia");
    expect(applySavedTheme()).toBe("light");
  });

  it("localStorage 拋錯時退回 light、不拋錯", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
    });
    expect(applySavedTheme()).toBe("light");
  });
});

describe("useTheme", () => {
  it("初始值取 <html> 上已套用的主題", () => {
    storage.set(THEME_STORAGE_KEY, "dark");
    applySavedTheme();
    expect(useTheme().theme.value).toBe("dark");
  });

  it("<html> 沒有 data-theme 時改讀已存偏好（savedTheme 分支）", () => {
    storage.set(THEME_STORAGE_KEY, "dark");
    expect(root().hasAttribute("data-theme")).toBe(false);
    expect(useTheme().theme.value).toBe("dark");
  });

  it("<html> 沒有 data-theme 且無偏好時為 light", () => {
    expect(useTheme().theme.value).toBe("light");
  });

  it("toggle 切換主題、寫 fg.theme，並在兩幀後移除 data-theme-switching", () => {
    applySavedTheme();
    const { theme, toggle } = useTheme();
    expect(theme.value).toBe("light");

    toggle();
    expect(theme.value).toBe("dark");
    expect(root().dataset.theme).toBe("dark");
    expect(storage.get(THEME_STORAGE_KEY)).toBe("dark");
    expect(root().hasAttribute("data-theme-switching")).toBe(true);

    nextFrame();
    expect(root().hasAttribute("data-theme-switching")).toBe(true);
    nextFrame();
    expect(root().hasAttribute("data-theme-switching")).toBe(false);

    toggle();
    expect(theme.value).toBe("light");
    expect(storage.get(THEME_STORAGE_KEY)).toBe("light");
  });

  it("多處呼叫共用同一份狀態", () => {
    const a = useTheme();
    const b = useTheme();
    a.apply("dark");
    expect(b.theme.value).toBe("dark");
  });
});
