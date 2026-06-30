# Phase 0 Research: 即時 Gateway、遙測產生器與 MongoDB 歷史層

本 feature 的技術選型大多已由憲章與指南 §7 固定，以下記錄仍需決定的取捨與其理由。
格式：Decision / Rationale / Alternatives considered。

## R1. 控制訊息如何納入契約（contract-first）

**Decision**：在 `packages/contracts/src/events.ts` 新增控制訊息的 TS 型別，並在
`asyncapi.yaml` 補上對應通道；Gateway 一律 import 契約型別，不在元件內自訂結構。新增：

- client→server：`Ping`（`{ type:'ping' }`）、`MachineSubscribe`（001 已有）。
- server→client：`SystemConnected`（`{ type:'system/connected', clientId }`）、
  `MachineSubscribed`（`{ type:'machine/subscribed', machineIds }`）、`Pong`
  （`{ type:'pong', ts }`）、`SystemUnauthorized`（`{ type:'system/unauthorized' }`）。

**Rationale**：憲章 II/III 要求通訊一律依 `packages/contracts` 與 `asyncapi.yaml`，新增
event MUST 先改契約。指南骨架把這些控制訊息寫死在 Gateway 內屬「reference」，正式產出
應入契約以維持單一來源、避免 002/004 兩端分歧。

**Alternatives considered**：
- 沿用指南、控制訊息留在 Gateway 內字面量 → 違反 contract-first，004 前端要自己重寫一份，
  整合期易分歧。**否決**。
- 為每個控制訊息加 Zod schema + runtime parse → 與 001 既定模式（事件型別為手寫 TS、僅
  `DiagnosisResult` 用 Zod）不一致，且控制訊息為傳輸層 ack，過度工程。改採「型別入契約 +
  inbound 輕量 runtime guard」。

## R2. 原生 ws 如何與 NestJS HTTP server 共用 port

**Decision**：`apps/api` 改用 `NestFactory.create(AppModule)`（需 `@nestjs/platform-express`），
`await app.listen(API_PORT)` 後以 `app.get(MonitoringGateway).attach(app.getHttpServer())` 把
HTTP server 交給 `new WebSocketServer({ server, path: '/ws' })`。

**Rationale**：與既有 `ws://localhost:3000/ws` 約定一致（asyncapi server、004 前端）；ws 掛在
同一個 HTTP server 上，單一 port，符合憲章 IV 與 ADR-001。`NestFactory.create` 預設需要平台
adapter，故新增 `@nestjs/platform-express`。

**Alternatives considered**：用 `@nestjs/websockets` + `WsAdapter` → 仍是抽象層，且容易誤用
Socket.IO adapter；直接用原生 `ws` 最貼近 ADR 決策、最可控。**採原生 ws**。

## R3. 伺服器端心跳與「半死」連線清理（Q3）

**Decision**：採 `ws` 慣用的 liveness 模式——每個 socket 設 `isAlive` 旗標，`pong`（協定層）
事件時置 `true`；每 `WS_HEARTBEAT_MS`（預設 15000）的 interval 掃描所有 socket：`isAlive`
為 false 者 `terminate()` 並清理訂閱，否則置 false 後送 protocol-level `ping()`。客戶端
應用層 `{type:'ping'}` → `{type:'pong'}` 仍保留（供客戶端確認），兩者並存不衝突。

**Rationale**：直接滿足 FR-007(b)/FR-008/SC-005——網路硬中斷不會觸發 `close`，需伺服器主動
探活才能回收殭屍連線。`WS_HEARTBEAT_MS` 已存在於 `.env.example`，呼應原設計。

**Alternatives considered**：只靠 `close` 事件（spec Q3 選項 B）→ 與 edge case「未正常關閉仍
清理」有落差。**否決**。

## R4. 時序持久化、TTL 與 errorlog 去重

