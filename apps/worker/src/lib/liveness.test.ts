import { describe, expect, it } from "vitest";
import { createLivenessTracker } from "./liveness.js";

function setup() {
  let t = 0;
  const tracker = createLivenessTracker({ slots: 2, stallMs: 1000, now: () => t });
  return { tracker, advance: (ms: number) => (t += ms) };
}

describe("createLivenessTracker", () => {
  it("閒置（無進行中 job）＝活著", () => {
    const { tracker, advance } = setup();
    advance(10_000);
    expect(tracker.isAlive()).toBe(true);
  });

  it("只有一個槽卡住、仍有空槽 ＝ 活著", () => {
    const { tracker, advance } = setup();
    tracker.begin("a");
    advance(5000);
    expect(tracker.isAlive()).toBe(true);
  });

  it("兩個槽都卡住超過 stallMs ＝ 不活", () => {
    const { tracker, advance } = setup();
    tracker.begin("a");
    tracker.begin("b");
    advance(1001);
    expect(tracker.isAlive()).toBe(false);
  });

  it("任一槽有進度（touch）＝ 活著；結束後釋出槽", () => {
    const { tracker, advance } = setup();
    tracker.begin("a");
    tracker.begin("b");
    advance(900);
    tracker.touch("b");
    advance(200);
    expect(tracker.isAlive()).toBe(true);
    advance(2000);
    expect(tracker.isAlive()).toBe(false);
    tracker.end("a");
    expect(tracker.isAlive()).toBe(true);
  });

  it("touch 未 begin 的 id 不佔槽", () => {
    const { tracker } = setup();
    tracker.touch("ghost");
    tracker.begin("a");
    expect(tracker.isAlive()).toBe(true);
  });
});
