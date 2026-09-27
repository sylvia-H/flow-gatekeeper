import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger, REDACTED } from "./index.js";

const SECRET = "SuperSecret";

/** 捕捉 pino 輸出的每一行 JSON。 */
function capture(): { stream: Writable; lines: () => Record<string, unknown>[]; raw: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  const raw = () => chunks.join("");
  return {
    stream,
    raw,
    lines: () =>
      raw()
        .split("\n")
        .filter((l) => l.trim() !== "")
        .map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

/** 模擬 ioredis `ReplyError`：AUTH 失敗時整條命令（含密碼）掛在 error 上。 */
function authError(): Error {
  return Object.assign(new Error("WRONGPASS invalid username-password pair"), {
    command: { name: "auth", args: [SECRET] },
  });
}

const env = { LOG_LEVEL: "info", LOG_PRETTY: "false" };

describe("createLogger 祕密遮蔽（ioredis err.command.args）", () => {
  it("`{ err }` 記錄 AUTH 失敗：輸出不含密碼，但保留 command.name", () => {
    const out = capture();
    const logger = createLogger("api", env, out.stream);
    logger.warn({ err: authError() }, "redis connection error");

    expect(out.raw()).not.toContain(SECRET);
    const [line] = out.lines();
    const err = line?.err as { message: string; command: Record<string, unknown> };
    expect(err.message).toContain("WRONGPASS");
    expect(err.command).toEqual({ name: "auth" });
  });

  it("child logger 同樣遮蔽", () => {
    const out = capture();
    const logger = createLogger("worker", env, out.stream);
    logger.child({ context: "redis" }).error({ err: authError() }, "noauth");
    expect(out.raw()).not.toContain(SECRET);
    expect(out.raw()).toContain('"name":"auth"');
  });

  it("直接傳 Error 為第一個參數（pino 放進 err 鍵）也遮蔽", () => {
    const out = capture();
    createLogger("api", env, out.stream).error(authError());
    expect(out.raw()).not.toContain(SECRET);
  });

  it("包在 cause 鏈裡的 AUTH 錯誤也不外洩密碼", () => {
    const out = capture();
    const wrapped = new Error("connect failed", { cause: authError() });
    createLogger("api", env, out.stream).error({ err: wrapped }, "wrapped");
    expect(out.raw()).not.toContain(SECRET);
  });

  it("不經 err 鍵（其他鍵名或巢狀）的 command.args 由 redact 路徑遮蔽", () => {
    const out = capture();
    const logger = createLogger("api", env, out.stream);
    logger.warn({ reply: { command: { name: "auth", args: [SECRET] } } }, "other key");
    logger.warn({ job: { err: { command: { name: "auth", args: [SECRET] } } } }, "nested err");
    expect(out.raw()).not.toContain(SECRET);
    expect(out.raw()).toContain(REDACTED);
  });

  it("不改動呼叫端的原始 error 物件", () => {
    const out = capture();
    const err = authError() as Error & { command: { args: string[] } };
    createLogger("api", env, out.stream).warn({ err }, "x");
    expect(err.command.args).toEqual([SECRET]);
  });

  it("巢狀 error 屬性（如 ClusterAllFailedError.lastNodeError）上的 command.args 也剝掉", () => {
    const out = capture();
    const cluster = Object.assign(new Error("Failed to refresh slots cache."), {
      lastNodeError: authError(),
      nodes: [{ last: authError() }],
    });
    createLogger("api", env, out.stream).error({ err: cluster }, "cluster");
    expect(out.raw()).not.toContain(SECRET);
    const [line] = out.lines();
    const err = line?.err as { lastNodeError: { command: unknown } };
    expect(err.lastNodeError.command).toEqual({ name: "auth" });
  });

  it("可列舉的 plain object cause：輸出遮蔽，呼叫端物件不被改動", () => {
    const out = capture();
    const plainCause = { command: { name: "auth", args: [SECRET] } };
    const err = new Error("x");
    err.cause = plainCause;
    createLogger("api", env, out.stream).error({ err }, "plain cause");
    expect(out.raw()).not.toContain(SECRET);
    expect(plainCause.command.args).toEqual([SECRET]);
  });

  it("循環參考不致無窮遞迴", () => {
    const out = capture();
    const err = authError() as Error & { self?: unknown; meta?: Record<string, unknown> };
    const meta: Record<string, unknown> = {};
    meta.loop = meta;
    err.meta = meta;
    createLogger("api", env, out.stream).error({ err }, "cycle");
    expect(out.raw()).not.toContain(SECRET);
  });
});
