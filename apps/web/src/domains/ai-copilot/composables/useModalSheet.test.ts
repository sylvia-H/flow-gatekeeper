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

function harness(opts: { mobile: boolean; autoFocus?: () => boolean; restoreTarget?: () => FakeEl | null }) {
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
  // sheet 內＝opener 以外的元素（opener 代表 sheet 外的卡片）。
  const root = { ...mk("root"), querySelectorAll: () => children, contains: (other: unknown) => other !== null && other !== el("opener") };
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
  }, { autoFocus: opts.autoFocus, restoreTarget: opts.restoreTarget });
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

describe("createModalSheet.disengage：modal 退回非 modal（合併門第 2 輪 #1）", () => {
  it("焦點仍在 sheet 內（中止鈕）→ 解除焦點陷阱、焦點移到指定目標，搬焦點時的 focusin 不再接手；之後關閉不歸還焦點", () => {
    const h = harness({ mobile: true, autoFocus: () => false });
    h.setActive("opener");
    h.show(true);
    h.sheet.engage();
    expect(h.sheet.trapActive.value).toBe(true);
    h.setActive("close"); // 模擬焦點在 sheet 內的按鈕

    const target = {
      focus: () => {
        h.setActive("diagnose");
        // 真瀏覽器裡 focus() 會同步派發 focusin；搬焦點期間不得被當成「使用者自己進來」
        h.sheet.onFocusIn({ relatedTarget: null });
      },
      getClientRects: () => ({ length: 1 }),
    };
    h.sheet.disengage(() => target);
    expect(h.sheet.trapActive.value).toBe(false);
    expect(h.sheet.open.value).toBe(true);
    // 非 modal：Escape 不由 sheet 攔
    const e = h.key("Escape");
    expect(h.onClose).not.toHaveBeenCalled();
    expect(e.stopPropagation).not.toHaveBeenCalled();

    h.show(false);
    expect(h.focused.at(-1)).not.toBe("opener");
  });

  it("焦點遺失（中止鈕隨單列切換被移除，activeElement＝null）→ 同樣移到目標", () => {
    const h = harness({ mobile: true });
    h.show(true);
    h.clearActive();
    const focus = vi.fn();
    h.sheet.disengage(() => ({ focus, getClientRects: () => ({ length: 1 }) }));
    expect(focus).toHaveBeenCalledTimes(1);
    expect(h.sheet.trapActive.value).toBe(false);
  });

  it("焦點已在 sheet 外（搜尋 Enter 後移到卡片）→ 不搬動焦點", () => {
    const h = harness({ mobile: true });
    h.show(true);
    h.setActive("opener");
    const focus = vi.fn();
    h.sheet.disengage(() => ({ focus, getClientRects: () => ({ length: 1 }) }));
    expect(focus).not.toHaveBeenCalled();
    expect(h.sheet.trapActive.value).toBe(false);
  });

  it("未接手時無作用（不搬焦點）", () => {
    const h = harness({ mobile: true, autoFocus: () => false });
    h.show(true);
    const focus = vi.fn();
    h.sheet.disengage(() => ({ focus, getClientRects: () => ({ length: 1 }) }));
    expect(focus).not.toHaveBeenCalled();
  });

  it("onFocusIn：焦點在 sheet 內部移動（fromInside）不接手；從外面進來才接手", () => {
    const h = harness({ mobile: true, autoFocus: () => false });
    h.show(true);
    h.sheet.onFocusIn({ relatedTarget: h.el("diagnose"), fromInside: true });
    expect(h.sheet.trapActive.value).toBe(false);
    h.sheet.onFocusIn({ relatedTarget: h.el("opener"), fromInside: false });
    expect(h.sheet.trapActive.value).toBe(true);
  });
});

