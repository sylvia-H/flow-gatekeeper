# Implementation Plan: Observability Baseline（可觀測性基線）

**Branch**: `009-Observability-Baseline` | **Date**: 2026-07-20 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/009-observability-baseline/spec.md`

---

## Summary

把「這個專案本身是監控台，但它自己不可被監控」這句話收掉——為 api／worker 補上可觀測性基線：
**pino 結構化日誌 + 關聯鍵**（US1）、**`GET /healthz` 二態依賴健康端點**（US2）、
**四項關鍵指標的週期摘要**（入日誌 + web dev 面板，US3）、**有損寫入語意明文化**（US4）。

技術路徑（詳見 [research.md](./research.md)）：

- **日誌**：pino。api 走 `LoggerService` adapter + `app.useLogger()`，因 api 已全面使用 Nest
  `Logger`，**無需逐檔改呼叫點**；worker 以 pino 取代手寫 `log()` helper。欄位約定收在
  `packages/shared/src/logging/`（**子路徑 export**，避免 pino 進入 web bundle）。
- **健康端點**：Redis `PING` + Mongo `{ping:1}` 併行探測、各自 2s 逾時；全 up→200 healthy、
  任一 down→503 unhealthy。連帶把 008 的容器 healthcheck 由 `/ws` 握手改為 `/healthz`
  ——這正是 008 clarify 明文劃歸 009 的交棒點。
- **指標**：四項指標分屬兩個 process。worker 每週期把自己那半寫入 Redis key `metrics:worker`
  （TTL = 3×間隔），api 讀取後與自身兩項合併，輸出一則四項齊全的摘要並經既有 Gateway 以新的
  `system/metrics` ws 訊息廣播給 web dev 面板。worker 缺席時降級為 `worker: null`，摘要照常輸出。
- **明文化**：`persistBatch` 註解、`lastState` 去重註解、README「已宣告的取捨」三處，
  引用 ADR-002 §6.4。

**零回歸是硬約束**（FR-012／SC-007）：除「日誌輸出管道」外不改任何寫入語意或即時行為。

---

## Technical Context

**Language/Version**: TypeScript 5.6（strict）、Node.js 20（ESM，`"type": "module"`）

**Primary Dependencies**：
- 新增：`pino`（`packages/shared` dependency）、`pino-pretty`（devDependency）
- 既有：NestJS 10、`ws` 8、BullMQ 5、ioredis 5、mongodb 6、Vue 3.5 + Pinia 2 + Vite 5

**Storage**: 無新增。Redis 新增一個暫態 key `metrics:worker`（TTL 180s）。
**MongoDB 完全不動**（FR-012）。

**Testing**: Vitest（三端既有）。策略為「抽純函式 → 單測」，沿用 api 側既有範式
（`errorlog-transition.test.ts` 等）。零回歸（SC-007）以 quickstart 逐項對照演練承接，
與 007／008 做法一致。

**Target Platform**: 本機 Windows/PowerShell 開發（四終端機直跑）+ Linux 容器（008 一鍵 demo）

**Project Type**: pnpm monorepo — web application（Vue SPA）+ 雙後端行程（NestJS api、Node worker）

**Performance Goals**：
- 健康端點最壞回應 ≤ `HEALTH_PROBE_TIMEOUT_MS`(2s) + HTTP 往返，遠低於 compose `timeout: 5s`。
- 指標蒐集對高頻路徑（每 50ms 的 `publishTelemetry`）的額外成本 ≈ 0
  ——只做記憶體計數，**不寫日誌、不進 I/O**（FR-009）。
- 背壓比值（賣點一）與 streaming 延遲**維持改動前數值**（SC-007）。

**Constraints**：
- FR-012 零行為回歸——這是最強約束，一切設計向它讓步。
- 憲章 IV：worker MUST NOT 直接 emit ws；跨行程一律走 Redis；Redis 連線分離。
- FR-009：高頻 telemetry 不得逐筆入日誌。
- `fatal.ts` 的同步 stderr 寫出**不得**改為 pino（會破壞 007 契約與致命訊息保證）。
- pino MUST NOT 進入 web 瀏覽器 bundle。

**Scale/Scope**：新增約 14 個檔案、修改約 12 個；不新增 package；不新增 HTTP 端點（除 `/healthz`）。

---

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

對照 `.specify/memory/constitution.md` v1.4.1：

| 原則 | 判定 | 依據 |
| --- | --- | --- |
| **I. 規格驅動開發** | ✅ PASS | 已走 specify → clarify → plan；branch `009-Observability-Baseline` 自 `develop` 開出；merge 將用 `--no-ff`。 |
| **II. 單一真實來源** | ✅ PASS | dev 面板視覺依 `design-spec.md` 具名 token、沿用 `BackpressureBadge` 語彙，不散落 hex；`system/metrics` 先改 `packages/contracts` + `asyncapi.yaml` 再改三端；跨 feature 決策已列 ⚑ 回補清單（research 末節）。 |
| **III. 契約優先與型別安全** | ✅ PASS | `SystemMetrics` 加在 `packages/contracts` 並納入 `ServerControlMessage`，三端不另寫平行定義。依「型別來源分層」，它是做 `switch(type)` 分派、由本系統自身產生的傳輸訊息 → **以 TS 型別定義**，與既有 `system/connected`／`job/status` 一致，不引入 Zod。全棧 strict TS，無新增 `any`。<br>**已變更（2026-09-27 升級分支）**：現為 Zod schema（`SystemMetricsSchema`，型別由 `z.infer` 推導），理由為納入 AsyncAPI 漂移比對（`asyncapi-drift.test.ts`）；原決策敘述保留。 |
| **IV. 即時通道架構紀律** | ✅ PASS（含明示邊界） | 沿用原生 `ws`，不引入 Socket.IO。**worker 不直接 emit ws**——指標走 Redis key → api 合併 → Gateway 廣播。Redis 連線分離：health probe 用**專屬**連線，MUST NOT 借用 subscriber。**高頻規則邊界**：`system/metrics` 是 60s 一則的低頻控制訊息，直接寫入 reactive store 是正確的，MUST NOT 進 telemetry 的 rAF buffer（否則會污染背壓比值量測）——此邊界在 contracts/metrics-summary.md §3 與程式註解中明示。 |
| **V. AI 診斷紀律** | ✅ PASS | 不動 `AiProvider` interface、cache signature、`DiagnosisResultSchema.parse()`。僅在 `streamDiagnosis` 呼叫外圍加計時、在 `replyCached()` 加命中計數——**純觀測，不改控制流**。 |
| **VI. 祕密與設定衛生** | ✅ PASS | 只新增 6 個非敏感環境變數並同步 `.env.example`。日誌欄位不含 token／API key（`WS_AUTH_SECRET`、`GEMINI_API_KEY` 絕不入 log）。 |
| **VII. 資料可追溯性** | ✅ PASS | 不改任何持久化行為。`metrics:worker` 是**暫態快照**（TTL 180s），屬 Redis 的正當用途（cache/暫態），非歷史資料——歷史資料仍全數在 Mongo。 |
| **測試門檻** | ✅ PASS | 6 個純函式單測（research R9）：`aggregateHealth`、`mergeMetrics`、`summarizeLatency`、`hitRate`、`resolveLogLevel`、`resolveMetricsInterval`。 |
| **可重播驗收** | ✅ PASS | quickstart 提供可重播演練（停 Redis／停 Mongo／調 `LOG_LEVEL`／觸發診斷看命中率）。既有 mock producer 與 seed 不動。 |
| **Phase 化可追溯遞交** | ✅ PASS | tasks 將依 US 分 phase，每 phase 勾選後 commit，標題標記 phase。 |

**結論：無違反，Complexity Tracking 留空。**

**Post-Design 複查（Phase 1 後）**：設計未引入新 package、未新增框架、未偏離既有架構
（沿用 Nest DI、既有 Gateway、既有 Redis 連線模式）。唯一新增的跨行程機制是一個 Redis
string key，比 Pub/Sub 更簡單。**維持 PASS。**

---

## Project Structure

### Documentation (this feature)

```text
specs/009-observability-baseline/
├── plan.md                       # 本檔
├── spec.md                       # 含 2026-07-17 Clarifications
├── research.md                   # Phase 0：R1–R10 + ⚑ 回補清單
├── data-model.md                 # Phase 1：E1–E5
├── quickstart.md                 # Phase 1：驗收演練
├── checklists/requirements.md    # 既有
├── contracts/                    # Phase 1
│   ├── health-endpoint.md        #   GET /healthz 契約
│   ├── metrics-summary.md        #   指標摘要 + system/metrics ws 訊息
│   └── log-fields.md             #   結構化日誌欄位約定
└── tasks.md                      # Phase 2（/speckit-tasks 產出，非本指令）
```

### Source Code (repository root)

```text
packages/
├── contracts/src/
│   └── events.ts                       # ✏️ 新增 SystemMetrics / WorkerMetrics，納入 ServerControlMessage
└── shared/
    ├── package.json                    # ✏️ 新增 pino 相依 + 子路徑 export "./logging"
    └── src/
        ├── index.ts                    # ⛔ MUST NOT re-export logging（否則 pino 進 web bundle）
        └── logging/                    # ➕ 日誌單一來源
            ├── index.ts                #    createLogger(service) 工廠
            ├── level.ts                #    resolveLogLevel / resolvePretty / resolveMetricsLogLevel（純函式）
            ├── level.test.ts           #    ➕ 單測
            ├── interval.ts             #    resolveMetricsInterval（純函式，下限 5000ms → 回退預設）
            └── interval.test.ts        #    ➕ 單測

