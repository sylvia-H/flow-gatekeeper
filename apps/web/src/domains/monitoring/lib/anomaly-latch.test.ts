import { describe, expect, it } from "vitest";
import type { MachineState } from "@flow-gatekeeper/contracts";
import {
  applyTransition,
  clearLatch,
  isLatchStruck,
  isLatchVisible,
  latchText,
  summarize,
  type AnomalyLatch,
} from "./anomaly-latch.js";
import { machineLabel } from "./machine-labels.js";
import { staleClock } from "./stale.js";

const ID = "press-02";

/** 依序套用一串 (state, receivedAt)，回最後的 latch；prev 以前一個 state 帶入（模擬 store）。 */
function run(steps: ReadonlyArray<readonly [MachineState, number]>, start: AnomalyLatch | null = null) {
  let latch = start;
  let prev: MachineState | undefined;
  for (const [next, at] of steps) {
    latch = applyTransition(latch, prev, next, at, ID);
    prev = next;
  }
  return latch;
}

describe("applyTransition（data-model §5）", () => {
  it("無 latch 且 next 為 healthy：回 null", () => {
    expect(applyTransition(null, undefined, "healthy", 0, ID)).toBeNull();
    expect(applyTransition(undefined, "healthy", "healthy", 0, ID)).toBeNull();
  });

  it("進入 warning：建立 latch", () => {
    expect(applyTransition(null, "healthy", "warning", 1_000, ID)).toEqual({
      machineId: ID,
      level: "warning",
      enteredAt: 1_000,
      recoveredAt: null,
      clearedBy: null,
    });
  });

  it("仍異常中 warning → critical 升級，enteredAt 不變", () => {
    const latch = run([
      ["warning", 1_000],
      ["critical", 2_000],
    ]);
    expect(latch).toMatchObject({ level: "critical", enteredAt: 1_000, recoveredAt: null });
  });

  it("已劃線的 warning 升為 critical：重置為未確認", () => {
    const struck = clearLatch(run([["warning", 1_000]])!);
    const upgraded = applyTransition(struck, "warning", "critical", 2_000, ID);
    expect(upgraded?.level).toBe("critical");
    expect(upgraded?.clearedBy).toBeNull();
  });

  it("critical → warning 維持 critical，劃線狀態不變（回原物件）", () => {
    const struck = clearLatch(run([["critical", 1_000]])!);
    const after = applyTransition(struck, "critical", "warning", 2_000, ID);
    expect(after).toBe(struck);
    expect(after?.level).toBe("critical");
    expect(after?.clearedBy).toBe("user");
  });

  it("同態不變（回原物件）", () => {
    const latch = run([["warning", 1_000]])!;
    expect(applyTransition(latch, "warning", "warning", 2_000, ID)).toBe(latch);
  });

  it("異常 → healthy：記 recoveredAt；之後 healthy → healthy 不變", () => {
    const recovered = run([
      ["critical", 1_000],
      ["healthy", 5_000],
    ])!;
    expect(recovered).toMatchObject({ level: "critical", enteredAt: 1_000, recoveredAt: 5_000 });
    expect(applyTransition(recovered, "healthy", "healthy", 6_000, ID)).toBe(recovered);
  });

  it("回復後 30 s 內再進 warning：以新異常重建（level=warning、清除劃線）", () => {
    const recovered = clearLatch(
      run([
        ["critical", 1_000],
        ["healthy", 5_000],
      ])!,
    );
    const again = applyTransition(recovered, "healthy", "warning", 10_000, ID);
    expect(again).toEqual({
      machineId: ID,
      level: "warning",
      enteredAt: 10_000,
      recoveredAt: null,
      clearedBy: null,
    });
  });

  it("不就地修改輸入", () => {
    const latch = run([["warning", 1_000]])!;
    const snapshot = { ...latch };
    applyTransition(latch, "warning", "critical", 2_000, ID);
    applyTransition(latch, "warning", "healthy", 3_000, ID);
    clearLatch(latch);
    expect(latch).toEqual(snapshot);
  });
});