describe("createModalSheet 斷點監聽走共用 onMediaChange（合併門第 2 輪 #11）", () => {
  it("舊 Safari 只有 addListener：仍能隨斷點切換 sheet 形態，detach 時解除", () => {
    const listeners = new Set<(e: { matches: boolean }) => void>();
    const list = {
      matches: false,
      addListener: vi.fn((cb: (e: { matches: boolean }) => void) => void listeners.add(cb)),
      removeListener: vi.fn((cb: (e: { matches: boolean }) => void) => void listeners.delete(cb)),
    };
    const sheet = createModalSheet(() => null, vi.fn(), {
      matchMedia: () => list,
      activeElement: () => null,
      defer: (fn) => fn(),
    });
    sheet.attach();
    expect(sheet.isSheet.value).toBe(false);
    expect(list.addListener).toHaveBeenCalledTimes(1);
    listeners.forEach((cb) => cb({ matches: true }));
    expect(sheet.isSheet.value).toBe(true);
    sheet.detach();
    expect(list.removeListener).toHaveBeenCalledTimes(1);
    expect(listeners.size).toBe(0);
  });
});

describe("createModalSheet.engage 已接手時：焦點遺失才拉回根節點（合併門第 2 輪實測追加）", () => {
  it("已接手、焦點掉到 body（被點的「診斷」鈕隨標頭切換被移除）→ 移到根節點", () => {
    const h = harness({ mobile: true, autoFocus: () => false });
    h.setActive("opener");
    h.show(true);
    h.setActive("diagnose");
    h.sheet.onFocusIn({ relatedTarget: h.el("opener") }); // 點「診斷」：focusin 接手
    expect(h.sheet.trapActive.value).toBe(true);
    h.clearActive(); // 該鈕被移除
    h.sheet.engage();
    expect(h.focused.at(-1)).toBe("root");
    expect(h.sheet.trapActive.value).toBe(true);
  });

  it("已接手、焦點仍在 sheet 內 → 不動；焦點在已移除（sheet 外）的節點 → 拉回根節點", () => {
    const h = harness({ mobile: true });
    h.show(true);
    expect(h.focused).toEqual(["root"]);
    h.setActive("close");
    h.sheet.engage();
    expect(h.focused).toEqual(["root"]);
    h.setActive("opener"); // contains 回 false（模擬已脫離 DOM 的節點）
    h.sheet.engage();
    expect(h.focused).toEqual(["root", "root"]);
  });
});

describe("createModalSheet 關閉時的焦點歸還（合併門第 3 輪 #1）", () => {
  /** card：sheet 外的選取卡（restoreTarget 的回傳值）。 */
  function withCard(autoFocus = () => false) {
    let card: FakeEl | null = null;
    const h = harness({ mobile: true, autoFocus, restoreTarget: () => card });
    card = h.el("opener");
    return h;
  }

  it("disengage 後焦點留在 sheet 內，從 sheet 內收合（隱藏）→ 歸還到 restoreTarget（選取卡）", () => {
    const h = withCard();
    h.show(true);
    h.sheet.engage();
    h.sheet.disengage(() => h.el("diagnose"));
    h.setActive("close"); // 焦點在 sheet 內的收合鈕
    h.show(false);
    expect(h.focused.at(-1)).toBe("opener");
  });

  it("disengage 後焦點已遺失（aside 隱藏時瀏覽器把焦點丟回 body）→ 同樣歸還", () => {
    const h = withCard();
    h.show(true);
    h.sheet.engage();
    h.sheet.disengage();
    h.clearActive();
    const before = h.focused.length;
    h.show(false);
    expect(h.focused.length).toBe(before + 1);
    expect(h.focused.at(-1)).toBe("opener");
  });

  it("從未接手、焦點一直在外面（卡片）→ 隱藏時不搬動焦點", () => {
    const h = withCard();
    h.setActive("opener");
    h.show(true);
    const before = h.focused.length;
    h.show(false);
    expect(h.focused.length).toBe(before);
  });

  it("接手前的元素在 sheet 內（例如根節點；隱藏後對它 focus() 無效）→ 退用 restoreTarget（合併門最後一批 #1）", () => {
    const h = withCard(() => true);
    h.setActive("close"); // sheet 內的元素
    h.show(true); // autoFocus：記下 close 為 restoreTo 並接手
    h.show(false);
    expect(h.focused.at(-1)).toBe("opener");
  });

  it("接手前的元素已脫離 DOM → 退用 restoreTarget", () => {
    const h = withCard(() => true);
    h.setActive("hidden");
    h.el("hidden")!.isConnected = false;
    h.show(true); // autoFocus：記下 hidden 為 restoreTo 並接手
    h.show(false);
    expect(h.focused.at(-1)).toBe("opener");
  });
});
