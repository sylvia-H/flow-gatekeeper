// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { createApp, defineComponent, effectScope, h, nextTick } from "vue";
import { ESCAPE_LAYERS, type EscapeLayerId } from "../lib/shortcuts.js";
import type { GridRect } from "../lib/focus-grid.js";
import {
  attachKeyboardShortcuts,
  useKeyboardShortcuts,
  type KeyboardShortcutHandlers,
  type UseKeyboardShortcutsOptions,
} from "./useKeyboardShortcuts.js";

/** 可變的假狀態：測試直接改它，handlers 的查詢函式讀它。 */
interface FakeState {
  selectedId: string | null;
  latchVisible: Set<string>;
  open: Record<EscapeLayerId, boolean>;
}

type FakeLayers = Record<EscapeLayerId, { isOpen: Mock<() => boolean>; close: Mock<() => void> }>;

interface FakeHandlers extends KeyboardShortcutHandlers {
  focusSearch: Mock<() => void>;
  selectMachine: Mock<(id: string) => void>;
  clearSelection: Mock<() => void>;
  diagnose: Mock<() => void>;
  clearLatch: Mock<(id: string) => void>;
  toggleHelp: Mock<() => void>;
  layers: FakeLayers;
}

let state: FakeState;
let handlers: FakeHandlers;
let searchInput: HTMLInputElement;
let cards: HTMLButtonElement[];
let detach: (() => void) | null = null;

function makeHandlers(): FakeHandlers {
  const layers = {} as FakeLayers;
  for (const { id } of ESCAPE_LAYERS) {
    layers[id] = {
      isOpen: vi.fn(() => state.open[id]),
      close: vi.fn(() => {
        state.open[id] = false;
      }),
    };
  }
  return {
    focusSearch: vi.fn(),
    selectMachine: vi.fn((id: string) => {
      state.selectedId = id;
    }),
    clearSelection: vi.fn(() => {
      state.selectedId = null;
    }),
    diagnose: vi.fn(),
    clearLatch: vi.fn(),
    toggleHelp: vi.fn(),
    getSelectedId: () => state.selectedId,
    isLatchVisible: (id: string) => state.latchVisible.has(id),
    layers,
  };
}

/** 3 欄 × 2 列的假卡片（每格 100×80、間距 20）；happy-dom 無版面，以 stub 提供 rect。 */
const GRID_IDS = ["a1", "a2", "a3", "b1", "b2", "b3"] as const;

function rectAt(col: number, row: number): GridRect & DOMRect {
  const left = col * 120;
  const top = row * 100;
  return { left, top, right: left + 100, bottom: top + 80, x: left, y: top, width: 100, height: 80 } as GridRect &
    DOMRect;
}

function makeCards(): HTMLButtonElement[] {
  return GRID_IDS.map((id, i) => {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "machine-card";
    card.dataset.machine = id;
    const rect = rectAt(i % 3, Math.floor(i / 3));
    card.getBoundingClientRect = () => rect;
    document.body.appendChild(card);
    return card;
  });
}

function card(id: string): HTMLButtonElement {
  const found = cards.find((c) => c.dataset.machine === id);
  if (!found) throw new Error(`找不到卡片 ${id}`);
  return found;
}

function attach(extra: Partial<UseKeyboardShortcutsOptions> = {}): void {
  detach = attachKeyboardShortcuts({ handlers, ...extra });
}

