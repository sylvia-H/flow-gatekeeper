import { describe, expect, it } from "vitest";
import { LogThrottle } from "@flow-gatekeeper/shared/logging";
import { throttledFields } from "./throttled-log.js";

describe("throttledFields", () => {
  it("首則放行且不帶 suppressed；窗內壓掉；過窗放行並帶出被壓掉的則數", () => {
    const throttle = new LogThrottle(1_000);
    expect(throttledFields(throttle, "k", { a: 1 }, 0)).toEqual({ a: 1 });
    expect(throttledFields(throttle, "k", { a: 2 }, 100)).toBeNull();
    expect(throttledFields(throttle, "k", { a: 3 }, 200)).toBeNull();
    expect(throttledFields(throttle, "k", { a: 4 }, 1_000)).toEqual({ a: 4, suppressed: 2 });
    expect(throttledFields(throttle, "k", { a: 5 }, 2_000)).toEqual({ a: 5 });
  });

  it("不同 key 互不影響", () => {
    const throttle = new LogThrottle(1_000);
    expect(throttledFields(throttle, "a", {}, 0)).toEqual({});
    expect(throttledFields(throttle, "b", {}, 0)).toEqual({});
  });
});
