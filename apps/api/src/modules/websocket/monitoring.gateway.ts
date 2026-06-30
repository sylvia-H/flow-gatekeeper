import { Injectable, Logger } from "@nestjs/common";
import type { OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { Server as HttpServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import type { MachineSubscribed, Pong, SystemConnected } from "@flow-gatekeeper/contracts";
import { AppConfigService } from "../config/config.service.js";
import { MockTelemetryService } from "../telemetry/mock-telemetry.service.js";
import { HistoryService } from "../history/history.service.js";
import { filterPointsForSubscription } from "../../lib/subscription-filter.js";

type ClientId = string;

/**
 * 原生 `ws` Gateway（掛在 NestJS HTTP server，path `/ws`），非 Socket.IO（憲章 IV、ADR-001）。
 *
 * 跨多相演進的中心檔：
 * - Foundational：連線生命週期、ping→pong、send() 銜接點（FR-015）。
 * - US1（本相）：machine/subscribe（取代式 + 授權 happy-path）、producer tick、依訂閱推送。
 * - US3：伺服器端心跳探活回收、system/unauthorized 回執、生命週期記錄。
 */
@Injectable()
export class MonitoringGateway implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MonitoringGateway.name);
  private wss?: WebSocketServer;
  private producerTimer?: ReturnType<typeof setInterval>;
  private readonly clients = new Map<ClientId, WebSocket>();
  private readonly subscriptions = new Map<ClientId, Set<string>>();

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
  }

  onModuleDestroy(): void {
    if (this.producerTimer) clearInterval(this.producerTimer);
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
    this.send(clientId, { type: "system/connected", clientId } satisfies SystemConnected);
    this.logger.log(`client connected: ${clientId}`);

    socket.on("message", (raw) => this.handleMessage(clientId, raw.toString()));
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
          // 無效授權：不建立/變更訂閱。明確的 system/unauthorized 回執於 US3（T021）補上。
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

  private cleanup(clientId: ClientId, reason: string): void {
    this.clients.delete(clientId);
    this.subscriptions.delete(clientId);
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
