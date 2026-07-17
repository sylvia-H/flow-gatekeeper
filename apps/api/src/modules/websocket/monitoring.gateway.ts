import { Injectable, Logger } from "@nestjs/common";
import type { OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { Server as HttpServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import type {
  MachineSubscribed,
  Pong,
  SystemConnected,
  SystemUnauthorized,
} from "@flow-gatekeeper/contracts";
import { AppConfigService } from "../config/config.service.js";
import { MockTelemetryService } from "../telemetry/mock-telemetry.service.js";
import { HistoryService } from "../history/history.service.js";
import { filterPointsForSubscription } from "../../lib/subscription-filter.js";

type ClientId = string;

/**
 * 原生 `ws` Gateway（掛在 NestJS HTTP server，path `/ws`），非 Socket.IO（憲章 IV、ADR-001）。
 *
 * - 連線生命週期：連線→system/connected、close/心跳逾時→清理（FR-001/FR-008）。
 * - 訂閱：machine/subscribe 取代式 + 授權（FR-002/FR-003）；未訂閱者不收遙測（FR-004）。
 * - 心跳：應用層 ping→pong（FR-007a）+ 伺服器端探活回收半死連線（FR-007b/SC-005）。
 * - 落地：全量 fire-and-forget 交給 HistoryService（FR-009/FR-010）。
 * - 記錄：連線/斷線/授權失敗/逾時回收（FR-017）。
 * - send()：對單一連線推送任意 payload，003 AI relay 銜接點（FR-015）。
 */
@Injectable()
export class MonitoringGateway implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MonitoringGateway.name);
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

  onModuleDestroy(): void {
    if (this.producerTimer) clearInterval(this.producerTimer);
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
  attach(server: HttpServer): void {
    this.wss = new WebSocketServer({ server, path: "/ws" });
    this.wss.on("connection", (socket) => this.handleConnection(socket));
  }

  private handleConnection(socket: WebSocket): void {
    const clientId = randomUUID();
    this.clients.set(clientId, socket);
    this.subscriptions.set(clientId, new Set());
    this.alive.set(clientId, true);
    this.send(clientId, { type: "system/connected", clientId } satisfies SystemConnected);
    this.logger.log(`client connected: ${clientId}`);

    socket.on("message", (raw) => this.handleMessage(clientId, raw.toString()));
    // protocol-level pong（回應伺服器的 ping()）→ 標記存活。
    socket.on("pong", () => this.alive.set(clientId, true));
    socket.on("close", () => this.cleanup(clientId, "close"));
  }

  private handleMessage(clientId: ClientId, raw: string): void {
    let msg: { type?: string; token?: string; machineIds?: string[] };
    try {
      msg = JSON.parse(raw) as typeof msg;
    } catch {
      return; // 無法解析的訊息安全忽略（FR-014）
    }

    switch (msg.type) {
      case "ping":
        this.send(clientId, { type: "pong", ts: Date.now() } satisfies Pong);
        break;

      case "machine/subscribe": {
        const secret = this.config.wsAuthSecret;
        if (secret && msg.token !== secret) {
          // 無效授權：回 system/unauthorized 且不建立/變更訂閱（FR-003/SC-006）。
          this.logger.warn(`unauthorized subscribe from ${clientId}`);
          this.send(clientId, { type: "system/unauthorized" } satisfies SystemUnauthorized);
          return;
        }
        const machineIds = msg.machineIds ?? [];
        // 取代式：新集合即為當前訂閱的唯一真實狀態（FR-002）。
        this.subscriptions.set(clientId, new Set(machineIds));
        this.send(clientId, {
          type: "machine/subscribed",
          machineIds,
        } satisfies MachineSubscribed);
        break;
      }

      default:
        break; // 未知 type 安全忽略（FR-014）
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

    // 持久化：全部機台、與訂閱無關（FR-009）；fire-and-forget，不 await 阻塞 cadence（FR-010）。
    void this.history.persistBatch(points);
  }

  /**
   * 心跳探活掃描：上一輪未回 pong 者判定失效並回收（涵蓋網路硬中斷的半死連線）；
   * 存活者標記為待驗證並送 ping()。回收上限約 2 × WS_HEARTBEAT_MS（SC-005）。
   */
  private sweepDeadConnections(): void {
    for (const [clientId, socket] of this.clients) {
      if (this.alive.get(clientId) === false) {
        this.logger.warn(`heartbeat timeout, terminating ${clientId}`);
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
    this.logger.log(`client disconnected (${reason}): ${clientId}`);
  }

  /** 對單一連線推送任意 payload——003 AI relay / job status relay 的銜接點（FR-015）。 */
  send(clientId: ClientId, payload: unknown): void {
    const socket = this.clients.get(clientId);
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(payload));
    }
  }
}
