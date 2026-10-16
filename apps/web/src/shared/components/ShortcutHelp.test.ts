// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import { nextTick } from "vue";
import ShortcutHelp from "./ShortcutHelp.vue";
import { SHORTCUTS, SHORTCUT_FOOTNOTE, SHORTCUT_HELP_TITLE } from "../lib/shortcuts.js";

/**
 * 快捷鍵說明層（spec FR-034b、ui-contract §3–§4、tasks T055／T058）：
 * dialog 語意、內容由 `SHORTCUTS` 渲染（含 `x` 與 `?`）、Escape／關閉鈕關閉、焦點陷阱與還原、
 * 起於工具列下緣（`top-14`）不遮工具列。
 */

let wrapper: VueWrapper | null = null;

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  document.body.innerHTML = "";
});

function mountHelp(open = true): VueWrapper {
  wrapper = mount(ShortcutHelp, { props: { open }, attachTo: document.body });
  return wrapper;
}

const dialog = (w: VueWrapper) => w.get('[data-fg="shortcut-help"]');
const text = (el: Element): string => (el.textContent ?? "").replace(/\s+/g, " ").trim();

describe("ShortcutHelp 語意", () => {
  it("是 aria-modal 的 dialog，以標題命名", () => {
    const w = mountHelp();
    const el = dialog(w);
    expect(el.attributes("role")).toBe("dialog");
    expect(el.attributes("aria-modal")).toBe("true");
    const titleId = el.attributes("aria-labelledby");
    expect(titleId).toBeTruthy();
    const title = document.getElementById(titleId as string);
    expect(title?.tagName).toBe("H2");
    expect(title?.textContent?.trim()).toBe(SHORTCUT_HELP_TITLE);
  });

  it("捲動區以獨立名稱標示，不與 dialog 重複朗讀標題", () => {
    const w = mountHelp();
    const region = dialog(w).get('[role="region"]');
    expect(region.attributes("aria-label")).toBe("快捷鍵清單");
    expect(region.attributes("aria-labelledby")).toBeUndefined();
    expect(dialog(w).findAll("section[aria-labelledby]")).toHaveLength(0);
  });

  it("open=false 時不渲染", () => {
    const w = mountHelp(false);
    expect(w.find('[data-fg="shortcut-help"]').exists()).toBe(false);
    expect(document.querySelector(".bg-scrim\\/50")).toBeNull();
  });

  it("遮罩與面板起於工具列下緣（top-14），不遮工具列", () => {
    const w = mountHelp();
    const layer = dialog(w).element.parentElement as HTMLElement;
    expect(layer.classList).toContain("fixed");
    expect(layer.classList).toContain("top-14");
    expect(layer.classList).not.toContain("inset-0");
    expect(layer.querySelector(".bg-scrim\\/50")).not.toBeNull();
  });
});

describe("ShortcutHelp 內容由 SHORTCUTS 渲染", () => {
  it("列出全部快捷鍵，數量與常數相等", () => {
    const w = mountHelp();
    const rows = dialog(w).findAll("[data-shortcut]");
    expect(rows.map((r) => r.attributes("data-shortcut"))).toEqual(
      expect.arrayContaining(SHORTCUTS.map((s) => s.id)),
    );
    expect(rows).toHaveLength(SHORTCUTS.length);
  });

  it("每列以 kbd 顯示每個鍵，並含動作與條件文字", () => {
    const w = mountHelp();
    for (const entry of SHORTCUTS) {
      const row = dialog(w).get(`[data-shortcut="${entry.id}"]`);
      expect(row.findAll("kbd").map((k) => k.text())).toEqual([...entry.keys]);
      expect(text(row.element)).toContain(entry.action);
      expect(text(row.element)).toContain(entry.scope);
    }
  });

  it("含 x（清除異常標記）與 ? 兩項", () => {
    const w = mountHelp();
    const clear = dialog(w).get('[data-shortcut="clear-latch"]');
    expect(clear.get("kbd").text()).toBe("x");
    const toggle = dialog(w).get('[data-shortcut="toggle-help"]');
    expect(toggle.get("kbd").text()).toBe("?");
  });

  it("依四個分組呈現，順序為全域／搜尋／機台卡片／版面", () => {
    const w = mountHelp();
    expect(dialog(w).findAll("h3").map((h) => h.text())).toEqual(["全域", "搜尋", "機台卡片", "版面"]);
  });

  it("顯示註腳", () => {
    const w = mountHelp();
    expect(text(dialog(w).element)).toContain(SHORTCUT_FOOTNOTE);
  });
});

