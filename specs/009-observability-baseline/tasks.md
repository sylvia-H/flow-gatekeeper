# Tasks: Observability Baseline（可觀測性基線）

**Input**: Design documents from `/specs/009-observability-baseline/`

**Prerequisites**: [plan.md](./plan.md)、[spec.md](./spec.md)（含 2026-07-20 checklist 回補修訂）、[research.md](./research.md)、[data-model.md](./data-model.md)、[contracts/](./contracts/)、[quickstart.md](./quickstart.md)

**Tests**: 包含測試任務。依 research R9 與憲章「測試門檻」，本 feature 要求 **6 個純函式單測**：`resolveLogLevel`、`resolveMetricsInterval`、`aggregateHealth`、`mergeMetrics`、`summarizeLatency`、`hitRate`。零回歸（SC-007）不寫整合測試，改以 quickstart 逐項對照演練承接（與 007／008 一致）。

**Organization**: 依 User Story 分 phase，每個 phase 可獨立實作與驗收。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 可平行（不同檔案、無未完成相依）
- **[Story]**: 對應 spec 的 User Story（US1–US4）
- 每項任務都標明確切檔案路徑

## Path Conventions

pnpm monorepo：`apps/{api,worker,web}` + `packages/{contracts,shared}`（見 plan.md §Project Structure）。

---

## ⚠️ 全程硬約束（每個 phase 都適用）

1. **FR-012 零回歸**：除日誌管道替換與明文新增的 `/healthz`、`system/metrics` 外，MUST NOT 改動任何既有寫入語意或即時行為。
2. **`fatal.ts` 是 FR-004 的唯一例外**：MUST NOT 改為 pino（contracts/log-fields.md §7）。
3. **worker MUST NOT 直接 emit ws**（憲章 IV）：指標一律走 Redis key → api 合併 → Gateway 廣播。
4. **pino MUST NOT 進入 web bundle**：`packages/shared/src/index.ts` MUST NOT re-export `./logging`。
5. **FR-009**：高頻路徑（`publishTelemetry`、`persistBatch`）正常路徑 MUST NOT 產生任何日誌。
6. **祕密不入日誌**：`WS_AUTH_SECRET`、`GEMINI_API_KEY` 絕不出現在任何日誌欄位。

---

## Phase 1: Setup（共用基礎設施）

**Purpose**: 相依、子路徑 export 與環境變數登錄——所有後續 phase 的前置。

- [ ] T001 在 `packages/shared/package.json` 新增 `pino` 為 dependency、`pino-pretty` 為 devDependency（pino-pretty MUST NOT 進 production image，見 research R3）
- [ ] T002 在 `packages/shared/package.json` 的 `exports` 新增子路徑 `"./logging"`（指向 `./dist/logging/index.js` 與對應 `.d.ts`），並確認 `packages/shared/tsconfig.json` 的輸出結構可產生該路徑
- [ ] T003 執行 `pnpm install` 產生 lockfile，並驗證 `@flow-gatekeeper/shared/logging` 可自 `apps/api` 與 `apps/worker` 解析
- [ ] T004 [P] 在根目錄 `.env.example` 登錄六個新環境變數與預設值：`LOG_LEVEL`(info)、`LOG_PRETTY`(由 NODE_ENV 推導)、`METRICS_INTERVAL_MS`(60000，**下限 5000，低於下限回退預設**)、`METRICS_LOG_LEVEL`(info，獨立於 LOG_LEVEL)、`HEALTH_PROBE_TIMEOUT_MS`(2000)、`VITE_METRICS_PANEL`(dev true / prod false)（FR-016）
- [ ] T005 [P] 在 `apps/api/.env.example` 登錄 api 適用的五個變數（除 `VITE_METRICS_PANEL`）及其用途註解（FR-016）
- [ ] T006 [P] 在 `apps/worker/.env.example` 登錄 worker 適用的四個變數（`LOG_LEVEL`、`LOG_PRETTY`、`METRICS_INTERVAL_MS`、`METRICS_LOG_LEVEL`）及其用途註解（FR-016）

**Checkpoint**: 相依就緒、子路徑可解析、設定形狀已記錄。

---

## Phase 2: Foundational（阻塞性前置）

**Purpose**: 日誌欄位約定的單一來源。**所有 User Story 都依賴此 phase**。

