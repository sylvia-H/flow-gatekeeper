import { describe, expect, it } from "vitest";
import { createThrottledErrorReporter, LogThrottle } from "./log-throttle.js";

describe("LogThrottle", () => {
  it("首次放行；窗內重複壓掉；過窗放行並回報被壓次數", () => {
    const t = new LogThrottle(1000);
    expect(t.hit("pub", 0)).toEqual({ suppressed: 0 });
    expect(t.hit("pub", 100)).toBeNull();
    expect(t.hit("pub", 999)).toBeNull();
    expect(t.hit("pub", 1000)).toEqual({ suppressed: 2 });
    expect(t.hit("pub", 1500)).toBeNull();
  });

  it("不同 key 各自節流", () => {
    const t = new LogThrottle(1000);
    expect(t.hit("pub", 0)).toEqual({ suppressed: 0 });
    expect(t.hit("cache", 10)).toEqual({ suppressed: 0 });
  });

  it("模擬每 150ms 重連 30 秒：只放行 ceil(30000/interval) 則", () => {
    const t = new LogThrottle(10_000);
    let passed = 0;
    for (let now = 0; now < 30_000; now += 150) if (t.hit("pub", now)) passed += 1;
    expect(passed).toBe(3);
  });

  it("reset：只清指定 key 並回報未回報的被壓次數；無紀錄回 null；清後首則立即放行", () => {
    const t = new LogThrottle(1000);
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

describe("createThrottledErrorReporter", () => {
  it("連線錯誤洗版只放行一則；恢復時記一則並重置，之後再故障立即放行", () => {
    let t = 0;
    const r = createThrottledErrorReporter(30_000, () => t);
    const logged: number[] = [];
    const recovered: number[] = [];
    for (; t < 3000; t += 150) r.error("pub", new Error("WRONGPASS invalid password"), (s) => logged.push(s));
    expect(logged).toEqual([0]);

    r.recovered("pub", (s) => recovered.push(s));
    expect(recovered).toEqual([19]);
    r.recovered("pub", (s) => recovered.push(s)); // 沒有新錯誤：不重複記恢復
    expect(recovered).toEqual([19]);

    r.error("pub", new Error("WRONGPASS invalid password"), (s) => logged.push(s));
    expect(logged).toEqual([0, 0]);
  });

  it("同連線不同訊息（例如帶 jobId 的 lock 續租失敗）仍受節流", () => {
    let t = 0;
    const r = createThrottledErrorReporter(30_000, () => t);
    const logged: number[] = [];
    for (let i = 0; i < 100; i += 1, t += 100) {
      r.error("bullmq", new Error(`could not renew lock for job ${i}`), (s) => logged.push(s));
    }
    expect(logged).toEqual([0]);
    t = 30_000;
    r.error("bullmq", new Error("could not renew lock for job 999"), (s) => logged.push(s));
    expect(logged).toEqual([0, 99]);
  });

  it("不同連線互不影響", () => {
    const r = createThrottledErrorReporter(30_000, () => 0);
    const logged: string[] = [];
    r.error("pub", new Error("x"), () => logged.push("pub"));
    r.error("cache", new Error("x"), () => logged.push("cache"));
    r.recovered("cache", () => logged.push("cache-ok"));
    r.error("pub", new Error("y"), () => logged.push("pub-again"));
    expect(logged).toEqual(["pub", "cache", "cache-ok"]);
  });
});
