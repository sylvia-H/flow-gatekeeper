import { describe, expect, it } from "vitest";
import { ConnectionErrorThrottle, ERROR_LOG_THROTTLE_MS, LogThrottle } from "./throttle.js";

describe("LogThrottle", () => {
  it("同 key 在間隔內只放行第一則，下次放行時回報被壓掉的次數；放行後計數歸零、重新計時", () => {
    const t = new LogThrottle(30_000);
    expect(t.hit("telemetry", 0)).toEqual({ suppressed: 0 });
    expect(t.hit("telemetry", 1_000)).toBeNull();
    expect(t.hit("telemetry", 29_999)).toBeNull();
    expect(t.hit("telemetry", 30_000)).toEqual({ suppressed: 2 });
    expect(t.hit("telemetry", 30_001)).toBeNull();
    expect(t.hit("telemetry", 60_000)).toEqual({ suppressed: 1 });
  });

  it("不同 key 各自節流", () => {
    const t = new LogThrottle(1_000);
    expect(t.hit("pub", 0)).toEqual({ suppressed: 0 });
    expect(t.hit("cache", 10)).toEqual({ suppressed: 0 });
    expect(t.hit("pub", 20)).toBeNull();
  });

  it("模擬每 150ms 重連 30 秒：只放行 ceil(30000/interval) 則", () => {
    const t = new LogThrottle(10_000);
    let passed = 0;
    for (let now = 0; now < 30_000; now += 150) if (t.hit("pub", now)) passed += 1;
    expect(passed).toBe(3);
  });

  it("reset：只清指定 key 並回報未回報的被壓次數；無紀錄回 null；清後首則立即放行", () => {
    const t = new LogThrottle(1_000);
    t.hit("pub", 0);
    t.hit("pub", 1);
    t.hit("pub", 2);
    t.hit("cache", 4);
    expect(t.reset("pub")).toEqual({ suppressed: 2 });
    expect(t.reset("pub")).toBeNull();
    expect(t.hit("pub", 5)).toEqual({ suppressed: 0 });
    expect(t.hit("cache", 6)).toBeNull();
  });
});

describe("ConnectionErrorThrottle", () => {
  it("預設間隔為 ERROR_LOG_THROTTLE_MS（30 秒）", () => {
    expect(ERROR_LOG_THROTTLE_MS).toBe(30_000);
    const t = new ConnectionErrorThrottle();
    expect(t.onError(0)).toEqual({ log: true, suppressed: 0 });
    expect(t.onError(29_999)).toEqual({ log: false });
    expect(t.onError(30_000)).toEqual({ log: true, suppressed: 1 });
  });

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