**⚠️ CRITICAL**: 本 phase 未完成前，任何 User Story 不得開始。

- [ ] T007 在 `packages/shared/src/logging/level.ts` 實作純函式 `resolveLogLevel(env)`（未設定回 `info`、無法辨識的值回退 `info` 並回報需記警告，FR-003）、`resolvePretty(env)`（由 `NODE_ENV` 推導，`LOG_PRETTY` 可顯式覆寫）、`resolveMetricsLogLevel(env)`（預設 `info`，獨立於 `LOG_LEVEL`）
- [ ] T008 [P] 在 `packages/shared/src/logging/level.test.ts` 撰寫單測：預設值、非法值回退、`LOG_PRETTY` 由 `NODE_ENV` 推導與顯式覆寫（research R9）
- [ ] T009 [P] 在 `packages/shared/src/logging/interval.ts` 實作純函式 `resolveMetricsInterval(env)`：預設 60000ms，**下限 5000ms**，低於下限的設定值 MUST **回退至預設 60000ms**（而非 clamp 到 5000），確保與 FR-009 相容（FR-008／research R11）
- [ ] T010 [P] 在 `packages/shared/src/logging/interval.test.ts` 撰寫單測：未設定回 60000、`4999` 回退 60000、`5000` 原樣通過（邊界）、非數值／負數回退、合法值原樣通過
- [ ] T011 在 `packages/shared/src/logging/index.ts` 實作 `createLogger(service)` 工廠：根 logger 綁定 `service` 欄位與 `LOG_LEVEL`、pretty 模式**動態載入** `pino-pretty`、提供 `child(context)` 與**專屬 metrics child logger**（level 由 `METRICS_LOG_LEVEL` 獨立釘定，不受 `LOG_LEVEL` 影響，SC-005／contracts/log-fields.md §5）
- [ ] T011a 在 `createLogger` 內落地 FR-003 的警告**輸出**（不只回報）：當 `resolveLogLevel` 判定收到非法 `LOG_LEVEL` 值時，MUST 於 logger 建立後立即輸出一則 `warn`，載明收到的非法值與實際採用的等級；MUST NOT 拋錯或中止行程。同理適用 `resolveMetricsInterval` 的下限回退（記一則 `warn`）
- [ ] T012 在 `packages/shared/src/index.ts` 加入明確註解：**MUST NOT** `export * from "./logging/*"`，理由為 `apps/web` 相依本 package，根 export 會把 pino 拉進瀏覽器 bundle（research R10）

**Checkpoint**: 日誌欄位約定有單一來源，US1 可開始。

---

## Phase 3: User Story 1 - 後端結構化日誌與關聯鍵（Priority: P1）🎯 MVP

**Goal**: api 與 worker 的所有服務日誌轉為統一結構化格式，帶 `service`／`context`／關聯鍵，並可經 `LOG_LEVEL` 過濾。

**Independent Test**: 觸發一筆診斷，只用日誌以該次 `jobId` 串起「api 接收 → worker 處理 → 結果回傳」；再把 `LOG_LEVEL` 調為 `warn`，確認 info 級雜訊消失而錯誤仍在（quickstart 場景 1、2）。

### Implementation for User Story 1

