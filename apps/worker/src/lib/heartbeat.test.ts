import { describe, expect, it } from "vitest";
import { isHeartbeatFresh } from "./heartbeat.js";

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
