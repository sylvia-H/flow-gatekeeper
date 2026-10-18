import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { attachThrottledErrorLog, bullmqConnection } from "./connection-error-throttle.js";

describe("attachThrottledErrorLog", () => {
  it("接上 ioredis 形狀的 emitter：重連風暴只記一則，ready 記一次恢復", async () => {
    const { EventEmitter } = await import("node:events");
    const conn = new EventEmitter();
    const errors: [string, number][] = [];
    const recovered: number[] = [];
    let clock = 0;
    attachThrottledErrorLog(
      conn,
      {
        error: (err, suppressed) => errors.push([err.message, suppressed]),
        recovered: (suppressed) => recovered.push(suppressed),
      },
      { intervalMs: 30_000, now: () => clock },
    );
    for (let i = 0; i < 50; i += 1) {
      clock += 200;
      conn.emit("error", new Error("WRONGPASS"));
    }
    conn.emit("ready");
    expect(errors).toEqual([["WRONGPASS", 0]]);
    expect(recovered).toEqual([49]);
  });
});

describe("bullmqConnection（Queue／QueueEvents 共用）", () => {
  /** 仿 bullmq：自身轉發 error，`client` 是底層 ioredis 連線（第一次 ready 才 resolve）。 */
  function makeEmitter(status: string, rejectClient = false) {
    const self = new EventEmitter();
    const client = Object.assign(new EventEmitter(), { status });
    return {
      self,
      client,
      emitter: {
        on: (event: "error", listener: (err: Error) => void) => self.on(event, listener),
        client: rejectClient ? Promise.reject(new Error("closing")) : Promise.resolve(client),
      },
    };
  }

  it("error 掛在 Queue 自身；恢復訊號取自底層連線的 ready", async () => {
    const { self, client, emitter } = makeEmitter("connecting");
    const errors: string[] = [];
    const recovered: number[] = [];
    attachThrottledErrorLog(bullmqConnection(emitter), {
      error: (err) => errors.push(err.message),
      recovered: (suppressed) => recovered.push(suppressed),
    });
    expect(self.listenerCount("error")).toBe(1);
    self.emit("error", new Error("ECONNREFUSED"));
    await Promise.resolve();
    client.emit("ready");
    expect(errors).toEqual(["ECONNREFUSED"]);
    expect(recovered).toEqual([0]);
  });

  it("掛上時底層連線已 ready：補觸發一次（開機期間的故障也記得到恢復）", async () => {
    const { self, emitter } = makeEmitter("ready");
    const recovered: number[] = [];
    attachThrottledErrorLog(bullmqConnection(emitter), {
      error: () => undefined,
      recovered: (suppressed) => recovered.push(suppressed),
    });
    self.emit("error", new Error("boom"));
    await Promise.resolve();
    await Promise.resolve();
    expect(recovered).toEqual([0]);
  });

  it("取底層連線失敗：只是收不到恢復訊號，error 監聽照常", async () => {
    const { self, emitter } = makeEmitter("end", true);
    const errors: string[] = [];
    attachThrottledErrorLog(bullmqConnection(emitter), {
      error: (err) => errors.push(err.message),
      recovered: () => undefined,
    });
    await Promise.resolve();
    self.emit("error", new Error("x"));
    expect(errors).toEqual(["x"]);
  });
});