- [ ] T013 [US1] 在 `apps/api/src/logging/pino-logger.service.ts` 實作 Nest `LoggerService` adapter：把 Nest 的 `log/error/warn/debug/verbose` 映射到 pino 對應等級，並將 Nest 的 context 參數原樣帶入 `context` 欄位（contracts/log-fields.md §3）
- [ ] T014 [US1] 在 `apps/api/src/main.ts` 以 `app.useLogger(...)` 注入 T013 的 adapter——api 現況已全面使用 Nest 內建 `Logger`（6 處），**不逐檔改呼叫點**即整批轉為結構化輸出（research R1）
- [ ] T015 [US1] 在 `apps/api/src/modules/config/config.service.ts` 新增 `LOG_LEVEL`／`LOG_PRETTY` 的讀取，沿用既有設定讀取慣例
- [ ] T016 [US1] 在 `apps/worker/src/main.ts` 以 `createLogger("worker")` 取代手寫的 `log(level, msg)` helper，移除該 helper 本體
- [ ] T017 [US1] 將 `apps/worker/src/main.ts` 約 20 個呼叫點改為結構化形式 `logger.info({ jobId, machineId }, "…")`，長流程以 `logger.child({ jobId })` 綁定；**MUST 移除訊息字串中內嵌的關聯鍵**（如 `` `job active: ${jobId}` `` → `{ jobId }` + `"job active"`，contracts/log-fields.md §2 規則 2）
- [ ] T018 [P] [US1] 在 `apps/api/src/modules/websocket/monitoring.gateway.ts` 為連線相關事件補上 `clientId` 關聯鍵欄位，機台相關事件補 `machineId`
- [ ] T019 [P] [US1] 在 `apps/api/src/modules/jobs/jobs.service.ts`、`apps/api/src/modules/websocket/job-status-relay.service.ts`、`apps/api/src/modules/websocket/ai-stream-relay.service.ts` 為診斷相關事件補上 `jobId` 關聯鍵欄位（使 SC-002 的跨行程串接成立）
- [ ] T020 [P] [US1] 在 `apps/worker/src/lib/fatal.ts` 加一行註解，指向 `specs/009-observability-baseline/contracts/log-fields.md §7`，說明此處**刻意**維持同步純文字 stderr 寫出、是 FR-004 的唯一例外，MUST NOT 被後續 review 當作漏改而修正（**行為不變，只加註解**）
- [ ] T021 [P] [US1] 在 `apps/api/src/scripts/seed.ts` 與 `apps/worker/src/ai/smoke-gemini.ts` 各加一行註解，說明其為一次性 CLI 工具、依 FR-004／SC-001 的範圍界定維持人類可讀輸出（**不改為結構化**）
- [ ] T022 [US1] 檢視 `apps/api/src/modules/websocket/monitoring.gateway.ts` 的 `publishTelemetry` 與 `apps/api/src/modules/history/history.service.ts` 的 `persistBatch`，確認**正常路徑零日誌**（僅錯誤路徑可記 `error`），滿足 FR-009 的可驗證門檻
- [ ] T023 [US1] 執行 `pnpm -r typecheck`、`pnpm -r lint`、`pnpm -r test`，並手動確認 dev 為 pretty、`NODE_ENV=production` 為逐行合法 JSON（FR-001 判準）

**Checkpoint**: US1 可獨立驗收——quickstart 場景 1、2 應全數通過。**此即 MVP。**

---

## Phase 4: User Story 2 - api 健康端點反映依賴狀態（Priority: P2）

**Goal**: `GET /healthz` 以二態（200／503）回報 api 與 Redis／Mongo 的即時連通狀態，並讓 008 的容器 healthcheck 改由它消費。

**Independent Test**: 系統就緒後查詢得 200；停掉 Redis 或 Mongo，5 秒內再查得 503 且 body 指出失聯依賴；恢復後轉回 200（quickstart 場景 3、3.5）。

### Implementation for User Story 2

