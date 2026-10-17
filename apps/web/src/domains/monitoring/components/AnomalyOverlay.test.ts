// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import { nextTick } from "vue";
import AnomalyOverlay from "./AnomalyOverlay.vue";
import type { AnomalySummaryItem } from "../lib/anomaly-latch.js";

/**
 * 手機異常清單覆蓋層（T061；FR-033a、FR-034a、ui-contract §3）：純 props／emit 的容器，
 * 內容重用 AnomalySummary；dialog 語意、起於工具列下緣、選台後收合、確認不收合、
 * Escape／遮罩／關閉鈕收合、焦點陷阱與還原。
 */

const NOW = 100_000;

const ITEMS: AnomalySummaryItem[] = [
  { machineId: "press-02", label: "壓製機 02", level: "critical", active: true, struck: false, since: NOW - 12_000 },
  { machineId: "oven-04", label: "烤爐 04", level: "warning", active: false, struck: false, since: NOW - 5_000 },
];

let wrapper: VueWrapper | null = null;

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  document.body.innerHTML = "";
});

function mountOverlay(
  props: Partial<{ open: boolean; items: readonly AnomalySummaryItem[]; selectedId: string | null; panelId: string }> = {},
): VueWrapper {
  wrapper = mount(AnomalyOverlay, {
    props: { open: true, items: ITEMS, now: NOW, selectedId: null, ...props },
    attachTo: document.body,
  });
  return wrapper;
}

const dialog = (w: VueWrapper) => w.get('[data-fg="anomaly-overlay"]');