describe("isLatchVisible／isLatchStruck／clearLatch", () => {
  const recovered: AnomalyLatch = {
    machineId: ID,
    level: "critical",
    enteredAt: 1_000,
    recoveredAt: 10_000,
    clearedBy: null,
  };

  it("仍異常恆可見", () => {
    expect(isLatchVisible({ ...recovered, recoveredAt: null }, 10_000_000)).toBe(true);
  });

  it("回復後 30 s 內可見，滿 30 s 消失（holdMs 可自訂）", () => {
    expect(isLatchVisible(recovered, 10_000)).toBe(true);
    expect(isLatchVisible(recovered, 39_999)).toBe(true);
    expect(isLatchVisible(recovered, 40_000)).toBe(false);
    expect(isLatchVisible(recovered, 14_999, 5_000)).toBe(true);
    expect(isLatchVisible(recovered, 15_000, 5_000)).toBe(false);
  });

  it("使用者清除後劃線，但可見期不變：期滿才消失", () => {
    const struck = clearLatch(recovered);
    expect(isLatchStruck(recovered)).toBe(false);
    expect(isLatchStruck(struck)).toBe(true);
    expect(isLatchVisible(struck, 39_999)).toBe(true);
    expect(isLatchVisible(struck, 40_000)).toBe(false);
  });

  it("仍異常中清除：劃線但持續可見", () => {
    const struck = clearLatch({ ...recovered, recoveredAt: null });
    expect(isLatchStruck(struck)).toBe(true);
    expect(isLatchVisible(struck, 10_000_000)).toBe(true);
  });

  it("clearLatch 已確認者回原物件", () => {
    const struck = clearLatch(recovered);
    expect(clearLatch(struck)).toBe(struck);
  });

  it("staleNow 凍結（Pause）時不倒數：凍結在回復後 5 s，無論實際過多久都可見", () => {
    // store 的 staleClock(now, pausedAt, connected) 於 Pause 且連線中時恆回 pausedAt
    const pausedAt = 15_000;
    for (const realNow of [20_000, 60_000, 600_000]) {
      const staleNow = staleClock(realNow, pausedAt, true);
      expect(isLatchVisible(recovered, staleNow)).toBe(true);
    }
  });

  it("恢復後 staleNow 回到實際時間：Pause 期間計入，已滿 30 s 立即消失、未滿者續顯", () => {
    // Pause 於 15 s（回復後 5 s）、恢復於 50 s：實際已過 40 s ≥ 30 s → 立即消失
    expect(isLatchVisible(recovered, staleClock(50_000, null, true))).toBe(false);
    // 若恢復於 30 s：實際已過 20 s < 30 s → 仍可見，到 40 s 消失
    expect(isLatchVisible(recovered, staleClock(30_000, null, true))).toBe(true);
    expect(isLatchVisible(recovered, staleClock(40_000, null, true))).toBe(false);
  });
});

describe("summarize（data-model §6）", () => {
  function latch(
    machineId: string,
    enteredAt: number,
    recoveredAt: number | null,
    extra: Partial<AnomalyLatch> = {},
  ): AnomalyLatch {
    return { machineId, level: "warning", enteredAt, recoveredAt, clearedBy: null, ...extra };
  }

  function mapOf(...latches: AnomalyLatch[]): Map<string, AnomalyLatch> {
    return new Map(latches.map((l) => [l.machineId, l]));
  }

  it("全部正常（空 Map 或全數過期）回空陣列", () => {
    expect(summarize(new Map(), 0, machineLabel)).toEqual([]);
    expect(summarize(mapOf(latch("oven-04", 0, 1_000)), 31_000, machineLabel)).toEqual([]);
  });

  it("active 優先、再依 enteredAt 降冪；過期者濾掉", () => {
    const items = summarize(
      mapOf(
        latch("mixer-01", 1_000, 20_000), // 已回復（可見）
        latch("press-02", 2_000, null, { level: "critical" }), // 進行中
        latch("oven-04", 5_000, null), // 進行中，較晚進入
        latch("pack-03", 9_000, 25_000), // 已回復，較晚進入
        latch("sorter-05", 0, 1_000), // 已過期（31 000 − 1 000 = 30 000 ≥ 30 s）
      ),
      31_000,
      machineLabel,
    );
    expect(items.map((i) => i.machineId)).toEqual(["oven-04", "press-02", "pack-03", "mixer-01"]);
  });

  it("欄位：label 經 labels 函式、level、active、struck", () => {
    const [item] = summarize(
      mapOf(latch("press-02", 2_000, null, { level: "critical", clearedBy: "user" })),
      3_000,
      machineLabel,
    );
    expect(item).toEqual({
      machineId: "press-02",
      label: "壓製機 02",
      level: "critical",
      active: true,
      struck: true,
      since: 2_000,
    });
  });

  it("相對時間錨點：進行中為 enteredAt、回復後為 recoveredAt", () => {
    const items = summarize(
      mapOf(latch("press-02", 2_000, null), latch("oven-04", 1_000, 8_000)),
      10_000,
      machineLabel,
    );
    expect(items.map((i) => [i.machineId, i.active, i.since])).toEqual([
      ["press-02", true, 2_000],
      ["oven-04", false, 8_000],
    ]);
  });
});

describe("latchText（research R13 時態註記，T073 第四輪）", () => {
  const NOW = 100_000;
  it.each([
    [{ level: "critical", active: true, since: NOW - 12_000 }, "嚴重 · 進入 12 秒前"],
    [{ level: "warning", active: true, since: NOW - 1_000 }, "警告 · 剛進入"],
    [{ level: "critical", active: false, since: NOW - 3_000 }, "曾嚴重 · 3 秒前回復"],
    [{ level: "warning", active: false, since: NOW - 12_000 }, "曾警告 · 12 秒前回復"],
    [{ level: "critical", active: false, since: NOW }, "曾嚴重 · 剛回復"],
  ] as const)("%o → %s", (mark, text) => {
    expect(latchText(mark, NOW)).toBe(text);
  });

  it("已回復一律以「曾」起頭（過去式）；仍異常不帶「曾」、不出現「已回復」或「進入 剛剛」", () => {
    for (const level of ["warning", "critical"] as const) {
      for (const offset of [0, 1_500, 5_000, 75_000]) {
        expect(latchText({ level, active: false, since: NOW - offset }, NOW)).toMatch(/^曾(警告|嚴重) · /);
        const active = latchText({ level, active: true, since: NOW - offset }, NOW);
        expect(active).not.toMatch(/^曾/);
        expect(active).not.toContain("剛剛");
        expect(active).not.toContain("已回復");
      }
    }
  });
});
