import { describe, expect, it, vi } from "vitest";
import { MOBILE_QUERY, createModalSheet, nextTrapTarget } from "./useModalSheet.js";

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

function harness(opts: { mobile: boolean; autoFocus?: () => boolean }) {
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
  }, { autoFocus: opts.autoFocus });
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
    el,
    setActive: (name: string) => (active = el(name)),
    clearActive: () => (active = null),
    show: (v: boolean) => ioCallback?.([{ isIntersecting: v }]),
  };
}

describe("createModalSheet：不搶焦點的非 modal 開啟（critique 第二輪 P1／鍵盤使用者）", () => {
  it("autoFocus=false 且焦點在卡片：open 但不接手、不攔 Escape；關閉時不搬動焦點", () => {
    const h = harness({ mobile: true, autoFocus: () => false });
    h.setActive("opener");
    h.show(true);
    expect(h.sheet.open.value).toBe(true);
    expect(h.sheet.trapActive.value).toBe(false);
    expect(h.focused).toEqual([]);
    const e = h.key("Escape");
    expect(h.onClose).not.toHaveBeenCalled();
    expect(e.stopPropagation).not.toHaveBeenCalled();
    h.show(false);
    expect(h.sheet.open.value).toBe(false);
    expect(h.focused).toEqual([]);
  });

  it("autoFocus=false 且焦點在 body（觸控 Safari 點卡片不給焦點）→ 不強制接手，維持非 modal（第三輪交叉審查 medium）", () => {
    const h = harness({ mobile: true, autoFocus: () => false });
    h.clearActive();
    h.show(true);
    expect(h.sheet.open.value).toBe(true);
    expect(h.sheet.trapActive.value).toBe(false);
    expect(h.focused).toEqual([]);
  });

  it("autoFocus=true 且焦點在 body（空狀態或有可操作內容）→ 照樣接手", () => {
    const h = harness({ mobile: true, autoFocus: () => true });
    h.clearActive();
    h.show(true);
    expect(h.sheet.trapActive.value).toBe(true);
    expect(h.focused.at(-1)).toBe("root");
  });

  it("engage()：開著時改由程式接手並記下原焦點，關閉時歸還；未開時無作用", () => {
    const h = harness({ mobile: true, autoFocus: () => false });
    h.setActive("opener");
    h.sheet.engage();
    expect(h.sheet.trapActive.value).toBe(false); // 尚未出現
    h.show(true);
    h.sheet.engage();
    expect(h.sheet.trapActive.value).toBe(true);
    expect(h.focused.at(-1)).toBe("root");
    h.show(false);
    expect(h.focused.at(-1)).toBe("opener");
  });

  it("onFocusIn：使用者自己進入 sheet → 接手（不再搬焦點），關閉時把焦點還給它離開的元素", () => {
    const h = harness({ mobile: true, autoFocus: () => false });
    h.setActive("opener");
    h.show(true);
    h.setActive("diagnose");
    h.sheet.onFocusIn({ relatedTarget: h.el("opener") });
    expect(h.sheet.trapActive.value).toBe(true);
    expect(h.focused).toEqual([]);
    const e = h.key("Escape");
    expect(h.onClose).toHaveBeenCalledTimes(1);
    expect(e.stopPropagation).toHaveBeenCalled();
    h.show(false);
    expect(h.focused.at(-1)).toBe("opener");
  });

  it("桌機：onFocusIn／engage 都不啟用焦點陷阱", () => {
    const h = harness({ mobile: false });
    h.show(true);
    h.sheet.onFocusIn({ relatedTarget: null });
    h.sheet.engage();
    expect(h.sheet.open.value).toBe(false);
    expect(h.sheet.trapActive.value).toBe(false);
  });
});

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

  it("Esc → 關閉並攔下冒泡（避免 App 層 useKeyboardShortcuts 的 window 監聽再關一次）", () => {
    const h = harness({ mobile: true });
    h.show(true);
    const e = h.key("Escape");
    expect(h.onClose).toHaveBeenCalledTimes(1);
    expect(e.stopPropagation).toHaveBeenCalled();
  });
});

describe("bottom sheet 斷點（T073 D：推擠式側欄門檻 lg→desk／1366）", () => {
  it("< 1366px 為 sheet：查詢字串與 AppLayout 的 desk 斷點一致，attach 時以它查詢", () => {
    expect(MOBILE_QUERY).toBe("(max-width: 1365.98px)");
    const matchMedia = vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    const sheet = createModalSheet(() => null, vi.fn(), {
      matchMedia,
      activeElement: () => null,
      defer: (fn) => fn(),
    });
    sheet.attach();
    expect(matchMedia).toHaveBeenCalledWith(MOBILE_QUERY);
    expect(sheet.isSheet.value).toBe(true);
    sheet.detach();
  });
});