- [ ] T024 [P] [US2] 在 `apps/api/src/lib/health-aggregate.ts` 實作純函式 `aggregateHealth(probes)`：全 `up` → `healthy`、任一 `down` → `unhealthy`；並保證不變量「`unhealthy` 時 body 至少有一個 `down`」（data-model E2）
- [ ] T025 [P] [US2] 在 `apps/api/src/lib/health-aggregate.test.ts` 撰寫單測：全 up、單一 down、**多重 down 須全部列出**、不變量檢核（research R9）
- [ ] T026 [US2] 在 `apps/api/src/modules/config/config.service.ts` 新增 `HEALTH_PROBE_TIMEOUT_MS` 讀取（預設 2000）
- [ ] T027 [US2] 在 `apps/api/src/modules/history/history.service.ts` 新增 `ping()` 方法暴露 Mongo 探測能力（`db.command({ ping: 1 })`）；`db` 未就緒時回 `down` 而非拋錯——此即 spec Edge Case「api 啟動中、依賴尚未就緒」的落地
- [ ] T028 [US2] 在 `apps/api/src/modules/health/health.service.ts` 實作探測：Redis `PING` 使用**專屬 ioredis 連線**（憲章 IV 連線分離，MUST NOT 借用 relay 的 subscriber）、Mongo 複用 `HistoryService.ping()`；兩者 `Promise.all` 併行、各自以 `Promise.race` 套用逾時；**逾時或任何例外一律轉為 `{ status: "down", error }`，MUST NOT 向上拋錯**（FR-007／contracts/health-endpoint.md §4）
- [ ] T029 [US2] 在 `apps/api/src/modules/health/health.controller.ts` 實作 `GET /healthz`：**免認證**、`Cache-Control: no-store`、每次請求即時探測不快取、healthy 回 200／unhealthy 回 503，body 依 contracts/health-endpoint.md §3 形狀
- [ ] T030 [US2] 建立 `apps/api/src/modules/health/health.module.ts` 並在 `apps/api/src/app.module.ts` 掛載，與既有 `config`／`history`／`jobs`／`websocket` 同層同構
- [ ] T031 [US2] 改寫 `apps/api/src/healthcheck.ts`：由現行「連 `ws://127.0.0.1:${API_PORT}/ws` 等 `system/connected`」改為「`GET http://127.0.0.1:${API_PORT}/healthz`，200 → `exit 0`、其餘／錯誤／逾時 → `exit 1`」；沿用既有的 `API_PORT`（預設 3000）讀取，**MUST 只用 node 內建 `http`**（不引入 wget／curl）、自我逾時維持 4000ms；`docker-compose.yml` 的 `test` 指令**不需變更**（仍為 `["CMD","node","dist/healthcheck.js"]`）。**MUST 一併改寫該檔的 doc 註解**——現有理由「api 無任何 GET 路由，探 HTTP 必得 404」在 `/healthz` 落地後即不成立，須改為「009 起以 `/healthz` 取代握手探活，涵蓋 Redis／Mongo 連通深度」，MUST NOT 留下自相矛盾的敘述（FR-006a／research R4a／contracts/health-endpoint.md §6）
- [ ] T032 [P] [US2] 在 `apps/api/src/lib/health-probe.ts` 檔頭加註「008 `/ws` 探活方式的歷史產物，009 起 healthcheck 改走 `/healthz`」；**保留該檔與其既有測試**（純函式、無副作用，移除只會一併刪掉既有測試，收益為零）
- [ ] T033 [US2] 執行 `pnpm -r typecheck`、`pnpm -r lint`、`pnpm -r test`，並依 quickstart 場景 3 手動驗證停／啟 Redis 與 Mongo 的雙向轉換與回應不阻塞

**Checkpoint**: US1 + US2 皆可獨立運作；容器就緒判定已具備依賴深度。

---

## Phase 5: User Story 3 - 關鍵指標週期摘要入日誌 + dev 面板（Priority: P3）

**Goal**: 四項關鍵指標跨 api／worker 合併為一則週期摘要入日誌，並經新增的 `system/metrics` ws 訊息送到 web 唯讀 dev 面板。

**Independent Test**: 承載遙測與至少兩次同機台診斷後，只讀日誌即見四項齊全的週期摘要；開啟 dev 面板見同組指標最新快照且與日誌一致（quickstart 場景 4、4.1、5、6）。

### 契約先行（憲章 II／III：先改契約，再改三端）

- [ ] T034 [US3] 在 `packages/contracts/src/events.ts` 新增 `WorkerMetrics` 與 `SystemMetrics` 型別，並納入 `ServerControlMessage` 聯集；依「型別來源分層」**以 TS 型別定義、不引入 Zod**（與既有 `system/connected`／`job/status` 一致，contracts/metrics-summary.md §1）
- [ ] T035 [US3] 在根目錄 `asyncapi.yaml` 新增 `system/metrics` 訊息定義，與 T034 的型別逐欄位一致（FR-008a／憲章 II）

### 純函式與單測（可平行）

- [ ] T036 [P] [US3] 在 `apps/worker/src/lib/latency.ts` 實作 `summarizeLatency(samples)`：回傳 `{ count, avgMs, p95Ms, maxMs }`；**空樣本時各統計值回 `null`（不是 0）**（data-model E3 不變量）
- [ ] T037 [P] [US3] 在 `apps/worker/src/lib/latency.test.ts` 撰寫單測：空樣本回 null、單一樣本、p95 邊界（research R9）
- [ ] T038 [P] [US3] 在 `apps/worker/src/lib/hit-rate.ts` 實作 `hitRate(hits, misses)`：`hits / (hits + misses)`；**分母為 0 時回 `null`（不是 0）**（FR-008／data-model E3）
- [ ] T039 [P] [US3] 在 `apps/worker/src/lib/hit-rate.test.ts` 撰寫單測：分母為 0 回 null、比值正確、窗內計數不受累計污染（research R9）
- [ ] T040 [P] [US3] 在 `apps/api/src/lib/metrics-merge.ts` 實作 `mergeMetrics(apiPart, workerRaw)`：對 key 不存在、`JSON.parse` 失敗、欄位缺漏、型別不符**一律降級為 `worker: null` 並照常回傳完整結構，MUST NOT 拋錯**（FR-008 降級輸出／spec Edge Case「指標蒐集自身失敗」）
- [ ] T041 [P] [US3] 在 `apps/api/src/lib/metrics-merge.test.ts` 撰寫單測：worker 快照缺席／過期／畸形 JSON／欄位型別不符時，皆回完整結構且 `worker` 為 `null`，api 那兩項指標不受影響（research R9）

