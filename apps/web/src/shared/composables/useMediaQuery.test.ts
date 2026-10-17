// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h, nextTick, type Ref } from "vue";
import {
  BELOW_DESK_QUERY,
  BELOW_MD_QUERY,
  DESK_QUERY,
  REDUCED_MOTION_QUERY,
  hasMatchMedia,
  matchesMedia,
  onMediaChange,
  useMediaQuery,
} from "./useMediaQuery.js";

type Listener = (event: { matches: boolean }) => void;

/** 假 MediaQueryList：`legacy` 為 true 時只有舊 Safari 的 addListener／removeListener。 */
function fakeList(matches: boolean, legacy = false) {
  const listeners = new Set<Listener>();
  const add = vi.fn((...args: unknown[]) => void listeners.add(args[args.length - 1] as Listener));
  const remove = vi.fn((...args: unknown[]) => void listeners.delete(args[args.length - 1] as Listener));
  const list = legacy
    ? { matches, addListener: add, removeListener: remove }
    : { matches, addEventListener: add, removeEventListener: remove };
  return {
    list,
    add,
    remove,
    emit: (next: boolean) => listeners.forEach((cb) => cb({ matches: next })),
    size: () => listeners.size,
  };
}

function mountProbe(query: string) {
  let state: Readonly<Ref<boolean>> | null = null;
  const wrapper = mount(
    defineComponent({
      setup() {
        state = useMediaQuery(query);
        return () => h("span", state!.value ? "yes" : "no");
      },
    }),
  );
  return { wrapper, state: () => state!.value };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("查詢字串與 tailwind 斷點對齊", () => {
  it("md（768）、desk（1366）與其互補、reduced-motion", () => {
    expect(BELOW_MD_QUERY).toBe("(max-width: 767.98px)");
    expect(DESK_QUERY).toBe("(min-width: 1366px)");
    expect(BELOW_DESK_QUERY).toBe("(max-width: 1365.98px)");
    expect(REDUCED_MOTION_QUERY).toBe("(prefers-reduced-motion: reduce)");
  });
});

describe("沒有 matchMedia（SSR／舊環境）", () => {
  it("hasMatchMedia 為 false、matchesMedia 回 false、useMediaQuery 固定 false 且不拋錯", () => {
    vi.stubGlobal("matchMedia", undefined);
    expect(hasMatchMedia()).toBe(false);
    expect(matchesMedia(DESK_QUERY)).toBe(false);
    const { wrapper, state } = mountProbe(BELOW_MD_QUERY);
    expect(state()).toBe(false);
    expect(() => wrapper.unmount()).not.toThrow();
  });
});

describe("matchesMedia：單次讀取", () => {
  it("每次呼叫都即時查詢傳入的字串", () => {
    let width = 1024;
    const matchMedia = vi.fn((q: string) => ({ matches: q === DESK_QUERY && width >= 1366 }));
    vi.stubGlobal("matchMedia", matchMedia);
    expect(matchesMedia(DESK_QUERY)).toBe(false);
    width = 1366;
    expect(matchesMedia(DESK_QUERY)).toBe(true);
    expect(matchMedia).toHaveBeenCalledWith(DESK_QUERY);
  });
});

describe("useMediaQuery", () => {
  it("setup 當下同步讀初值，以傳入的查詢字串查詢", () => {
    const fake = fakeList(true);
    const matchMedia = vi.fn(() => fake.list);
    vi.stubGlobal("matchMedia", matchMedia);
    const { state } = mountProbe(REDUCED_MOTION_QUERY);
    expect(matchMedia).toHaveBeenCalledWith(REDUCED_MOTION_QUERY);
    expect(state()).toBe(true);
  });

  it("mounted 後以 addEventListener('change') 監聽，change 事件更新值與畫面", async () => {
    const fake = fakeList(false);
    vi.stubGlobal("matchMedia", () => fake.list);
    const { wrapper, state } = mountProbe(BELOW_MD_QUERY);
    expect(fake.add).toHaveBeenCalledWith("change", expect.any(Function));
    fake.emit(true);
    await nextTick();
    expect(state()).toBe(true);
    expect(wrapper.text()).toBe("yes");
    fake.emit(false);
    await nextTick();
    expect(wrapper.text()).toBe("no");
  });

  it("unmounted 時以同一個 listener 解除監聽", () => {
    const fake = fakeList(false);
    vi.stubGlobal("matchMedia", () => fake.list);
    const { wrapper } = mountProbe(BELOW_MD_QUERY);
    expect(fake.size()).toBe(1);
    wrapper.unmount();
    expect(fake.remove).toHaveBeenCalledTimes(1);
    expect(fake.remove).toHaveBeenCalledWith("change", fake.add.mock.calls[0]![1]);
    expect(fake.size()).toBe(0);
  });

  it("舊 Safari 只有 addListener／removeListener 時退回使用", async () => {
    const fake = fakeList(false, true);
    vi.stubGlobal("matchMedia", () => fake.list);
    const { wrapper, state } = mountProbe(BELOW_DESK_QUERY);
    expect(fake.add).toHaveBeenCalledTimes(1);
    fake.emit(true);
    await nextTick();
    expect(state()).toBe(true);
    wrapper.unmount();
    expect(fake.remove).toHaveBeenCalledTimes(1);
    expect(fake.size()).toBe(0);
  });

  it("MediaQueryList 兩種監聽 API 都沒有時只讀初值、不拋錯", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    const { wrapper, state } = mountProbe(BELOW_MD_QUERY);
    expect(state()).toBe(true);
    expect(() => wrapper.unmount()).not.toThrow();
  });
});

describe("onMediaChange：共用的 change 監聽（合併門第 2 輪 #11，useMediaQuery 與 useModalSheet 共用）", () => {
  it("新版 API：以 addEventListener('change') 掛，回傳的解除函式以同一個 listener 解除", () => {
    const fake = fakeList(false);
    const cb = vi.fn();
    const stop = onMediaChange(fake.list, cb);
    expect(fake.add).toHaveBeenCalledWith("change", cb);
    fake.emit(true);
    expect(cb).toHaveBeenCalledWith({ matches: true });
    stop();
    expect(fake.remove).toHaveBeenCalledWith("change", cb);
    expect(fake.size()).toBe(0);
  });

  it("舊 Safari：退回 addListener／removeListener", () => {
    const fake = fakeList(false, true);
    const cb = vi.fn();
    const stop = onMediaChange(fake.list, cb);
    expect(fake.add).toHaveBeenCalledWith(cb);
    fake.emit(true);
    expect(cb).toHaveBeenCalledTimes(1);
    stop();
    expect(fake.remove).toHaveBeenCalledWith(cb);
    expect(fake.size()).toBe(0);
  });

  it("兩種 API 都沒有：不掛、解除函式為 no-op 且不拋錯", () => {
    const stop = onMediaChange({ matches: false }, vi.fn());
    expect(() => stop()).not.toThrow();
  });
});
