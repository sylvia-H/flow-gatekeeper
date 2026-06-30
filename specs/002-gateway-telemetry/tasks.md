---
description: "Task list for 002-gateway-telemetry implementation"
---

# Tasks: 即時 Gateway、遙測產生器與 MongoDB 歷史層

**Input**: Design documents from `/specs/002-gateway-telemetry/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/control-messages.contract.md, quickstart.md

**Tests**: 本 feature **要求**至少一支實際純函式單元測試（spec FR-016）。下列 T011、T016 為
必需測試任務（非 optional）；其餘行為以 quickstart 手動驗收。

**Organization**: 依 user story（US1 P1 / US2 P2 / US3 P3）分相，使每相為可獨立驗收的增量。
範圍只動 `apps/api` 與 `packages/contracts` + `asyncapi.yaml`（worker/web 不在本 feature）。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 可平行（不同檔案、無未完成相依）
- **[Story]**: US1 / US2 / US3；Setup、Foundational、Polish 無 story 標籤
- 每個任務含明確檔案路徑

## Path Conventions

monorepo：`apps/api/src/...`、`packages/contracts/src/...`、repo 根的 `asyncapi.yaml`。

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: 補齊本 feature 需要的相依與指令

- [X] T001 在 `apps/api/package.json` 新增相依 `mongodb`、`@nestjs/platform-express`、`dotenv`，以及 devDependency `tsx`、`@nestjs/cli`（`nest start` 需要，因 tsconfig 用 `emitDecoratorMetadata`，須走 tsc 而非 esbuild/tsx）
- [X] T002 在 `apps/api/package.json` 的 `scripts` 新增 `"start:dev": "nest start --watch"` 與 `"seed": "tsx src/scripts/seed.ts"`；新增 `apps/api/nest-cli.json`（指向 `tsconfig.build.json`）
- [X] T003 於 repo 根執行 `pnpm install` 安裝新相依並更新 `pnpm-lock.yaml`（依賴 T001、T002 同檔，須先完成）

**Checkpoint**: 相依就緒，可開始 Foundational。

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: 契約擴充（contract-first）與 NestJS／ws 共用骨架——所有 user story 的前提

**⚠️ CRITICAL**: 完成本相之前，任何 user story 不得開工

- [X] T004 [P] 擴充 `packages/contracts/src/events.ts`：新增 `Ping`、`SystemConnected`、`MachineSubscribed`、`Pong`、`SystemUnauthorized` 型別與 `ClientControlMessage`／`ServerControlMessage` 聯集（依 contracts/control-messages.contract.md），完成後 `pnpm --filter @flow-gatekeeper/contracts build` 以更新 dist 供 api 取用
- [X] T005 [P] 擴充 `asyncapi.yaml`：新增 `system/connected`、`machine/subscribed`、`pong`、`system/unauthorized`（server→client）與 `ping`（client→server）通道/訊息；確保 `pnpm contract:lint` 0 違規
- [X] T006 建立 `apps/api/src/modules/config/config.module.ts`（與 `config.service.ts`）：`import 'dotenv/config'` 載入 `apps/api/.env`，型別化讀取 `MOCK_TELEMETRY_INTERVAL_MS`(預設 50)、`WS_HEARTBEAT_MS`(預設 15000)、`WS_AUTH_SECRET`、`MONGO_URL`、`MONGO_DB`、`TELEMETRY_TTL_SECONDS`(預設 604800)
- [X] T007 建立 `apps/api/src/app.module.ts`：彙整 Config、MonitoringGateway、MockTelemetryService、HistoryService 等 provider（後續任務逐步補齊 provider 本體）
- [X] T008 改寫 `apps/api/src/main.ts`：`NestFactory.create(AppModule)` → `await app.listen(API_PORT)` → `app.get(MonitoringGateway).attach(app.getHttpServer())`；**保留 entry import 為 side-effect-free 的守衛**（`if (import.meta.url …)` 才啟動），使 001 的 `main.test.ts` smoke 仍通過（必要時同步調整該測試）
- [X] T009 建立 `apps/api/src/modules/websocket/monitoring.gateway.ts` 骨架：`attach(server)` 以 `new WebSocketServer({ server, path: '/ws' })`；維護 `clients: Map<ClientId, WebSocket>` 與 `subscriptions: Map<ClientId, Set<string>>`；連線時以 `randomUUID()` 配 clientId 並送 `system/connected`；`close` 事件清理 maps；公開 `send(clientId, payload)` 方法（003 relay 銜接點，FR-015）

**Checkpoint**: 契約已擴充、API 可啟動並接受 ws 連線、連線/斷線基本生命週期就緒。

---

## Phase 3: User Story 1 - 依訂閱接收高頻機台遙測 (Priority: P1) 🎯 MVP

**Goal**: 客戶端以有效授權訂閱機台後，持續且只收到所訂閱機台的高頻遙測；不同訂閱互不串流。

**Independent Test**: 兩連線訂閱不相交集合，≥60 秒內各自只收到自身機台的 `TelemetryPoint[]`、
且出現狀態變化（對應 SC-001、SC-002）。

### Tests for User Story 1 (FR-016 必需)

- [X] T010 [P] [US1] 建立純函式 `apps/api/src/lib/subscription-filter.ts`：`filterPointsForSubscription(points, machineIds): TelemetryPoint[]`
- [X] T011 [P] [US1] 建立 `apps/api/src/lib/subscription-filter.test.ts`（Vitest）：斷言只回傳訂閱機台、空集合回傳空、不相交集合互不外洩（SC-001 決定性佐證）

### Implementation for User Story 1

- [X] T012 [US1] 建立 `apps/api/src/modules/telemetry/mock-telemetry.service.ts`：固定 5 台（`mixer-01`/`press-02`/`pack-03`/`oven-04`/`sorter-05`），`nextBatch(): TelemetryPoint[]` 以決定性規律產生並內含週期性 warning/critical 尖峰，門檻與欄位範圍依指南 §7.3
- [X] T013 [US1] 在 `monitoring.gateway.ts` 實作訊息分派：`machine/subscribe`（先以 `WS_AUTH_SECRET` 驗 token，通過則以新集合**取代**訂閱並回 `machine/subscribed`）、`ping`→`pong`；啟動 producer tick（`setInterval(MOCK_TELEMETRY_INTERVAL_MS)`）於 `publishTelemetry()` 內用 `filterPointsForSubscription` 對每個訂閱者送其機台的 `TelemetryPoint[]`
  - 註：`ping`→`pong`（FR-007a）與 token 驗證 happy-path（FR-003）為 US1/US3 共用基礎，於此先建；US3 的 T020/T021 再補伺服器端探活回收與「無效 token 拒絕／壞訊息忽略」行為
- [X] T014 [US1] 於 `app.module.ts` 完成 `MockTelemetryService` 注入並由 Gateway 取用；確認 `pnpm --filter @flow-gatekeeper/api typecheck` 通過

**Checkpoint**: US1 可獨立驗收——MVP 達成（依訂閱即時推送、互不串流）。

---

## Phase 4: User Story 2 - 遙測與異常事件可追溯地落地 (Priority: P2)

**Goal**: 全部機台每 tick 的遙測全量、與訂閱解耦地寫入時序歷史（可調 TTL）；轉入 warning/critical
時記一筆 errorlog（去重）；維修紀錄 seed 可重播。

**Independent Test**: 運行 ≥60 秒後查 Mongo：`telemetry` 有資料（含未被訂閱的機台）、`errorlogs`
筆數＝轉換次數、`maintenanceRecords` ≥1（對應 SC-003、SC-004）。

### Tests for User Story 2 (FR-016 必需)

- [X] T015 [P] [US2] 建立純函式 `apps/api/src/lib/errorlog-transition.ts`：`detectErrorTransitions(points, lastState): ErrorLogDoc[]`（僅「轉入 warning/critical」產生，回傳更新後 lastState）
- [X] T016 [P] [US2] 建立 `apps/api/src/lib/errorlog-transition.test.ts`（Vitest）：斷言連續同狀態不重複、healthy 轉入不記錄、warning↔critical 轉換各記一筆（SC-003 去重佐證）

### Implementation for User Story 2

- [X] T017 [US2] 建立 `apps/api/src/modules/history/history.service.ts`：`onModuleInit` 連 Mongo 並 `ensureCollections()`（`telemetry` time-series + `expireAfterSeconds=TELEMETRY_TTL_SECONDS`；`errorlogs` index `{machineId:1,timestamp:-1}`；`maintenanceRecords` index `{machineId:1,performedAt:-1}`）；`persistBatch(points)`：`insertMany` 全部機台遙測（`ordered:false`）+ 用 `detectErrorTransitions` 寫 errorlogs；落地錯誤 `catch` 並以 Logger `error` 記錄（不丟出，FR-010/FR-017）
- [X] T018 [US2] 於 `monitoring.gateway.ts` 的 `publishTelemetry()` 末端加入 `void this.history.persistBatch(points)`（fire-and-forget，與推送解耦；落地不得 await 阻塞 cadence，SC-008）
- [X] T019 [US2] 建立 `apps/api/src/scripts/seed.ts`：`maintenanceRecords` `deleteMany({})` 後 `insertMany([...])` 種入示範維修紀錄（決定性、可重播；`pnpm --filter @flow-gatekeeper/api seed` 可跑）

**Checkpoint**: US1 + US2 皆可獨立驗收——即時推送 + 可追溯歷史。

---

## Phase 5: User Story 3 - 連線存活偵測與離線清理 (Priority: P3)

**Goal**: 伺服器端心跳探活回收「半死」連線；無效授權被拒；無法解析訊息安全忽略。

**Independent Test**: 送 `ping` 得 `pong`；無效 token 訂閱得 `system/unauthorized` 且不建立訂閱；
強制中斷連線後於 ≤2×`WS_HEARTBEAT_MS` 內訂閱被清理（對應 SC-005、SC-006）。

### Implementation for User Story 3

- [ ] T020 [US3] 在 `monitoring.gateway.ts` 實作伺服器端心跳：每 socket `isAlive` 旗標，protocol `pong` 事件置 true；`setInterval(WS_HEARTBEAT_MS)` 掃描，`isAlive` 為 false 者 `terminate()` 並清理 `clients`/`subscriptions`，否則置 false 後 `socket.ping()`（回收 ≤2×`WS_HEARTBEAT_MS`，FR-007b/FR-008/SC-005）
- [ ] T021 [US3] 強化 `handleMessage`：JSON 解析失敗或未知 `type` 安全忽略（FR-014）；`machine/subscribe` token 無效時回 `system/unauthorized` 且**不**建立/變更訂閱（FR-003/SC-006）
- [ ] T022 [US3] 補齊 FR-017 生命週期記錄（Nest `Logger`）：連線建立（含 clientId）、連線中斷（含心跳逾時回收，標原因）、授權失敗——分 `log`/`warn` 等級，跨 `monitoring.gateway.ts`

**Checkpoint**: 三個 user story 皆可獨立驗收。

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: 跨故事的驗證與品質門檻

- [ ] T023 [P] 於 repo 根執行 `pnpm contract:lint`、`pnpm typecheck`、`pnpm lint` 並修正任何問題（contracts 新型別、asyncapi 擴充、api strict TS 無 `any`）
- [ ] T024 [P] 執行 `pnpm --filter @flow-gatekeeper/api test`，確認 T011、T016 兩支實際單元測試通過（FR-016/SC-007）
- [ ] T025 依 `quickstart.md` 跑場景 1–3 手動驗收（SC-001、SC-002、SC-003、SC-004、SC-005、SC-006、SC-008）
- [ ] T026 驗證 FR-017：實際觀察 log 中出現連線/斷線（含逾時回收）/授權失敗/落地錯誤四類事件

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: 無相依，立即可開始
- **Foundational (Phase 2)**: 依賴 Setup 完成——**阻擋所有 user story**
- **User Stories (Phase 3–5)**: 皆依賴 Foundational 完成
  - 因共用同一個 Gateway 檔，本 feature 建議**依優先序 P1 → P2 → P3** 進行（非平行多人）
- **Polish (Phase 6)**: 依賴所有目標 user story 完成

### User Story Dependencies

- **US1 (P1)**: Foundational 後即可開始；為 MVP，無對其他故事的相依
- **US2 (P2)**: 需 US1 的 producer tick 存在（T018 掛在 `publishTelemetry`）；但其驗收（歷史落地/errorlog/seed）獨立可測
- **US3 (P3)**: 在 Foundational 連線骨架 + US1 訊息分派之上增補心跳/拒絕/忽略；驗收獨立可測

### Within Each User Story

- 純函式測試（T011、T016）可與其對應純函式（T010、T015）一起完成，先寫測試再實作
- model/service 先於整合：MockTelemetry/History service 先於掛入 Gateway（T013/T018）

### Parallel Opportunities

- T004、T005 可平行（contracts vs asyncapi，不同檔）
- T010+T011（filter 純函式與測試）與 T015+T016（transition 純函式與測試）各自為獨立檔案，可平行
- T023、T024 可平行（lint/typecheck vs 單元測試）
- 同一檔 `monitoring.gateway.ts` 的 T009→T013→T018→T020→T021→T022 **不可平行**（同檔，須依序）

---

## Parallel Example: Foundational 契約擴充

```bash
# 同時進行（不同檔）：
Task: "擴充 packages/contracts/src/events.ts 控制訊息型別 + build"   # T004
Task: "擴充 asyncapi.yaml 控制訊息通道並通過 spectral lint"          # T005
```

## Parallel Example: 純函式 + 測試

```bash
# US1 與 US2 的純函式/測試彼此獨立，可平行：
Task: "subscription-filter.ts + subscription-filter.test.ts"   # T010 + T011
Task: "errorlog-transition.ts + errorlog-transition.test.ts"   # T015 + T016
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. 完成 Phase 1 Setup
2. 完成 Phase 2 Foundational（契約擴充 + ws 骨架，阻擋所有故事）
3. 完成 Phase 3 US1
4. **STOP & VALIDATE**：用 quickstart 場景 1 獨立驗收（依訂閱推送、互不串流）
5. 即可作為可展示 MVP

### Incremental Delivery

1. Setup + Foundational → 地基就緒
2. US1 → 場景 1 驗收 → MVP demo
3. US2 → 場景 3 驗收（歷史/errorlog/seed）
4. US3 → 場景 2 驗收（心跳/拒絕/清理）
5. Polish → 全工件 lint/typecheck/test + 手動驗收

### Phase 化遞交（憲章/ CLAUDE.md）

`/speckit-implement` 期間每完成一個 Phase 即勾選並 commit，標題標記 phase；大 phase（如
Foundational）可依「契約擴充 / app 骨架 / gateway 骨架」拆成數個同 phase commit。

---

## Notes

- [P] = 不同檔、無相依；同檔任務一律依序
- `monitoring.gateway.ts` 為跨多相的中心檔，務必依 T009→T013→T018→T020→T021→T022 順序演進
- contract-first：T004/T005 MUST 先於任何 Gateway 行為實作
- 落地 fire-and-forget，MUST NOT await 阻塞推送 cadence（FR-010/SC-008）
- 每個 task 或邏輯群組完成後 commit；於各 checkpoint 可停下獨立驗收
