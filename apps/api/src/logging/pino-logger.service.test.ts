import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { overrideNestLogger } from "../test-support/nest-logger.js";
import { Logger } from "@nestjs/common";
import { createLogger } from "@flow-gatekeeper/shared/logging";
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

/**
 * API-11：Error 物件導到 `err` 鍵、不再 `JSON.stringify` 成 msg。以真 pino（同一份 `createLogger`）
 * 捕捉實際輸出，涵蓋審查報告列的外洩形狀。
 */
describe("PinoLoggerService 的 Error 處理與祕密遮蔽（API-11）", () => {
  const SECRET = "SECRET";

  function realSetup() {
    const chunks: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer | string, _enc, cb) {
        chunks.push(chunk.toString());
        cb();
      },
    });
    const logger = createLogger("api", { LOG_LEVEL: "info", LOG_PRETTY: "false" }, stream);
    const service = new PinoLoggerService(logger);
    const raw = () => chunks.join("");
    const lines = () => chunks.map((l) => JSON.parse(l) as Record<string, unknown>);
    return { service, raw, lines };
  }

  /** 模擬 ioredis `ReplyError`：AUTH 失敗時整條命令（含密碼）掛在 error 上。 */
  function replyError(): Error {
    class ReplyError extends Error {}
    return Object.assign(new ReplyError("WRONGPASS invalid username-password pair"), {
      command: { name: "auth", args: [SECRET] },
    });
  }

  /** 模擬 body-parser 的 `entity.parse.failed`：原始請求本文掛在 `err.body`。 */
  function bodyParserError(): Error {
    return Object.assign(new SyntaxError("Unexpected token 'S', \"SECRET\" is not valid JSON"), {
      status: 400,
      statusCode: 400,
      expose: true,
      type: "entity.parse.failed",
      body: `{"password":"${SECRET}"`,
    });
  }

  it(".error(err)：msg 取 err.message、err 走標準序列化（type／stack 保留），command.args 不外洩", () => {
    const { service, raw, lines } = realSetup();
    service.error(replyError());
    expect(raw()).not.toContain(SECRET);
    const [line] = lines();
    expect(line?.msg).toBe("WRONGPASS invalid username-password pair");
    expect(line?.err).toMatchObject({ type: "ReplyError", command: { name: "auth" } });
    expect((line?.err as { stack: string }).stack).toContain("WRONGPASS");
  });

  it(".warn(msg, err)：extra 裡的 Error 導到 err 鍵，不留在 extra", () => {
    const { service, raw, lines } = realSetup();
    service.warn("redis down", replyError(), { attempt: 2 });
    expect(raw()).not.toContain(SECRET);
    const [line] = lines();
    expect(line?.msg).toBe("redis down");
    expect(line?.err).toMatchObject({ type: "ReplyError", command: { name: "auth" } });
    expect(line?.extra).toEqual([{ attempt: 2 }]);
  });

  it("extra 裡第二個以後的 Error 仍留在 extra，但同樣序列化且不外洩", () => {
    const { service, raw, lines } = realSetup();
    service.warn("two errors", replyError(), replyError());
    expect(raw()).not.toContain(SECRET);
    const [line] = lines();
    const [second] = line?.extra as [{ message: string; command: unknown }];
    expect(second.message).toContain("WRONGPASS");
    expect(second.command).toEqual({ name: "auth" });
  });

  it(".log({ err })：物件 message 裡的 Error 在 JSON 化前已剝掉 command.args", () => {
    const { service, raw, lines } = realSetup();
    service.log({ err: replyError(), nested: { reply: { command: { name: "auth", args: [SECRET] } } } });
    expect(raw()).not.toContain(SECRET);
    const parsed = JSON.parse(lines()[0]?.msg as string) as { err: { message: string } };
    expect(parsed.err.message).toContain("WRONGPASS");
  });

  it("body-parser 解析錯誤：err.body 與引用本文的 message／stack 都不進日誌（SECRET 完全不出現），原物件不被改動", () => {
    const { service, raw, lines } = realSetup();
    const err = bodyParserError() as Error & { body: string };
    const originalMessage = err.message;
    service.error(err);
    service.warn("parse failed", err);
    service.warn("as extra", "x", err);
    expect(raw()).not.toContain(SECRET);
    expect(raw()).not.toContain(`"body"`);
    const [first, second, third] = lines();
    expect(first?.msg).toBe("request body could not be parsed");
    expect(first?.err).toMatchObject({
      type: "SyntaxError",
      message: "request body could not be parsed",
      status: 400,
      expose: true,
    });
    expect((first?.err as { stack: string }).stack).toContain("request body could not be parsed");
    expect(second?.err).toMatchObject({ message: "request body could not be parsed" });
    expect(third?.err).toMatchObject({ message: "request body could not be parsed" });
    expect(third?.extra).toEqual(["x"]);
    expect(err.body).toContain(SECRET);
    expect(err.message).toBe(originalMessage);
  });

  it("Nest BaseExceptionFilter 對非 HttpException 的 `logger.error(exception)`：msg 不再是 `{}`", () => {
    const { service, raw, lines } = realSetup();
    withNestLogger(service, () => {
      new Logger("ExceptionsHandler").error(replyError());
    });
    expect(raw()).not.toContain(SECRET);
    const [line] = lines();
    expect(line?.msg).toBe("WRONGPASS invalid username-password pair");
    expect(line?.context).toBe("ExceptionsHandler");
    expect(line?.err).toMatchObject({ type: "ReplyError" });
  });

  it("error(message, stack)：沒有 Error 物件時照舊把 stack 字串放進 err.stack", () => {
    const { service, lines } = realSetup();
    service.error("boom", STACK);
    expect(lines()[0]?.err).toEqual({ stack: STACK });
  });
});
