# Phase 1 Data Model: Observability Baseline

**Feature**: 009-Observability-Baseline | **Date**: 2026-07-20
**Input**: [spec.md](./spec.md) Key Entities、[research.md](./research.md)

> 本 feature **不新增任何 MongoDB collection、不改動任何既有持久化文件形狀**（FR-012）。
> 以下實體皆為**運行期記憶體結構**或**傳輸／日誌形狀**。

---

## E1 — 結構化日誌條目（Structured Log Entry）

pino 的 NDJSON 輸出。每行一個 JSON 物件。

| 欄位 | 型別 | 必填 | 說明 |
| --- | --- | --- | --- |
| `level` | number | ✅ | pino 數值等級（30=info、40=warn、50=error）。pretty 模式顯示為文字。 |
| `time` | number | ✅ | epoch millis。 |
| `service` | `"api" \| "worker"` | ✅ | 行程來源。根 logger 的固定 binding。 |
| `context` | string | ✅ | 來源脈絡。api 為 Nest 的 logger context（如 `MonitoringGateway`）；worker 為模組名（如 `processor`、`metrics`）。 |
| `msg` | string | ✅ | 人類可讀訊息。**MUST NOT** 再把關聯鍵串進字串（FR-002）。 |
| `jobId` | string | ⬜ | 關聯鍵：一次診斷。 |
| `machineId` | string | ⬜ | 關聯鍵：一台機台。 |
| `clientId` | string | ⬜ | 關聯鍵：一條 ws 連線。 |
| `err` | object | ⬜ | 錯誤物件（pino 標準序列化：`type`／`message`／`stack`）。 |

**Validation rules**：
- 關聯鍵命名 MUST 與 `packages/contracts` 逐字一致（camelCase），不得出現 `job_id`／`jobID` 變體。
- 同一筆事件 MUST NOT 同時把關聯鍵放進 `msg` 與獨立欄位（重複即失去單一來源）。

**States / lifecycle**：無狀態；每筆獨立。

**例外**：worker 致命路徑（`fatal.ts`）**不採本形狀**——維持 007 契約的同步純文字寫出（research R1a）。

---

## E2 — 健康狀態報告（Health Report）

`GET /healthz` 的回應 body。形狀契約見 [contracts/health-endpoint.md](./contracts/health-endpoint.md)。

| 欄位 | 型別 | 說明 |
| --- | --- | --- |
| `status` | `"healthy" \| "unhealthy"` | 二態（Clarifications）。對應 HTTP 200／503。 |
| `checkedAt` | string (ISO-8601) | 本次探測時間。 |
| `dependencies.redis` | `DependencyProbe` | Redis 探測結果。 |
| `dependencies.mongo` | `DependencyProbe` | Mongo 探測結果。 |

**`DependencyProbe`**：

| 欄位 | 型別 | 說明 |
| --- | --- | --- |
| `status` | `"up" \| "down"` | 連通與否。 |
| `latencyMs` | number \| null | 探測往返耗時；`down` 時為 `null`。 |
| `error` | string \| null | `down` 時的原因（如 `"timeout"`、連線錯誤訊息）；`up` 時為 `null`。 |

**Validation rules（不變量）**：
- `status === "healthy"` **若且唯若**所有 `dependencies.*.status === "up"`。
- `status === "unhealthy"` 時，body MUST 至少有一個 `down` 依賴——否則是聚合邏輯錯誤。
- 探測 MUST NOT 拋錯：任何例外（含逾時）一律轉為 `down` + `error`。

**State transitions**：無持久狀態機。每次請求都是即時探測（無快取），
確保 SC-003「數秒內轉為非健康」不受快取延遲影響。

---

## E3 — 指標摘要（Metrics Summary）

週期性快照。同一形狀同時用於：①api 的日誌摘要 ②`system/metrics` ws 訊息 ③web dev 面板。
形狀契約見 [contracts/metrics-summary.md](./contracts/metrics-summary.md)。

| 欄位 | 型別 | 擁有者 | 說明 |
| --- | --- | --- | --- |
| `windowMs` | number | api | 本則摘要涵蓋的時間窗（＝`METRICS_INTERVAL_MS`）。 |
| `collectedAt` | string (ISO-8601) | api | 結算時間。 |
| `queue.waiting` | number | api | BullMQ 佇列深度。 |
| `queue.active` | number | api | 處理中。 |
| `queue.failed` | number | api | 失敗計數。 |
| `wsConnections` | number | api | 當前 ws 連線數（瞬時值，非窗內平均）。 |
| `worker` | `WorkerMetrics \| null` | worker | 來自 Redis 快照；缺席／過期／畸形時為 `null`。 |

