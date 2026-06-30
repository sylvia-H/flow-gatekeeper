import { Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { Server as HttpServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import type { Pong, SystemConnected } from "@flow-gatekeeper/contracts";

type ClientId = string;

/**
 * 原生 `ws` Gateway（掛在 NestJS HTTP server，path `/ws`），非 Socket.IO（憲章 IV、ADR-001）。
 *
 * 本檔為跨多相演進的中心檔：
 * - Foundational（本相）：連線生命週期骨架（連線→system/connected、close 清理）、ping→pong、
 *   send() 銜接點（003 AI relay 用，FR-015）。
 * - US1（T013）：machine/subscribe 訂閱（取代式 + 授權）、producer tick、依訂閱推送。
 * - US3（T020/T021/T022）：伺服器端心跳探活回收、授權拒絕/壞訊息強化、生命週期記錄。
 */
@Injectable()
export class MonitoringGateway {
  private readonly logger = new Logger(MonitoringGateway.name);
  private wss?: WebSocketServer;
  private readonly clients = new Map<ClientId, WebSocket>();
  private readonly subscriptions = new Map<ClientId, Set<string>>();

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
    let msg: { type?: string };
    try {
      msg = JSON.parse(raw) as { type?: string };
    } catch {
      return; // 無法解析的訊息安全忽略（FR-014）
    }

    switch (msg.type) {
      case "ping":
        // ping→pong 為 US1/US3 共用基礎，於此先建（見 tasks O1 註）。
        this.send(clientId, { type: "pong", ts: Date.now() } satisfies Pong);
        break;
      // machine/subscribe 於 US1（T013）填入；其餘 type 安全忽略（FR-014）。
      default:
        break;
    }
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
