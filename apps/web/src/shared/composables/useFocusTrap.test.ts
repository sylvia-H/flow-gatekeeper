// @vitest-environment happy-dom
import { mount, type VueWrapper } from "@vue/test-utils";
import { afterEach, describe, expect, it } from "vitest";
import { defineComponent, h, nextTick, ref } from "vue";
import { FOCUSABLE_SELECTOR, focusablesIn, nextTrapTarget, useFocusTrap, type FocusTrapOptions } from "./useFocusTrap.js";

/**
 * 覆蓋層焦點陷阱（T075）：啟用時記住先前焦點並移進容器、Tab／Shift+Tab 循環、停用或卸載時還原，
 * 以及還原後備（iOS Safari 點按鈕不給焦點 → 啟用時焦點在 body）。
 */

let wrapper: VueWrapper | null = null;

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  document.body.innerHTML = "";
});

/** 測試用覆蓋層：`open` 由 props 控制，v-if 渲染容器與三個按鈕（中間一個 disabled、一個 hidden 不算）。 */
const Overlay = defineComponent({
  props: {
    open: { type: Boolean, required: true },
    options: { type: Object, default: () => ({}) },
    /** true 時容器內沒有任何可聚焦元素。 */
    empty: { type: Boolean, default: false },
  },
  setup(props) {
    const panel = ref<HTMLElement | null>(null);
    // fallback 經 props 間接讀，測試可在掛載後換掉它
    const trap = useFocusTrap(panel, () => props.open, {
      fallback: () => (props.options as FocusTrapOptions).fallback?.() ?? null,
    });
    return () =>
      props.open
        ? h(
            "div",
            { ref: panel, tabindex: "-1", "data-fg": "panel", onKeydown: trap.onKeydown },
            props.empty
              ? "空"
              : [
                  h("button", { id: "first" }, "first"),
                  h("button", { id: "disabled", disabled: true }, "disabled"),
                  h("button", { id: "hidden", hidden: true }, "hidden"),
                  h("button", { id: "last" }, "last"),
                ],
          )
        : null;
  },
});

function addOutsideButton(id: string): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.id = id;
  btn.textContent = id;
  document.body.appendChild(btn);
  return btn;
}

function mountOverlay(open: boolean, options: FocusTrapOptions = {}): VueWrapper {
  wrapper = mount(Overlay, { props: { open, options }, attachTo: document.body });
  return wrapper;
}

const panelEl = (): HTMLElement => document.querySelector<HTMLElement>('[data-fg="panel"]')!;
const byId = (id: string): HTMLElement => document.getElementById(id)!;

function tab(shiftKey = false): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true, cancelable: true });
  (document.activeElement ?? panelEl()).dispatchEvent(event);
  return event;
}

describe("nextTrapTarget", () => {
  it("清單為空回 null；焦點不在清單內時拉回邊界；頭尾循環；中間交給瀏覽器", () => {
    expect(nextTrapTarget([], null, false)).toBeNull();
    expect(nextTrapTarget(["a", "b", "c"], null, false)).toBe("a");
    expect(nextTrapTarget(["a", "b", "c"], "x", true)).toBe("c");
    expect(nextTrapTarget(["a", "b", "c"], "c", false)).toBe("a");
    expect(nextTrapTarget(["a", "b", "c"], "a", true)).toBe("c");
    expect(nextTrapTarget(["a", "b", "c"], "b", false)).toBeNull();
  });
});

describe("focusablesIn", () => {
  it("排除 disabled、hidden 與 aria-hidden；tabindex=-1 不算可 Tab", () => {
    const root = document.createElement("div");
    root.innerHTML =
      '<button id="a">a</button><button disabled>b</button><button hidden>c</button>' +
      '<a href="#" aria-hidden="true">d</a><div tabindex="-1">e</div><div id="f" tabindex="0">f</div>';
    document.body.appendChild(root);
    expect(FOCUSABLE_SELECTOR).toContain("button:not([disabled])");
    expect(focusablesIn(root).map((el) => el.id)).toEqual(["a", "f"]);
  });
});

