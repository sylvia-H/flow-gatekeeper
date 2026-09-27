import { afterEach, describe, expect, it, vi } from "vitest";
import { HEARTBEAT_INTERVAL_MS, isHeartbeatFresh, startHeartbeat, stopHeartbeat } from "./heartbeat.js";

/** isHeartbeatFresh 邊界（憲章測試門檻；contracts/supervision-runtime.md §3）。 */
describe("isHeartbeatFresh", () => {
  it("PTTL 正值＝存活", () => {
    expect(isHeartbeatFresh(1)).toBe(true);
    expect(isHeartbeatFresh(29_999)).toBe(true);
  });

  it("PTTL 0（剛過期）＝不健康", () => {
    expect(isHeartbeatFresh(0)).toBe(false);
  });

  it("PTTL -1（key 存在但無 TTL，異常狀態）＝不健康", () => {
    expect(isHeartbeatFresh(-1)).toBe(false);
  });

  it("PTTL -2（key 不存在）＝不健康", () => {
    expect(isHeartbeatFresh(-2)).toBe(false);
  });
});

describe("startHeartbeat 的 isAlive 閘門", () => {
  afterEach(() => {
    stopHeartbeat();
    vi.useRealTimers();
  });

  it("處理槽全卡住時停止寫 key、只 warn 一次；恢復後續寫", () => {
    vi.useFakeTimers();
    const set = vi.fn().mockResolvedValue("OK");
    const warn = vi.fn();
    let alive = true;
    startHeartbeat({ set }, warn, () => alive);
    expect(set).toHaveBeenCalledTimes(1);

    alive = false;
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 3);
    expect(set).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);

    alive = true;
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    expect(set).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
