import { describe, expect, it } from "vitest";
import {
  deriveTransitionEvent,
  mergeEvent,
  pushCapped,
  type DerivedEvent,
  type Severity,
} from "./events.js";

describe("deriveTransitionEvent（FR-010 去重）", () => {
  it("healthy → warning 記一筆 warning（繁中訊息、count 1）", () => {
    const e = deriveTransitionEvent("healthy", "warning", "press-02", 100, 7);
    expect(e).not.toBeNull();
    expect(e?.severity).toBe("warning");
    expect(e?.machineId).toBe("press-02");
    expect(e?.message).toBe("壓製機 02 進入警告");
    expect(e?.id).toBe("100-press-02#7");
    expect(e?.count).toBe(1);
  });

  it("warning → critical 記一筆 critical", () => {
    const e = deriveTransitionEvent("warning", "critical", "press-02", 1, 0);
    expect(e?.severity).toBe("critical");
    expect(e?.message).toBe("壓製機 02 進入嚴重");
  });

  it("critical → warning 記一筆 warning（降級仍屬轉入 warning）", () => {
    expect(deriveTransitionEvent("critical", "warning", "press-02", 1, 0)?.severity).toBe("warning");
  });

  it("首次出現（prev undefined）轉入 critical 記一筆", () => {
    expect(deriveTransitionEvent(undefined, "critical", "mixer-01", 1, 0)).not.toBeNull();
  });

  it("同態抖動不記（warning → warning → null）", () => {
    expect(deriveTransitionEvent("warning", "warning", "press-02", 1, 0)).toBeNull();
    expect(deriveTransitionEvent("critical", "critical", "press-02", 1, 0)).toBeNull();
    expect(deriveTransitionEvent("healthy", "healthy", "press-02", 1, 0)).toBeNull();
  });

  it("warning/critical → healthy 記一筆回復事件", () => {
    const fromCritical = deriveTransitionEvent("critical", "healthy", "oven-04", 5, 3);
    expect(fromCritical?.severity).toBe("recovered");
    expect(fromCritical?.message).toBe("烤爐 04 回復正常");
    expect(fromCritical?.count).toBe(1);
    expect(deriveTransitionEvent("warning", "healthy", "oven-04", 5, 4)?.severity).toBe("recovered");
  });

  it("首次出現即 healthy 不記", () => {
    expect(deriveTransitionEvent(undefined, "healthy", "press-02", 1, 0)).toBeNull();
  });

  it("未知 machineId 訊息 fallback 用 id 本身", () => {
    expect(deriveTransitionEvent("healthy", "critical", "unknown-99", 1, 0)?.message).toBe(
      "unknown-99 進入嚴重",
    );
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

function ev(ts: number, machineId = "m", severity: Severity = "warning"): DerivedEvent {
  return { id: `${ts}-${machineId}-${severity}`, ts, machineId, severity, message: "x", count: 1 };
}

describe("pushCapped（FR-011 上限）", () => {
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

describe("mergeEvent（data-model §10 合併視窗）", () => {
  it("回傳同一陣列（就地修改）", () => {
    const list: DerivedEvent[] = [];
    expect(mergeEvent(list, ev(0))).toBe(list);
  });

  it("同機台同嚴重度、相距恰 10 000 ms（閉區間）→ 合併、count+1、ts 更新、id 沿用", () => {
    const list: DerivedEvent[] = [];
    mergeEvent(list, ev(1_000, "press-02"));
    mergeEvent(list, ev(11_000, "press-02"));
    expect(list.length).toBe(1);
    expect(list[0]?.count).toBe(2);
    expect(list[0]?.ts).toBe(11_000);
    expect(list[0]?.id).toBe("1000-press-02-warning");
  });

  it("相距 10 001 ms → 不合併，新事件放頂端", () => {
    const list: DerivedEvent[] = [];
    mergeEvent(list, ev(1_000, "press-02"));
    mergeEvent(list, ev(11_001, "press-02"));
    expect(list.length).toBe(2);
    expect(list.map((e) => [e.ts, e.count])).toEqual([
      [11_001, 1],
      [1_000, 1],
    ]);
  });

  it("亂序事件：早於既有事件但在視窗內 → 合併且 ts 不倒退；早超過視窗 → 不合併", () => {
    const list: DerivedEvent[] = [];
    mergeEvent(list, ev(50_000, "press-02"));
    mergeEvent(list, ev(45_000, "press-02")); // 早 5 s：合併
    expect(list.length).toBe(1);
    expect(list[0]?.count).toBe(2);
    expect(list[0]?.ts).toBe(50_000);
    mergeEvent(list, ev(39_999, "press-02")); // 早 10 001 ms：不合併
    expect(list.length).toBe(2);
    expect(list[0]?.ts).toBe(39_999);
    expect(list[0]?.count).toBe(1);
  });

  it("視窗以最近一次發生時間滑動：每次合併後以新 ts 為基準", () => {
    const list: DerivedEvent[] = [];
    mergeEvent(list, ev(0, "press-02"));
    mergeEvent(list, ev(9_000, "press-02"));
    mergeEvent(list, ev(18_000, "press-02")); // 距首筆 18 s，但距上一次 9 s → 仍合併
    expect(list.length).toBe(1);
    expect(list[0]?.count).toBe(3);
    expect(list[0]?.ts).toBe(18_000);
  });

  it("合併的那筆不在頂端時移到頂端", () => {
    const list: DerivedEvent[] = [];
    mergeEvent(list, ev(0, "press-02"));
    mergeEvent(list, ev(1_000, "oven-04"));
    mergeEvent(list, ev(2_000, "mixer-01"));
    mergeEvent(list, ev(3_000, "press-02"));
    expect(list.map((e) => e.machineId)).toEqual(["press-02", "mixer-01", "oven-04"]);
    expect(list[0]?.count).toBe(2);
  });

  it("不同機台或不同嚴重度不合併", () => {
    const list: DerivedEvent[] = [];
    mergeEvent(list, ev(0, "press-02", "warning"));
    mergeEvent(list, ev(1, "oven-04", "warning"));
    mergeEvent(list, ev(2, "press-02", "critical"));
    expect(list.length).toBe(3);
    expect(list.every((e) => e.count === 1)).toBe(true);
  });

  it("warning／recovered／warning 交錯：兩筆 warning 仍合併，recovered 各自一筆", () => {
    const list: DerivedEvent[] = [];
    mergeEvent(list, ev(0, "press-02", "warning"));
    mergeEvent(list, ev(2_000, "press-02", "recovered"));
    mergeEvent(list, ev(4_000, "press-02", "warning"));
    expect(list.map((e) => [e.severity, e.count, e.ts])).toEqual([
      ["warning", 2, 4_000],
      ["recovered", 1, 2_000],
    ]);
    mergeEvent(list, ev(6_000, "press-02", "recovered"));
    expect(list.map((e) => [e.severity, e.count])).toEqual([
      ["recovered", 2],
      ["warning", 2],
    ]);
  });

  it("新事件 count 固定從 1 起算", () => {
    const list: DerivedEvent[] = [];
    mergeEvent(list, { ...ev(0), count: 7 });
    expect(list[0]?.count).toBe(1);
  });

  it("上限 50（recovered 同樣計入）：超過裁最舊", () => {
    const list: DerivedEvent[] = [];
    // 每筆不同機台 → 永不合併
    for (let i = 0; i < 60; i += 1) {
      mergeEvent(list, ev(i, `m-${i}`, i % 2 === 0 ? "warning" : "recovered"));
    }
    expect(list.length).toBe(50);
    expect(list[0]?.machineId).toBe("m-59");
    expect(list[49]?.machineId).toBe("m-10");
  });

  it("合併不增加長度（滿 50 時合併不裁任何一筆）", () => {
    const list: DerivedEvent[] = [];
    for (let i = 0; i < 50; i += 1) mergeEvent(list, ev(i, `m-${i}`));
    mergeEvent(list, ev(100, "m-0")); // 最舊那筆被合併並移到頂端
    expect(list.length).toBe(50);
    expect(list[0]?.machineId).toBe("m-0");
    expect(list[0]?.count).toBe(2);
    expect(list[49]?.machineId).toBe("m-1");
  });
});
