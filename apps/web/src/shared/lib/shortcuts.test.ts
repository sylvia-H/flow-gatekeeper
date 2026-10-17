// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import {
  ESCAPE_LAYERS,
  isImeComposing,
  isTypingTarget,
  SHORTCUT_FOOTNOTE,
  SHORTCUT_HELP_TITLE,
  SHORTCUTS,
} from "./shortcuts.js";

afterEach(() => {
  document.body.innerHTML = "";
});

/** 在元素上 dispatch keydown 並回傳該事件（dispatch 後 `target` 已設好）。 */
function keydownOn(el: EventTarget, init: KeyboardEventInit = { key: "d" }): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, ...init });
  el.dispatchEvent(event);
  return event;
}

/** 帶 keyCode 229 的事件（KeyboardEventInit 不保證支援 keyCode，直接覆寫屬性）。 */
function imeProcessEvent(): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: "Process" });
  Object.defineProperty(event, "keyCode", { value: 229 });
  return event;
}

function mount<K extends keyof HTMLElementTagNameMap>(tag: K): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  document.body.appendChild(el);
  return el;
}

const byId = (id: string) => SHORTCUTS.find((s) => s.id === id);

describe("isImeComposing — 輸入法組字判定", () => {
  it("isComposing → true", () => {
    expect(isImeComposing(new KeyboardEvent("keydown", { key: "d", isComposing: true }))).toBe(true);
  });

  it("keyCode 229 → true", () => {
    expect(isImeComposing(imeProcessEvent())).toBe(true);
  });

  it("一般按鍵 → false", () => {
    expect(isImeComposing(new KeyboardEvent("keydown", { key: "d" }))).toBe(false);
  });
});

describe("isTypingTarget — 輸入情境判定（data-model §11）", () => {
  it.each(["input", "textarea", "select"] as const)("焦點在 %s → true", (tag) => {
    expect(isTypingTarget(keydownOn(mount(tag)))).toBe(true);
  });

  it("contenteditable 元素本身 → true", () => {
    const el = mount("div");
    el.setAttribute("contenteditable", "true");
    expect(isTypingTarget(keydownOn(el))).toBe(true);
  });

  it("contenteditable 祖先內的子元素 → true", () => {
    const host = mount("div");
    host.setAttribute("contenteditable", "");
    const child = document.createElement("span");
    host.appendChild(child);
    expect(isTypingTarget(keydownOn(child))).toBe(true);
  });

  it('contenteditable="false" → false', () => {
    const el = mount("div");
    el.setAttribute("contenteditable", "false");
    expect(isTypingTarget(keydownOn(el))).toBe(false);
  });

  it('可編輯區內夾 contenteditable="false" 區塊：其子元素 → false', () => {
    const host = mount("div");
    host.setAttribute("contenteditable", "true");
    const island = document.createElement("div");
    island.setAttribute("contenteditable", "false");
    const child = document.createElement("button");
    island.appendChild(child);
    host.appendChild(island);
    expect(isTypingTarget(keydownOn(child))).toBe(false);
  });

  it("isComposing（IME 組字中）→ true，即使焦點不在輸入欄", () => {
    expect(isTypingTarget(keydownOn(mount("div"), { key: "d", isComposing: true }))).toBe(true);
  });

  it("keyCode 229（IME 處理中）→ true，即使焦點不在輸入欄", () => {
    expect(isTypingTarget(imeProcessEvent())).toBe(true);
  });

  it.each(["div", "button"] as const)("一般 %s → false", (tag) => {
    expect(isTypingTarget(keydownOn(mount(tag)))).toBe(false);
  });

  it("target 為 null（未 dispatch 的事件）→ false", () => {
    const event = new KeyboardEvent("keydown", { key: "/" });
    expect(event.target).toBeNull();
    expect(isTypingTarget(event)).toBe(false);
  });

  it("target 不是 Element（document）→ false", () => {
    expect(isTypingTarget(keydownOn(document))).toBe(false);
  });
});