### worker 側

- [ ] T042 [US3] 在 `apps/worker/src/lib/metrics-collector.ts` 實作累加器與週期結算：`latencySamples` 為**固定上限 1000 的環形緩衝**、`cacheHits`／`cacheMisses` 窗內計數；每 `METRICS_INTERVAL_MS` 結算後 `SET metrics:worker <json> EX <3×間隔秒數>`、同時以 `context: "metrics"` 記入 worker 自身日誌，並將累加器歸零（data-model E4／E5、research R5）。**MUST NOT 讀寫、覆寫或改動 007 的 `worker:heartbeat` key**——兩者各自獨立、不同命名空間、不同 TTL、不同消費者（FR-010／data-model E4）
- [ ] T043 [US3] 在 `apps/worker/src/main.ts` 接線：於 `ai.streamDiagnosis` 呼叫**外圍**加計時、於 `replyCached()` 加命中／未命中計數、於 `bootstrap()` 啟動 collector 並於關閉路徑清除 timer（**關閉時不輸出未滿一窗的殘窗摘要**，data-model E3）；**MUST 為純觀測，不改任何控制流**（憲章 V）

### api 側

- [ ] T044 [US3] 在 `apps/api/src/modules/jobs/jobs.service.ts` 暴露 `queue.getJobCounts()` 的讀取方法，供指標收集器取得 `waiting`／`active`／`failed` **瞬時值**
- [ ] T045 [US3] 在 `apps/api/src/modules/websocket/monitoring.gateway.ts` 暴露當前連線數（瞬時值）與一個 `broadcastMetrics(payload)` 方法，廣播給**所有已連線 client**（與 `machine/subscribe` 訂閱狀態無關，contracts/metrics-summary.md §2）
- [ ] T046 [US3] 在 `apps/api/src/modules/metrics/metrics.service.ts` 實作週期結算：取 queue counts + ws 連線數、`GET metrics:worker`（非破壞性，不 `DEL`）、呼叫 `mergeMetrics` 合併，以**專屬 metrics child logger** 輸出一則摘要並經 T045 廣播；蒐集失敗時該項標記不可用、**MUST NOT 中斷摘要或影響主流程**
- [ ] T047 [US3] 建立 `apps/api/src/modules/metrics/metrics.module.ts` 並在 `apps/api/src/app.module.ts` 掛載；於 `onModuleDestroy` 清除 timer
- [ ] T048 [US3] 在 `apps/api/src/modules/config/config.service.ts` 新增 `METRICS_INTERVAL_MS`（經 T009 的 `resolveMetricsInterval` 套用下限）與 `METRICS_LOG_LEVEL` 讀取

### web 側

