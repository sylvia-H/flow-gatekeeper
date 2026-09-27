import { describe, expect, it } from "vitest";
import { attachThrottledErrorLog } from "./connection-error-throttle.js";

describe("attachThrottledErrorLog", () => {
  it("接上 ioredis 形狀的 emitter：重連風暴只記一則，ready 記一次恢復", async () => {
    const { EventEmitter } = await import("node:events");
    const conn = new EventEmitter();
    const errors: [string, number][] = [];
    const recovered: number[] = [];
    let clock = 0;
    attachThrottledErrorLog(
      conn,
      {
        error: (err, suppressed) => errors.push([err.message, suppressed]),
        recovered: (suppressed) => recovered.push(suppressed),
      },
      { intervalMs: 30_000, now: () => clock },
    );
    for (let i = 0; i < 50; i += 1) {
      clock += 200;
      conn.emit("error", new Error("WRONGPASS"));
    }
    conn.emit("ready");
    expect(errors).toEqual([["WRONGPASS", 0]]);
    expect(recovered).toEqual([49]);
  });
});
