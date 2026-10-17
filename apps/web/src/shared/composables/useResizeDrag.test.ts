// @vitest-environment happy-dom
import { mount, type VueWrapper } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h, nextTick } from "vue";
import { useResizeDrag, type UseResizeDragOptions } from "./useResizeDrag.js";

/**
 * 以 Map 模擬 localStorage：新版 Node 內建的實驗性 `localStorage` 會遮蔽 happy-dom 的實作
 * （未帶 `--localstorage-file` 時為 undefined），所以不依賴環境提供的 storage。
 */
let storage: Map<string, string>;

function stubStorage(overrides: Partial<Storage> = {}): void {
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
    removeItem: (k: string) => void storage.delete(k),
    ...overrides,
  });
}

const SIDEBAR: UseResizeDragOptions = {
  axis: "x",
  min: 200,
  max: 420,
  initial: 240,
  storageKey: "flow-gatekeeper:sidebar-width",
  label: "調整側欄寬度",
};

const EVENT_STRIP: UseResizeDragOptions = {
  axis: "y",
  min: 100,
  max: 360,
  initial: 150,
  storageKey: "flow-gatekeeper:event-strip-height",
  direction: -1,
  label: "調整事件流面板高度",
};

/** 掛一個只有把手的最小元件，照 AppLayout／App 的接法綁 attrs 與事件。 */
function mountHandle(options: UseResizeDragOptions) {
  let api!: ReturnType<typeof useResizeDrag>;
  const Host = defineComponent({
    setup() {
      api = useResizeDrag(options);
      return () =>
        h("div", {
          ...api.handleAttrs.value,
          "data-testid": "handle",
          onPointerdown: api.startDrag,
          onKeydown: api.onKeydown,
        });
    },
  });
  const wrapper = mount(Host, { attachTo: document.body });
  return { wrapper, api, handle: () => wrapper.get("[data-testid=handle]") };
}

let mounted: VueWrapper[] = [];

function setup(options: UseResizeDragOptions) {
  const result = mountHandle(options);
  mounted.push(result.wrapper);
  return result;
}

beforeEach(() => {
  storage = new Map();
  stubStorage();
});

afterEach(() => {
  for (const w of mounted) w.unmount();
  mounted = [];
  vi.unstubAllGlobals();
});

