import { describe, expect, it } from "vitest";
import { createThrottledErrorReporter } from "./log-throttle.js";

describe("createThrottledErrorReporter", () => {
  it("連線錯誤洗版只放行一則；恢復時記一則並重置，之後再故障立即放行", () => {
    let t = 0;
    const r = createThrottledErrorReporter(30_000, () => t);
    const logged: number[] = [];
    const recovered: number[] = [];
    for (; t < 3000; t += 150) r.error("pub", (s) => logged.push(s));
    expect(logged).toEqual([0]);

    r.recovered("pub", (s) => recovered.push(s));
    expect(recovered).toEqual([19]);
    r.recovered("pub", (s) => recovered.push(s)); // 沒有新錯誤：不重複記恢復
    expect(recovered).toEqual([19]);

    r.error("pub", (s) => logged.push(s));
    expect(logged).toEqual([0, 0]);
  });

  it("同連線連續錯誤（例如每則帶不同 jobId 的 lock 續租失敗）仍只以連線名節流", () => {
    let t = 0;
    const r = createThrottledErrorReporter(30_000, () => t);
    const logged: number[] = [];
    for (let i = 0; i < 100; i += 1, t += 100) {
      r.error("bullmq", (s) => logged.push(s));
    }
    expect(logged).toEqual([0]);
    t = 30_000;
    r.error("bullmq", (s) => logged.push(s));
    expect(logged).toEqual([0, 99]);
  });

  it("不同連線互不影響", () => {
    const r = createThrottledErrorReporter(30_000, () => 0);
    const logged: string[] = [];
    r.error("pub", () => logged.push("pub"));
    r.error("cache", () => logged.push("cache"));
    r.recovered("cache", () => logged.push("cache-ok"));
    r.error("pub", () => logged.push("pub-again"));
    expect(logged).toEqual(["pub", "cache", "cache-ok"]);
  });
});
