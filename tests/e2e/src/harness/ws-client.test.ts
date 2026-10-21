import { describe, expect, it } from "vitest";
import { computeMaxGap, diagnosisLookupUrl } from "./ws-client.js";

/** ws-client.ts 的純函式（相鄰間隔最大值、GET URL 組裝）——不需 Docker。 */

describe("computeMaxGap", () => {
  it("相鄰收到時刻差的最大值", () => {
    expect(computeMaxGap([0, 500, 1000, 31_000, 31_500])).toBe(30_000);
  });

  it("不足兩個時刻回 0", () => {
    expect(computeMaxGap([])).toBe(0);
    expect(computeMaxGap([123])).toBe(0);
  });

  it("from／to 只取區間內（含端點）的時刻，區間外的大間隔不算", () => {
    const times = [0, 40_000, 40_500, 41_000, 90_000];
    expect(computeMaxGap(times, 40_000, 41_000)).toBe(500);
    expect(computeMaxGap(times, 40_500)).toBe(49_000);
    expect(computeMaxGap(times, undefined, 41_000)).toBe(40_000);
  });
});

describe("diagnosisLookupUrl", () => {
  it("只帶 socketId", () => {
    expect(diagnosisLookupUrl("job-1", "sock-a")).toBe("http://127.0.0.1:18080/diagnoses/job-1?socketId=sock-a");
  });

  it("帶 previousSocketId，且 path／query 都經編碼", () => {
    expect(diagnosisLookupUrl("a/b", "s 1", "p&2")).toBe(
      "http://127.0.0.1:18080/diagnoses/a%2Fb?socketId=s+1&previousSocketId=p%262",
    );
  });
});