describe("ShortcutHelp 關閉", () => {
  it("Escape emit close 並攔下冒泡", async () => {
    const w = mountHelp();
    let reachedWindow = false;
    const onWindow = () => {
      reachedWindow = true;
    };
    window.addEventListener("keydown", onWindow);
    try {
      const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
      dialog(w).element.dispatchEvent(event);
      await nextTick();
      expect(w.emitted("close")).toHaveLength(1);
      expect(reachedWindow).toBe(false);
      expect(event.defaultPrevented).toBe(true);
    } finally {
      window.removeEventListener("keydown", onWindow);
    }
  });

  it("其他按鍵（如 ?）照常冒泡給 App 層", () => {
    const w = mountHelp();
    let reachedWindow = false;
    const onWindow = () => {
      reachedWindow = true;
    };
    window.addEventListener("keydown", onWindow);
    try {
      dialog(w).element.dispatchEvent(new KeyboardEvent("keydown", { key: "?", bubbles: true }));
      expect(reachedWindow).toBe(true);
      expect(w.emitted("close")).toBeUndefined();
    } finally {
      window.removeEventListener("keydown", onWindow);
    }
  });

  it("關閉鈕 emit close", async () => {
    const w = mountHelp();
    await w.get('button[aria-label="關閉快捷鍵說明"]').trigger("click");
    expect(w.emitted("close")).toHaveLength(1);
  });

  it("點遮罩 emit close", async () => {
    const w = mountHelp();
    const scrim = dialog(w).element.parentElement?.querySelector(".bg-scrim\\/50") as HTMLElement;
    scrim.click();
    expect(w.emitted("close")).toHaveLength(1);
  });
});

describe("ShortcutHelp 焦點", () => {
  it("開啟時焦點在面板內，Tab 在面板內循環", async () => {
    const w = mountHelp();
    await nextTick();
    const panel = dialog(w).element as HTMLElement;
    expect(panel.contains(document.activeElement)).toBe(true);

    const items = Array.from(
      panel.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex]:not([tabindex="-1"])'),
    );
    expect(items.length).toBeGreaterThanOrEqual(2);
    const first = items[0] as HTMLElement;
    const last = items[items.length - 1] as HTMLElement;

    // 焦點在面板本身時 Tab 拉到第一個
    await dialog(w).trigger("keydown", { key: "Tab" });
    expect(document.activeElement).toBe(first);

    // 最後一個按 Tab 回到第一個
    last.focus();
    await dialog(w).trigger("keydown", { key: "Tab" });
    expect(document.activeElement).toBe(first);

    // 第一個按 Shift+Tab 到最後一個
    await dialog(w).trigger("keydown", { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it("關閉後焦點回到開啟前的元素", async () => {
    const opener = document.createElement("button");
    opener.textContent = "開啟";
    document.body.appendChild(opener);
    opener.focus();

    const w = mountHelp(false);
    await w.setProps({ open: true });
    await nextTick();
    expect(dialog(w).element.contains(document.activeElement)).toBe(true);

    await w.setProps({ open: false });
    expect(document.activeElement).toBe(opener);
  });

  it("開著時直接卸載，焦點回到開啟前的元素", async () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();

    const w = mountHelp(false);
    await w.setProps({ open: true });
    await nextTick();
    expect(dialog(w).element.contains(document.activeElement)).toBe(true);

    w.unmount();
    wrapper = null;
    expect(document.activeElement).toBe(opener);
  });

  it("關閉前使用者已聚焦面板外的元素時，不搶走焦點", async () => {
    const opener = document.createElement("button");
    const toolbarButton = document.createElement("button");
    document.body.append(opener, toolbarButton);
    opener.focus();

    const w = mountHelp(false);
    await w.setProps({ open: true });
    await nextTick();

    toolbarButton.focus();
    await w.setProps({ open: false });
    expect(document.activeElement).toBe(toolbarButton);
  });
});