apps/api/src/
├── main.ts                             # ✏️ app.useLogger(pino adapter)
├── healthcheck.ts                      # ✏️ /ws 握手 → GET /healthz（R4a）
├── lib/
│   ├── health-probe.ts                 # ✏️ 僅加註「008 歷史產物」註記，保留檔與測試
│   ├── health-aggregate.ts             # ➕ aggregateHealth（純函式）
│   ├── health-aggregate.test.ts        # ➕
│   ├── metrics-merge.ts                # ➕ mergeMetrics（純函式，含降級）
│   ├── metrics-merge.test.ts           # ➕
│   └── errorlog-transition.ts          # ✏️ 重啟邊界重複的註解（US4）
├── logging/
│   └── pino-logger.service.ts          # ➕ Nest LoggerService adapter
├── modules/
│   ├── config/config.service.ts        # ✏️ 新增 6 個設定讀取
│   ├── health/                         # ➕
│   │   ├── health.controller.ts        #    GET /healthz
│   │   ├── health.service.ts           #    Redis/Mongo 併行探測 + 逾時
│   │   └── health.module.ts
│   ├── history/history.service.ts      # ✏️ 加 ping()；persistBatch 有損語意註解（US4）
│   ├── metrics/                        # ➕
│   │   ├── metrics.service.ts          #    週期結算：queue counts + ws 連線數 + 讀 worker 快照
│   │   └── metrics.module.ts
│   ├── jobs/jobs.service.ts            # ✏️ 暴露 queue.getJobCounts()
│   └── websocket/monitoring.gateway.ts # ✏️ 暴露連線數 + broadcast(system/metrics)
└── app.module.ts                       # ✏️ 掛 Health/Metrics module

