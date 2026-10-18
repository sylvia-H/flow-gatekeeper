import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger } from "./index.js";

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

  it("不經 err 鍵（其他鍵名或巢狀）的 command 物件：formatters.log 剝掉 args、只留 name", () => {
    const out = capture();
    const logger = createLogger("api", env, out.stream);
    logger.warn({ reply: { command: { name: "auth", args: [SECRET] } } }, "other key");
    logger.warn({ job: { err: { command: { name: "auth", args: [SECRET] } } } }, "nested err");
    logger.warn({ command: { name: "auth", args: [SECRET] } }, "top-level command");
    expect(out.raw()).not.toContain(SECRET);
    const [reply, job, top] = out.lines();
    expect((reply?.reply as { command: unknown }).command).toEqual({ name: "auth" });
    expect((job?.job as { err: { command: unknown } }).err.command).toEqual({ name: "auth" });
    expect(top?.command).toEqual({ name: "auth" });
  });

  it("child bindings 也全深度剝除（比 REDACT_PATHS 更深、子代的子代、setBindings、metrics child）", () => {
    const out = capture();
    const logger = createLogger("api", env, out.stream);
    logger.child({ reply: { command: { name: "auth", args: [SECRET] } } }).warn("one level");
    logger.child({ a: { b: { c: { command: { name: "auth", args: [SECRET] } } } } }).warn("deep");
    logger.child({ context: "x" }).child({ ctx: { error: authError() } }).warn("grandchild");
    const later = logger.child({ context: "later" });
    later.setBindings({ a: { b: { command: { name: "auth", args: [SECRET] } } } });
    later.warn("setBindings");
    logger.metrics.child({ a: { b: { e: authError() } } }).warn("metrics child");
    expect(out.raw()).not.toContain(SECRET);
    const [one, deep, grand, set, metrics] = out.lines();
    expect((one?.reply as { command: unknown }).command).toEqual({ name: "auth" });
    expect((deep?.a as { b: { c: { command: unknown } } }).b.c.command).toEqual({ name: "auth" });
    expect(grand).toMatchObject({ context: "x", ctx: { error: { type: "Error", command: { name: "auth" } } } });
    expect((set?.a as { b: { command: unknown } }).b.command).toEqual({ name: "auth" });
    expect(metrics).toMatchObject({ context: "metrics", a: { b: { e: { command: { name: "auth" } } } } });
  });

  it("一般字串 bindings 的輸出形狀不變", () => {
    const out = capture();
    createLogger("api", env, out.stream).child({ context: "JobsService", jobId: "j1" }).info("x");
    const [line] = out.lines();
    expect(line).toMatchObject({ service: "api", context: "JobsService", jobId: "j1", msg: "x" });
  });

  it("自我參照：Error 經陣列指回自己（e.arr = [e]）不外洩，循環的陣列與物件不致無窮遞迴也不外洩", () => {
    const out = capture();
    const logger = createLogger("api", env, out.stream);
    const e = authError() as Error & { arr?: unknown[]; self?: unknown };
    e.arr = [e];
    e.self = e;
    logger.warn({ x: e }, "error cycle");
    const arr: unknown[] = [{ command: { name: "auth", args: [SECRET] } }];
    arr.push(arr);
    const obj: Record<string, unknown> = { command: { name: "auth", args: [SECRET] } };
    obj.me = obj;
    obj.list = [obj, arr];
    logger.warn({ arr, obj }, "array/object cycle");
    expect(out.raw()).not.toContain(SECRET);
    expect(out.lines()).toHaveLength(2);
  });

  it("有 toJSON 的物件：先 toJSON 再剝除；Date／Buffer 輸出與 JSON.stringify 相同", () => {
    const out = capture();
    const holder = {
      toJSON() {
        return { kind: "holder", inner: { e: authError(), reply: { command: { name: "auth", args: [SECRET] } } } };
      },
    };
    class Wrapped {
      toJSON() {
        return [authError()];
      }
    }
    const at = new Date("2026-10-18T00:00:00.000Z");
    const buf = Buffer.from("ab");
    createLogger("api", env, out.stream).warn({ ctx: { holder, w: new Wrapped() }, at, buf }, "toJSON");
    expect(out.raw()).not.toContain(SECRET);
    const [line] = out.lines();
    const ctx = line?.ctx as { holder: { kind: string; inner: { e: { command: unknown }; reply: { command: unknown } } }; w: [{ command: unknown }] };
    expect(ctx.holder.kind).toBe("holder");
    expect(ctx.holder.inner.e.command).toEqual({ name: "auth" });
    expect(ctx.holder.inner.reply.command).toEqual({ name: "auth" });
    expect(ctx.w[0].command).toEqual({ name: "auth" });
    expect(line?.at).toBe(JSON.parse(JSON.stringify(at)));
    expect(line?.buf).toEqual(JSON.parse(JSON.stringify(buf)));
  });

  it("toJSON 拋錯：logger 不拋出，該行照常輸出", () => {
    const out = capture();
    const logger = createLogger("api", env, out.stream);
    const bad = {
      toJSON(): never {
        throw new Error("x");
      },
    };
    expect(() => logger.warn({ x: bad, ok: 1 }, "m")).not.toThrow();
    const [line] = out.lines();
    expect(line).toMatchObject({ msg: "m", ok: 1 });
  });

  it("toJSON 回傳自己：照 pino 原樣處理（輸出自有屬性），不會變成 [Circular]", () => {
    const out = capture();
    const self = {
      a: 1,
      toJSON() {
        return this;
      },
    };
    createLogger("api", env, out.stream).warn({ x: self }, "m");
    expect(out.raw()).not.toContain("[Circular]");
    const [line] = out.lines();
    expect(line?.x).toEqual({ a: 1 });
  });

  it("command 是陣列（命令列形狀）時只留命令名", () => {
    const out = capture();
    const logger = createLogger("api", env, out.stream);
    logger.warn({ command: ["auth", SECRET] }, "array command");
    logger.warn({ ctx: { command: ["auth", "user", SECRET] } }, "nested array command");
    expect(out.raw()).not.toContain(SECRET);
    const [top, nested] = out.lines();
    expect(top?.command).toEqual(["auth"]);
    expect((nested?.ctx as { command: unknown }).command).toEqual(["auth"]);
  });

  // CT-13：REDACT_PATHS 只涵蓋一層萬用字元、serializer 只處理 `err` 鍵，以下寫法原本都會外洩。
  it("巢狀兩層的 error（{ ctx: { error } }）不外洩密碼，且保留 message 與 command.name", () => {
    const out = capture();
    createLogger("api", env, out.stream).warn({ ctx: { error: authError() } }, "nested two levels");
    expect(out.raw()).not.toContain(SECRET);
    const [line] = out.lines();
    const error = (line?.ctx as { error: { message: string; type: string; command: unknown } }).error;
    expect(error.message).toContain("WRONGPASS");
    expect(error.type).toBe("Error");
    expect(error.command).toEqual({ name: "auth" });
  });

  it("陣列裡的 error（{ extra: [err] }）不外洩密碼，且轉成標準序列化形狀", () => {
    const out = capture();
    createLogger("api", env, out.stream).warn({ extra: ["x", authError()] }, "array");
    expect(out.raw()).not.toContain(SECRET);
    const [line] = out.lines();
    const [first, second] = line?.extra as [string, { message: string; stack: string }];
    expect(first).toBe("x");
    expect(second.message).toContain("WRONGPASS");
    expect(second.stack).toContain("WRONGPASS");
  });

  it("更深層（三層以上、陣列中的物件）與帶 command 的 plain object 也不外洩", () => {
    const out = capture();
    const logger = createLogger("worker", env, out.stream);
    logger.error({ a: { b: { c: [{ d: authError() }] } } }, "deep");
    logger.error({ a: { b: { reply: { command: { name: "auth", args: [SECRET] } } } } }, "deep plain");
    expect(out.raw()).not.toContain(SECRET);
    expect(out.raw()).toContain('"name":"auth"');
  });

  it("formatters.log 不改動呼叫端物件，也不重複序列化 err 鍵（type 維持原 class 名）", () => {
    const out = capture();
    const ctx = { error: authError() as Error & { command: { args: string[] } } };
    class ReplyError extends Error {}
    const replyErr = Object.assign(new ReplyError("NOAUTH"), { command: { name: "auth", args: [SECRET] } });
    createLogger("api", env, out.stream).warn({ ctx, err: replyErr }, "both");
    expect(out.raw()).not.toContain(SECRET);
    expect(ctx.error.command.args).toEqual([SECRET]);
    expect(replyErr.command.args).toEqual([SECRET]);
    const [line] = out.lines();
    expect((line?.err as { type: string }).type).toBe("ReplyError");
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

  it("err 鍵的值不是 Error（包著 error 或命令的 plain object）：三層以上也剝掉，呼叫端物件不變", () => {
    const out = capture();
    const logger = createLogger("api", env, out.stream);
    const wrapped = { a: { b: authError() } };
    const plain = { a: { b: { command: { name: "auth", args: [SECRET] } } } };
    logger.warn({ err: wrapped }, "err wraps error");
    logger.warn({ err: plain }, "err wraps command");
    expect(out.raw()).not.toContain(SECRET);
    const [first, second] = out.lines();
    const b = ((first?.err as { a: { b: { message: string; command: unknown } } }).a).b;
    expect(b.message).toContain("WRONGPASS");
    expect(b.command).toEqual({ name: "auth" });
    expect((second?.err as { a: { b: { command: unknown } } }).a.b.command).toEqual({ name: "auth" });
    expect(plain.a.b.command.args).toEqual([SECRET]);
  });

  it("沒有 toJSON 的 class instance 也往下走訪；Date／Map 等原樣保留", () => {
    const out = capture();
    class Holder {
      inner = { deep: { e: authError() } };
      label = "h";
    }
    const holder = new Holder();
    const at = new Date("2026-10-18T00:00:00.000Z");
    createLogger("api", env, out.stream).warn(
      { ctx: { h: holder }, at, tags: new Map([["k", 1]]) },
      "class instance",
    );
    expect(out.raw()).not.toContain(SECRET);
    const [line] = out.lines();
    const h = (line?.ctx as { h: { label: string; inner: { deep: { e: { command: unknown } } } } }).h;
    expect(h.label).toBe("h");
    expect(h.inner.deep.e.command).toEqual({ name: "auth" });
    expect(line?.at).toBe("2026-10-18T00:00:00.000Z");
    expect(line?.tags).toEqual({});
    expect((holder.inner.deep.e as Error & { command: { args: string[] } }).command.args).toEqual([SECRET]);
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
