import { Injectable } from "@nestjs/common";
import type { OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { Server as HttpServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import type { VerifyClientCallbackAsync } from "ws";
import { ClientControlMessageSchema } from "@flow-gatekeeper/contracts";
import type {
  ClientControlMessage,
  MachineSubscribed,
  Pong,
  SystemConnected,
  SystemMetrics,
  SystemUnauthorized,
} from "@flow-gatekeeper/contracts";
import { AppConfigService } from "../config/config.service.js";
import { MockTelemetryService } from "../telemetry/mock-telemetry.service.js";
import { HistoryService } from "../history/history.service.js";
import { filterPointsForSubscription } from "../../lib/subscription-filter.js";
import { isOriginAllowed, parseAllowedOrigins } from "../../lib/ws-origin.js";
import { getAppLogger } from "../../logging/app-logger.js";

type ClientId = string;

/**
 * 單則 client 訊息上限 16 KiB。合法控制訊息最大約 512（token）+ 50×64（machineIds）≈ 4 KiB；
 * ws 預設 100 MiB 等於讓任何連線者都能逼 api 配置巨量記憶體。
 */
export const WS_MAX_PAYLOAD_BYTES = 16 * 1024;

export type GatewayAttachOptions = {
  /** Origin 白名單；未指定時讀 `WS_ALLOWED_ORIGINS`（空＝不檢查）。 */
  allowedOrigins?: readonly string[];
};

/**
 * 原生 `ws` Gateway（掛在 NestJS HTTP server，path `/ws`），非 Socket.IO（憲章 IV、ADR-001）。
 *
 * - 連線生命週期：連線→system/connected、close/心跳逾時→清理（FR-001/FR-008）。
 * - 訂閱：machine/subscribe 取代式 + 授權（FR-002/FR-003）；未訂閱者不收遙測（FR-004）。
 * - 心跳：應用層 ping→pong（FR-007a）+ 伺服器端探活回收半死連線（FR-007b/SC-005）。
 * - 落地：全量同步進 HistoryService buffer，由其每秒批次落庫（FR-009/FR-010）。
 * - 記錄：連線/斷線/授權失敗/逾時回收（FR-017）。
 * - 輸入加固：client 訊息一律視為不可信——Zod safeParse 後才分派、socket/server 皆掛 error
 *   listener、maxPayload 16 KiB、Origin 白名單、machineIds 與已知機台取交集。任何畸形輸入
 *   都只影響該則訊息（或該條連線），不得讓行程結束。
 * - send()：對單一連線推送任意 payload，003 AI relay 銜接點（FR-015）。
 */
@Injectable()
export class MonitoringGateway implements OnModuleInit, OnModuleDestroy {
  // 連線相關事件需要 clientId 為獨立結構化欄位（FR-002），Nest Logger 的 API 只能帶字串
  // context，故此類事件改走底層 pino child logger 直接呼叫（contracts/log-fields.md §2）。
  private readonly plog = getAppLogger().child({ context: MonitoringGateway.name });
  private wss?: WebSocketServer;
  private producerTimer?: ReturnType<typeof setInterval>;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private readonly clients = new Map<ClientId, WebSocket>();
  private readonly subscriptions = new Map<ClientId, Set<string>>();
  private readonly alive = new Map<ClientId, boolean>();

  constructor(
    private readonly config: AppConfigService,
    private readonly telemetry: MockTelemetryService,
    private readonly history: HistoryService,
  ) {}

  onModuleInit(): void {
    // 高頻 producer tick：每 MOCK_TELEMETRY_INTERVAL_MS 產生一批並依訂閱推送。
    this.producerTimer = setInterval(
      () => this.publishTelemetry(),
      this.config.mockTelemetryIntervalMs,
    );
    // 伺服器端心跳探活：回收網路硬中斷的「半死」連線（FR-007b/SC-005）。
    this.heartbeatTimer = setInterval(() => this.sweepDeadConnections(), this.config.wsHeartbeatMs);
  }

  /**
   * 停止產生新 telemetry（冪等）。關閉流程要先呼叫：Nest 的 onModuleDestroy 不保證 Gateway
   * 比 HistoryModule 先停，若 producer 還在跑，最後幾批會丟進已關閉的 Mongo。
   */
  stopProducer(): void {
    if (this.producerTimer) clearInterval(this.producerTimer);
    this.producerTimer = undefined;
  }

  onModuleDestroy(): void {
    this.stopProducer();
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    // 優雅關閉（FR-004）：主動 terminate 所有連線並關閉 ws server。升級後的 ws 是「活躍連線」，
    // 不主動釋放的話 app.close() 等待的 http.Server 'close' 永不回呼——關閉會掛到 stop_grace_period
    // 逾時被 SIGKILL（非零退出→被監督者誤判為崩潰而重啟一個正被停止的服務）。terminate 觸發的
    // 'close' 事件會再進 cleanup()，其冪等守衛可安全重入。
    for (const [clientId, socket] of [...this.clients]) {
      socket.terminate();
      this.cleanup(clientId, "shutdown");
    }
    this.wss?.close();
  }

  /** 由 main.ts 在 app.listen() 後呼叫，與 HTTP 共用同一個 port（ws://host:port/ws）。 */
  attach(server: HttpServer, options: GatewayAttachOptions = {}): void {
    const allowedOrigins =
      options.allowedOrigins ?? parseAllowedOrigins(process.env.WS_ALLOWED_ORIGINS);
    this.wss = new WebSocketServer({
      server,
      path: "/ws",
      maxPayload: WS_MAX_PAYLOAD_BYTES,
      ...(allowedOrigins.length > 0 ? { verifyClient: this.originVerifier(allowedOrigins) } : {}),
    });
    this.wss.on("connection", (socket) => this.handleConnection(socket));
    // 掛 server 端 error listener：ws 會把底層 http server 的 error 轉發到 wss，
    // 沒有 listener 時 EventEmitter 直接 throw → uncaughtException → 行程結束。
    this.wss.on("error", (err) => {
      this.plog.error({ err }, "websocket server error");
    });
  }

  /** upgrade 前比對 Origin；不在白名單回 403 並不建立連線。 */
  private originVerifier(allowed: readonly string[]): VerifyClientCallbackAsync {
    return (info, done) => {
      // ws 的型別宣告 origin 為 string，但實際上沒帶 header 時是 undefined。
      const origin = (info.origin as string | undefined) || undefined;
      if (isOriginAllowed(origin, allowed)) {
        done(true);
        return;
      }
      this.plog.warn({ origin }, "websocket upgrade rejected: origin not allowed");
      done(false, 403, "Forbidden");
    };
  }

  private handleConnection(socket: WebSocket): void {
    const clientId = randomUUID();
    this.clients.set(clientId, socket);
    this.subscriptions.set(clientId, new Set());
    this.alive.set(clientId, true);
    this.send(clientId, { type: "system/connected", clientId } satisfies SystemConnected);
    this.plog.info({ clientId }, "client connected");

    socket.on("message", (raw) => this.handleMessage(clientId, raw.toString()));
    // protocol-level pong（回應伺服器的 ping()）→ 標記存活。
    socket.on("pong", () => this.alive.set(clientId, true));
    socket.on("close", () => this.cleanup(clientId, "close"));
    // 協定層錯誤（非法 opcode、未遮罩 frame、無效 UTF-8、超過 maxPayload）ws 會 emit 'error'，
    // 沒有 listener 就會直接 throw 讓行程崩潰。ws 會自行關閉這條連線，後續由 'close' 清理。
    socket.on("error", (err) => {
      this.plog.warn({ clientId, err: { message: err.message } }, "websocket client error");
    });
  }

  private handleMessage(clientId: ClientId, raw: string): void {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      this.plog.warn({ clientId, reason: "invalid-json" }, "ignored client message");
      return; // 無法解析的訊息安全忽略（FR-014）
    }

    const parsed = ClientControlMessageSchema.safeParse(json);
    if (!parsed.success) {
      // 只記路徑與訊息摘要，不記原始內容——原始內容可能含 token。
      const issues = parsed.error.issues
        .slice(0, 5)
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
      this.plog.warn({ clientId, reason: "schema", issues }, "ignored client message");
      return; // 未知 type 或形狀不符一律安全忽略（FR-014）
    }
    this.dispatch(clientId, parsed.data);
  }

  private dispatch(clientId: ClientId, msg: ClientControlMessage): void {
    switch (msg.type) {
      case "ping":
        this.send(clientId, { type: "pong", ts: Date.now() } satisfies Pong);
        break;

      case "machine/subscribe": {
        const secret = this.config.wsAuthSecret;
        if (secret && msg.token !== secret) {
          // 無效授權：回 system/unauthorized 且不建立/變更訂閱（FR-003/SC-006）。
          this.plog.warn({ clientId }, "unauthorized subscribe");
          this.send(clientId, { type: "system/unauthorized" } satisfies SystemUnauthorized);
          return;
        }
        // 只保留已知機台（去重、保持 client 給的順序）：未知 id 訂閱了也不會有資料，
        // 留著只會讓每次廣播多做無謂比對。
        const known = new Set(this.telemetry.machineIds);
        const machineIds = [...new Set(msg.machineIds)].filter((id) => known.has(id));
        // 取代式：新集合即為當前訂閱的唯一真實狀態（FR-002）。
        this.subscriptions.set(clientId, new Set(machineIds));
        this.send(clientId, {
          type: "machine/subscribed",
          machineIds,
        } satisfies MachineSubscribed);
        break;
      }

    }
  }

  /** 每 tick：只把訂閱機台的 TelemetryPoint[] 推給各訂閱者（FR-004）；全量落地與推送解耦。 */
  private publishTelemetry(): void {
    const points = this.telemetry.nextBatch();

    // 即時推送：只送訂閱者（FR-004）。
    for (const [clientId, machineIds] of this.subscriptions) {
      const selected = filterPointsForSubscription(points, machineIds);
      if (selected.length > 0) {
        this.send(clientId, selected);
      }
    }

    // 持久化：全部機台、與訂閱無關（FR-009）；只進記憶體 buffer，由 HistoryService 每秒批次
    // 落庫，推送 cadence 不受資料庫延遲牽制（FR-010）。
    this.history.enqueue(points);
  }

  /**
   * 心跳探活掃描：上一輪未回 pong 者判定失效並回收（涵蓋網路硬中斷的半死連線）；
   * 存活者標記為待驗證並送 ping()。回收上限約 2 × WS_HEARTBEAT_MS（SC-005）。
   */
  private sweepDeadConnections(): void {
    for (const [clientId, socket] of this.clients) {
      if (this.alive.get(clientId) === false) {
        this.plog.warn({ clientId }, "heartbeat timeout, terminating");
        socket.terminate();
        this.cleanup(clientId, "heartbeat-timeout");
        continue;
      }
      this.alive.set(clientId, false);
      socket.ping();
    }
  }

  private cleanup(clientId: ClientId, reason: string): void {
    if (!this.clients.has(clientId)) return; // 冪等：避免 terminate→close 重複清理/記錄
    this.clients.delete(clientId);
    this.subscriptions.delete(clientId);
    this.alive.delete(clientId);
    this.plog.info({ clientId, reason }, "client disconnected");
  }

  /** 當前 ws 連線數（瞬時值 gauge，非窗內平均）——009 US3 指標來源。 */
  get connectionCount(): number {
    return this.clients.size;
  }

  /**
   * 廣播 `system/metrics` 給**所有已連線 client**（009 FR-008a）。
   *
   * 與 `machine/subscribe` 訂閱狀態**無關**：指標是系統級資訊、不隸屬任何機台，用機台訂閱
   * 過濾它在語意上不成立（contracts/metrics-summary.md §2）。至多送一次——漏送一則即等
   * 下一週期，不重送、不補發。
   */
  broadcastMetrics(payload: SystemMetrics): void {
    for (const clientId of this.clients.keys()) {
      this.send(clientId, payload);
    }
  }

  /** 對單一連線推送任意 payload——003 AI relay / job status relay 的銜接點（FR-015）。 */
  send(clientId: ClientId, payload: unknown): void {
    const socket = this.clients.get(clientId);
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(payload));
    }
  }
}