**`WorkerMetrics`**：

| 欄位 | 型別 | 說明 |
| --- | --- | --- |
| `snapshotAt` | string (ISO-8601) | worker 端結算時間（供判讀新鮮度）。 |
| `llmLatency.count` | number | 窗內 LLM 呼叫樣本數。 |
| `llmLatency.avgMs` | number \| null | 平均；`count === 0` 時為 `null`。 |
| `llmLatency.p95Ms` | number \| null | 95 百分位；`count === 0` 時為 `null`。 |
| `llmLatency.maxMs` | number \| null | 最大值；`count === 0` 時為 `null`。 |
| `cache.hits` | number | 窗內快取命中數。 |
| `cache.misses` | number | 窗內未命中數。 |
| `cache.hitRate` | number \| null | `hits / (hits + misses)`；分母為 0 時為 `null`（**不是 0**）。 |

**Validation rules（不變量）**：
- 所有計數欄位為窗內**增量**，每週期結算後歸零——`collectedAt` 之間的值互不累加。
- `wsConnections` 是**例外**：它是瞬時值（gauge），不歸零。
- `cache.hitRate === null` ⟺ `hits + misses === 0`。`0` 與 `null` 語意不同，MUST NOT 混用。
- `llmLatency.*Ms === null` ⟺ `count === 0`。
- `worker === null` 時，api 側四項中的兩項仍 MUST 正常輸出（摘要不因 worker 缺席而中止）。

**State transitions（收集器生命週期）**：

```
idle ──啟動──▶ collecting ──每 METRICS_INTERVAL_MS──▶ [結算 → 輸出 → 歸零] ──▶ collecting
                    │
                    └──onModuleDestroy / SIGTERM──▶ stopped（清除 timer，不輸出殘窗）
```

關閉時**不**輸出未滿一窗的殘餘摘要——避免優雅關閉的日誌尾端出現誤導性的低值。

---

## E4 — worker 指標快照（Redis 中介）

跨行程傳遞用，**非**對外契約。

| 項目 | 值 |
| --- | --- |
| Key | `metrics:worker` |
| 型別 | Redis string（`WorkerMetrics` 的 JSON） |
| 寫入 | worker 每 `METRICS_INTERVAL_MS` 一次 `SET ... EX <3 × 間隔秒數>` |
| 讀取 | api 每 `METRICS_INTERVAL_MS` 一次 `GET`（無 `DEL`——讀取不破壞性消費） |
| 過期語意 | key 消失＝worker 已缺席逾 3 個週期 → 合併時 `worker: null` |

**與 007 `worker:heartbeat` 的關係**：兩者**各自獨立**（Clarifications）。
`worker:heartbeat`（TTL 30s）是 007 的存活探針、由 007 的 healthcheck 消費；
`metrics:worker`（TTL 180s）是 009 的指標快照、由 api 的收集器消費。
命名空間不同（`worker:` vs `metrics:`）、TTL 不同、消費者不同，**MUST NOT** 互相取代或合併。

**Validation rules**：
- api 端讀取 MUST 對 `JSON.parse` 失敗、欄位缺漏、型別不符一律**降級為 `worker: null`**，
  MUST NOT 拋錯中斷摘要輸出（`mergeMetrics` 的核心測試點，research R9）。

---

## E5 — 指標收集器的內部累加器（worker 端，記憶體）

| 欄位 | 型別 | 說明 |
| --- | --- | --- |
| `latencySamples` | number[] | 環形緩衝，**固定上限 1000**。滿載後覆寫最舊樣本。 |
| `cacheHits` | number | 窗內計數。 |
| `cacheMisses` | number | 窗內計數。 |

**Validation rules**：
- 樣本陣列 MUST 有固定上限——無界成長會在長跑 demo 中緩慢吃記憶體，且 p95 計算成本上升。
- 每次結算後 `latencySamples.length = 0`、兩個計數歸零。
- **跨重啟不連續**：worker 重啟後累加器歸零，這是可接受的（spec Edge Case
  「不要求關聯鍵跨行程生命週期連續」的同一精神）。

---

## 既有實體的變更

| 實體 | 變更 |
| --- | --- |
| `TelemetryPoint`／`JobStatus`／`AiStreamEvent` | **無變更**（FR-012） |
| `ServerControlMessage` 聯集 | **新增** `SystemMetrics` 成員（見 contracts/metrics-summary.md） |
| MongoDB `telemetry`／`errorlogs`／`diagnoses`／`diagnosisTriggers`／`maintenanceRecords` | **無變更**——US4 只加註解，不改寫入行為 |