describe("SHORTCUTS — 說明層與 composable 共用的對照表", () => {
  it("說明層標題與註腳", () => {
    expect(SHORTCUT_HELP_TITLE).toBe("鍵盤快捷鍵");
    expect(SHORTCUT_FOOTNOTE).toBe("在輸入欄或輸入法組字中時，字母與符號快捷鍵不會觸發。");
  });

  it("涵蓋 data-model §11 全部項目，id 不重複", () => {
    const ids = SHORTCUTS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(
      expect.arrayContaining([
        "focus-search",
        "search-select",
        "card-move",
        "card-select",
        "diagnose",
        "clear-latch",
        "escape",
        "toggle-help",
        "resize-sidebar",
        "resize-events",
      ]),
    );
    expect(ids).toHaveLength(10);
  });

  it("每項都有顯示按鍵、比對按鍵、動作與條件文案，且 keys 與 eventKeys 數量一致", () => {
    for (const s of SHORTCUTS) {
      expect(s.keys.length).toBeGreaterThan(0);
      expect(s.eventKeys.length).toBeGreaterThan(0);
      expect(s.eventKeys).toHaveLength(s.keys.length);
      expect(s.action.trim()).not.toBe("");
      expect(s.scope.trim()).not.toBe("");
    }
  });

  it("字母與符號快捷鍵：/、?、d、x，條件統一為「焦點不在輸入欄」", () => {
    for (const [id, key] of [
      ["focus-search", "/"],
      ["toggle-help", "?"],
      ["diagnose", "d"],
      ["clear-latch", "x"],
    ] as const) {
      expect(byId(id)?.keys).toEqual([key]);
      expect(byId(id)?.eventKeys).toEqual([key]);
      expect(byId(id)?.scope).toBe("焦點不在輸入欄");
    }
  });

  it("card-move：四個方向鍵", () => {
    const move = byId("card-move");
    expect(move?.keys).toEqual(["↑", "↓", "←", "→"]);
    expect(move?.eventKeys).toEqual(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);
  });

  it("把手：側欄 →／←、事件流 ↑／↓，並寫明步進與範圍", () => {
    const sidebar = byId("resize-sidebar");
    const events = byId("resize-events");
    expect(sidebar?.keys).toEqual(["→", "←"]);
    expect(sidebar?.eventKeys).toEqual(["ArrowRight", "ArrowLeft"]);
    expect(events?.keys).toEqual(["↑", "↓"]);
    expect(events?.eventKeys).toEqual(["ArrowUp", "ArrowDown"]);
    expect(sidebar?.action).toContain("16px");
    expect(sidebar?.action).toContain("200–420px");
    expect(events?.action).toContain("16px");
    expect(events?.action).toContain("100–360px");
  });

  it("Enter：搜尋框與卡片兩項", () => {
    expect(byId("search-select")?.eventKeys).toEqual(["Enter"]);
    expect(byId("card-select")?.eventKeys).toEqual(["Enter"]);
  });

  it("Escape 五層順序：快捷鍵說明 → 搜尋 → 異常清單（手機）→ AI 診斷面板 → 取消選取", () => {
    expect(ESCAPE_LAYERS.map((l) => l.id)).toEqual([
      "help",
      "search-overlay",
      "anomaly-overlay",
      "copilot-panel",
      "selection",
    ]);
    expect(ESCAPE_LAYERS.map((l) => l.label)).toEqual([
      "快捷鍵說明",
      "搜尋",
      "異常清單（手機）",
      "AI 診斷面板",
      "選取",
    ]);
    const escape = byId("escape");
    expect(escape?.keys).toEqual(["Escape"]);
    expect(escape?.eventKeys).toEqual(["Escape"]);
    expect(escape?.action).toBe("依序關閉最上層：快捷鍵說明 → 搜尋 → 異常清單（手機） → AI 診斷面板 → 取消選取");
    expect(escape?.scope).toBe("每次只關一層");
  });

  it("UI 文案不出現「Copilot」（research R13：UI 寫「AI 診斷」）", () => {
    const texts = [
      ...SHORTCUTS.flatMap((s) => [s.action, s.scope]),
      ...ESCAPE_LAYERS.map((l) => l.label),
      SHORTCUT_HELP_TITLE,
      SHORTCUT_FOOTNOTE,
    ];
    for (const t of texts) expect(t).not.toMatch(/copilot/i);
  });
});
