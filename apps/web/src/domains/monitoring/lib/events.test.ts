import { describe, expect, it } from "vitest";
import { deriveTransitionEvent, pushCapped, type DerivedEvent } from "./events.js";

describe("deriveTransitionEvent（FR-010 去重）", () => {
  it("healthy → warning 記一筆 warning", () => {
    const e = deriveTransitionEvent("healthy", "warning", "press-02", 100, 7);
    expect(e).not.toBeNull();
    expect(e?.severity).toBe("warning");
    expect(e?.machineId).toBe("press-02");
    expect(e?.message).toBe("Press 02 entered WARNING");
    expect(e?.id).toBe("100-press-02#7");
  });

  it("warning → critical 記一筆 critical", () => {
    expect(deriveTransitionEvent("warning", "critical", "oven-04", 1, 0)?.severity).toBe("critical");
  });

  it("首次出現（prev undefined）轉入 critical 記一筆", () => {
    expect(deriveTransitionEvent(undefined, "critical", "mixer-01", 1, 0)).not.toBeNull();
  });

  it("同態抖動不記（warning → warning → null）", () => {
    expect(deriveTransitionEvent("warning", "warning", "press-02", 1, 0)).toBeNull();
    expect(deriveTransitionEvent("critical", "critical", "press-02", 1, 0)).toBeNull();
  });

  it("轉回 healthy 不記（不記恢復事件）", () => {
    expect(deriveTransitionEvent("critical", "healthy", "press-02", 1, 0)).toBeNull();
    expect(deriveTransitionEvent(undefined, "healthy", "press-02", 1, 0)).toBeNull();
  });

  it("同批次（同 ts、同機台）多次轉態以 seq 保 id 唯一", () => {
    // pause/resume 後整段 buffer 於同一 receivedAt 沖出：同機台 warning→critical→warning
    // 會落在同一 ts。若 id 僅 ts+machineId 會重複 key；seq 遞增即可保唯一。
    const a = deriveTransitionEvent("healthy", "warning", "press-02", 100, 0);
    const b = deriveTransitionEvent("warning", "critical", "press-02", 100, 1);
    const c = deriveTransitionEvent("critical", "warning", "press-02", 100, 2);
    expect(new Set([a?.id, b?.id, c?.id]).size).toBe(3);
  });
});

describe("pushCapped（FR-011 上限）", () => {
  function ev(ts: number): DerivedEvent {
    return { id: `${ts}`, ts, machineId: "m", severity: "warning", message: "x" };
  }

  it("最新在頂端", () => {
    const list: DerivedEvent[] = [];
    pushCapped(list, ev(1));
    pushCapped(list, ev(2));
    expect(list[0]?.ts).toBe(2);
    expect(list[1]?.ts).toBe(1);
  });

  it("超過 50 淘汰最舊、長度不超過 50", () => {
    const list: DerivedEvent[] = [];
    for (let i = 0; i < 60; i += 1) pushCapped(list, ev(i));
    expect(list.length).toBe(50);
    expect(list[0]?.ts).toBe(59); // 最新
    expect(list[49]?.ts).toBe(10); // 最舊保留者（0..9 已淘汰）
  });
});
