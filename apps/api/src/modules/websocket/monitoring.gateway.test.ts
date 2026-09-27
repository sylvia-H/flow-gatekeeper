import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import { createServer } from "node:http";
import type { Server as HttpServer } from "node:http";
import { connect as netConnect } from "node:net";
import type { AddressInfo, Socket } from "node:net";
import { WebSocket } from "ws";
import type { AppConfigService } from "../config/config.service.js";
import type { HistoryService } from "../history/history.service.js";
import { MockTelemetryService } from "../telemetry/mock-telemetry.service.js";
import { MonitoringGateway, WS_MAX_PAYLOAD_BYTES } from "./monitoring.gateway.js";

// Gateway 只需要 config 的三個欄位（下方以 fake 提供）；把真實的 AppConfigService 模組替換掉，
// 讓這支測試不受環境變數驗證等設定層變動影響，也不必載入其相依。
vi.mock("../config/config.service.js", () => ({ AppConfigService: class AppConfigService {} }));

/**
 * Gateway 整合測試：真實 http.Server + ws，Config／History 用最小 fake，機台名冊用真的
 * MockTelemetryService（名冊單一來源）。重點是「任何畸形輸入都不得讓行程結束」——
 * 斷言 process.exit 未被呼叫、沒有 uncaughtException、server 之後仍接受新連線且合法訂閱正常。
 */

type Msg = { type?: string; [key: string]: unknown };

type Harness = {
  port: number;
  server: HttpServer;
  gateway: MonitoringGateway;
};

const running: Harness[] = [];

async function startGateway(
  opts: { secret?: string; allowedOrigins?: readonly string[] } = {},
): Promise<Harness> {
  const config = {
    mockTelemetryIntervalMs: 50,
    wsHeartbeatMs: 15_000,
    wsAuthSecret: opts.secret ?? "",
  } as unknown as AppConfigService;
  const history = { enqueue: vi.fn() } as unknown as HistoryService;
  const gateway = new MonitoringGateway(config, new MockTelemetryService(), history);
  const server = createServer();
  // 不呼叫 onModuleInit：不需要 producer／心跳計時器，只測訊息處理與協定層防護。
  gateway.attach(server, { allowedOrigins: opts.allowedOrigins ?? [] });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const h = { port, server, gateway };
  running.push(h);
  return h;
}

/** 連線並等到 system/connected；回傳 socket 與之後收到的訊息佇列。 */
async function openClient(
  port: number,
  origin?: string,
): Promise<{ ws: WebSocket; next: () => Promise<Msg> }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, origin ? { origin } : {});
  const queue: Msg[] = [];
  const waiters: Array<(m: Msg) => void> = [];
  ws.on("message", (data) => {
    const m = JSON.parse((data as Buffer).toString()) as Msg;
    const w = waiters.shift();
    if (w) w(m);
    else queue.push(m);
  });
  const next = (): Promise<Msg> =>
    new Promise((resolve, reject) => {
      const q = queue.shift();
      if (q) return resolve(q);
      const t = setTimeout(() => reject(new Error("timeout waiting for message")), 3_000);
      waiters.push((m) => {
        clearTimeout(t);
        resolve(m);
      });
    });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  const hello = await next();
  expect(hello.type).toBe("system/connected");
  return { ws, next };
}

/** 送出一則原始訊息，再送 ping，收集 pong 之前的所有回應——證明訊息被忽略且連線仍健康。 */
async function sendThenProbe(
  client: { ws: WebSocket; next: () => Promise<Msg> },
  raw: string,
): Promise<Msg[]> {
  client.ws.send(raw);
  client.ws.send(JSON.stringify({ type: "ping" }));
  const before: Msg[] = [];
  for (;;) {
    const m = await client.next();
    if (m.type === "pong") return before;
    before.push(m);
  }
}

async function expectServerHealthy(port: number): Promise<void> {
  const client = await openClient(port);
  client.ws.send(
    JSON.stringify({ type: "machine/subscribe", token: "", machineIds: ["mixer-01"] }),
  );
  expect(await client.next()).toEqual({ type: "machine/subscribed", machineIds: ["mixer-01"] });
  client.ws.close();
}

/** 以 raw TCP 完成 WebSocket handshake，之後可直接寫入畸形 frame。 */
async function rawUpgrade(port: number): Promise<Socket> {
  const sock = netConnect(port, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    sock.once("connect", () => resolve());
    sock.once("error", reject);
  });
  sock.write(
    [
      "GET /ws HTTP/1.1",
      `Host: 127.0.0.1:${port}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
      "Sec-WebSocket-Version: 13",
      "",
      "",
    ].join("\r\n"),
  );
  await new Promise<void>((resolve, reject) => {
    let buf = "";
    const onData = (chunk: Buffer): void => {
      buf += chunk.toString("latin1");
      if (buf.includes("\r\n\r\n")) {
        sock.off("data", onData);
        if (buf.startsWith("HTTP/1.1 101")) resolve();
        else reject(new Error(`handshake failed: ${buf.split("\r\n")[0]}`));
      }
    };
    sock.on("data", onData);
  });
  return sock;
}

function waitClosed(sock: Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("server did not close the socket")), 3_000);
    sock.on("error", () => undefined); // server 端 reset 屬預期，不讓測試因此失敗
    sock.once("close", () => {
      clearTimeout(t);
      resolve();
    });
    sock.resume();
  });
}

let exitSpy: MockInstance;
const uncaught: unknown[] = [];
const onUncaught = (err: unknown): void => {
  uncaught.push(err);
};

beforeAll(() => {
  // logger 走純 JSON 且靜音：避免測試啟動 pino-pretty transport 與輸出雜訊。
  process.env.LOG_PRETTY = "false";
  process.env.LOG_LEVEL = "silent";
});

beforeEach(() => {
  uncaught.length = 0;
  process.on("uncaughtException", onUncaught);
  exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code}) called`);
  }) as never);
});

