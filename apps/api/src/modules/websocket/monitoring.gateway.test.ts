import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import { createServer } from "node:http";
import type { Server as HttpServer } from "node:http";
import { connect as netConnect } from "node:net";
import type { AddressInfo, Socket } from "node:net";
import { WebSocket } from "ws";
import type { ClientOptions } from "ws";
import type { Queue } from "bullmq";
import type {
  AiDone,
  AiError,
  DiagnosisJobPayload,
  SystemMetrics,
  TelemetryPoint,
} from "@flow-gatekeeper/contracts";
import type { AppConfigService } from "../config/config.service.js";
import type { HistoryService } from "../history/history.service.js";
import { MockTelemetryService } from "../telemetry/mock-telemetry.service.js";
import { JobsService } from "../jobs/jobs.service.js";
import {
  MonitoringGateway,
  WS_MAX_PAYLOAD_BYTES,
  WS_MAX_VIOLATIONS,
  WS_SLOW_CONSUMER_TICKS,
  authGraceSweepIntervalMs,
  isBackpressureDroppable,
  unauthorizedConnectionCap,
} from "./monitoring.gateway.js";

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
  enqueue: ReturnType<typeof vi.fn<(points: TelemetryPoint[]) => void>>;
};

type GatewayOpts = {
  secret?: string;
  allowedOrigins?: readonly string[];
  /** true：呼叫 onModuleInit，啟動 producer 與心跳計時器（tick／心跳用下方縮短的間隔）。 */
  init?: boolean;
  intervalMs?: number;
  heartbeatMs?: number;
  sendHighWaterBytes?: number;
  maxConnections?: number;
  authGraceMs?: number;
};

const running: Harness[] = [];

async function startGateway(opts: GatewayOpts = {}): Promise<Harness> {
  const config = {
    mockTelemetryIntervalMs: opts.intervalMs ?? 50,
    wsHeartbeatMs: opts.heartbeatMs ?? 15_000,
    wsAuthSecret: opts.secret ?? "",
  } as unknown as AppConfigService;
  const enqueue = vi.fn<(points: TelemetryPoint[]) => void>();
  const history = { enqueue } as unknown as HistoryService;
  const gateway = new MonitoringGateway(config, new MockTelemetryService(), history);
  const server = createServer();
  // 預設不呼叫 onModuleInit：只測訊息處理與協定層防護；需要 producer／心跳的測試以 init 開啟。
  gateway.attach(server, {
    allowedOrigins: opts.allowedOrigins ?? [],
    ...(opts.sendHighWaterBytes !== undefined ? { sendHighWaterBytes: opts.sendHighWaterBytes } : {}),
    ...(opts.maxConnections !== undefined ? { maxConnections: opts.maxConnections } : {}),
    ...(opts.authGraceMs !== undefined ? { authGraceMs: opts.authGraceMs } : {}),
  });
  if (opts.init) gateway.onModuleInit();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const h = { port, server, gateway, enqueue };
  running.push(h);
  return h;
}

type Client = {
  ws: WebSocket;
  clientId: string;
  next: () => Promise<Msg>;
  /** system/connected 之後收到的所有 frame（含遙測陣列），不受 next() 消費影響。 */
  frames: unknown[];
};

/** 連線並等到 system/connected；回傳 socket、clientId 與之後收到的訊息佇列。 */
async function openClient(
  port: number,
  origin?: string,
  extra: ClientOptions = {},
): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { ...extra, ...(origin ? { origin } : {}) });
  const queue: Msg[] = [];
  const frames: unknown[] = [];
  const waiters: Array<(m: Msg) => void> = [];
  let helloSeen = false;
  ws.on("message", (data) => {
    const m = JSON.parse((data as Buffer).toString()) as Msg;
    if (helloSeen) frames.push(m);
    helloSeen = true;
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
  return { ws, clientId: String(hello.clientId), next, frames };
}

const isTelemetryBatch = (f: unknown): f is TelemetryPoint[] => Array.isArray(f);

function waitClose(ws: WebSocket, ms = 3_000): Promise<number> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.CLOSED) return resolve(-1);
    const t = setTimeout(() => reject(new Error("client was not closed")), ms);
    ws.on("error", () => undefined);
    ws.once("close", (code) => {
      clearTimeout(t);
      resolve(code);
    });
  });
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Gateway 內部的單一連線狀態（僅測試用：模擬慢讀者需要改寫 server 端 socket 的 bufferedAmount）。 */
type GatewayInternals = {
  clients: Map<string, { socket: WebSocket; alive: boolean; connectedAt: number; closeTimer?: unknown }>;
  sweepDeadConnections(): void;
  sweepAuthGrace(): void;
  unauthorizedCount: number;
};

