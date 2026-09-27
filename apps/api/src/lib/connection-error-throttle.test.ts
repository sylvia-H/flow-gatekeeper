import { describe, expect, it } from "vitest";
import { ConnectionErrorThrottle, attachThrottledErrorLog } from "./connection-error-throttle.js";

describe("ConnectionErrorThrottle", () => {
  it("故障的第一則立即放行，持續重連的後續錯誤在間隔內全數壓掉", () => {
    const t = new ConnectionErrorThrottle(30_000);
    expect(t.onError(0)).toEqual({ log: true, suppressed: 0 });
    // 模擬 ioredis 每 ~200ms 重連一次、持續 10 秒
    let passed = 0;
    for (let now = 200; now < 10_000; now += 200) {
      if (t.onError(now).log) passed += 1;
    }
    expect(passed).toBe(0);
  });

  it("故障持續超過間隔：再放行一則並帶出被壓掉的則數", () => {
    const t = new ConnectionErrorThrottle(1_000);
    t.onError(0);
    t.onError(100);
    t.onError(200);
    expect(t.onError(1_000)).toEqual({ log: true, suppressed: 2 });
    expect(t.onError(1_100)).toEqual({ log: false });
  });

  it("恢復時回報一次並重置：下一次故障的第一則照樣立即可見", () => {
    const t = new ConnectionErrorThrottle(30_000);
    t.onError(0);
    t.onError(100);
    expect(t.onReady()).toEqual({ log: true, suppressed: 1 });
    expect(t.onReady()).toEqual({ log: false });
    expect(t.onError(200)).toEqual({ log: true, suppressed: 0 });
  });

  it("從未故障時 ready 不輸出", () => {
    expect(new ConnectionErrorThrottle().onReady()).toEqual({ log: false });
  });
});

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