**Decision**：`HistoryService.onModuleInit` 用 `ensureCollections()` 建立 `telemetry`
（time-series，`expireAfterSeconds = TELEMETRY_TTL_SECONDS`）並對 `errorlogs`/`maintenanceRecords`
建索引。每 tick 由 Gateway 以 `void history.persistBatch(points)`（fire-and-forget）落地：
一次 `insertMany`（`ordered:false`）寫**全部機台**遙測（FR-009），並以記憶體 `lastState` map
偵測「轉入 warning/critical」者寫 `errorlogs`（FR-011 去重）。

**Rationale**：批次寫降低 round-trip、fire-and-forget 不阻塞推送 cadence（SC-008）；
`lastState` map 是「狀態轉換」去重的最小可行做法，且其判定邏輯可抽純函式單測（FR-016）。
TTL 由 env 控制（Q1：預設 7 天，demo 可調 60 分鐘）。

**Alternatives considered**：逐筆 `insertOne` → round-trip 過多；`await` 落地 → 拖慢 cadence，
違反 FR-010。**否決**。errorlog 每筆都寫 → 高頻洪水，違反 FR-011。**否決**。

## R5. 「依訂閱過濾」與「狀態轉換」抽純函式以利測試

**Decision**：把 `filterPointsForSubscription(points, machineIds)` 與
`detectErrorTransitions(points, lastState)` 抽成 `apps/api/src/lib/` 下的純函式，Gateway 與
HistoryService 呼叫它們；單元測試只測純函式，不啟動 ws/Mongo。

**Rationale**：FR-016 要求實際單元測試覆蓋「訂閱過濾」或「errorlog 去重」決定性邏輯；純函式
化讓測試無 I/O、快且穩定，符合憲章測試門檻。

**Alternatives considered**：在 Gateway/Service 內聯邏輯後用整合測試 → 需起 server/DB，慢且脆，
不利 CI。**抽純函式**。

## R6. 環境設定載入

**Decision**：`apps/api` 以 `dotenv`（`import 'dotenv/config'` 於 main entry）載入
`apps/api/.env`，並集中在 `modules/config` 做型別化讀取（`MOCK_TELEMETRY_INTERVAL_MS`、
`WS_HEARTBEAT_MS`、`WS_AUTH_SECRET`、`MONGO_URL`、`MONGO_DB`、`TELEMETRY_TTL_SECONDS`）。

**Rationale**：與 worker（`dotenv/config`）一致、最小相依；集中讀取避免 `process.env` 散落。

**Alternatives considered**：`@nestjs/config` → 功能更多但本 feature 用不到，增加相依與樣板。
**採 dotenv + 薄 config**（未來要換 @nestjs/config 也可平滑遷移）。

## R7. Redis 在 002 不使用

**Decision**：本 feature 不連 Redis；BullMQ queue、Pub/Sub relay、cache/lock 全部留待 003。

**Rationale**：spec FR-015 已將 job/status 與 AI 串流轉發劃歸 003；Gateway 僅保留通用
`send(clientId, payload)` 作為銜接點，避免本 feature 引入未使用的 Redis 連線。

## R8. 記錄（logging）策略

**Decision**：以 NestJS 內建 `Logger`（context 標 `MonitoringGateway`／`HistoryService`）記錄
四類事件（FR-017）：連線建立（含 clientId）、連線中斷（含心跳逾時回收，標明原因）、授權
失敗、歷史落地錯誤（`persistBatch` catch）。連線建立用 `log`、授權失敗／逾時回收用 `warn`、
落地錯誤用 `error`。

**Rationale**：FR-017 只要求「可記錄以利展示與除錯」，內建 `Logger` 零額外相依、與 Nest 啟動
輸出一致即可滿足；結構化 metrics／tracing 明確排除，避免過度工程。落地錯誤須被 catch 並記錄
（而非吞掉），同時不得中斷推送（FR-010）——`void persistBatch().catch(log)` 模式。

**Alternatives considered**：導入 pino／OpenTelemetry → 超出 demo 範圍、增相依，留待未來真有
觀測需求再評估。**採內建 Logger**。