apps/worker/src/
├── main.ts                             # ✏️ log() → pino；LLM 計時；cache 命中計數
├── lib/
│   ├── fatal.ts                        # ✏️ 僅加註「FR-004 唯一例外」（行為不變）
│   ├── metrics-collector.ts            # ➕ 累加器 + 週期寫 Redis + 記自身日誌
│   ├── latency.ts                      # ➕ summarizeLatency（純函式）
│   ├── latency.test.ts                 # ➕
│   ├── hit-rate.ts                     # ➕ hitRate（純函式）
│   └── hit-rate.test.ts                # ➕
└── package.json                        # ✏️ 無新增直接相依（pino 經 shared）

apps/web/
├── .env.example                        # ➕ VITE_METRICS_PANEL（Vite 的 env 根目錄為 apps/web/，
│                                       #    根 .env.example 的 VITE_ 變數不會被讀取；envDir 不改）
└── src/
    ├── domains/monitoring/
    │   ├── stores/metrics.store.ts     # ➕ 低頻直寫（非 rAF 路徑）+ live/stale/disconnected/empty 四態
    │   └── lib/ws-message.ts           # ✏️ 分派 system/metrics
    └── shared/components/
        ├── MetricsPanel.vue            # ➕ 唯讀 dev 面板，預設收合
        └── TopBar.vue                  # ✏️ 依 VITE_METRICS_PANEL 掛載面板

