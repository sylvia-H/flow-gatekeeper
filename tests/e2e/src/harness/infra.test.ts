import { describe, expect, it } from "vitest";
import {
  clearDiagnosisCacheScript,
  countLlmCallsIn,
  firstLogAfter,
  nthLogTime,
  parseDockerTime,
  parseLogLines,
  parseMongoshCount,
  parsePubsubKillOutput,
  pubsubKillScript,
  sumCacheCounters,
} from "./infra.js";

/**
 * infra.ts 的純函式（日誌解析、窗界加總、kill 迴圈腳本）——不需 Docker。
 * 日誌樣本照 pino 實際輸出形狀：`time` 為 epoch ms、`msg` 為訊息、child bindings 攤平在頂層。
 */

const line = (obj: Record<string, unknown>): string => JSON.stringify(obj);

const summary = (time: number, hits: number, misses: number): string =>
  line({
    level: 30,
    time,
    service: "worker",
    context: "metrics",
    llmLatency: { count: 0, p50: null, p95: null },
    cache: { hits, misses, hitRate: null },
    windowMs: 5000,
    msg: "worker metrics summary",
  });

describe("parseLogLines", () => {
  it("剝掉 compose 服務名前綴與 --timestamps 前綴，只留 pino JSON 行", () => {
    const stdout = [
      `worker-1  | ${line({ level: 30, time: 1000, msg: "worker ready" })}`,
      `worker-1  | 2026-10-21T01:02:03.123456789Z ${line({ level: 30, time: 2000, jobId: "j1", msg: "LLM call" })}`,
      line({ level: 30, time: 3000, msg: "no prefix" }),
      "worker-1  | (node:1) Warning: something not json",
      "worker-1  | {not json",
      line({ level: 30, msg: "缺 time" }),
      line({ level: 30, time: 4000 }),
      "",
    ].join("\r\n");
    const entries = parseLogLines(stdout);
    expect(entries.map((e) => [e.time, e.msg])).toEqual([
      [1000, "worker ready"],
      [2000, "LLM call"],
      [3000, "no prefix"],
    ]);
    expect(entries[1]?.jobId).toBe("j1");
  });

  it("time 為 ISO 字串時轉成 epoch ms", () => {
    const [e] = parseLogLines(line({ time: "2026-10-21T00:00:00.000Z", msg: "x" }));
    expect(e?.time).toBe(Date.parse("2026-10-21T00:00:00.000Z"));
  });
});

describe("countLlmCallsIn", () => {
  it("只數 msg 完全相符且 jobId 相符者", () => {
    const entries = parseLogLines(
      [
        line({ time: 1, jobId: "a", msg: "LLM call" }),
        line({ time: 2, jobId: "a", msg: "LLM call" }),
        line({ time: 3, jobId: "b", msg: "LLM call" }),
        line({ time: 4, jobId: "a", msg: "cache hit" }),
        line({ time: 5, jobId: "a", msg: "LLM call failed" }),
      ].join("\n"),
    );
    expect(countLlmCallsIn(entries, "a")).toBe(2);
    expect(countLlmCallsIn(entries, "b")).toBe(1);
    expect(countLlmCallsIn(entries, "c")).toBe(0);
  });
});

describe("firstLogAfter", () => {
  const entries = parseLogLines(
    [
      line({ time: 100, msg: "worker ready" }),
      line({ time: 500, msg: "worker ready" }),
      line({ time: 300, msg: "worker ready" }),
      line({ time: 400, msg: "other" }),
    ].join("\n"),
  );

  it("回 after 之後（嚴格大於）最早的一則，不依賴日誌順序", () => {
    expect(firstLogAfter(entries, "worker ready", 100)).toBe(300);
    expect(firstLogAfter(entries, "worker ready", 0)).toBe(100);
  });

  it("沒有符合者回 undefined", () => {
    expect(firstLogAfter(entries, "worker ready", 500)).toBeUndefined();
    expect(firstLogAfter(entries, "missing", 0)).toBeUndefined();
  });
});

describe("sumCacheCounters", () => {
  const entries = parseLogLines(
    [
      summary(1000, 5, 5), // 前一場景的窗：from 本身不算
      summary(2000, 0, 1),
      summary(3000, 0, 0),
      summary(4000, 1, 0), // to：含
      summary(5000, 9, 9), // to 之後
      line({ time: 2500, msg: "api metrics summary", cache: { hits: 7, misses: 7 } }),
      line({ time: 2600, msg: "worker metrics summary" }), // 缺 cache
      line({ time: 2700, msg: "worker metrics summary", cache: { hits: "x", misses: 2 } }),
    ].join("\n"),
  );

  it("加總 (from, to] 內每窗的 hits + misses", () => {
    // 2000：1、3000：0、4000：1、2600 缺 cache：0、2700 hits 非數字：0＋2；api 的摘要不算
    expect(sumCacheCounters(entries, 1000, 4000)).toBe(4);
  });

  it("區間外與其他訊息不計", () => {
    expect(sumCacheCounters(entries, 4000, 5000)).toBe(18);
    expect(sumCacheCounters(entries, 5000, 9000)).toBe(0);
  });
});