describe("AnomalyOverlay 語意與版面", () => {
  it("open=false 時不渲染（含遮罩）", () => {
    const w = mountOverlay({ open: false });
    expect(w.find('[data-fg="anomaly-overlay"]').exists()).toBe(false);
    expect(document.querySelector(".bg-scrim\\/50")).toBeNull();
  });

  it("是 aria-modal 的 dialog，名稱「異常清單」，id 預設供摘要條 aria-controls 指向", () => {
    const w = mountOverlay();
    const el = dialog(w);
    expect(el.attributes("role")).toBe("dialog");
    expect(el.attributes("aria-modal")).toBe("true");
    expect(el.attributes("aria-label")).toBe("異常清單");
    expect(el.attributes("id")).toBe("anomaly-overlay-panel");
  });

  it("panelId 可覆寫面板 id", () => {
    const w = mountOverlay({ panelId: "custom-panel" });
    expect(dialog(w).attributes("id")).toBe("custom-panel");
  });

  it("遮罩與面板起於工具列下緣（top-14）、fixed 疊在版面上，不遮工具列", () => {
    const w = mountOverlay();
    const layer = dialog(w).element.parentElement as HTMLElement;
    expect(layer.classList).toContain("fixed");
    expect(layer.classList).toContain("top-14");
    expect(layer.classList).not.toContain("inset-0");
    expect(layer.querySelector(".bg-scrim\\/50")).not.toBeNull();
    expect(dialog(w).classes()).toContain("bg-surface-strong");
  });

  it("面板從摘要條下緣開始（top-16），高度扣掉上方 64px 與下緣 8px", () => {
    const w = mountOverlay();
    expect(dialog(w).classes()).toEqual(expect.arrayContaining(["top-16", "max-h-[calc(100%-4.5rem)]"]));
  });

  it("關閉鈕在不捲動的標題列，不在清單捲動區內；清單的 h2 轉為 sr-only 仍命名清單", () => {
    const w = mountOverlay();
    const scroll = dialog(w).get('[data-fg="anomaly-overlay-scroll"]');
    expect(scroll.classes()).toContain("overflow-y-auto");
    expect(scroll.find('[aria-label="關閉異常清單"]').exists()).toBe(false);
    const close = dialog(w).get('[aria-label="關閉異常清單"]');
    expect(close.element.compareDocumentPosition(scroll.element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(scroll.classes()).toContain("[&>section>h2]:sr-only");
    const summary = scroll.get('[data-fg="anomaly-summary"]');
    expect(summary.attributes("aria-labelledby")).toBe(summary.get("h2").attributes("id"));
  });

  it("內含 AnomalySummary 並轉接 items 與 selectedId", () => {
    const w = mountOverlay({ selectedId: "oven-04" });
    const summary = dialog(w).get('[data-fg="anomaly-summary"]');
    expect(summary.findAll("[data-machine]").map((r) => r.attributes("data-machine"))).toEqual([
      "press-02",
      "oven-04",
    ]);
    expect(summary.get('[data-machine="oven-04"] [data-fg="anomaly-select"]').attributes("aria-current")).toBe("true");
  });

  it("沒有異常時顯示空狀態，關閉鈕仍可用", () => {
    const w = mountOverlay({ items: [] });
    expect(dialog(w).text()).toContain("目前沒有異常");
    expect(dialog(w).find('[aria-label="關閉異常清單"]').exists()).toBe(true);
  });
});

describe("AnomalyOverlay 事件", () => {
  it("點列：emit select（機台 id）後 emit close", async () => {
    const w = mountOverlay();
    await dialog(w).get('[data-machine="press-02"] [data-fg="anomaly-select"]').trigger("click");
    expect(w.emitted("select")).toEqual([["press-02"]]);
    expect(w.emitted("close")).toHaveLength(1);
  });

  it("確認：只 emit clear，不收合", async () => {
    const w = mountOverlay();
    await dialog(w).get('[data-machine="oven-04"] [data-fg="anomaly-clear"]').trigger("click");
    expect(w.emitted("clear")).toEqual([["oven-04"]]);
    expect(w.emitted("close")).toBeUndefined();
  });

  it("Escape：emit close，攔下冒泡並 preventDefault", async () => {
    const w = mountOverlay();
    let reachedWindow = false;
    const onWindow = () => {
      reachedWindow = true;
    };
    window.addEventListener("keydown", onWindow);
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    dialog(w).element.dispatchEvent(event);
    window.removeEventListener("keydown", onWindow);
    expect(w.emitted("close")).toHaveLength(1);
    expect(event.defaultPrevented).toBe(true);
    expect(reachedWindow).toBe(false);
  });

  it("點遮罩 emit close", async () => {
    const w = mountOverlay();
    await w.get('[data-fg="anomaly-overlay-scrim"]').trigger("click");
    expect(w.emitted("close")).toHaveLength(1);
  });

  it("關閉鈕 emit close", async () => {
    const w = mountOverlay();
    await dialog(w).get('[aria-label="關閉異常清單"]').trigger("click");
    expect(w.emitted("close")).toHaveLength(1);
  });
});

describe("AnomalyOverlay 焦點", () => {
  it("開啟時焦點移進面板；關閉後還給開啟前的元素", async () => {
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();

    const w = mountOverlay({ open: false });
    await w.setProps({ open: true });
    await nextTick();
    expect(document.activeElement).toBe(dialog(w).element);

    await w.setProps({ open: false });
    expect(document.activeElement).toBe(trigger);
  });

  it("使用者已點了面板外的元素時，關閉不搶回焦點", async () => {
    const trigger = document.createElement("button");
    const outside = document.createElement("button");
    document.body.append(trigger, outside);
    trigger.focus();

    const w = mountOverlay({ open: false });
    await w.setProps({ open: true });
    await nextTick();
    outside.focus();

    await w.setProps({ open: false });
    expect(document.activeElement).toBe(outside);
  });

  it("焦點停在面板本身時，Tab 進第一個按鈕、Shift+Tab 進最後一個", async () => {
    const w = mountOverlay();
    await nextTick();
    const panel = dialog(w).element as HTMLElement;
    const buttons = dialog(w).findAll("button").map((b) => b.element as HTMLButtonElement);
    expect(document.activeElement).toBe(panel);

    panel.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(buttons[0]);

    panel.focus();
    panel.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(buttons[buttons.length - 1]);
  });

  it("Tab／Shift+Tab 在面板內循環", async () => {
    const w = mountOverlay();
    await nextTick();
    const buttons = dialog(w).findAll("button").map((b) => b.element as HTMLButtonElement);
    const first = buttons[0]!;
    const last = buttons[buttons.length - 1]!;
    expect(first.getAttribute("aria-label")).toBe("關閉異常清單");

    last.focus();
    dialog(w).element.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(first);

    dialog(w).element.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }),
    );
    expect(document.activeElement).toBe(last);
  });
});