- [ ] T049 [P] [US3] 在 `apps/web/src/domains/monitoring/stores/metrics.store.ts` 建立 Pinia store 保存最新快照與其 `collectedAt`，並提供新鮮度判斷：**以 payload 的 `collectedAt` 為基準，超過 2 × `METRICS_INTERVAL_MS`（預設 120 秒）未更新即視為過期**（FR-008a／contracts/metrics-summary.md §2.1）；**MUST NOT 與 `metrics:worker` 的 3× TTL 對齊**（不同層問題，research R11）
- [ ] T050 [US3] 在 `apps/web/src/domains/monitoring/lib/ws-message.ts` 新增 `system/metrics` 分派：**直接寫入 metrics store**；並在該處加註解說明——此為 60s 一則的低頻控制訊息，**MUST NOT 進入 `machine/data` 的 rAF buffer 路徑**，否則會延遲顯示並污染背壓比值量測（憲章 IV 邊界，contracts/metrics-summary.md §3）
- [ ] T051 [P] [US3] 在 `apps/web/src/shared/components/MetricsPanel.vue` 建立**唯讀** dev 面板：**預設收合**、展開後顯示四項指標與快照新鮮度、超過 T049 的過期門檻時以**過期樣態**呈現（數值可留但 MUST NOT 看起來像即時值）；顏色／圓角／間距一律用 `design-spec.md` 具名 token、沿用 `BackpressureBadge.vue` 的視覺語彙，**MUST NOT 散落 hex**；**MUST NOT 提供任何觸發後端動作的控制項**（FR-008a／憲章 II）
- [ ] T052 [US3] 在 `apps/web/src/shared/components/TopBar.vue` 依 `VITE_METRICS_PANEL` 旗標掛載面板（dev 預設開、production build 預設關）；旗標關閉時 MUST NOT 渲染，使首屏與改動前逐項一致
- [ ] T053 [US3] 執行 `pnpm -r typecheck`、`pnpm -r lint`、`pnpm -r test`；並執行 `pnpm --filter @flow-gatekeeper/web build` 後以 `Select-String -Path apps/web/dist/assets/*.js -Pattern "pino" -SimpleMatch` 確認**無任何命中**（research R10／quickstart 6.1）

**Checkpoint**: US1–US3 皆可獨立運作；指標可從日誌與面板兩處判讀。

---

## Phase 6: User Story 4 - 有損寫入語意明文化（Priority: P3）

**Goal**: 把既有的有損寫入取捨從隱性變顯性，三處敘述一致且與程式行為相符。

**Independent Test**: 對照持久化程式註解、README 與 ADR-002 §6.4，三者對「可丟失什麼、何時可能重複」的描述一致；`git diff` 確認**未改動任何程式行為**（quickstart 場景 7）。

**⚠️ 本 phase MUST NOT 改動任何程式行為——只加註解與文件。**

- [ ] T054 [P] [US4] 在 `apps/api/src/modules/history/history.service.ts` 的 `persistBatch` 既有註解上**補上後果**：「API 崩潰時 in-flight batch 直接丟失（可丟失最後數秒 telemetry），此為 `ADR-002 §6.4` 明文接受的取捨」（research R8）
- [ ] T055 [P] [US4] 在 `apps/api/src/lib/errorlog-transition.ts` 的 `lastState` 去重邏輯補註解：「去重狀態存於行程內 Map，**重啟後首筆會重複寫入**；多實例下判斷會錯。見 `ADR-002 §6.4`」（research R8）
- [ ] T056 [US4] 在 `README.md` 新增「已宣告的取捨」小節，載明兩項有損語意與升級路徑（寫入前先進佇列再批次落庫），並引用 `ADR-002 §6.4`；三處敘述 MUST 指向同一份事實、不得各自表述（FR-011／SC-006）
- [ ] T057 [US4] 以 `git diff` 確認本 phase 僅見註解與文件變更、**無任何程式行為改動**（quickstart 場景 7 最後一項判準）

**Checkpoint**: 四個 User Story 全數完成。

---

## Phase 7: Polish、跨 Feature 回補與驗收

**Purpose**: FR-015 的六項真實來源回補、quickstart 逐項驗收、零回歸對照。

### 跨 Feature 回補（FR-015）⚑ 收尾前 MUST 完成

- [ ] T058 回補 `docs/Flow-Gatekeeper-SDD-完整實作指南.md` 四處：**§15.2／§15.3** 四項 clarify 標記已定案並填入答案、「要做」清單補上 web dev 面板；**§14（008 章節）** api healthcheck 由 `/ws` 握手改為 `/healthz` 的現況描述；**§15.4** 驗收清單補「web dev 面板」與「二態 200／503」判準。**MUST NOT 重寫歷史**——決策背景與由來敘述保留（必要時改過去式並標註現況出處）
- [ ] T059 [P] 回補 `docs/adr-002-productionization-scope.md` §6.4：「落地」欄位由「Feature 009 將寫入…」改為已落地的現況描述，原決策敘述保留
- [ ] T060 [P] 回補 `README.md`：新增六個環境變數的說明與預設值、dev 指標面板開關（`VITE_METRICS_PANEL`）說明（「已宣告的取捨」小節已於 T056 完成）
- [ ] T061 全域搜尋確認無殘留矛盾敘述：搜尋 `/ws` 握手探活、「web 完全不在範圍」、「留待 clarify」等舊表述，確認全案 MUST NOT 殘留指向舊決策的描述（FR-015）

