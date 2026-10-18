import "reflect-metadata";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Global, Injectable, Module } from "@nestjs/common";
import type { OnModuleInit } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { getQueueToken } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import type { RedisConnection } from "bullmq";
import { DIAGNOSIS_QUEUE } from "@flow-gatekeeper/contracts";
import type { DiagnosisJobPayload } from "@flow-gatekeeper/contracts";
import { DiagnosisQueueErrorLog } from "./diagnosis-queue-error-log.js";
import { JobsModule } from "./jobs.module.js";
import { AppConfigService } from "../config/config.service.js";

/**
 * API-1（P1）：producer `Queue` 沒掛 error 監聽時，bullmq 的 `QueueBase.emit` 直接 `console.error(err)`，
 * ioredis `ReplyError` 的 `command.args`（AUTH 時即 `REDIS_PASSWORD`）明文進 stderr。
 *
 * 用**真的** bullmq `Queue`（只把底層連線換成不連 Redis 的假連線），emit 行為與正式環境同一份程式碼；
 * app logger 換成寫進記憶體的真 pino（同一份 `createLogger`），斷言實際輸出的 JSON。
 */

const SECRET = "SECRET";

const logs = vi.hoisted(() => ({ chunks: [] as string[] }));

vi.mock("../../logging/app-logger.js", async () => {
  const { Writable } = await import("node:stream");
  const { createLogger } = await import("@flow-gatekeeper/shared/logging");
  const stream = new Writable({
    write(chunk: Buffer | string, _enc, cb) {
      logs.chunks.push(chunk.toString());
      cb();
    },
  });
  const logger = createLogger("api", { LOG_LEVEL: "info", LOG_PRETTY: "false" }, stream);
  return { getAppLogger: () => logger };
});

/** 不連 Redis 的假連線：`client` 永不 resolve，`error` 由測試從 Queue 端 emit。 */
class FakeConnection extends EventEmitter {
  readonly client = new Promise<never>(() => undefined);
  close(): Promise<void> {
    return Promise.resolve();
  }
}

function makeQueue(): Queue<DiagnosisJobPayload> {
  return new Queue<DiagnosisJobPayload>(
    DIAGNOSIS_QUEUE,
    { connection: {} },
    FakeConnection as unknown as typeof RedisConnection,
  );
}

/** 模擬 ioredis `ReplyError`：AUTH 失敗時整條命令（含密碼）掛在 error 上。 */
function authError(): Error {
  return Object.assign(new Error("WRONGPASS invalid username-password pair"), {
    command: { name: "auth", args: [SECRET] },
  });
}


afterEach(() => {
  logs.chunks.length = 0;
  vi.restoreAllMocks();
});

describe("DiagnosisQueueErrorLog：producer Queue 的 error 監聽（API-1）", () => {
  it("對照：沒有監聽者時 bullmq 真的走 console.error，密碼原樣外洩", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const queue = makeQueue();
    expect(queue.listenerCount("error")).toBe(0);

    const err = authError();
    queue.emit("error", err);

    expect(consoleError).toHaveBeenCalledWith(err);
  });

  it("建構後 Queue 有 error 監聽；帶 command.args 的錯誤不走 console.error，日誌不含密碼", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const queue = makeQueue();
    new DiagnosisQueueErrorLog(queue);
    expect(queue.listenerCount("error")).toBeGreaterThan(0);

    queue.emit("error", authError());

    expect(consoleError).not.toHaveBeenCalled();
    const raw = logs.chunks.join("");
    expect(raw).not.toContain(SECRET);
    const [line] = logs.chunks.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(line).toMatchObject({
      level: 40,
      context: "DiagnosisQueueErrorLog",
      msg: "diagnosis queue redis connection error",
      err: { message: "WRONGPASS invalid username-password pair", command: { name: "auth" } },
    });
  });

  it("重連風暴：連續錯誤只記第一則（轉態節流）", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const queue = makeQueue();
    new DiagnosisQueueErrorLog(queue);

    for (let i = 0; i < 20; i += 1) queue.emit("error", authError());

    expect(logs.chunks).toHaveLength(1);
  });
});

describe("DiagnosisQueueErrorLog 的 DI 佈線（API-1）", () => {
  it("真的 JobsModule（BullModule 建的 Queue）：建好後 Queue 已有 error 監聽，錯誤不走 console.error", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    // 只提供 JobsModule 需要的 AppConfigService.redisOptions：指向不會有服務的埠、lazyConnect，
    // retryStrategy 回 null 讓 ioredis 第一次連不上就放棄（關閉時沒有進行中的連線，不留未處理的 rejection）。
    const config = {
      redisOptions: () => ({
        host: "127.0.0.1",
        port: 1,
        lazyConnect: true,
        retryStrategy: () => null,
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
      }),
    };

    @Global()
    @Module({ providers: [{ provide: AppConfigService, useValue: config }], exports: [AppConfigService] })
    class FakeConfigModule {}

    @Module({ imports: [FakeConfigModule, JobsModule] })
    class TestModule {}

    const app = await NestFactory.createApplicationContext(TestModule, { logger: false });
    try {
      const queue = app.get<Queue<DiagnosisJobPayload>>(getQueueToken(DIAGNOSIS_QUEUE));
      expect(queue).toBeInstanceOf(Queue);
      expect(queue.listenerCount("error")).toBeGreaterThan(0);
      queue.emit("error", authError());
      expect(consoleError).not.toHaveBeenCalled();
      expect(logs.chunks.join("")).toContain("diagnosis queue redis connection error");
      expect(logs.chunks.join("")).not.toContain(SECRET);
      // 等真的連線錯誤（ECONNREFUSED）也經過監聽、ioredis 放棄重連後再關閉。
      await new Promise((resolve) => queue.once("error", resolve));
      await queue.client.catch(() => undefined);
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  }, 20_000);

  it("任何 onModuleInit 執行前 Queue 已有 error 監聽（Mongo 連線等 hook 的空窗內不會走 console.error）", async () => {
    const queue = makeQueue();
    const seenAtInit: number[] = [];

    @Injectable()
    class EarliestHook implements OnModuleInit {
      onModuleInit(): void {
        seenAtInit.push(queue.listenerCount("error"));
      }
    }

    // EarliestHook 放在被匯入的子模組：Nest 依模組距離由深到淺呼叫 hook，它會比任何同層 provider 先跑。
    @Module({ providers: [EarliestHook] })
    class InnerModule {}

    @Module({
      imports: [InnerModule],
      providers: [{ provide: getQueueToken(DIAGNOSIS_QUEUE), useValue: queue }, DiagnosisQueueErrorLog],
    })
    class TestModule {}

    const app = await NestFactory.createApplicationContext(TestModule, { logger: false });
    await app.close();
    expect(seenAtInit).toHaveLength(1);
    expect(seenAtInit[0]).toBeGreaterThan(0);
  });
});