describe("pubsubKillScript", () => {
  it("單行、不含雙引號（Windows spawn 傳參不必跳脫），每輪 sleep 0.05", () => {
    const s = pubsubKillScript(20);
    expect(s).not.toContain("\n");
    expect(s).not.toContain('"');
    expect(s).toContain("+ 20 ))");
    expect(s).toContain("redis-cli CLIENT KILL TYPE pubsub");
    expect(s).toContain("sleep 0.05");
    // 密碼走 REDISCLI_AUTH，不進 -a 行程參數
    expect(s).toContain("REDISCLI_AUTH=$REDIS_PASSWORD");
    expect(s).not.toContain(" -a ");
  });

  it("秒數非 1–600 整數時拒絕", () => {
    expect(() => pubsubKillScript(0)).toThrow();
    expect(() => pubsubKillScript(1.5)).toThrow();
    expect(() => pubsubKillScript(601)).toThrow();
  });
});

describe("parsePubsubKillOutput", () => {
  it("取結尾摘要行", () => {
    expect(parsePubsubKillOutput("noise\npubsub-kill-loop iterations=380 killed=12\n")).toEqual({
      iterations: 380,
      killed: 12,
    });
  });

  it("沒有摘要行時拋錯", () => {
    expect(() => parsePubsubKillOutput("sh: redis-cli: not found")).toThrow(/未輸出結尾摘要/);
  });
});

describe("nthLogTime（workerReadyAt 的基線判定）", () => {
  const entries = parseLogLines(
    [
      line({ time: 900, msg: "worker ready" }),
      line({ time: 100, msg: "worker ready" }),
      line({ time: 500, msg: "other" }),
    ].join("\n"),
  );

  it("依時間排序取第 n 則（1 起算），不依賴日誌順序", () => {
    expect(nthLogTime(entries, "worker ready", 1)).toBe(100);
    expect(nthLogTime(entries, "worker ready", 2)).toBe(900);
  });

  it("基線 2 則時第 3 則尚未出現 → undefined（繼續等）；n < 1 也是 undefined", () => {
    expect(nthLogTime(entries, "worker ready", 3)).toBeUndefined();
    expect(nthLogTime(entries, "worker ready", 0)).toBeUndefined();
  });
});

describe("parseDockerTime", () => {
  it("奈秒小數截到毫秒", () => {
    expect(parseDockerTime("2026-10-21T14:03:13.123456789Z\n")).toBe(Date.parse("2026-10-21T14:03:13.123Z"));
  });

  it("無小數、短小數與時區偏移", () => {
    expect(parseDockerTime("2026-10-21T14:03:13Z")).toBe(Date.parse("2026-10-21T14:03:13.000Z"));
    expect(parseDockerTime("2026-10-21T14:03:13.5Z")).toBe(Date.parse("2026-10-21T14:03:13.500Z"));
    expect(parseDockerTime("2026-10-21T22:03:13.1+08:00")).toBe(Date.parse("2026-10-21T14:03:13.100Z"));
  });

  it("零值（從未結束）與格式不符回 NaN", () => {
    expect(parseDockerTime("0001-01-01T00:00:00Z")).toBeNaN();
    expect(parseDockerTime("")).toBeNaN();
    expect(parseDockerTime("not a time")).toBeNaN();
  });
});

describe("parseMongoshCount", () => {
  it("單純整數輸出", () => {
    expect(parseMongoshCount("1\n")).toBe(1);
    expect(parseMongoshCount("0")).toBe(0);
  });

  it("前置雜訊列與尾端警告列都略過，取最後一個整數列", () => {
    expect(parseMongoshCount("Current Mongosh Log ID: 6716abc\r\n2\r\n")).toBe(2);
    expect(parseMongoshCount("3\nWarning: Found ~/.mongorc.js, but not ~/.mongoshrc.js\n")).toBe(3);
  });

  it("空輸出或沒有整數列時拋錯", () => {
    expect(() => parseMongoshCount("")).toThrow(/找不到整數/);
    expect(() => parseMongoshCount("MongoServerError: not authorized\n")).toThrow(/找不到整數/);
  });
});

describe("clearDiagnosisCacheScript", () => {
  it("單行、不含雙引號、只掃 ai-cache: 前綴、密碼走 REDISCLI_AUTH", () => {
    const s = clearDiagnosisCacheScript();
    expect(s).not.toContain("\n");
    expect(s).not.toContain('"');
    expect(s).toContain("--scan --pattern 'ai-cache:*'");
    expect(s).not.toMatch(/FLUSH/i);
    expect(s).toContain("REDISCLI_AUTH=$REDIS_PASSWORD");
    expect(s).toContain("echo ai-cache-cleared=$n");
  });
});