/** 從 `target` 派發 keydown（冒泡到 window），回傳事件供斷言 `defaultPrevented`。 */
function press(target: EventTarget, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

function allOpen(): Record<EscapeLayerId, boolean> {
  return { help: true, "search-overlay": true, "anomaly-overlay": true, "copilot-panel": true, selection: true };
}

function allClosed(): Record<EscapeLayerId, boolean> {
  return { help: false, "search-overlay": false, "anomaly-overlay": false, "copilot-panel": false, selection: false };
}

/** 除了 Escape 層的 isOpen 查詢以外，handlers 沒有任何呼叫。 */
function expectNoActionCalls(): void {
  expect(handlers.focusSearch).not.toHaveBeenCalled();
  expect(handlers.selectMachine).not.toHaveBeenCalled();
  expect(handlers.clearSelection).not.toHaveBeenCalled();
  expect(handlers.diagnose).not.toHaveBeenCalled();
  expect(handlers.clearLatch).not.toHaveBeenCalled();
  expect(handlers.toggleHelp).not.toHaveBeenCalled();
  for (const { id } of ESCAPE_LAYERS) expect(handlers.layers[id].close).not.toHaveBeenCalled();
}

beforeEach(() => {
  state = { selectedId: null, latchVisible: new Set(), open: allClosed() };
  handlers = makeHandlers();
  searchInput = document.createElement("input");
  document.body.appendChild(searchInput);
  cards = makeCards();
});

afterEach(() => {
  detach?.();
  detach = null;
  document.body.innerHTML = "";
});

describe("輸入欄與 IME 守門", () => {
  function editable(kind: "input" | "textarea" | "contenteditable"): HTMLElement {
    const el =
      kind === "contenteditable" ? document.createElement("div") : document.createElement(kind);
    if (kind === "contenteditable") el.setAttribute("contenteditable", "true");
    document.body.appendChild(el);
    return el;
  }

  it.each(["input", "textarea", "contenteditable"] as const)("焦點在 %s 時 / ? d x Escape 方向鍵都不觸發", (kind) => {
    attach();
    state.selectedId = "a1";
    state.open = { ...allOpen(), help: false };
    const el = editable(kind);
    for (const key of ["/", "?", "d", "x", "Escape", "ArrowRight"]) {
      const event = press(el, key);
      expect(event.defaultPrevented).toBe(false);
    }
    expectNoActionCalls();
  });

  it.each([
    ["isComposing", { isComposing: true }],
    ["keyCode 229", { keyCode: 229 }],
  ] as const)("IME 組字中（%s）不觸發任何快捷鍵", (_label, init) => {
    attach();
    state.selectedId = "a1";
    state.open = { ...allOpen(), help: false };
    card("a1").focus();
    for (const key of ["/", "?", "d", "x", "Escape", "ArrowRight"]) press(card("a1"), key, init);
    expectNoActionCalls();
    expect(document.activeElement).toBe(card("a1"));
  });

  it("已被上層處理（defaultPrevented）的按鍵不再處理", () => {
    attach();
    state.open = allOpen();
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    event.preventDefault();
    document.body.dispatchEvent(event);
    expectNoActionCalls();
  });

  it("帶 Ctrl／Meta／Alt 的組合鍵不搶（例如 Ctrl+D 加書籤）", () => {
    attach();
    state.selectedId = "a1";
    press(document.body, "d", { ctrlKey: true });
    press(document.body, "/", { metaKey: true });
    press(document.body, "?", { altKey: true, shiftKey: true });
    expectNoActionCalls();
  });
});

describe("Escape 每次只關最上層一項", () => {
  it("五層都開著時連按五次，依說明層 → 搜尋覆蓋 → 手機異常覆蓋層 → Copilot 面板 → 取消選取", () => {
    attach();
    state.open = allOpen();
    const order: EscapeLayerId[] = [];
    for (const { id } of ESCAPE_LAYERS) {
      handlers.layers[id].close.mockImplementation(() => {
        state.open[id] = false;
        order.push(id);
      });
    }

    for (let i = 1; i <= ESCAPE_LAYERS.length; i += 1) {
      const event = press(document.body, "Escape");
      expect(event.defaultPrevented).toBe(true);
      // 每按一次只多關一層。
      expect(order).toHaveLength(i);
    }
    expect(order).toEqual(["help", "search-overlay", "anomaly-overlay", "copilot-panel", "selection"]);

    // 全部關著後再按：不動作、不吃掉事件。
    const extra = press(document.body, "Escape");
    expect(extra.defaultPrevented).toBe(false);
    expect(order).toHaveLength(ESCAPE_LAYERS.length);
  });

  it("跳過關著的層：只有 Copilot 面板與選取開著時先關面板", () => {
    attach();
    state.open = { ...allClosed(), "copilot-panel": true, selection: true };
    press(document.body, "Escape");
    expect(handlers.layers["copilot-panel"].close).toHaveBeenCalledTimes(1);
    expect(handlers.layers.selection.close).not.toHaveBeenCalled();
  });

  it("關 Copilot 面板只呼叫該層的 close（當次 dismiss），不觸發其他 handler（不寫手動收合偏好）", () => {
    attach();
    state.open = { ...allClosed(), "copilot-panel": true, selection: true };
    state.selectedId = "a1";
    press(document.body, "Escape");

    expect(handlers.layers["copilot-panel"].close).toHaveBeenCalledTimes(1);
    expect(handlers.clearSelection).not.toHaveBeenCalled();
    expect(handlers.selectMachine).not.toHaveBeenCalled();
    expect(handlers.diagnose).not.toHaveBeenCalled();
    expect(handlers.toggleHelp).not.toHaveBeenCalled();
    for (const id of ["help", "search-overlay", "anomaly-overlay", "selection"] as const) {
      expect(handlers.layers[id].close).not.toHaveBeenCalled();
    }
    // 選取仍在。
    expect(state.selectedId).toBe("a1");
  });

  it("長按 Escape 的重複事件不連續關閉", () => {
    attach();
    state.open = allOpen();
    press(document.body, "Escape");
    press(document.body, "Escape", { repeat: true });
    press(document.body, "Escape", { repeat: true });
    expect(handlers.layers.help.close).toHaveBeenCalledTimes(1);
    expect(handlers.layers["search-overlay"].close).not.toHaveBeenCalled();
  });
});

describe("d：診斷選取機台", () => {
  it("有選取機台時呼叫注入的 diagnose", () => {
    attach();
    state.selectedId = "b2";
    const event = press(document.body, "d");
    expect(handlers.diagnose).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("無選取時不呼叫", () => {
    attach();
    press(document.body, "d");
    expect(handlers.diagnose).not.toHaveBeenCalled();
  });

  it("僅聚焦、未選取的卡片按 d 不作用", () => {
    attach();
    card("a2").focus();
    press(card("a2"), "d");
    expect(handlers.diagnose).not.toHaveBeenCalled();
    expect(handlers.selectMachine).not.toHaveBeenCalled();
  });
});

describe("搜尋框內的按鍵（Enter 只由 TopBar.onSearchEnter 處理，合併門第 1 輪 low）", () => {
  it("搜尋框 Enter 不由本 composable 選取、不攔截、不移焦（TopBar 為唯一處理者）", async () => {
    attach();
    searchInput.focus();
    const enter = press(searchInput, "Enter");
    await nextTick();
    expect(enter.defaultPrevented).toBe(false);
    expectNoActionCalls();
    expect(document.activeElement).toBe(searchInput);
  });

  it("搜尋框內的 d／x／? 等快捷鍵字元照常輸入，不觸發任何動作", () => {
    attach();
    state.selectedId = "a1";
    searchInput.focus();
    for (const key of ["d", "x", "?", "/"]) expect(press(searchInput, key).defaultPrevented).toBe(false);
    expectNoActionCalls();
  });

  it("搜尋框內的 Escape 不由本 composable 處理（覆蓋式搜尋自行收回）", () => {
    attach();
    state.open = allOpen();
    searchInput.focus();
    press(searchInput, "Escape");
    expectNoActionCalls();
  });
});

describe("x：確認聚焦卡片的異常標記", () => {
  it("聚焦卡片且標記可見時呼叫 clearLatch(該台)", () => {
    attach();
    state.latchVisible.add("a3");
    card("a3").focus();
    const event = press(card("a3"), "x");
    expect(handlers.clearLatch).toHaveBeenCalledExactlyOnceWith("a3");
    expect(event.defaultPrevented).toBe(true);
  });

  it("聚焦卡片但標記不可見時不呼叫", () => {
    attach();
    state.latchVisible.add("a1");
    card("a3").focus();
    press(card("a3"), "x");
    expect(handlers.clearLatch).not.toHaveBeenCalled();
  });

  it("焦點不在卡片上時不呼叫（即使選取機台的標記可見）", () => {
    attach();
    state.selectedId = "a1";
    state.latchVisible.add("a1");
    const other = document.createElement("button");
    document.body.appendChild(other);
    other.focus();
    press(other, "x");
    expect(handlers.clearLatch).not.toHaveBeenCalled();
  });
});

describe("? 與 /", () => {
  it("? 每按一次呼叫 toggleHelp（開關由注入端切換）", () => {
    attach();
    press(document.body, "?", { shiftKey: true });
    press(document.body, "?", { shiftKey: true });
    expect(handlers.toggleHelp).toHaveBeenCalledTimes(2);
  });

  it("/ 呼叫 focusSearch 並 preventDefault（避免把 / 輸入進搜尋框）", () => {
    attach();
    const event = press(document.body, "/");
    expect(handlers.focusSearch).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });
});

describe("說明層開著時只處理 ? 與 Escape", () => {
  it("/、d、x、方向鍵、非按鈕卡片 Enter 都不處理", () => {
    const div = document.createElement("div");
    div.className = "machine-card";
    div.tabIndex = 0;
    div.dataset.machine = "z9";
    document.body.appendChild(div);
    attach();
    state.open = { ...allClosed(), help: true, selection: true };
    state.selectedId = "a1";
    state.latchVisible.add("a1");

    card("a1").focus();
    for (const key of ["d", "x", "ArrowRight"]) {
      const event = press(card("a1"), key);
      expect(event.defaultPrevented).toBe(false);
    }
    // `/` 不聚焦搜尋，但吃掉瀏覽器預設（Firefox Quick Find，合併門第 3 輪 #3）
    expect(press(card("a1"), "/").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(card("a1"));
    div.focus();
    press(div, "Enter");
    expectNoActionCalls();
  });

  it("? 仍可關說明層，Escape 仍先關說明層", () => {
    attach();
    state.open = { ...allClosed(), help: true, selection: true };
    press(document.body, "?", { shiftKey: true });
    expect(handlers.toggleHelp).toHaveBeenCalledTimes(1);

    press(document.body, "Escape");
    expect(handlers.layers.help.close).toHaveBeenCalledTimes(1);
    expect(handlers.layers.selection.close).not.toHaveBeenCalled();

    // 說明層關閉後恢復正常處理。
    press(document.body, "/");
    expect(handlers.focusSearch).toHaveBeenCalledTimes(1);
  });
});

describe("手機異常覆蓋層開著時只處理 Escape 與 /", () => {
  it("d、x、方向鍵、?、非按鈕卡片 Enter 都不處理（不在覆蓋層底下對選取機台觸發診斷）", () => {
    const div = document.createElement("div");
    div.className = "machine-card";
    div.tabIndex = 0;
    div.dataset.machine = "z9";
    document.body.appendChild(div);
    attach();
    state.open = { ...allClosed(), "anomaly-overlay": true, "copilot-panel": true, selection: true };
    state.selectedId = "a1";
    state.latchVisible.add("a1");

    card("a1").focus();
    for (const key of ["d", "x", "ArrowRight"]) {
      const event = press(card("a1"), key);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(press(card("a1"), "?", { shiftKey: true }).defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(card("a1"));
    div.focus();
    press(div, "Enter");
    expectNoActionCalls();
  });

  it("/ 放行（搜尋覆蓋在異常覆蓋層之上）；Escape 先關異常覆蓋層，不連帶關面板", () => {
    attach();
    state.open = { ...allClosed(), "anomaly-overlay": true, "copilot-panel": true, selection: true };
    press(document.body, "/");
    expect(handlers.focusSearch).toHaveBeenCalledTimes(1);

    press(document.body, "Escape");
    expect(handlers.layers["anomaly-overlay"].close).toHaveBeenCalledTimes(1);
    expect(handlers.layers["copilot-panel"].close).not.toHaveBeenCalled();
  });

  it("搜尋覆蓋疊在異常覆蓋層之上時，Escape 先收回搜尋覆蓋", () => {
    attach();
    state.open = { ...allClosed(), "search-overlay": true, "anomaly-overlay": true };
    press(document.body, "Escape");
    expect(handlers.layers["search-overlay"].close).toHaveBeenCalledTimes(1);
    expect(handlers.layers["anomaly-overlay"].close).not.toHaveBeenCalled();
  });

  it("搜尋框內的 Enter 不由本 composable 處理（交 TopBar），覆蓋層開著也一樣", () => {
    attach();
    state.open = { ...allClosed(), "anomaly-overlay": true };
    searchInput.focus();
    const event = press(searchInput, "Enter");
    expect(event.defaultPrevented).toBe(false);
    expect(handlers.selectMachine).not.toHaveBeenCalled();
  });

  it("異常覆蓋層關閉後 d 恢復作用", () => {
    attach();
    state.open = { ...allClosed(), "anomaly-overlay": true, selection: true };
    state.selectedId = "a1";
    press(document.body, "d");
    expect(handlers.diagnose).not.toHaveBeenCalled();
    state.open = { ...allClosed(), selection: true };
    press(document.body, "d");
    expect(handlers.diagnose).toHaveBeenCalledTimes(1);
  });
});

describe("Copilot bottom-sheet 為 modal 時不處理 /（合併門第 2 輪 #2，比照說明層）", () => {
  it("isCopilotSheetModal=true：/ 不呼叫 focusSearch，但 preventDefault（Firefox Quick Find，合併門第 3 輪 #3）；sheet 退回非 modal 後恢復", () => {
    let modal = true;
    handlers.isCopilotSheetModal = () => modal;
    attach();
    state.open = { ...allClosed(), "copilot-panel": true, selection: true };
    const blocked = press(document.body, "/");
    expect(blocked.defaultPrevented).toBe(true);
    expect(handlers.focusSearch).not.toHaveBeenCalled();

    modal = false;
    const passed = press(document.body, "/");
    expect(passed.defaultPrevented).toBe(true);
    expect(handlers.focusSearch).toHaveBeenCalledTimes(1);
  });

  it("未提供 isCopilotSheetModal 時視為 false（/ 照常聚焦搜尋）", () => {
    attach();
    press(document.body, "/");
    expect(handlers.focusSearch).toHaveBeenCalledTimes(1);
  });
});

describe("方向鍵依視覺位置移焦（3 × 2）", () => {
  it.each([
    ["a2", "ArrowRight", "a3"],
    ["a2", "ArrowLeft", "a1"],
    ["a2", "ArrowDown", "b2"],
    ["b2", "ArrowUp", "a2"],
    ["b1", "ArrowRight", "b2"],
  ])("%s 按 %s → %s", (from, key, to) => {
    attach();
    card(from).focus();
    const event = press(card(from), key);
    expect(document.activeElement).toBe(card(to));
    expect(event.defaultPrevented).toBe(true);
  });

  it.each([
    ["a1", "ArrowLeft"],
    ["a1", "ArrowUp"],
    ["a3", "ArrowRight"],
    ["b3", "ArrowDown"],
  ])("邊界停留：%s 按 %s 不移動，仍吃掉事件（不捲動頁面）", (from, key) => {
    attach();
    card(from).focus();
    const event = press(card(from), key);
    expect(document.activeElement).toBe(card(from));
    expect(event.defaultPrevented).toBe(true);
  });

  it("焦點不在卡片上時不處理、不吃掉事件", () => {
    attach();
    const other = document.createElement("button");
    document.body.appendChild(other);
    other.focus();
    const event = press(other, "ArrowRight");
    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(other);
  });

  it("無尺寸（隱藏）的卡片不參與移焦", () => {
    attach();
    card("a2").getBoundingClientRect = () => ({ left: 0, top: 0, right: 0, bottom: 0 }) as DOMRect;
    card("a1").focus();
    press(card("a1"), "ArrowRight");
    expect(document.activeElement).toBe(card("a3"));
  });

  it("getCards 可注入：只在注入的卡片之間移動", () => {
    attach({ getCards: () => [card("a1"), card("b3")] });
    card("a1").focus();
    press(card("a1"), "ArrowRight");
    expect(document.activeElement).toBe(card("b3"));
  });
});

describe("Enter 在卡片上", () => {
  it("原生 <button> 卡片：不重複選取、不攔截（交給原生 click）", () => {
    attach();
    card("a1").focus();
    const event = press(card("a1"), "Enter");
    expect(handlers.selectMachine).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("非原生按鈕的卡片（tabindex=0 容器）：代為選取", () => {
    const div = document.createElement("div");
    div.className = "machine-card";
    div.tabIndex = 0;
    div.dataset.machine = "z9";
    document.body.appendChild(div);
    attach();
    div.focus();
    const event = press(div, "Enter");
    expect(handlers.selectMachine).toHaveBeenCalledExactlyOnceWith("z9");
    expect(event.defaultPrevented).toBe(true);
  });
});

describe("生命週期", () => {
  it("dispose 後不再處理任何按鍵", () => {
    const scope = effectScope();
    const api = scope.run(() => useKeyboardShortcuts({ handlers }));
    press(document.body, "/");
    expect(handlers.focusSearch).toHaveBeenCalledTimes(1);

    api?.dispose();
    press(document.body, "/");
    expect(handlers.focusSearch).toHaveBeenCalledTimes(1);
    scope.stop();
  });

  it("effectScope 結束時自動拆除", () => {
    const scope = effectScope();
    scope.run(() => useKeyboardShortcuts({ handlers }));
    scope.stop();
    press(document.body, "?");
    expect(handlers.toggleHelp).not.toHaveBeenCalled();
  });

  /** 以單一測試元件掛載 composable；`disposeInSetup` 為 true 時在 setup 內（mount 前）就 dispose。 */
  function mountHost(disposeInSetup: boolean): ReturnType<typeof createApp> {
    const Host = defineComponent({
      setup() {
        const api = useKeyboardShortcuts({ handlers });
        if (disposeInSetup) api.dispose();
        return () => h("div");
      },
    });
    const host = document.createElement("div");
    document.body.appendChild(host);
    const app = createApp(Host);
    app.mount(host);
    return app;
  }

  it("元件內：mounted 後才掛、unmounted 後拆", () => {
    const app = mountHost(false);
    press(document.body, "?");
    expect(handlers.toggleHelp).toHaveBeenCalledTimes(1);

    app.unmount();
    press(document.body, "?");
    expect(handlers.toggleHelp).toHaveBeenCalledTimes(1);
  });

  it("元件內：mount 前呼叫 dispose 會擋住之後的掛載", () => {
    const app = mountHost(true);
    press(document.body, "?");
    expect(handlers.toggleHelp).not.toHaveBeenCalled();
    app.unmount();
  });

  it("target 可注入：只監聽指定對象", () => {
    attach({ target: () => document });
    press(document.body, "/");
    expect(handlers.focusSearch).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "/", cancelable: true }));
    expect(handlers.focusSearch).toHaveBeenCalledTimes(1);
  });
});