afterEach(async () => {
  // 先收尾再斷言：斷言失敗會中止 afterEach，若排在前面，mock 與 ws server／timer 會洩漏到後續測試。
  // 監聽與 exit 計數要等收尾做完才拆：關閉 ws server 期間若拋出或觸發致命守門 exit(1)，
  // 正是「優雅關閉被誤報成崩潰」，必須仍被下面兩個斷言抓到。
  for (const h of running.splice(0)) {
    h.gateway.onModuleDestroy();
    await new Promise<void>((resolve) => h.server.close(() => resolve()));
  }
  process.off("uncaughtException", onUncaught);
  const exitCalls = exitSpy.mock.calls.length;
  exitSpy.mockRestore();
  expect(exitCalls).toBe(0);
  expect(uncaught).toEqual([]);
});

describe("MonitoringGateway：不可信輸入不得讓行程結束", () => {
  it.each([
    ["JSON null", "null"],
    ["JSON 數字", "5"],
    ["未知 type", JSON.stringify({ type: "x" })],
    ["machineIds 不是陣列", JSON.stringify({ type: "machine/subscribe", token: "t", machineIds: 5 })],
    [
      "machineIds 為字串（舊寫法會被拆成單字元）",
      JSON.stringify({ type: "machine/subscribe", token: "t", machineIds: "press-02" }),
    ],
    [
      "machineIds 超過 50 個",
      JSON.stringify({
        type: "machine/subscribe",
        token: "t",
        machineIds: Array.from({ length: 51 }, (_, i) => `m-${i}`),
      }),
    ],
    ["無法解析的 JSON", "{not json"],
  ])("%s → 忽略、不回 machine/subscribed、連線仍可用", async (_label, raw) => {
    const { port } = await startGateway();
    const client = await openClient(port);
    const replies = await sendThenProbe(client, raw);
    expect(replies.filter((m) => m.type === "machine/subscribed")).toEqual([]);
    client.ws.close();
    await expectServerHealthy(port);
  });

  it("超過 maxPayload 的訊息 → 該連線以 1009 關閉，server 仍存活", async () => {
    const { port } = await startGateway();
    const client = await openClient(port);
    const closed = new Promise<number>((resolve) => client.ws.once("close", (code) => resolve(code)));
    client.ws.on("error", () => undefined);
    client.ws.send("x".repeat(WS_MAX_PAYLOAD_BYTES + 1));
    expect(await closed).toBe(1009);
    await expectServerHealthy(port);
  });

  it("未遮罩的 client frame → server 關閉該連線，行程不結束", async () => {
    const { port } = await startGateway();
    const sock = await rawUpgrade(port);
    const closed = waitClosed(sock);
    // FIN + text opcode，長度 2，MASK bit 未設（client→server 必須遮罩）。
    sock.write(Buffer.from([0x81, 0x02, 0x68, 0x69]));
    await closed;
    await expectServerHealthy(port);
  });

  it("非法（保留）opcode → server 關閉該連線，行程不結束", async () => {
    const { port } = await startGateway();
    const sock = await rawUpgrade(port);
    const closed = waitClosed(sock);
    // FIN + opcode 0x3（保留），MASK bit 有設、長度 0，後接 4 bytes mask key。
    sock.write(Buffer.from([0x83, 0x80, 0x01, 0x02, 0x03, 0x04]));
    await closed;
    await expectServerHealthy(port);
  });
});

describe("MonitoringGateway：合法行為維持", () => {
  it("合法訂閱：去重並與已知機台取交集，回 machine/subscribed", async () => {
    const { port } = await startGateway();
    const client = await openClient(port);
    client.ws.send(
      JSON.stringify({
        type: "machine/subscribe",
        token: "",
        machineIds: ["press-02", "ghost-99", "press-02", "oven-04"],
      }),
    );
    expect(await client.next()).toEqual({
      type: "machine/subscribed",
      machineIds: ["press-02", "oven-04"],
    });
    client.ws.close();
  });

  it("有設 WS_AUTH_SECRET 時錯誤 token 回 system/unauthorized、正確 token 可訂閱", async () => {
    const { port } = await startGateway({ secret: "s3cret" });
    const client = await openClient(port);
    client.ws.send(JSON.stringify({ type: "machine/subscribe", token: "nope", machineIds: [] }));
    expect(await client.next()).toEqual({ type: "system/unauthorized" });
    client.ws.send(
      JSON.stringify({ type: "machine/subscribe", token: "s3cret", machineIds: ["pack-03"] }),
    );
    expect(await client.next()).toEqual({ type: "machine/subscribed", machineIds: ["pack-03"] });
    client.ws.close();
  });

  it("Origin 白名單：不在清單回 403；在清單或無 Origin 放行", async () => {
    const { port } = await startGateway({ allowedOrigins: ["http://ok.example"] });

    const rejected = await new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: "http://evil.example" });
      ws.once("unexpected-response", (_req, res) => {
        resolve(res.statusCode ?? 0);
        ws.terminate();
      });
      ws.once("open", () => reject(new Error("should not open")));
      ws.on("error", () => undefined);
    });
    expect(rejected).toBe(403);

    const allowed = await openClient(port, "http://ok.example");
    allowed.ws.close();
    // 無 Origin 的非瀏覽器 client（smoke 腳本）
    await expectServerHealthy(port);
  });
});
