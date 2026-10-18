import { Injectable } from "@nestjs/common";
import type { OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { randomBytes, randomUUID } from "node:crypto";
import type { Server as HttpServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import type { VerifyClientCallbackAsync } from "ws";
import { ClientControlMessageSchema } from "@flow-gatekeeper/contracts";
import type {
  ClientControlMessage,
  MachineSubscribed,
  Pong,
  ServerMessage,
  SystemConnected,
  SystemMetrics,
  SystemUnauthorized,
} from "@flow-gatekeeper/contracts";
import { AppConfigService } from "../config/config.service.js";
import { MockTelemetryService } from "../telemetry/mock-telemetry.service.js";
import { HistoryService } from "../history/history.service.js";
import { filterPointsForSubscription } from "../../lib/subscription-filter.js";
import { isOriginAllowed, parseAllowedOrigins } from "../../lib/ws-origin.js";
import { safeEqualString } from "../../lib/safe-equal.js";
import { ERROR_LOG_THROTTLE_MS, LogThrottle } from "@flow-gatekeeper/shared/logging";
import {
  DEFAULT_MAX_WS_CONNECTIONS,
  DEFAULT_WS_AUTH_GRACE_MS,
  DEFAULT_WS_SEND_HIGH_WATER_BYTES,
} from "../../lib/env-schema.js";
import { getAppLogger } from "../../logging/app-logger.js";
import { throttledFields } from "../../lib/throttled-log.js";

type ClientId = string;

/**
 * 單則 client 訊息上限 16 KiB。合法控制訊息最大約 512（token）+ 50×64（machineIds）≈ 4 KiB；
 * ws 預設 100 MiB 等於讓任何連線者都能逼 api 配置巨量記憶體。
 */
export const WS_MAX_PAYLOAD_BYTES = 16 * 1024;

/**
 * 慢讀者判定：心跳 tick 時 `bufferedAmount` 仍超過高水位的**連續**次數達此值即 terminate。
 * 單一 tick 超標可能只是瞬間網路抖動（期間的高頻流已被略過、不會繼續堆積）；連續 3 輪仍消化
 * 不掉，代表對端讀得太慢，留著只會佔記憶體。從開始超標起算，這條路徑約在
 * `(WS_SLOW_CONSUMER_TICKS - 1)`～`WS_SLOW_CONSUMER_TICKS` 個 `WS_HEARTBEAT_MS` 後回收（預設 30～45 秒）。
 * 完全停止讀取的對端通常更早被回收：它讀不到排在緩衝後面的協定層 ping、回不了帶 nonce 的 pong，
 * 下一輪心跳就以 heartbeat-timeout terminate（見 `sweepDeadConnections`）；本常數兜底的是「有在讀、
 * 但讀得比送得慢」的對端，以及不讀推送卻持續送應用層 ping 的對端（超標時 pong 照回，入站量由 token
 * bucket 壓在每秒 20 則以內，見 `WS_INBOUND_RATE_PER_SEC`）。
 */
export const WS_SLOW_CONSUMER_TICKS = 3;

/**
 * 每連線違規（無法解析的 JSON、schema 不符、錯誤 token、超過入站速率）累計達此值即以 1008 關閉。
 * 合法前端不會送出任何一種；無上限時同一連線可無限暴力猜 token、每則都寫一行 warn 放大日誌。
 */
export const WS_MAX_VIOLATIONS = 10;

/**
 * 每連線入站速率（token bucket，API-13）：穩態每秒補 `WS_INBOUND_RATE_PER_SEC` 則、桶容量
 * `WS_INBOUND_BURST` 則；桶空時到達的訊息不解析、直接丟棄並各計一次違規（`rate-limit`），持續超速約
 * `WS_MAX_VIOLATIONS` 則後即以 1008 關閉。
 *
 * 取值依據：web 前端每條連線只送 `machine/subscribe`（連上時一次）與 `ping`（連上時一次、之後每 15 s
 * 一次），穩態遠低於 1 則／秒；20 則／秒留兩個數量級的餘裕給 smoke 腳本等非瀏覽器 client，容量 40
 * 則容許重連瞬間或腳本的短促突發。沒有上限時，不讀回應、只灌 ping 的 client 能讓 server 端送出緩衝
 * 在心跳回收前線性成長（實測 10 s 達高水位 63 倍）。
 */
export const WS_INBOUND_RATE_PER_SEC = 20;
/** 入站 token bucket 容量（突發上限），見 `WS_INBOUND_RATE_PER_SEC`。 */
export const WS_INBOUND_BURST = 40;

/** 心跳 ping 的 nonce 長度；pong 必須原樣帶回才算存活。 */
const PING_NONCE_BYTES = 8;

/** 未授權連線子上限的下限（見 `unauthorizedConnectionCap`）。 */
export const MIN_UNAUTHORIZED_CONNECTIONS = 10;
/** 未授權連線子上限佔總連線上限的比例（見 `unauthorizedConnectionCap`）。 */
export const UNAUTHORIZED_CONNECTION_RATIO = 0.2;

/**
 * 有設 `WS_AUTH_SECRET` 時，「尚未通過 token 檢查」的連線同時最多幾條：
 * `max(1, min(maxConnections - 1, max(10, floor(maxConnections × 0.2))))`。沒有子上限時，不知道 token
 * 的一方只要持續開連線（每條在授權期限內都合法存在）就能佔滿全域名額，讓持有 token 的正常使用者連不進來。
 *
 * `maxConnections - 1` 那一層（API-14）：`MAX_WS_CONNECTIONS` 允許 1～100000，只取 `max(10, 20%)` 時
 * 上限 ≤ 10 的部署子上限等於（或大於）全域上限，未授權者能單獨佔滿全部名額。加上這層後未授權者不能
 * 單獨佔滿全域名額，但保留的那一格只有**已在線且已授權**的連線用得到：新的持 token 連線一樣得先經過
 * 未授權池，池滿時照樣拿 503（見 `upgradeVerifier` 的註解）。
 * 最外層 `max(1, …)`：每條新連線都得先以未授權身分進來，子上限為 0 就沒有人連得上——`maxConnections = 1`
 * 時只能讓那唯一一格也開放給未授權者，佔住它的未授權連線由授權期限（`WS_AUTH_GRACE_MS`）回收。
 */
export function unauthorizedConnectionCap(maxConnections: number): number {
  const proportional = Math.max(
    MIN_UNAUTHORIZED_CONNECTIONS,
    Math.floor(maxConnections * UNAUTHORIZED_CONNECTION_RATIO),
  );
  return Math.max(1, Math.min(maxConnections - 1, proportional));
}

/**
 * 背壓可略過的推送：遙測批次與 `ai/token`（每筆 LLM token 一則的高頻流）。其餘皆為低頻控制／終態訊息，
 * 慢讀者仍須收到（漏送終態會讓前端卡在 streaming）。應用層 `pong` 也照送：它的數量由入站 ping 決定，
 * 已由入站 token bucket 限量（API-13，見 `WS_INBOUND_RATE_PER_SEC`）。
 */
export function isBackpressureDroppable(payload: ServerMessage): boolean {
  return Array.isArray(payload) || payload.type === "ai/token";
}

/** 授權期限掃描的間隔：`min(WS_HEARTBEAT_MS, WS_AUTH_GRACE_MS)`，實際關閉時間 ≤ 期限 + 此間隔。 */
export function authGraceSweepIntervalMs(heartbeatMs: number, authGraceMs: number): number {
  return Math.min(heartbeatMs, authGraceMs);
}

export type GatewayAttachOptions = {
  /** Origin 白名單；未指定時讀 `WS_ALLOWED_ORIGINS`（空＝不檢查）。 */
  allowedOrigins?: readonly string[];
  /** 單一連線送出緩衝高水位（bytes）；未指定時用 `DEFAULT_WS_SEND_HIGH_WATER_BYTES`。 */
  sendHighWaterBytes?: number;
  /** 同時連線數上限；未指定時用 `DEFAULT_MAX_WS_CONNECTIONS`。 */
  maxConnections?: number;
  /** 有設密鑰時通過 token 檢查的期限（ms）；未指定時用 `DEFAULT_WS_AUTH_GRACE_MS`。 */
  authGraceMs?: number;
  /** 入站 token bucket 用的單調時鐘（ms）；未指定時用 `performance.now()`。測試注入可控時鐘用。 */
  monotonicNow?: () => number;
};

/** 單一連線的全部伺服器端狀態（清理時整筆移除，不會有殘留的平行 Map）。 */
type ClientState = {
  socket: WebSocket;
  /** 連線建立時間（ms）；授權期限以此起算。 */
  connectedAt: number;
  subscriptions: Set<string>;
  /**
   * 是否已授權：未設 `WS_AUTH_SECRET` 時連上即授權；有設時僅在通過 `machine/subscribe` token
   * 檢查後才成立。AI／job 事件（`send()`）與 `system/metrics` 只送已授權連線。
   */
  authorized: boolean;
  /** 上一輪心跳後是否收到帶正確 nonce 的 pong。 */
  alive: boolean;
  /** 本輪心跳送出的 nonce；尚未送出或已回應則為 undefined（未經請求的 pong 一律不算）。 */
  pingNonce?: Buffer;
  /** 連續幾個心跳 tick `bufferedAmount` 超過高水位。 */
  overHighWaterTicks: number;
  violations: number;
  /** 入站 token bucket（見 `WS_INBOUND_RATE_PER_SEC`）；連上時為滿桶。 */
  inbound: InboundBucket;
  /**
   * 因違規／授權逾期發出 close(1008) 時掛上的逐連線計時器（見 `requestClose`）；有值即「關閉中」
   * （見 `isClosing`），期間的訊息一律忽略。對端在 `min(WS_HEARTBEAT_MS, WS_AUTH_GRACE_MS)` 內回
   * close frame → 'close' 事件進 `cleanup` 清掉此計時器；逾期未回 → 計時器以 `close-not-honoured`
   * terminate。
   */
  closeTimer?: ReturnType<typeof setTimeout>;
};

/** 已發出 close、等待對端回 close frame 的連線（單一來源：`closeTimer`）。 */
function isClosing(state: ClientState): boolean {
  return state.closeTimer !== undefined;
}

type ViolationReason = "invalid-json" | "schema" | "unauthorized" | "rate-limit";

const VIOLATION_LOG_MESSAGES: Record<ViolationReason, string> = {
  "invalid-json": "ignored client message",
  schema: "ignored client message",
  unauthorized: "unauthorized subscribe",
  "rate-limit": "client message rate exceeded, message dropped",
};

/**
 * 入站 token bucket 狀態：`tokens` 可為小數（依經過時間連續補充），`refilledAt` 為上次補充時刻（ms）。
 * 時刻一律取**單調時鐘**（預設 `performance.now()`）：牆上時鐘（`Date.now()`）倒退 D 時 `refilledAt` 會卡在
 * 未來、要等追回 D 才再補充——倒退 1 小時的話，既有 web 連線約 10 分鐘後的 ping 就會被判超速而重連。
 */
export type InboundBucket = { tokens: number; refilledAt: number };

/** 預設的單調時鐘。包成函式而非直接傳 `performance.now`：後者脫離 `performance` 呼叫會丟 Illegal invocation。 */
const defaultMonotonicNow = (): number => performance.now();

/** 新連線的滿桶。 */
export function fullInboundBucket(now: number): InboundBucket {
  return { tokens: WS_INBOUND_BURST, refilledAt: now };
}

/**
 * 依經過時間補充後嘗試取一則額度：取得回 true（並扣 1），桶空回 false（不扣、呼叫端丟棄該則）。
 * `now` MUST 來自單調時鐘（見 `InboundBucket`），故不另做倒退保護。
 */
export function takeInboundToken(bucket: InboundBucket, now: number): boolean {
  const elapsed = now - bucket.refilledAt;
  bucket.tokens = Math.min(WS_INBOUND_BURST, bucket.tokens + (elapsed * WS_INBOUND_RATE_PER_SEC) / 1_000);
  bucket.refilledAt = now;
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

/**
 * 原生 `ws` Gateway（掛在 NestJS HTTP server，path `/ws`），非 Socket.IO（憲章 IV、ADR-001）。
 *
 * - 連線生命週期：連線→system/connected、close/心跳逾時→清理（FR-001/FR-008）。
 * - 訂閱：machine/subscribe 取代式 + 授權（FR-002/FR-003）；未訂閱者不收遙測（FR-004）。
 * - 心跳：應用層 ping→pong（FR-007a）+ 伺服器端探活回收半死連線（FR-007b/SC-005）；協定層
 *   ping 帶每輪隨機 nonce，pong 必須原樣帶回才算存活——暫停讀取、只顧主動送 pong 的對端騙不過。
 *   協定層只有「server 送 ping、client 回 pong」這個方向：client 送來的協定層 ping 不自動回應
 *   （`autoPong: false`，見 attach）。
 * - 落地：全量同步進 HistoryService buffer，由其每秒批次落庫（FR-009/FR-010）。
 * - 記錄：連線/斷線/授權失敗/逾時回收（FR-017）；同類 warn 以 LogThrottle 節流——**授權失敗、
 *   畸形訊息、Origin 拒絕、連線數拒絕等日誌為 30 秒抽樣**（key 為事件種類、全域共用，每 30 秒
 *   至多一則並附 `suppressed` 被壓掉的則數），不是逐則記錄；逐連線的斷線／回收仍逐則記錄。
 * - 輸入加固：client 訊息一律視為不可信——Zod safeParse 後才分派、socket/server 皆掛 error
 *   listener、maxPayload 16 KiB、Origin 白名單、連線數上限、授權期限（有密鑰時連線須在
 *   `WS_AUTH_GRACE_MS` 內通過 token，否則 1008——不讓不訂閱的連線佔住名額；未授權連線另有子上限
 *   `unauthorizedConnectionCap`）、machineIds 與已知機台取交集、
 *   token 常數時間比較、每連線入站訊息速率（token bucket，`WS_INBOUND_RATE_PER_SEC`）、每連線違規計數
 *   （畸形訊息、錯誤 token、超速各計一次，達 `WS_MAX_VIOLATIONS` 以 1008 關閉）。任何畸形輸入
 *   都只影響該則訊息（或該條連線），不得讓行程結束。
 * - 出口閘門：所有推送經 `deliver()` 做背壓（`bufferedAmount` 超過高水位時略過高頻流——遙測批次與
 *   `ai/token`——其餘控制／終態訊息與應用層 `pong` 照送，`pong` 的量由入站 token bucket 壓住）；連續
 *   `WS_SLOW_CONSUMER_TICKS` 個心跳 tick 超標則 terminate；對外的 `send()` 另只送已授權連線。
 */
@Injectable()
export class MonitoringGateway implements OnModuleInit, OnModuleDestroy {
  // 連線相關事件需要 clientId 為獨立結構化欄位（FR-002），Nest Logger 的 API 只能帶字串
  // context，故此類事件改走底層 pino child logger 直接呼叫（contracts/log-fields.md §2）。
  private readonly plog = getAppLogger().child({ context: MonitoringGateway.name });
  // key 為固定的事件種類（不含 clientId）：key 集合有界、不隨連線數成長。
  private readonly warnThrottle = new LogThrottle(ERROR_LOG_THROTTLE_MS);
  private wss?: WebSocketServer;
  private producerTimer?: ReturnType<typeof setInterval>;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private authGraceTimer?: ReturnType<typeof setInterval>;
  private readonly clients = new Map<ClientId, ClientState>();
  /** 目前在 `clients` 內、尚未授權的連線數（未設密鑰時恆為 0）；未授權子上限以此判定。 */
  private unauthorizedCount = 0;
  private sendHighWaterBytes = DEFAULT_WS_SEND_HIGH_WATER_BYTES;
  private maxConnections = DEFAULT_MAX_WS_CONNECTIONS;
  private authGraceMs = DEFAULT_WS_AUTH_GRACE_MS;
  /** 發出 close 後等待對端 close frame 的上限：`min(WS_HEARTBEAT_MS, WS_AUTH_GRACE_MS)`，於 attach 算定。 */
  private closeDeadlineMs = DEFAULT_WS_AUTH_GRACE_MS;
  private droppedSends = 0;
  /** 入站 token bucket 的時鐘（單調，見 `InboundBucket`）；於 attach 決定。 */
  private monotonicNow: () => number = defaultMonotonicNow;

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
    // 伺服器端心跳探活：回收網路硬中斷的「半死」連線（FR-007b/SC-005）與慢讀者。
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
    this.heartbeatTimer = undefined;
    if (this.authGraceTimer) clearInterval(this.authGraceTimer);
    this.authGraceTimer = undefined;
    // 優雅關閉（FR-004）：主動 terminate 所有連線並關閉 ws server。升級後的 ws 是「活躍連線」，
    // 不主動釋放的話 app.close() 等待的 http.Server 'close' 永不回呼——關閉會掛到 stop_grace_period
    // 逾時被 SIGKILL（非零退出→被監督者誤判為崩潰而重啟一個正被停止的服務）。terminate 觸發的
    // 'close' 事件會再進 cleanup()，其冪等守衛可安全重入。
    for (const clientId of [...this.clients.keys()]) {
      this.terminate(clientId, "shutdown");
    }
    this.wss?.close();
  }

  /** 由 main.ts 在 app.listen() 後呼叫，與 HTTP 共用同一個 port（ws://host:port/ws）。 */
  attach(server: HttpServer, options: GatewayAttachOptions = {}): void {
    const allowedOrigins =
      options.allowedOrigins ?? parseAllowedOrigins(process.env.WS_ALLOWED_ORIGINS);
    this.sendHighWaterBytes = options.sendHighWaterBytes ?? DEFAULT_WS_SEND_HIGH_WATER_BYTES;
    this.maxConnections = options.maxConnections ?? DEFAULT_MAX_WS_CONNECTIONS;
    this.authGraceMs = options.authGraceMs ?? DEFAULT_WS_AUTH_GRACE_MS;
    this.monotonicNow = options.monotonicNow ?? defaultMonotonicNow;
    this.closeDeadlineMs = Math.min(this.config.wsHeartbeatMs, this.authGraceMs);
    this.wss = new WebSocketServer({
      server,
      path: "/ws",
      maxPayload: WS_MAX_PAYLOAD_BYTES,
      verifyClient: this.upgradeVerifier(allowedOrigins),
      // API-13：ws 預設 `autoPong: true`，收到 client 的協定層 ping frame（opcode 0x9）就自動回 pong——
      // 這條路不經 `message` 事件，繞過入站 token bucket、違規計數與任何背壓判斷：暫停讀取、狂送
      // `ws.ping()` 的連線實測 2 秒把送出緩衝推到高水位的 72 倍、違規數 0。關掉不影響任何合法路徑：
      // 瀏覽器 WebSocket API 不會送協定層 ping（web 心跳走應用層 `ping` 訊息），server 的探活是「server
      // 送 ping、client 回 pong」，只吃 client 端的 autoPong 與本端的 'pong' 事件。不回應的協定層 ping
      // 只花接收端解析（control frame 上限 125 bytes），不會讓送出緩衝成長。
      autoPong: false,
    });
    this.wss.on("connection", (socket) => this.handleConnection(socket));
    // 授權期限另開獨立 interval，不掛在心跳 sweep 上：`WS_HEARTBEAT_MS` 可設到 2^31-1，掛在心跳上
    // 期限就形同失效。在 attach（而非 onModuleInit）啟動，因為期限值在此才確定；未設密鑰時不需要。
    if (this.authGraceTimer) clearInterval(this.authGraceTimer);
    this.authGraceTimer = undefined;
    if (this.config.wsAuthSecret) {
      this.authGraceTimer = setInterval(
        () => this.sweepAuthGrace(),
        authGraceSweepIntervalMs(this.config.wsHeartbeatMs, this.authGraceMs),
      );
    }
    // 掛 server 端 error listener：ws 會把底層 http server 的 error 轉發到 wss，
    // 沒有 listener 時 EventEmitter 直接 throw → uncaughtException → 行程結束。
    this.wss.on("error", (err) => {
      this.plog.error({ err }, "websocket server error");
    });
  }

  /**
   * upgrade 前的三道檢查：連線數上限（已達上限回 503，不建立連線）、有密鑰時的未授權連線子上限
   * （`unauthorizedConnectionCap`，達上限回 503）與 Origin 白名單（不在清單回 403；清單為空則
   * 不檢查）。連線數以「已建立的連線」計：同一瞬間併發的 upgrade 可能略微超出上限，屬可接受的
   * 誤差（目的是擋住無上限成長，而非精確配額）。
   */
  private upgradeVerifier(allowedOrigins: readonly string[]): VerifyClientCallbackAsync {
    return (info, done) => {
      if (this.clients.size >= this.maxConnections) {
        this.throttledWarn(
          "max-connections",
          { connections: this.clients.size, maxConnections: this.maxConnections },
          "websocket upgrade rejected: too many connections",
        );
        done(false, 503, "Service Unavailable");
        return;
      }
      // 有密鑰時，新連線在通過 token 前都算「未授權」：未授權者已達子上限就不再收。這限制的是未授權者
      // 可佔的**總名額**（其餘名額只有已授權者能佔住）；持 token 的新連線同樣得先經過未授權池，池被
      // 佔滿時一樣拿到 503——不保證新授權連線必能進入，只保證已授權者不受未授權洪水影響。
      const unauthorizedCap = unauthorizedConnectionCap(this.maxConnections);
      if (this.config.wsAuthSecret && this.unauthorizedCount >= unauthorizedCap) {
        this.throttledWarn(
          "max-unauthorized-connections",
          { unauthorizedConnections: this.unauthorizedCount, unauthorizedCap },
          "websocket upgrade rejected: too many unauthorized connections",
        );
        done(false, 503, "Service Unavailable");
        return;
      }
      if (allowedOrigins.length > 0) {
        // ws 的型別宣告 origin 為 string，但實際上沒帶 header 時是 undefined。
        const origin = (info.origin as string | undefined) || undefined;
        if (!isOriginAllowed(origin, allowedOrigins)) {
          this.throttledWarn("origin-rejected", { origin }, "websocket upgrade rejected: origin not allowed");
          done(false, 403, "Forbidden");
          return;
        }
      }
      done(true);
    };
  }

  private handleConnection(socket: WebSocket): void {
    const clientId = randomUUID();
    const state: ClientState = {
      socket,
      connectedAt: Date.now(),
      subscriptions: new Set(),
      // 未設密鑰（demo／本機）時沒有可驗的 token，連上即視為已授權。
      authorized: !this.config.wsAuthSecret,
      alive: true,
      overHighWaterTicks: 0,
      violations: 0,
      inbound: fullInboundBucket(this.monotonicNow()),
    };
    this.clients.set(clientId, state);
    if (!state.authorized) this.unauthorizedCount += 1;
    this.deliver(clientId, { type: "system/connected", clientId } satisfies SystemConnected);
    this.plog.info({ clientId }, "client connected");

    // binaryType 維持 ws 預設 "nodebuffer"：RawData 恆為 Buffer（分片訊息亦已合併），故可直接 toString()。
    socket.on("message", (raw) => this.handleMessage(clientId, (raw as Buffer).toString()));
    // protocol-level pong：只有原樣帶回本輪 nonce 者才算存活；未經請求或 nonce 不符的 pong 忽略。
    socket.on("pong", (data) => {
      if (state.pingNonce && data.equals(state.pingNonce)) {
        state.alive = true;
        state.pingNonce = undefined;
      }
    });
    socket.on("close", () => this.cleanup(clientId, "close"));
    // 協定層錯誤（非法 opcode、未遮罩 frame、無效 UTF-8、超過 maxPayload）ws 會 emit 'error'，
    // 沒有 listener 就會直接 throw 讓行程崩潰。ws 會自行關閉這條連線，後續由 'close' 清理。
    socket.on("error", (err) => {
      this.throttledWarn(
        "client-error",
        { clientId, err: { message: err.message } },
        "websocket client error",
      );
    });
  }

  private handleMessage(clientId: ClientId, raw: string): void {
    const state = this.clients.get(clientId);
    if (!state || isClosing(state)) return; // 已離線或正因違規關閉
    // 速率檢查排在解析之前：超速的訊息連 JSON.parse 都不做，灌訊息的一方拿不到任何 CPU 放大。
    if (!takeInboundToken(state.inbound, this.monotonicNow())) {
      this.recordViolation(clientId, "rate-limit");
      return;
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      this.recordViolation(clientId, "invalid-json");
      return; // 無法解析的訊息安全忽略（FR-014）
    }

    const parsed = ClientControlMessageSchema.safeParse(json);
    if (!parsed.success) {
      // 只記路徑與訊息摘要，不記原始內容——原始內容可能含 token。
      const issues = parsed.error.issues
        .slice(0, 5)
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
      this.recordViolation(clientId, "schema", { issues });
      return; // 未知 type 或形狀不符一律安全忽略（FR-014）
    }
    this.dispatch(clientId, parsed.data);
  }

  private dispatch(clientId: ClientId, msg: ClientControlMessage): void {
    const state = this.clients.get(clientId);
    if (!state) return;
    switch (msg.type) {
      case "ping":
        // 超過高水位時照回 pong（不受背壓略過）：擁塞但健康的連線若收不到 pong，web 5 s 後會判為斷線
        // 重連、進行中的診斷被標成中斷。ping 不需授權、每則換一則 pong，放大量已由入站 token bucket
        // 壓在每秒 `WS_INBOUND_RATE_PER_SEC` 則以內（API-13）；真的不讀的對端交給心跳 sweep——連續
        // `WS_SLOW_CONSUMER_TICKS` 個 tick 超過高水位即 terminate。
        this.deliver(clientId, { type: "pong", ts: Date.now() } satisfies Pong);
        break;

      case "machine/subscribe": {
        const secret = this.config.wsAuthSecret;
        if (secret) {
          if (!safeEqualString(msg.token, secret)) {
            // 無效授權：回 system/unauthorized 且不建立/變更訂閱、不改變授權狀態（FR-003/SC-006）。
            if (this.recordViolation(clientId, "unauthorized")) return;
            this.deliver(clientId, { type: "system/unauthorized" } satisfies SystemUnauthorized);
            return;
          }
          if (!state.authorized) {
            state.authorized = true;
            this.unauthorizedCount -= 1;
          }
        }
        // 只保留已知機台（去重、保持 client 給的順序）：未知 id 訂閱了也不會有資料，
        // 留著只會讓每次廣播多做無謂比對。
        const known = new Set(this.telemetry.machineIds);
        const machineIds = [...new Set(msg.machineIds)].filter((id) => known.has(id));
        // 取代式：新集合即為當前訂閱的唯一真實狀態（FR-002）。
        state.subscriptions = new Set(machineIds);
        this.deliver(clientId, {
          type: "machine/subscribed",
          machineIds,
        } satisfies MachineSubscribed);
        break;
      }
    }
  }

  /**
   * 記一次違規並節流記錄；累計達 `WS_MAX_VIOLATIONS` 時以 1008（policy violation）關閉連線。
   * 回傳 true 表示連線已被關閉（或已不在），呼叫端不必再回應。
   */
  private recordViolation(
    clientId: ClientId,
    reason: ViolationReason,
    extra: Record<string, unknown> = {},
  ): boolean {
    const state = this.clients.get(clientId);
    if (!state) return true;
    state.violations += 1;
    this.throttledWarn(
      `violation:${reason}`,
      { clientId, reason, violations: state.violations, ...extra },
      VIOLATION_LOG_MESSAGES[reason],
    );
    if (state.violations < WS_MAX_VIOLATIONS) return false;
    this.throttledWarn(
      "violation-close",
      { clientId, violations: state.violations },
      "too many client violations, closing with 1008",
    );
    this.requestClose(clientId, state, 1008, "policy violation");
    return true;
  }

  /**
   * 發出 close 並掛逐連線計時器（違規與授權逾期的唯一關閉入口）；之後的訊息一律忽略。
   *
   * 對端滿 `closeDeadlineMs`＝`min(WS_HEARTBEAT_MS, WS_AUTH_GRACE_MS)` 仍未回 close frame 即 terminate
   * （reason `close-not-honoured`）。不靠計時器也不會無限佔名額——ws 的 `close()` 會同步進入 CLOSING 並
   * 啟動內建 closeTimer（約 30 s），CLOSING 後 `ping()` 不會真的送出、心跳 sweep 也會以 heartbeat-timeout
   * 回收；逐連線計時器提供與 sweep 間隔、是否設密鑰、`WS_HEARTBEAT_MS` 設多大都無關的精確上限，
   * 並讓日誌可與半死連線區分。`WS_AUTH_GRACE_MS` 恆有值（預設 10 s），無密鑰時同樣可作門檻。
   * `unref()`：此計時器不應阻止行程結束。
   */
  private requestClose(clientId: ClientId, state: ClientState, code: number, reason: string): void {
    const deadlineMs = this.closeDeadlineMs;
    state.closeTimer = setTimeout(() => {
      this.plog.warn({ clientId, closeDeadlineMs: deadlineMs }, "close frame not received, terminating");
      this.terminate(clientId, "close-not-honoured");
    }, deadlineMs);
    state.closeTimer.unref();
    state.socket.close(code, reason);
  }

  /** 同類 warn 每 `ERROR_LOG_THROTTLE_MS` 至多一則，並帶出期間被壓掉的則數。 */
  private throttledWarn(key: string, fields: Record<string, unknown>, msg: string): void {
    const out = throttledFields(this.warnThrottle, key, fields);
    if (out) this.plog.warn(out, msg);
  }

  /** 每 tick：只把訂閱機台的 TelemetryPoint[] 推給各訂閱者（FR-004）；全量落地與推送解耦。 */
  private publishTelemetry(): void {
    const points = this.telemetry.nextBatch();

    // 即時推送：只送訂閱者（FR-004）。有設密鑰時訂閱只在授權通過後才建立，未授權者訂閱恆為空。
    for (const [clientId, state] of this.clients) {
      const selected = filterPointsForSubscription(points, state.subscriptions);
      if (selected.length > 0) {
        this.deliver(clientId, selected);
      }
    }

    // 持久化：全部機台、與訂閱無關（FR-009）；只進記憶體 buffer，由 HistoryService 每秒批次
    // 落庫，推送 cadence 不受資料庫延遲牽制（FR-010）。
    this.history.enqueue(points);
  }

  /**
   * 心跳探活掃描：上一輪未回帶正確 nonce 的 pong 者判定失效並回收（涵蓋網路硬中斷的半死連線）；
   * `bufferedAmount` 連續 `WS_SLOW_CONSUMER_TICKS` 輪超過高水位者視為慢讀者回收；其餘標記為
   * 待驗證並送 `ping(nonce)`。回收上限約 2 × WS_HEARTBEAT_MS（SC-005）。授權期限不在此檢查
   * （見 `sweepAuthGrace`）；已發 close 者的逾期回收由逐連線計時器負責（見 `requestClose`）。
   */
  private sweepDeadConnections(): void {
    for (const [clientId, state] of this.clients) {
      if (!state.alive) {
        this.plog.warn({ clientId }, "heartbeat timeout, terminating");
        this.terminate(clientId, "heartbeat-timeout");
        continue;
      }
      if (state.socket.bufferedAmount > this.sendHighWaterBytes) {
        state.overHighWaterTicks += 1;
        if (state.overHighWaterTicks >= WS_SLOW_CONSUMER_TICKS) {
          this.plog.warn(
            {
              clientId,
              bufferedAmount: state.socket.bufferedAmount,
              highWaterBytes: this.sendHighWaterBytes,
              ticks: state.overHighWaterTicks,
            },
            "slow consumer, terminating",
          );
          this.terminate(clientId, "slow-consumer");
          continue;
        }
      } else {
        state.overHighWaterTicks = 0;
      }
      state.alive = false;
      state.pingNonce = randomBytes(PING_NONCE_BYTES);
      state.socket.ping(state.pingNonce);
    }
  }

  /**
   * 授權期限掃描（有設密鑰時由 attach 以 `min(WS_HEARTBEAT_MS, WS_AUTH_GRACE_MS)` 間隔驅動）：
   * 逾 `WS_AUTH_GRACE_MS` 仍未授權者以 1008 關閉。不另開每連線 timer，故實際關閉時間介於
   * 期限～期限 + 一個掃描間隔，最長約 2 × WS_AUTH_GRACE_MS（與心跳間隔設多大無關）。
   * 已發 close 者跳過；其逾期回收由逐連線計時器負責（見 `requestClose`）。
   */
  private sweepAuthGrace(): void {
    if (!this.config.wsAuthSecret) return;
    const now = Date.now();
    for (const [clientId, state] of this.clients) {
      if (isClosing(state) || state.authorized || now - state.connectedAt < this.authGraceMs) continue;
      this.throttledWarn(
        "auth-grace-expired",
        { clientId, authGraceMs: this.authGraceMs },
        "websocket not authorized within grace period, closing with 1008",
      );
      this.requestClose(clientId, state, 1008, "authorization timeout");
    }
  }

  private terminate(clientId: ClientId, reason: string): void {
    const state = this.clients.get(clientId);
    if (!state) return;
    state.socket.terminate();
    this.cleanup(clientId, reason);
  }

  private cleanup(clientId: ClientId, reason: string): void {
    const state = this.clients.get(clientId);
    if (!state) return; // 冪等：避免 terminate→close 重複清理/記錄
    this.clients.delete(clientId);
    // 對端已回 close frame（或已被 terminate）：撤掉逾期計時器，不讓它之後再 terminate 一條已清理的連線。
    if (state.closeTimer) clearTimeout(state.closeTimer);
    if (!state.authorized) this.unauthorizedCount -= 1;
    this.plog.info({ clientId, reason }, "client disconnected");
  }

  /** 當前 ws 連線數（瞬時值 gauge，非窗內平均）——009 US3 指標來源。 */
  get connectionCount(): number {
    return this.clients.size;
  }

  /**
   * 因背壓（`bufferedAmount` 超過高水位）被略過的高頻推送累計數——遙測批次與 `ai/token`（counter，
   * 不歸零）。
   */
  get droppedSendCount(): number {
    return this.droppedSends;
  }

  /** 該 clientId 是否為目前在線的連線。 */
  isOnline(clientId: ClientId): boolean {
    return this.clients.has(clientId);
  }

  /**
   * 該 clientId 是否在線**且**已授權——`POST /diagnoses` 綁定 socketId 前的檢查（API-4）：
   * 不檢查的話，任何人都能拿一條未授權（或已斷線）的 clientId 發起診斷，繞過 `WS_AUTH_SECRET`。
   */
  isAuthorized(clientId: ClientId): boolean {
    return this.clients.get(clientId)?.authorized === true;
  }

  /**
   * 廣播 `system/metrics` 給**所有已授權 client**（009 FR-008a；未設密鑰時即所有已連線 client）。
   *
   * 與訂閱了哪些機台**無關**：指標是系統級資訊、不隸屬任何機台，用機台訂閱過濾它在語意上
   * 不成立（contracts/metrics-summary.md §2）。至多送一次——漏送一則即等下一週期，不重送、不補發。
   */
  broadcastMetrics(payload: SystemMetrics): void {
    for (const [clientId, state] of this.clients) {
      if (state.authorized) this.deliver(clientId, payload);
    }
  }

  /**
   * 對單一**已授權**連線推送——003 AI relay / job status relay 的銜接點（FR-015）。
   * 未授權或已離線的 clientId 一律靜默略過：AI 串流與 job 狀態不得送給沒通過 token 檢查的連線。
   */
  send(clientId: ClientId, payload: ServerMessage): void {
    if (!this.isAuthorized(clientId)) return;
    this.deliver(clientId, payload);
  }

  /**
   * 所有推送的唯一出口（不檢查授權：`system/connected`／`system/unauthorized` 這類連線層控制
   * 訊息必須送得到未授權連線）。
   *
   * 背壓只作用於**高頻流**——遙測批次（`TelemetryPoint[]`）與 `ai/token`（見 `isBackpressureDroppable`）：
   * `bufferedAmount` 已超過高水位時略過該則並計數——對端讀不動時繼續 `send()` 只會讓 api 記憶體無上限
   * 成長；漏掉的遙測下一 tick 就有新值補上，漏掉的 token 由 `ai/done` 帶完整結果收尾。終態與控制訊息
   * （`ai/done`／`ai/error`／`job/status`、`system/*`、`machine/subscribed`）一律照送：它們低頻、體積小，
   * 且漏送終態會讓前端卡在 streaming 直到 watchdog 逾時。應用層 `pong` 同樣照送：它由入站 ping 觸發、
   * 數量由對端決定，但入站總量受 token bucket 限制（API-13），放大有上限；client 送來的協定層 ping 則
   * 根本不回（`autoPong: false`）。記憶體上限由心跳 sweep 保證——不回協定層 pong 者下一輪以
   * heartbeat-timeout 回收，連續 `WS_SLOW_CONSUMER_TICKS` 個 tick 超標者以 slow-consumer 回收。
   */
  private deliver(clientId: ClientId, payload: ServerMessage): void {
    const state = this.clients.get(clientId);
    if (state?.socket.readyState !== WebSocket.OPEN) return;
    if (isBackpressureDroppable(payload) && state.socket.bufferedAmount > this.sendHighWaterBytes) {
      this.droppedSends += 1;
      this.throttledWarn(
        "backpressure-drop",
        { clientId, bufferedAmount: state.socket.bufferedAmount, droppedSends: this.droppedSends },
        "websocket send skipped: buffered amount over high water mark",
      );
      return;
    }
    state.socket.send(JSON.stringify(payload));
  }
}