### 驗收（quickstart 逐項）

- [ ] T062 執行 quickstart 場景 1–7 並逐項勾選：結構化日誌與 `LOG_LEVEL`（SC-001、SC-005）、非法 `LOG_LEVEL` 的回退警告（FR-003／T011a）、jobId 串接（SC-002）、健康端點雙向轉換與容器 healthcheck 切換（SC-003）、**容器內三端日誌為合法 JSON——即證明 `pino` 已隨 `packages/shared` 進入 production image**（場景 3.5）、指標摘要與 worker 缺席降級（SC-004）、摘要不被 `LOG_LEVEL` 濾掉（SC-005）、dev 面板含**過期樣態**（SC-004 後半／FR-008a）、有損語意明文化（SC-006）
- [ ] T063 執行 quickstart **場景 8 零回歸對照 8.1–8.9**（SC-007）：遙測推送 cadence、背壓比值、streaming token 順序與里程碑、快取命中、訂閱與授權、優雅關閉、**worker 致命語意（`WORKER_CHAOS` 演練，確認致命訊息仍為純文字同步寫出、exit 1、監督者重啟）**、持久化文件形狀、**007 `worker:heartbeat` key／TTL／消費者未被影響（FR-010）**。**8.7 是最容易誤傷之處，MUST 特別確認**
- [ ] T064 執行 quickstart 場景 9：`pnpm -r typecheck`、`pnpm -r lint`、`pnpm -r test` 三項全綠，且 **6 個**純函式測試皆存在並通過（`resolveLogLevel`、`resolveMetricsInterval`、`aggregateHealth`、`mergeMetrics`、`summarizeLatency`、`hitRate`）
- [ ] T065 勾選 `specs/009-observability-baseline/checklists/requirements.md` 與 `quickstart.md` 的驗收總表（SC-001 ~ SC-007 全數 ☑）
- [ ] T066 勾選本 `tasks.md` 全部任務，並將 `spec.md` 的 Status 由「待 `/speckit-implement`」更新為已完成

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 Setup**：無相依，可立即開始
- **Phase 2 Foundational**：依賴 Phase 1（需要 pino 相依與子路徑 export）——**阻塞所有 User Story**
- **Phase 3 US1 (P1)**：依賴 Phase 2。**MVP 邊界**
- **Phase 4 US2 (P2)**：依賴 Phase 2。健康端點的日誌以 US1 的 logger 承載，但端點本身可獨立驗收
- **Phase 5 US3 (P3)**：依賴 Phase 2。指標摘要以 US1 的 logger 為輸出載體
- **Phase 6 US4 (P3)**：**只依賴 Phase 1**（純註解與文件），與其他 story 完全無耦合，可隨時插入
- **Phase 7 Polish**：依賴所有欲交付的 story 完成

### User Story Dependencies

- **US1 (P1)**：Foundational 後即可開始，無其他 story 相依
- **US2 (P2)**：Foundational 後即可開始。與 US1 無程式相依（僅共用 logger）
- **US3 (P3)**：Foundational 後即可開始。與 US1／US2 無程式相依
- **US4 (P3)**：**零相依**——純文件工作，可與任何 phase 並行

### Within Each User Story

- 契約先行：T034／T035（契約 + AsyncAPI）MUST 在 US3 的三端實作之前
- 純函式與單測先於使用它們的 service（T024/T025 → T028；T036–T041 → T042/T046）
- Service 先於 controller／module 掛載
- worker 與 api 的指標實作可平行，但 T046 的合併依賴 T040（`mergeMetrics`）與 T042（worker 已寫入快照）

### Parallel Opportunities

- **Phase 1**：T004、T005、T006（三個不同的 `.env.example`）可平行
- **Phase 2**：T008、T009、T010 可平行（T009／T010 與 T007／T008 分屬不同檔案）
- **Phase 3**：T018、T019、T020、T021 可平行（分屬 gateway／jobs 與 relay／fatal／腳本，四組不同檔案）
- **Phase 4**：T024／T025 可與 T032 平行
- **Phase 5**：T036–T041 六個純函式與單測全部可平行；T049 與 T051 可平行
- **Phase 6**：T054、T055 可平行（不同檔案）
- **Phase 7**：T059、T060 可平行（T058 三處同屬指南一檔，MUST 串行）
- **跨 phase**：US4（Phase 6）與 US1–US3 可完全並行