describe("useResizeDrag 鍵盤調整：側欄（axis x）", () => {
  it("ArrowRight 加寬 16px、ArrowLeft 減寬 16px，並寫回偏好", async () => {
    const { api, handle } = setup(SIDEBAR);
    await handle().trigger("keydown", { key: "ArrowRight" });
    expect(api.size.value).toBe(256);
    expect(storage.get(SIDEBAR.storageKey)).toBe("256");
    await handle().trigger("keydown", { key: "ArrowLeft" });
    await handle().trigger("keydown", { key: "ArrowLeft" });
    expect(api.size.value).toBe(224);
    expect(storage.get(SIDEBAR.storageKey)).toBe("224");
  });

  it("ArrowUp／ArrowDown 不作用於側欄把手，也不攔截預設行為", async () => {
    const { api, handle } = setup(SIDEBAR);
    const event = new KeyboardEvent("keydown", { key: "ArrowUp", cancelable: true });
    handle().element.dispatchEvent(event);
    expect(api.size.value).toBe(240);
    expect(event.defaultPrevented).toBe(false);
  });

  it("方向鍵會 preventDefault（不讓頁面跟著捲動）", () => {
    const { handle } = setup(SIDEBAR);
    const event = new KeyboardEvent("keydown", { key: "ArrowRight", cancelable: true });
    handle().element.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it("夾限在 200–420", async () => {
    storage.set(SIDEBAR.storageKey, "410");
    const { api, handle } = setup(SIDEBAR);
    await handle().trigger("keydown", { key: "ArrowRight" });
    expect(api.size.value).toBe(420);
    await handle().trigger("keydown", { key: "ArrowRight" });
    expect(api.size.value).toBe(420);

    storage.set(SIDEBAR.storageKey, "210");
    const low = setup(SIDEBAR);
    await low.handle().trigger("keydown", { key: "ArrowLeft" });
    expect(low.api.size.value).toBe(200);
    await low.handle().trigger("keydown", { key: "ArrowLeft" });
    expect(low.api.size.value).toBe(200);
  });

  it("Home／End 跳到下限／上限", async () => {
    const { api, handle } = setup(SIDEBAR);
    await handle().trigger("keydown", { key: "End" });
    expect(api.size.value).toBe(420);
    await handle().trigger("keydown", { key: "Home" });
    expect(api.size.value).toBe(200);
  });

  it("帶修飾鍵的方向鍵不處理（留給瀏覽器／其他快捷鍵）", async () => {
    const { api, handle } = setup(SIDEBAR);
    await handle().trigger("keydown", { key: "ArrowRight", ctrlKey: true });
    expect(api.size.value).toBe(240);
  });

  it("把手帶 separator 角色、可聚焦、垂直 orientation 與 aria 值，且隨調整更新", async () => {
    const { handle } = setup(SIDEBAR);
    const el = handle();
    expect(el.attributes("role")).toBe("separator");
    expect(el.attributes("tabindex")).toBe("0");
    expect(el.attributes("aria-label")).toBe("調整側欄寬度");
    expect(el.attributes("aria-orientation")).toBe("vertical");
    expect(el.attributes("aria-valuemin")).toBe("200");
    expect(el.attributes("aria-valuemax")).toBe("420");
    expect(el.attributes("aria-valuenow")).toBe("240");
    expect(el.attributes("aria-valuetext")).toBe("240 像素");
    await el.trigger("keydown", { key: "ArrowRight" });
    expect(handle().attributes("aria-valuenow")).toBe("256");
    expect(handle().attributes("aria-valuetext")).toBe("256 像素");
  });
});

describe("useResizeDrag 鍵盤調整：事件流（axis y、direction -1）", () => {
  it("ArrowUp 增高 16px、ArrowDown 減少 16px（不受 direction 影響）", async () => {
    const { api, handle } = setup(EVENT_STRIP);
    await handle().trigger("keydown", { key: "ArrowUp" });
    expect(api.size.value).toBe(166);
    expect(storage.get(EVENT_STRIP.storageKey)).toBe("166");
    await handle().trigger("keydown", { key: "ArrowDown" });
    await handle().trigger("keydown", { key: "ArrowDown" });
    expect(api.size.value).toBe(134);
  });

  it("ArrowLeft／ArrowRight 不作用於事件流把手", async () => {
    const { api, handle } = setup(EVENT_STRIP);
    await handle().trigger("keydown", { key: "ArrowRight" });
    await handle().trigger("keydown", { key: "ArrowLeft" });
    expect(api.size.value).toBe(150);
  });

  it("夾限在 100–360", async () => {
    storage.set(EVENT_STRIP.storageKey, "350");
    const { api, handle } = setup(EVENT_STRIP);
    await handle().trigger("keydown", { key: "ArrowUp" });
    await handle().trigger("keydown", { key: "ArrowUp" });
    expect(api.size.value).toBe(360);

    storage.set(EVENT_STRIP.storageKey, "110");
    const low = setup(EVENT_STRIP);
    await low.handle().trigger("keydown", { key: "ArrowDown" });
    await low.handle().trigger("keydown", { key: "ArrowDown" });
    expect(low.api.size.value).toBe(100);
  });

  it("把手為水平 orientation，aria 範圍 100–360", () => {
    const { handle } = setup(EVENT_STRIP);
    expect(handle().attributes("aria-orientation")).toBe("horizontal");
    expect(handle().attributes("aria-valuemin")).toBe("100");
    expect(handle().attributes("aria-valuemax")).toBe("360");
    expect(handle().attributes("aria-valuenow")).toBe("150");
  });
});

describe("useResizeDrag 指標拖曳", () => {
  it("direction -1：往上拖（clientY 變小）增高，放開時寫回偏好", async () => {
    const { api, handle } = setup(EVENT_STRIP);
    await handle().trigger("pointerdown", { clientY: 500 });
    expect(document.body.classList.contains("select-none")).toBe(true);
    window.dispatchEvent(new PointerEvent("pointermove", { clientY: 460 }));
    expect(api.size.value).toBe(190);
    expect(storage.has(EVENT_STRIP.storageKey)).toBe(false);
    window.dispatchEvent(new PointerEvent("pointerup", { clientY: 460 }));
    expect(storage.get(EVENT_STRIP.storageKey)).toBe("190");
    expect(document.body.classList.contains("select-none")).toBe(false);
    // 放開後的移動不再影響尺寸
    window.dispatchEvent(new PointerEvent("pointermove", { clientY: 300 }));
    expect(api.size.value).toBe(190);
  });

  it("direction 1：往右拖加寬，且夾限上限", async () => {
    const { api, handle } = setup(SIDEBAR);
    await handle().trigger("pointerdown", { clientX: 240 });
    window.dispatchEvent(new PointerEvent("pointermove", { clientX: 300 }));
    expect(api.size.value).toBe(300);
    window.dispatchEvent(new PointerEvent("pointermove", { clientX: 900 }));
    expect(api.size.value).toBe(420);
    window.dispatchEvent(new PointerEvent("pointerup"));
  });

  it("clientX 帶小數時 size 取整數，寫回的偏好也是整數字串", async () => {
    const { api, handle } = setup(SIDEBAR);
    await handle().trigger("pointerdown", { clientX: 240 });
    window.dispatchEvent(new PointerEvent("pointermove", { clientX: 253.66 }));
    expect(api.size.value).toBe(254);
    expect(Number.isInteger(api.size.value)).toBe(true);
    await nextTick();
    expect(handle().attributes("aria-valuetext")).toBe("254 像素");
    window.dispatchEvent(new PointerEvent("pointerup"));
    expect(storage.get(SIDEBAR.storageKey)).toBe("254");
  });

  it("pointercancel 結束拖曳：收掉 select-none、不再跟隨 move", async () => {
    const { api, handle } = setup(SIDEBAR);
    await handle().trigger("pointerdown", { clientX: 240 });
    window.dispatchEvent(new PointerEvent("pointermove", { clientX: 280 }));
    expect(api.size.value).toBe(280);
    window.dispatchEvent(new PointerEvent("pointercancel"));
    expect(document.body.classList.contains("select-none")).toBe(false);
    expect(storage.get(SIDEBAR.storageKey)).toBe("280");
    window.dispatchEvent(new PointerEvent("pointermove", { clientX: 400 }));
    expect(api.size.value).toBe(280);
  });

  it("拖曳中卸載會收掉 body 的 select-none", async () => {
    const { wrapper, handle } = setup(SIDEBAR);
    await handle().trigger("pointerdown", { clientX: 240 });
    expect(document.body.classList.contains("select-none")).toBe(true);
    wrapper.unmount();
    mounted = mounted.filter((w) => w !== wrapper);
    expect(document.body.classList.contains("select-none")).toBe(false);
  });
});

describe("useResizeDrag 偏好讀寫", () => {
  it("讀取舊版存的純數字字串並夾限", () => {
    storage.set(SIDEBAR.storageKey, "300");
    expect(setup(SIDEBAR).api.size.value).toBe(300);
    storage.set(SIDEBAR.storageKey, "999");
    expect(setup(SIDEBAR).api.size.value).toBe(420);
  });

  it.each(["abc", "", "0", "-50", "NaN", "Infinity"])("壞值 %j 回預設", (raw) => {
    storage.set(SIDEBAR.storageKey, raw);
    expect(setup(SIDEBAR).api.size.value).toBe(240);
  });

  it("getItem 拋錯時回預設、不拋錯", () => {
    stubStorage({
      getItem: () => {
        throw new Error("SecurityError");
      },
    });
    expect(setup(EVENT_STRIP).api.size.value).toBe(150);
  });

  it("setItem 拋錯時不拋錯，size 仍更新", async () => {
    stubStorage({
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    });
    const { api, handle } = setup(SIDEBAR);
    await handle().trigger("keydown", { key: "ArrowRight" });
    expect(api.size.value).toBe(256);
    expect(handle().attributes("aria-valuenow")).toBe("256");
  });

  it("storage 完全不存在時以預設值運作", async () => {
    vi.stubGlobal("localStorage", undefined);
    const { api, handle } = setup(SIDEBAR);
    expect(api.size.value).toBe(240);
    await handle().trigger("keydown", { key: "ArrowLeft" });
    expect(api.size.value).toBe(224);
  });
});
