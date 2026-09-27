import { describe, expect, it, vi } from "vitest";
import { overrideNestLogger } from "../test-support/nest-logger.js";
import { Logger } from "@nestjs/common";
import type { FlowLogger } from "@flow-gatekeeper/shared/logging";
import { PinoLoggerService } from "./pino-logger.service.js";

/**
 * TQ-9：`PinoLoggerService` 仿 Nest `ConsoleLogger` 的 `(message, ...optionalParams)` 拆解。
 * 以假 `FlowLogger` 記錄每次呼叫的 level／bindings／msg。
 */

type Level = "info" | "error" | "warn" | "debug" | "trace";
type Call = { level: Level; bindings: Record<string, unknown>; msg: string };

function setup() {
  const calls: Call[] = [];
  const record = (level: Level) =>
    vi.fn((bindings: Record<string, unknown>, msg: string) => {
      calls.push({ level, bindings, msg });
    });
  const fake = {
    info: record("info"),
    error: record("error"),
    warn: record("warn"),
    debug: record("debug"),
    trace: record("trace"),
  };
  const service = new PinoLoggerService(fake as unknown as FlowLogger);
  return { service, calls };
}

/**
 * 以 `service` 接管 Nest 全域 logger（等同 main.ts 的 `NestFactory.create(..., { logger })`），
 * 跑完還原原本的 static instance，避免影響同檔其他測試。
 */
function withNestLogger(service: PinoLoggerService, run: () => void): void {
  const restore = overrideNestLogger(service);
  try {
    run();
  } finally {
    restore();
  }
}

const STACK = "Error: boom\n    at Object.<anonymous> (/app/dist/main.js:10:15)\n    at node:internal/x:1:1";

describe("PinoLoggerService 參數拆解（TQ-9）", () => {
  it("等級對應：log→info、verbose→trace，其餘同名", () => {
    const { service, calls } = setup();
    service.log("a");
    service.error("b");
    service.warn("c");
    service.debug("d");
    service.verbose("e");
    expect(calls.map((c) => [c.level, c.msg])).toEqual([
      ["info", "a"],
      ["error", "b"],
      ["warn", "c"],
      ["debug", "d"],
      ["trace", "e"],
    ]);
    // 只有 message：沒有 context、沒有 extra。
    for (const c of calls) expect(c.bindings).toEqual({});
  });

  it("T013 回歸：Nest `Logger` 實例帶建構子 context、呼叫端只傳一個 message → 最後一位字串是 context", () => {
    const { service, calls } = setup();
    // Nest `Logger` 持有 context 時，會以 `localInstance.log(message, context)` 呼叫——
    // 即 optionalParams 長度為 1；曾因只看 optionalParams 而誤判為「無 context」。
    withNestLogger(service, () => {
      new Logger("JobsService").log("job enqueued");
      new Logger("JobsService").warn("slow");
    });
    expect(calls).toEqual([
      { level: "info", bindings: { context: "JobsService" }, msg: "job enqueued" },
      { level: "warn", bindings: { context: "JobsService" }, msg: "slow" },
    ]);
  });

  it("多參數：最後一個字串視為 context，中間的參數放進 extra；最後一位非字串則全部當訊息", () => {
    const { service, calls } = setup();
    service.log("hello", { a: 1 }, 42, "Ctx");
    service.warn("hello", { a: 1 }, 42);
    expect(calls[0]).toEqual({
      level: "info",
      bindings: { context: "Ctx", extra: [{ a: 1 }, 42] },
      msg: "hello",
    });
    expect(calls[1]).toEqual({ level: "warn", bindings: { extra: [{ a: 1 }, 42] }, msg: "hello" });
  });

  it("object message：序列化為 JSON 字串當 msg，context 照常拆出", () => {
    const { service, calls } = setup();
    service.log({ event: "boot", port: 3000 }, "NestApplication");
    service.debug({ only: true });
    expect(calls[0]).toEqual({
      level: "info",
      bindings: { context: "NestApplication" },
      msg: JSON.stringify({ event: "boot", port: 3000 }),
    });
    expect(calls[1]).toEqual({ level: "debug", bindings: {}, msg: '{"only":true}' });
  });

  it("error(message, stack)：第二參數符合 stack 格式 → 放進 err.stack，不當 context", () => {
    const { service, calls } = setup();
    service.error("boom", STACK);
    expect(calls[0]).toEqual({ level: "error", bindings: { err: { stack: STACK } }, msg: "boom" });
  });

  it("error(message, context)：兩參數但第二個不是 stack 格式（含單行 'at' 字樣）→ 視為 context", () => {
    const { service, calls } = setup();
    service.error("boom", "ExceptionsHandler");
    service.error("boom", "look at file.ts:1:2"); // 無換行＋縮排 at：不是 stack
    expect(calls[0]).toEqual({ level: "error", bindings: { context: "ExceptionsHandler" }, msg: "boom" });
    expect(calls[1]).toEqual({
      level: "error",
      bindings: { context: "look at file.ts:1:2" },
      msg: "boom",
    });
  });

  it("error(message, stack, context)：Nest `Logger` 實例呼叫 error(msg, stack) 的實際形狀，三者各歸其位", () => {
    const { service, calls } = setup();
    service.error("boom", STACK, "HistoryService");
    // stack 位置是 undefined（Nest `Logger.error(msg)` 帶 context 時會補成 [msg, undefined, ctx]）。
    service.error("no stack", undefined, "HistoryService");
    expect(calls[0]).toEqual({
      level: "error",
      bindings: { context: "HistoryService", err: { stack: STACK } },
      msg: "boom",
    });
    expect(calls[1]).toEqual({ level: "error", bindings: { context: "HistoryService" }, msg: "no stack" });
  });

  it("error 經 Nest `Logger` 實例：帶 stack 與只帶 message 兩種呼叫都拆對 context 與 stack", () => {
    const { service, calls } = setup();
    withNestLogger(service, () => {
      const logger = new Logger("MonitoringGateway");
      logger.error("init failed", STACK);
      logger.error("init failed");
    });
    expect(calls[0]).toEqual({
      level: "error",
      bindings: { context: "MonitoringGateway", err: { stack: STACK } },
      msg: "init failed",
    });
    expect(calls[1]).toEqual({
      level: "error",
      bindings: { context: "MonitoringGateway" },
      msg: "init failed",
    });
  });

  it("error 多參數且最後一位非字串：不拆 stack，全部保留為訊息", () => {
    const { service, calls } = setup();
    service.error("boom", { code: 1 }, { code: 2 });
    expect(calls[0]).toEqual({
      level: "error",
      bindings: { extra: [{ code: 1 }, { code: 2 }] },
      msg: "boom",
    });
  });
});