---

## Parallel Example: User Story 3 的純函式群

```bash
# 六個純函式與其單測分屬六個檔案，可一次全部展開：
Task: "在 apps/worker/src/lib/latency.ts 實作 summarizeLatency"
Task: "在 apps/worker/src/lib/latency.test.ts 撰寫單測"
Task: "在 apps/worker/src/lib/hit-rate.ts 實作 hitRate"
Task: "在 apps/worker/src/lib/hit-rate.test.ts 撰寫單測"
Task: "在 apps/api/src/lib/metrics-merge.ts 實作 mergeMetrics"
Task: "在 apps/api/src/lib/metrics-merge.test.ts 撰寫單測"
```

---

## Implementation Strategy

### MVP First（僅 User Story 1）

1. 完成 Phase 1 Setup
2. 完成 Phase 2 Foundational（**關鍵——阻塞所有 story**）
3. 完成 Phase 3 US1
4. **STOP and VALIDATE**：跑 quickstart 場景 1、2
5. 此時「監控台自己不可被監控」最核心的缺口已補上，可獨立展示

### Incremental Delivery

1. Setup + Foundational → 地基就緒
2. + US1 → 結構化日誌與關聯鍵（**MVP**）
3. + US2 → 健康端點與容器就緒深度
4. + US3 → 指標摘要與 dev 面板
5. + US4 → 有損語意明文化（可隨時插入）
6. + Polish → 跨 feature 回補與零回歸驗收

### Phase-by-phase Commit（CLAUDE.md 規則）

每完成一個 phase：先就地驗證 → 在本檔勾選該 phase 任務 → 建立 commit，標題格式
`<type>(009): [Phase <n>: <名稱>] <中文描述>`。

**大 phase 拆細建議**（依主要開發大項，避免過度零碎）：

| Phase | 建議 commit 切分 | type |
| --- | --- | --- |
| 1 Setup | 相依與子路徑 export／環境變數登錄 | `build` / `docs` |
| 2 Foundational | 純函式與單測／logger 工廠 | `feat` |
| 3 US1 | api adapter 接線／worker log 轉換與關聯鍵／例外與豁免註記 | `feat` ×2 + `docs` |
| 4 US2 | health module 與端點／healthcheck 切換 | `feat` + `fix` |
| 5 US3 | 契約與 AsyncAPI／純函式群／worker 收集器／api 合併與廣播／web store 與面板 | `feat` ×5 |
| 6 US4 | 註解與 README 明文化 | `docs` |
| 7 Polish | 跨 feature 回補／驗收與勾選 | `docs` ×2 |

---

## Notes

- `[P]` = 不同檔案、無相依，可平行
- `[Story]` 標籤讓每項任務可追溯回 spec 的 User Story
- **本輪 tasks 已納入 2026-07-20 checklist 檢驗後的 spec 修訂**：新增的 **FR-006a**（T031）、**FR-015**（T058–T061）、**FR-016**（T004–T006）皆有對應任務；新增的兩個 Edge Case 分別落在 T027（api 啟動中）與 T040／T046（指標蒐集自身失敗）
- **`interval.ts` 的由來**：FR-008 的「間隔下限」是 checklist 收斂後新增的需求，故新增 `packages/shared/src/logging/interval.ts` 與其測試（T009／T010）。plan.md §Project Structure 與 research R9 已於 analyze 回補同步
- **2026-07-20 analyze 修補**（六項）：FR-003 的警告**輸出**補 T011a；間隔下限釘為 **5000ms**、面板過期門檻釘為 **2 × 間隔**（research R11，回填 spec／contracts §2.1／T009／T049）；FR-010 的 heartbeat 共存補 T042 禁令與 T063 對照項 8.9；容器內 pino 相依驗證併入 quickstart 場景 3.5／T062；測試數統一為 6；`unavailable` 措辭統一為 `worker: null`
- 每個 phase 結束前都跑 typecheck／lint／test，不把破綻帶進下一個 phase
- 絕不提交祕密（`.env`、API key、token）——只動 `.env.example`
