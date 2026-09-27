import { describe, expect, it, vi } from "vitest";
import { createModalSheet, nextTrapTarget } from "./useModalSheet.js";

describe("nextTrapTarget（bottom sheet 焦點循環）", () => {
  const items = ["close", "diagnose", "cancel"];

  it("最後一個再 Tab → 回到第一個", () => {
    expect(nextTrapTarget(items, "cancel", false)).toBe("close");
  });
  it("第一個 Shift+Tab → 跳到最後一個", () => {
    expect(nextTrapTarget(items, "close", true)).toBe("cancel");
  });
  it("中間項目交給瀏覽器預設（回傳 null）", () => {
    expect(nextTrapTarget(items, "diagnose", false)).toBeNull();
    expect(nextTrapTarget(items, "diagnose", true)).toBeNull();
  });
  it("焦點在清單外（例如容器本身）→ 拉回邊界", () => {
    expect(nextTrapTarget(items, null, false)).toBe("close");
    expect(nextTrapTarget(items, "outside", true)).toBe("cancel");
  });
  it("沒有可聚焦元素 → null", () => {
    expect(nextTrapTarget([], null, false)).toBeNull();
  });
});

// ── createModalSheet：以 stub 的 matchMedia／IntersectionObserver 驅動開關與鍵盤分支 ──

interface FakeEl {
  name: string;
  focus: () => void;
  getClientRects: () => { length: number };
  isConnected: boolean;
}

function harness(opts: { mobile: boolean }) {
  let active: unknown = null;
  const focused: string[] = [];
  const mk = (name: string, rendered = true): FakeEl => ({
    name,
    isConnected: true,
    getClientRects: () => ({ length: rendered ? 1 : 0 }),
    focus: () => {
      active = el(name);
      focused.push(name);
    },
  });
  const els: FakeEl[] = [];
  const el = (name: string) => els.find((e) => e.name === name) ?? null;
  const opener = mk("opener");
  const root = { ...mk("root"), querySelectorAll: () => children };
  const children = [mk("close"), mk("hidden", false), mk("diagnose")];
  els.push(opener, root, ...children);

  let ioCallback: ((entries: { isIntersecting: boolean }[]) => void) | null = null;
  class StubIO {
    constructor(cb: (entries: { isIntersecting: boolean }[]) => void) {
      ioCallback = cb;
    }
    observe(): void {}
    disconnect(): void {}
  }
  const media = {
    matches: opts.mobile,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  const onClose = vi.fn();
  const sheet = createModalSheet(() => root, onClose, {
    matchMedia: () => media,
    IntersectionObserver: StubIO,
    activeElement: () => active,
    defer: (fn) => fn(),
  });
  sheet.attach();
  const key = (k: string, shiftKey = false) => {
    const e = { key: k, shiftKey, preventDefault: vi.fn(), stopPropagation: vi.fn() };
    sheet.onKeydown(e);
    return e;
  };
  return {
    sheet,
    onClose,
    focused,
    key,
    setActive: (name: string) => (active = el(name)),
    show: (v: boolean) => ioCallback?.([{ isIntersecting: v }]),
  };
}

describe("createModalSheet", () => {
  it("手機：sheet 顯示 → trapActive 並聚焦容器；隱藏 → 解除並把焦點還給開啟前元素", () => {
    const h = harness({ mobile: true });
    h.setActive("opener");
    expect(h.sheet.isSheet.value).toBe(true);
    expect(h.sheet.trapActive.value).toBe(false);
    h.show(true);
    expect(h.sheet.trapActive.value).toBe(true);
    expect(h.focused.at(-1)).toBe("root");
    h.show(false);
    expect(h.sheet.trapActive.value).toBe(false);
    expect(h.focused.at(-1)).toBe("opener");
  });

  it("桌機：即使可見也不啟用焦點陷阱，按鍵不攔截", () => {
    const h = harness({ mobile: false });
    h.show(true);
    expect(h.sheet.trapActive.value).toBe(false);
    const e = h.key("Escape");
    expect(h.onClose).not.toHaveBeenCalled();
    expect(e.stopPropagation).not.toHaveBeenCalled();
  });

  it("Tab 在最後一個可見元素 → 回到第一個（略過未渲染元素）", () => {
    const h = harness({ mobile: true });
    h.show(true);
    h.setActive("diagnose");
    const e = h.key("Tab");
    expect(e.preventDefault).toHaveBeenCalled();
    expect(h.focused.at(-1)).toBe("close");
  });

  it("Shift+Tab 在第一個 → 跳到最後一個；焦點在容器本身時 Shift+Tab 也拉到最後一個", () => {
    const h = harness({ mobile: true });
    h.show(true);
    h.setActive("close");
    h.key("Tab", true);
    expect(h.focused.at(-1)).toBe("diagnose");
    h.setActive("root");
    h.key("Tab", true);
    expect(h.focused.at(-1)).toBe("diagnose");
  });

  it("Esc → 關閉並攔下冒泡（避免 AppLayout 的 window 監聽再關一次）", () => {
    const h = harness({ mobile: true });
    h.show(true);
    const e = h.key("Escape");
    expect(h.onClose).toHaveBeenCalledTimes(1);
    expect(e.stopPropagation).toHaveBeenCalled();
  });
});