# 根層
asyncapi.yaml                           # ✏️ 新增 system/metrics
README.md                               # ✏️ 「已宣告的取捨」+ 新環境變數 + 面板開關
docs/Flow-Gatekeeper-SDD-完整實作指南.md   # ✏️ ⚑ 回補 §14 / §15.2 / §15.3 / §15.4
docs/adr-002-productionization-scope.md  # ✏️ ⚑ 回補 §6.4「落地」現況
.env.example / apps/api/.env.example / apps/worker/.env.example  # ✏️ 6 個新變數
                                        #    （web 的 VITE_METRICS_PANEL 另見 apps/web/.env.example）
```

**Structure Decision**：沿用既有 pnpm monorepo 佈局（`apps/{api,worker,web}` +
`packages/{contracts,shared}`），**不新增 package**。新能力以既有慣例落位：

- api 的新功能走 **Nest module**（`modules/health/`、`modules/metrics/`），與既有
  `config`／`history`／`jobs`／`websocket`／`telemetry` 同層同構。
- **純函式抽到 `lib/`** 並就地放測試檔——這是本專案已建立的可測性範式
  （`errorlog-transition.ts` + `.test.ts` 等 8 組先例）。
- worker 無 DI 框架，新邏輯放 `lib/`，由 `main.ts` 的 `bootstrap()` 組裝，與既有
  `heartbeat.ts`／`chaos.ts`／`fatal.ts` 一致。
- web 依既有 domain 佈局：store 進 `domains/monitoring/stores/`，
  跨域展示元件進 `shared/components/`（與 `BackpressureBadge.vue` 同層）。

---

## Phase 2 預告（由 `/speckit-tasks` 產出）

預期 phase 切分，與 spec 的 US 優先級對齊、可獨立驗收：

| Phase | 內容 | 對應 |
| --- | --- | --- |
| 1. Setup | pino 相依、`packages/shared/logging` 子路徑 export、環境變數與 `.env.example` | 基礎 |
| 2. Foundational | `createLogger` 工廠 + `resolveLogLevel`／`resolveMetricsInterval` 純函式與單測 | US1 前置 |
| 3. US1 | api LoggerService adapter；worker `log()` → pino；關聯鍵改造；`fatal.ts` 註記 | P1 |
| 4. US2 | `health` module + `/healthz`；`aggregateHealth` 單測；`healthcheck.ts` 切換 | P2 |
| 5. US3 | worker 累加器 + Redis 快照；api metrics module + 合併；契約 + AsyncAPI；web store + 面板 | P3 |
| 6. US4 | `persistBatch`／`lastState` 註解、README「已宣告的取捨」 | P3 |
| 7. Polish | ⚑ 回補指南／ADR-002／README；quickstart 逐項驗收；零回歸對照 | 收尾 |

---

## Complexity Tracking

> Constitution Check 無違反，本節留空。

| Violation | Why Needed | Simpler Alternative Rejected Because |
| --- | --- | --- |
| （無） | — | — |