describe("useFocusTrap 啟用與還原", () => {
  it("啟用時焦點移進容器；停用後還給啟用前的元素", async () => {
    const opener = addOutsideButton("opener");
    opener.focus();
    const w = mountOverlay(false);
    await w.setProps({ open: true });
    await nextTick();
    expect(document.activeElement).toBe(panelEl());
    await w.setProps({ open: false });
    expect(document.activeElement).toBe(opener);
  });

  it("掛載當下即啟用：同樣移進容器，啟用中卸載也還焦點", async () => {
    const opener = addOutsideButton("opener");
    opener.focus();
    const w = mountOverlay(true);
    await nextTick();
    expect(document.activeElement).toBe(panelEl());
    w.unmount();
    wrapper = null;
    expect(document.activeElement).toBe(opener);
  });

  it("使用者已點了容器外的元素時，停用不搶回焦點", async () => {
    const opener = addOutsideButton("opener");
    const other = addOutsideButton("other");
    opener.focus();
    const w = mountOverlay(true);
    await nextTick();
    other.focus();
    await w.setProps({ open: false });
    expect(document.activeElement).toBe(other);
  });

  it("沒有 fallback 時，啟用前焦點在 body（iOS Safari 點按鈕不給焦點）→ 停用後不動焦點", async () => {
    addOutsideButton("opener");
    const w = mountOverlay(true);
    await nextTick();
    expect(document.activeElement).toBe(panelEl());
    await w.setProps({ open: false });
    expect(document.activeElement).toBe(document.body);
  });

  it("還原後備：啟用前焦點在 body 時，停用後聚焦 fallback 元素", async () => {
    const opener = addOutsideButton("opener");
    const w = mountOverlay(true, { fallback: () => document.getElementById("opener") });
    await nextTick();
    await w.setProps({ open: false });
    expect(document.activeElement).toBe(opener);
  });

  it("還原後備：先前焦點已不在 DOM 時改聚焦 fallback；fallback 也不在 DOM 時不動", async () => {
    const gone = addOutsideButton("gone");
    const backup = addOutsideButton("backup");
    gone.focus();
    const w = mountOverlay(true, { fallback: () => document.getElementById("backup") });
    await nextTick();
    gone.remove();
    await w.setProps({ open: false });
    expect(document.activeElement).toBe(backup);

    backup.blur();
    const detached = document.createElement("button");
    await w.setProps({ open: true, options: { fallback: () => detached } });
    await nextTick();
    await w.setProps({ open: false });
    expect(document.activeElement).toBe(document.body);
  });

  it("先前焦點仍在 DOM 時優先於 fallback", async () => {
    const opener = addOutsideButton("opener");
    addOutsideButton("backup");
    opener.focus();
    const w = mountOverlay(true, { fallback: () => document.getElementById("backup") });
    await nextTick();
    await w.setProps({ open: false });
    expect(document.activeElement).toBe(opener);
  });
});

describe("useFocusTrap Tab 循環", () => {
  it("焦點在容器本身時，Tab 進第一個、Shift+Tab 進最後一個（略過 disabled／hidden）", async () => {
    mountOverlay(true);
    await nextTick();
    expect(tab().defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(byId("first"));
    panelEl().focus();
    tab(true);
    expect(document.activeElement).toBe(byId("last"));
  });

  it("頭尾循環；非 Tab 鍵不處理", async () => {
    mountOverlay(true);
    await nextTick();
    byId("last").focus();
    tab();
    expect(document.activeElement).toBe(byId("first"));
    tab(true);
    expect(document.activeElement).toBe(byId("last"));
    const other = new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true });
    byId("last").dispatchEvent(other);
    expect(other.defaultPrevented).toBe(false);
  });

  it("容器內沒有可聚焦元素時 Tab 留在容器", async () => {
    wrapper = mount(Overlay, { props: { open: true, empty: true }, attachTo: document.body });
    await nextTick();
    expect(tab().defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(panelEl());
  });
});
