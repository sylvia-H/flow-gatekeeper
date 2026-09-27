import { describe, expect, it } from "vitest";
import { heartbeatKey, resolveInstanceId, WORKER_METRICS_PATTERN, workerMetricsKey } from "./redis-keys.js";

describe("resolveInstanceId", () => {
  it("有設定 WORKER_INSTANCE_ID 時優先採用", () => {
    expect(resolveInstanceId("worker-a", () => "host-1")).toBe("worker-a");
  });

  it("未設定時退回 hostname", () => {
    expect(resolveInstanceId(undefined, () => "host-1")).toBe("host-1");
  });

  it("預設 fallback 取 os.hostname()（非空字串）", () => {
    expect(resolveInstanceId(undefined).length).toBeGreaterThan(0);
  });
});

describe("每實例 key", () => {
  it("heartbeat 與 metrics key 皆帶實例後綴", () => {
    expect(heartbeatKey("abc")).toBe("worker:heartbeat:abc");
    expect(workerMetricsKey("abc")).toBe("metrics:worker:abc");
  });

  it("不同實例的 key 互不相同（不再互相覆寫）", () => {
    expect(workerMetricsKey("a")).not.toBe(workerMetricsKey("b"));
    expect(heartbeatKey("a")).not.toBe(heartbeatKey("b"));
  });

  it("metrics key 落在 api 掃描 pattern 的前綴內，且 heartbeat key 不會被誤掃", () => {
    const prefix = WORKER_METRICS_PATTERN.replace(/\*$/, "");
    expect(workerMetricsKey("abc").startsWith(prefix)).toBe(true);
    expect(heartbeatKey("abc").startsWith(prefix)).toBe(false);
  });
});
