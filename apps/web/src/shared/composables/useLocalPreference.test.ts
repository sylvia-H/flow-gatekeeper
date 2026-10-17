import { afterEach, describe, expect, it, vi } from "vitest";
import { readPreference, writePreference } from "./useLocalPreference.js";

/** 以 Map 模擬 localStorage；`throwing` 時每個方法都拋錯（模擬隱私模式／被封鎖）。 */
function stubStorage(throwing = false): Map<string, string> {
  const store = new Map<string, string>();
  const fail = (): never => {
    throw new DOMException("blocked", "SecurityError");
  };
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => (throwing ? fail() : (store.get(k) ?? null)),
    setItem: (k: string, v: string) => (throwing ? fail() : void store.set(k, v)),
    removeItem: (k: string) => (throwing ? fail() : void store.delete(k)),
  });
  return store;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useLocalPreference", () => {
  it("可用：寫入後讀回經 parse 的值；key 不存在時回 fallback", () => {
    const store = stubStorage();
    expect(readPreference("fg.x", 7, Number)).toBe(7);

    writePreference("fg.copilot-panel", JSON.stringify({ manuallyCollapsed: true }));
    expect(store.get("fg.copilot-panel")).toBe('{"manuallyCollapsed":true}');
    expect(
      readPreference("fg.copilot-panel", { manuallyCollapsed: false }, (raw) => JSON.parse(raw) as { manuallyCollapsed: boolean }),
    ).toEqual({ manuallyCollapsed: true });
  });

  it("localStorage 拋錯：讀回 fallback、寫入不拋錯", () => {
    stubStorage(true);
    expect(readPreference("fg.theme", "light", (raw) => raw)).toBe("light");
    expect(() => writePreference("fg.theme", "dark")).not.toThrow();
  });

  it("壞 JSON：parse 拋錯時回 fallback 且不拋錯", () => {
    const store = stubStorage();
    store.set("fg.copilot-panel", "{not json");
    const fallback = { manuallyCollapsed: false };
    expect(readPreference("fg.copilot-panel", fallback, (raw) => JSON.parse(raw) as typeof fallback)).toBe(fallback);
  });
});