function internals(gateway: MonitoringGateway): GatewayInternals {
  return gateway as unknown as GatewayInternals;
}

function serverSocket(gateway: MonitoringGateway, clientId: string): WebSocket {
  const state = internals(gateway).clients.get(clientId);
  if (!state) throw new Error(`no server socket for ${clientId}`);
  return state.socket;
}

async function subscribe(client: Client, machineIds: string[], token = ""): Promise<Msg> {
  client.ws.send(JSON.stringify({ type: "machine/subscribe", token, machineIds }));
  for (;;) {
    const m = await client.next();
    if (m.type === "machine/subscribed" || m.type === "system/unauthorized") return m;
  }
}

const metricsPayload: SystemMetrics = {
  type: "system/metrics",
  windowMs: 60_000,
  collectedAt: "2026-09-27T00:00:00.000Z",
  queue: { waiting: 0, active: 0, failed: 0 },
  wsConnections: 1,
  worker: null,
};

/** 送出一則原始訊息，再送 ping，收集 pong 之前的所有回應——證明訊息被忽略且連線仍健康。 */
async function sendThenProbe(
  client: Pick<Client, "ws" | "next">,
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

async function expectServerHealthy(port: number, token = ""): Promise<void> {
  const client = await openClient(port);
  client.ws.send(
    JSON.stringify({ type: "machine/subscribe", token, machineIds: ["mixer-01"] }),
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
  // 個別測試可能開了 fake timers（關閉逾期回收）；一律先還原，收尾的 server.close 才等得到真計時器。
  vi.useRealTimers();
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

describe("MonitoringGateway：producer／心跳／metrics（呼叫 onModuleInit）", () => {
  it("FR-004：未訂閱者收不到遙測；訂閱者只收自己訂的機台", async () => {
    const { port } = await startGateway({ init: true, intervalMs: 20 });
    const subscriber = await openClient(port);
    const idle = await openClient(port);
    expect(await subscribe(subscriber, ["press-02", "oven-04"])).toMatchObject({ type: "machine/subscribed" });

    await vi.waitFor(() => expect(subscriber.frames.filter(isTelemetryBatch).length).toBeGreaterThan(2), {
      timeout: 2_000,
    });
    const ids = new Set(subscriber.frames.filter(isTelemetryBatch).flat().map((p) => p.machineId));
    expect([...ids].sort()).toEqual(["oven-04", "press-02"]);
    expect(idle.frames.filter(isTelemetryBatch)).toEqual([]);
    subscriber.ws.close();
    idle.ws.close();
  });

  it("FR-009：遙測（全部機台、與訂閱無關）有進 HistoryService buffer", async () => {
    const { enqueue } = await startGateway({ init: true, intervalMs: 20 });
    await vi.waitFor(() => expect(enqueue.mock.calls.length).toBeGreaterThan(1), { timeout: 2_000 });
    const batch = enqueue.mock.calls[0]?.[0] ?? [];
    expect(batch.map((p) => p.machineId).sort()).toEqual([
      "mixer-01",
      "oven-04",
      "pack-03",
      "press-02",
      "sorter-05",
    ]);
  });

  it("SC-005：不回 pong、只送未經請求的 pong、或 nonce 不符的連線被 terminate；正常連線存活", async () => {
    const { port, gateway } = await startGateway({ init: true, intervalMs: 1_000, heartbeatMs: 250 });
    const healthy = await openClient(port);

    const silent = await openClient(port, undefined, { autoPong: false });
    const spoofer = await openClient(port, undefined, { autoPong: false });
    const spoofTimer = setInterval(() => spoofer.ws.pong(Buffer.from("unsolicited")), 20);
    const wrongNonce = await openClient(port, undefined, { autoPong: false });
    wrongNonce.ws.on("ping", () => wrongNonce.ws.pong(Buffer.from("wrong-nonce")));

    try {
      await Promise.all([waitClose(silent.ws), waitClose(spoofer.ws), waitClose(wrongNonce.ws)]);
    } finally {
      clearInterval(spoofTimer);
    }
    // 健康連線（ws 自動原樣回 pong）經歷同樣幾輪心跳仍在。
    await vi.waitFor(() => expect(gateway.connectionCount).toBe(1));
    expect(healthy.ws.readyState).toBe(WebSocket.OPEN);
    expect(gateway.isOnline(healthy.clientId)).toBe(true);
    healthy.ws.close();
  });

  it("重放上一輪的 nonce 不算存活：只有第一輪回對的連線，在後續輪次被 terminate", async () => {
    // 手動驅動 sweep，輪次可精確控制。
    const { port, gateway } = await startGateway();
    const replayer = await openClient(port, undefined, { autoPong: false });
    let firstNonce: Buffer | undefined;
    replayer.ws.on("ping", (data: Buffer) => {
      firstNonce ??= Buffer.from(data);
      replayer.ws.pong(firstNonce); // 永遠回第一輪的 nonce
    });
    const state = internals(gateway).clients.get(replayer.clientId);
    if (!state) throw new Error("missing state");

    internals(gateway).sweepDeadConnections(); // 第 1 輪：回的是本輪 nonce → 存活
    await vi.waitFor(() => expect(state.alive).toBe(true));
    internals(gateway).sweepDeadConnections(); // 第 2 輪：回的是舊 nonce → 不算
    await delay(100);
    expect(state.alive).toBe(false);
    const closed = waitClose(replayer.ws);
    internals(gateway).sweepDeadConnections(); // 第 3 輪：上一輪未存活 → terminate
    expect(await closed).toBe(1006);
    expect(gateway.isOnline(replayer.clientId)).toBe(false);
  });

  it("system/metrics 只廣播給已授權連線（有密鑰：通過 token 者）", async () => {
    const { port, gateway } = await startGateway({ init: true, intervalMs: 1_000, secret: "s3cret" });
    const authed = await openClient(port);
    const anonymous = await openClient(port);
    const wrong = await openClient(port);
    expect(await subscribe(authed, [], "s3cret")).toEqual({ type: "machine/subscribed", machineIds: [] });
    expect(await subscribe(wrong, ["mixer-01"], "nope")).toEqual({ type: "system/unauthorized" });

    gateway.broadcastMetrics(metricsPayload);

    expect(await authed.next()).toEqual(metricsPayload);
    for (const c of [anonymous, wrong]) {
      const before = await sendThenProbe(c, JSON.stringify({ type: "ping" }));
      expect(before.filter((m) => m.type === "system/metrics")).toEqual([]);
    }
    for (const c of [authed, anonymous, wrong]) c.ws.close();
  });

  it("未設密鑰（demo）時連上即授權：未訂閱的連線也收得到 system/metrics", async () => {
    const { port, gateway } = await startGateway({ init: true, intervalMs: 1_000 });
    const client = await openClient(port);
    gateway.broadcastMetrics(metricsPayload);
    expect(await client.next()).toEqual(metricsPayload);
    client.ws.close();
  });
});

describe("MonitoringGateway：出口閘門（背壓、授權、違規、連線數）", () => {
  it("慢讀者：bufferedAmount 持續超過高水位 → 推送被略過，連續 N 個心跳 tick 後 terminate", async () => {
    const { port, gateway } = await startGateway({
      init: true,
      intervalMs: 20,
      heartbeatMs: 100,
      sendHighWaterBytes: 64 * 1024,
    });
    const slow = await openClient(port);
    await subscribe(slow, ["mixer-01"]);
    await vi.waitFor(() => expect(slow.frames.filter(isTelemetryBatch).length).toBeGreaterThan(0));

    // 模擬對端停止讀取：server 端 socket 的送出緩衝恆高於高水位。
    Object.defineProperty(serverSocket(gateway, slow.clientId), "bufferedAmount", {
      get: () => 10 * 1024 * 1024,
    });
    const startedAt = Date.now();
    const code = await waitClose(slow.ws, 3_000);
    expect(code).toBe(1006); // terminate：沒有 close frame
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual((WS_SLOW_CONSUMER_TICKS - 1) * 100);
    expect(gateway.droppedSendCount).toBeGreaterThan(0);
    await vi.waitFor(() => expect(gateway.connectionCount).toBe(0));
  });

  it("超標必須「連續」N 個 tick 才回收：中間回落一次即重新計數", async () => {
    // 不啟動計時器、手動驅動心跳 sweep，讓 tick 次數可精確控制。
    const { port, gateway } = await startGateway({ sendHighWaterBytes: 64 * 1024 });
    const client = await openClient(port);
    let buffered = 10 * 1024 * 1024;
    Object.defineProperty(serverSocket(gateway, client.clientId), "bufferedAmount", { get: () => buffered });
    const state = internals(gateway).clients.get(client.clientId);
    if (!state) throw new Error("missing state");
    const sweep = async (): Promise<void> => {
      internals(gateway).sweepDeadConnections();
      // 等 client 自動回帶 nonce 的 pong，避免被當成心跳逾時（連線已被回收時不必等）。
      if (gateway.isOnline(client.clientId)) await vi.waitFor(() => expect(state.alive).toBe(true));
    };

    for (let i = 0; i < WS_SLOW_CONSUMER_TICKS - 1; i += 1) await sweep();
    buffered = 0;
    await sweep(); // 回落：連續計數歸零
    buffered = 10 * 1024 * 1024;
    for (let i = 0; i < WS_SLOW_CONSUMER_TICKS - 1; i += 1) await sweep();
    expect(client.ws.readyState).toBe(WebSocket.OPEN);
    expect(gateway.isOnline(client.clientId)).toBe(true);

    const closed = waitClose(client.ws);
    await sweep(); // 連續第 N 個超標 tick → terminate
    expect(await closed).toBe(1006);
    expect(gateway.isOnline(client.clientId)).toBe(false);
  });

  it("未授權連線收不到 ai/*、job/status；JobsService 對其回 409、對已授權連線入列", async () => {
    const { port, gateway } = await startGateway({ secret: "s3cret" });
    const authed = await openClient(port);
    const anonymous = await openClient(port);
    await subscribe(authed, ["mixer-01"], "s3cret");

    const jobId = "0e6c2b7a-1f3d-4d8e-a9b0-c1d2e3f4a5b6";
    const token = { type: "ai/token", jobId, attempt: 1, seq: 0, text: "hi" } as const;
    const status = { type: "job/status", jobId, machineId: "mixer-01", status: "active" } as const;
    gateway.send(anonymous.clientId, token);
    gateway.send(anonymous.clientId, status);
    gateway.send(authed.clientId, token);

    expect(await authed.next()).toEqual(token);
    const leaked = await sendThenProbe(anonymous, JSON.stringify({ type: "ping" }));
    expect(leaked).toEqual([]);
    expect(gateway.isOnline(anonymous.clientId)).toBe(true);
    expect(gateway.isAuthorized(anonymous.clientId)).toBe(false);
    expect(gateway.isAuthorized(authed.clientId)).toBe(true);

    const add = vi.fn(async () => ({}));
    const queue = { getJob: vi.fn(async () => undefined), add } as unknown as Queue<DiagnosisJobPayload>;
    const bindings = { bindJobToClient: vi.fn(), getBinding: () => undefined, deleteBinding: vi.fn() };
    const jobs = new JobsService(queue, bindings, gateway);
    await expect(
      jobs.createDiagnosis({ machineId: "mixer-01", socketId: anonymous.clientId }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      jobs.createDiagnosis({ machineId: "mixer-01", socketId: authed.clientId }),
    ).resolves.toMatchObject({ status: "waiting" });
    expect(add).toHaveBeenCalledTimes(1);

    // 斷線後同一 clientId 不再有效。
    authed.ws.close();
    await vi.waitFor(() => expect(gateway.isOnline(authed.clientId)).toBe(false));
    await expect(
      jobs.createDiagnosis({ machineId: "mixer-01", socketId: authed.clientId }),
    ).rejects.toMatchObject({ status: 409 });
    anonymous.ws.close();
  });

  it("同一連線違規（畸形訊息／錯誤 token）累計達上限 → close 1008，server 仍健康", async () => {
    const { port } = await startGateway({ secret: "s3cret" });
    const client = await openClient(port);
    const closed = waitClose(client.ws);
    const kinds = [
      "{not json", // 無法解析
      JSON.stringify({ type: "machine/subscribe", token: "x", machineIds: [] }), // 錯誤 token
      JSON.stringify({ type: "machine/subscribe", token: "t", machineIds: 5 }), // schema 不符
    ];
    for (let i = 0; i < WS_MAX_VIOLATIONS; i += 1) client.ws.send(kinds[i % kinds.length] ?? "");
    expect(await closed).toBe(1008);
    await expectServerHealthy(port, "s3cret");
  });

  it("未達違規上限的連線照常運作", async () => {
    const { port } = await startGateway();
    const client = await openClient(port);
    for (let i = 0; i < WS_MAX_VIOLATIONS - 1; i += 1) client.ws.send("{not json");
    expect(await sendThenProbe(client, JSON.stringify({ type: "ping" }))).toEqual([]);
    expect(client.ws.readyState).toBe(WebSocket.OPEN);
    client.ws.close();
  });

  it("連線數上限：已達上限的 upgrade 回 503；有連線離開後可再連", async () => {
    const { port, gateway } = await startGateway({ maxConnections: 2 });
    const a = await openClient(port);
    const b = await openClient(port);

    const status = await new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      ws.once("unexpected-response", (_req, res) => {
        resolve(res.statusCode ?? 0);
        ws.terminate();
      });
      ws.once("open", () => reject(new Error("should not open")));
      ws.on("error", () => undefined);
    });
    expect(status).toBe(503);

    a.ws.close();
    await vi.waitFor(() => expect(gateway.connectionCount).toBe(1));
    const c = await openClient(port);
    b.ws.close();
    c.ws.close();
  });

  /** 把連線的建立時間往回撥，模擬「已經過了 ms」——授權期限測試據此手動驅動 sweep，不依賴真實計時。 */
  function age(gateway: MonitoringGateway, clientId: string, ms: number): void {
    const state = internals(gateway).clients.get(clientId);
    if (!state) throw new Error(`no state for ${clientId}`);
    state.connectedAt -= ms;
  }

  it("授權期限：有密鑰時期限內未通過 token → 1008 關閉；未逾期與已通過者存活（手動驅動 sweep）", async () => {
    const { port, gateway } = await startGateway({ secret: "s3cret", authGraceMs: 60_000 });
    const expired = await openClient(port);
    const fresh = await openClient(port);
    const authed = await openClient(port);
    await subscribe(authed, [], "s3cret");
    age(gateway, expired.clientId, 60_000);
    age(gateway, authed.clientId, 60_000);

    const expiredClosed = waitClose(expired.ws);
    internals(gateway).sweepAuthGrace();
    expect(await expiredClosed).toBe(1008);
    internals(gateway).sweepAuthGrace(); // 再掃一輪：已授權與未逾期者不受影響
    expect(await sendThenProbe(fresh, JSON.stringify({ type: "ping" }))).toEqual([]);
    expect(fresh.ws.readyState).toBe(WebSocket.OPEN);
    expect(authed.ws.readyState).toBe(WebSocket.OPEN);
    expect(gateway.isAuthorized(authed.clientId)).toBe(true);
    await vi.waitFor(() => expect(gateway.connectionCount).toBe(2));
    fresh.ws.close();
    authed.ws.close();
  });

  it("授權期限：未設密鑰（連上即授權）時不適用", async () => {
    const { port, gateway } = await startGateway({ authGraceMs: 1_000 });
    const client = await openClient(port);
    age(gateway, client.clientId, 60_000);
    internals(gateway).sweepAuthGrace();
    expect(await sendThenProbe(client, JSON.stringify({ type: "ping" }))).toEqual([]);
    expect(client.ws.readyState).toBe(WebSocket.OPEN);
    client.ws.close();
  });

  it("授權期限由獨立 interval 驅動：心跳間隔設到 2^31-1 仍會在期限後關閉未授權連線", async () => {
    // 心跳在測試期間永遠不會 tick；只有獨立的授權期限 interval（min(心跳, 期限) = 期限）在跑。
    const { port } = await startGateway({
      secret: "s3cret",
      init: true,
      intervalMs: 1_000,
      heartbeatMs: 2 ** 31 - 1,
      authGraceMs: 200,
    });
    const idle = await openClient(port);
    expect(await waitClose(idle.ws, 3_000)).toBe(1008);
  });

  it("authGraceSweepIntervalMs：取心跳與期限的較小者", () => {
    expect(authGraceSweepIntervalMs(15_000, 10_000)).toBe(10_000);
    expect(authGraceSweepIntervalMs(2 ** 31 - 1, 10_000)).toBe(10_000);
    expect(authGraceSweepIntervalMs(5_000, 10_000)).toBe(5_000);
  });

  it("背壓只略過遙測批次：慢讀者仍收到 ai/done、ai/error、job/status 終態與 system/metrics", async () => {
    const { port, gateway } = await startGateway({ sendHighWaterBytes: 64 * 1024 });
    const slow = await openClient(port);
    Object.defineProperty(serverSocket(gateway, slow.clientId), "bufferedAmount", {
      get: () => 10 * 1024 * 1024,
    });
    const jobId = "0e6c2b7a-1f3d-4d8e-a9b0-c1d2e3f4a5b6";
    const done: AiDone = {
      type: "ai/done",
      jobId,
      attempt: 1,
      cached: false,
      result: { summary: "s", severity: "ok", likelyCauses: [], suggestedActions: [], evidence: [] },
    };
    const error: AiError = { type: "ai/error", jobId, attempt: 1, code: "provider_error", message: "m" };
    const status = { type: "job/status", jobId, machineId: "mixer-01", status: "completed" } as const;
    gateway.send(slow.clientId, done);
    gateway.send(slow.clientId, error);
    gateway.send(slow.clientId, status);
    gateway.broadcastMetrics(metricsPayload);

    expect(await slow.next()).toEqual(done);
    expect(await slow.next()).toEqual(error);
    expect(await slow.next()).toEqual(status);
    expect(await slow.next()).toEqual(metricsPayload);
    expect(gateway.droppedSendCount).toBe(0);
    slow.ws.close();
  });

  it("unauthorizedConnectionCap：max(10, floor(20% × 上限))", () => {
    expect(unauthorizedConnectionCap(500)).toBe(100);
    expect(unauthorizedConnectionCap(20)).toBe(10);
    expect(unauthorizedConnectionCap(1)).toBe(10);
    expect(unauthorizedConnectionCap(59)).toBe(11);
  });

  /** 嘗試 upgrade，回傳 HTTP 狀態碼（成功開啟回 101 並立即關閉）。 */
  function tryUpgrade(port: number): Promise<number> {
    return new Promise<number>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      ws.once("unexpected-response", (_req, res) => {
        resolve(res.statusCode ?? 0);
        ws.terminate();
      });
      ws.once("open", () => {
        resolve(101);
        ws.close();
      });
      ws.on("error", () => undefined);
    });
  }

  it("有密鑰時未授權連線達子上限 → 新 upgrade 回 503；其中一條通過 token 後可再連", async () => {
    const { port, gateway } = await startGateway({ secret: "s3cret", maxConnections: 20 });
    const cap = unauthorizedConnectionCap(20);
    const idle: Client[] = [];
    for (let i = 0; i < cap; i += 1) idle.push(await openClient(port));
    expect(gateway.connectionCount).toBe(cap);
    expect(await tryUpgrade(port)).toBe(503); // 全域上限 20 尚未滿，擋下的是未授權子上限

    const first = idle[0];
    if (!first) throw new Error("no client");
    expect(await subscribe(first, [], "s3cret")).toMatchObject({ type: "machine/subscribed" });
    const extra = await openClient(port);
    expect(await tryUpgrade(port)).toBe(503); // 新連線又佔回子上限

    // 未授權連線離線後名額釋放。
    extra.ws.close();
    await vi.waitFor(() => expect(gateway.connectionCount).toBe(cap));
    const again = await openClient(port);
    for (const c of [...idle, again]) c.ws.close();
  });

  it("未設密鑰時沒有未授權子上限（連上即授權）", async () => {
    const { port, gateway } = await startGateway({ maxConnections: 20 });
    const clients: Client[] = [];
    for (let i = 0; i < unauthorizedConnectionCap(20) + 2; i += 1) clients.push(await openClient(port));
    expect(gateway.connectionCount).toBe(unauthorizedConnectionCap(20) + 2);
    for (const c of clients) c.ws.close();
  });
  it("背壓也略過 ai/token（高頻流）：慢讀者收不到 token，但仍收到 ai/done 終態", async () => {
    const { port, gateway } = await startGateway({ sendHighWaterBytes: 64 * 1024 });
    const slow = await openClient(port);
    Object.defineProperty(serverSocket(gateway, slow.clientId), "bufferedAmount", {
      get: () => 10 * 1024 * 1024,
    });
    const jobId = "0e6c2b7a-1f3d-4d8e-a9b0-c1d2e3f4a5b6";
    const token = { type: "ai/token", jobId, attempt: 1, seq: 0, text: "hi" } as const;
    const done: AiDone = {
      type: "ai/done",
      jobId,
      attempt: 1,
      cached: false,
      result: { summary: "s", severity: "ok", likelyCauses: [], suggestedActions: [], evidence: [] },
    };
    expect(isBackpressureDroppable(token)).toBe(true);
    expect(isBackpressureDroppable(done)).toBe(false);
    expect(isBackpressureDroppable([])).toBe(true);
    gateway.send(slow.clientId, token);
    gateway.send(slow.clientId, done);
    expect(await slow.next()).toEqual(done);
    expect(gateway.droppedSendCount).toBe(1);
    slow.ws.close();
  });

  /**
   * 模擬「close frame 已送出、對端卻遲不回應」：真實 ws 的 `close()` 會同步進入 CLOSING，但在對端回
   * close frame（或內建 closeTimer 約 30 s 到期）前不會發出 'close' 事件。此處把 server 端 socket 的
   * `close()` 換成「只把 readyState 設為 CLOSING、不送 frame、不觸發事件」，重現該中間態；CLOSING 下
   * `ping()` 走 ws 的 sendAfterClose、不會真的送出（與真實行為一致）。回傳 close 的 spy。
   */
  function stallClose(socket: WebSocket): ReturnType<typeof vi.fn> {
    const closeSpy = vi.fn(() => {
      Object.defineProperty(socket, "readyState", { configurable: true, get: () => WebSocket.CLOSING });
    });
    socket.close = closeSpy;
    return closeSpy;
  }

  function warnSpy(gateway: MonitoringGateway): ReturnType<typeof vi.spyOn> {
    return vi.spyOn((gateway as unknown as { plog: { warn: (...args: unknown[]) => void } }).plog, "warn");
  }

  function infoSpy(gateway: MonitoringGateway): ReturnType<typeof vi.spyOn> {
    return vi.spyOn((gateway as unknown as { plog: { info: (...args: unknown[]) => void } }).plog, "info");
  }

  const HUGE_MS = 2 ** 31 - 1;

  /** 以 setImmediate（未被假造）輪詢等待條件成立，不推進 fake 時鐘；上限約 2000 輪。 */
  async function untilTrue(cond: () => boolean): Promise<void> {
    for (let i = 0; i < 2_000; i += 1) {
      if (cond()) return;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    throw new Error("condition not met");
  }

  /**
   * 關閉逾期回收：`requestClose` 掛逐連線計時器，於 `min(WS_HEARTBEAT_MS, WS_AUTH_GRACE_MS)` 到期即
   * terminate。以 fake timers（只假 setTimeout／clearTimeout／Date；socket I/O 與 vi.waitFor 仍走真實）
   * 精確驗證到期點——心跳／授權 sweep 都不手動驅動，證明回收不依賴任何 sweep 的間隔。
   */
  it.each([
    { name: "無密鑰＋極大心跳", secret: "", heartbeatMs: HUGE_MS, authGraceMs: 5_000, deadline: 5_000 },
    { name: "無密鑰＋極大授權期限", secret: "", heartbeatMs: 15_000, authGraceMs: HUGE_MS, deadline: 15_000 },
    { name: "有密鑰（心跳較短）", secret: "s3cret", heartbeatMs: 15_000, authGraceMs: 60_000, deadline: 15_000 },
    { name: "有密鑰＋極大心跳", secret: "s3cret", heartbeatMs: HUGE_MS, authGraceMs: 10_000, deadline: 10_000 },
  ])(
    "$name：close 後對端不回 close frame（CLOSING 停滯）→ 於 min(心跳, 授權期限)=$deadline ms 到期即以 close-not-honoured terminate、釋放名額",
    async ({ secret, heartbeatMs, authGraceMs, deadline }) => {
      const { port, gateway } = await startGateway({ secret, heartbeatMs, authGraceMs });
      const warn = warnSpy(gateway);
      const info = infoSpy(gateway);
      const client = await openClient(port);
      const socket = serverSocket(gateway, client.clientId);
      const closeSpy = stallClose(socket);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });

      if (secret) {
        // 有密鑰：走授權逾期路徑（未通過 token 的連線過了期限）。
        age(gateway, client.clientId, authGraceMs);
        internals(gateway).sweepAuthGrace();
        expect(closeSpy).toHaveBeenCalledWith(1008, "authorization timeout");
        internals(gateway).sweepAuthGrace(); // 已在關閉中：不重複發 close
        expect(closeSpy).toHaveBeenCalledTimes(1);
      } else {
        // 無密鑰：走違規累計路徑。
        for (let i = 0; i < WS_MAX_VIOLATIONS; i += 1) client.ws.send("{not json");
        // 不用 vi.waitFor：fake timers 開啟時它每輪會自動 advanceTimersByTime，會把逾期計時器提前推到期。
        await untilTrue(() => closeSpy.mock.calls.length > 0);
        expect(closeSpy).toHaveBeenCalledWith(1008, "policy violation");
      }
      expect(socket.readyState).toBe(WebSocket.CLOSING);
      expect(internals(gateway).clients.get(client.clientId)?.closeTimer).toBeDefined();

      vi.advanceTimersByTime(deadline - 1);
      expect(gateway.connectionCount).toBe(1);

      const closed = waitClose(client.ws);
      vi.advanceTimersByTime(1);
      expect(gateway.connectionCount).toBe(0);
      expect(internals(gateway).unauthorizedCount).toBe(0);
      expect(warn).toHaveBeenCalledWith(
        { clientId: client.clientId, closeDeadlineMs: deadline },
        "close frame not received, terminating",
      );
      expect(info).toHaveBeenCalledWith({ clientId: client.clientId, reason: "close-not-honoured" }, "client disconnected");
      vi.useRealTimers();
      expect(await closed).toBe(1006);
    },
  );

  it("對端正常回 close frame → 'close' 事件清掉逾期計時器，到期也不會 terminate", async () => {
    const { port, gateway } = await startGateway({ heartbeatMs: 15_000, authGraceMs: 5_000 });
    const warn = warnSpy(gateway);
    const info = infoSpy(gateway);
    const client = await openClient(port);
    const closed = waitClose(client.ws);
    // 先開 fake timers：requestClose 掛的逾期計時器才受 advanceTimersByTime 控制。
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const pendingBefore = vi.getTimerCount();
    for (let i = 0; i < WS_MAX_VIOLATIONS; i += 1) client.ws.send("{not json");
    expect(await closed).toBe(1008); // 真實 ws：client 自動回 close frame
    await untilTrue(() => gateway.connectionCount === 0);
    expect(info).toHaveBeenCalledWith({ clientId: client.clientId, reason: "close" }, "client disconnected");
    // 逾期計時器已被 cleanup 清掉：到期後不會再 terminate、也不會記 close-not-honoured。
    vi.advanceTimersByTime(5_000);
    expect(warn).not.toHaveBeenCalledWith(expect.anything(), "close frame not received, terminating");
    expect(info).not.toHaveBeenCalledWith(expect.objectContaining({ reason: "close-not-honoured" }), expect.anything());
    expect(vi.getTimerCount()).toBe(pendingBefore);
  });
});
