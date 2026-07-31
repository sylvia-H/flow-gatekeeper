# Phase 0 Research: Observability Baseline（可觀測性基線）

**Feature**: 009-Observability-Baseline | **Date**: 2026-07-20
**Input**: [spec.md](./spec.md)（含 2026-07-17 Clarifications 四項裁決）

本文件解決 Technical Context 的所有 NEEDS CLARIFICATION，並記錄關鍵取捨。
凡屬**跨 feature 決策**者標記 `⚑ 回補`，須於本 feature 收尾前寫回真實來源（CLAUDE.md 規則）。

---

## R1 — 結構化日誌方案與導入方式

**Decision**：採 **pino**。兩端導入方式刻意不同，以最小改動達成 FR-004／FR-012：

- **api（NestJS）**：實作一個 pino-backed 的 `LoggerService` adapter，於 `main.ts` 以
  `app.useLogger(...)` 注入。api 現況**已全面使用 Nest 內建 `Logger`**（`main.ts`、
  `MonitoringGateway`、`HistoryService`、`JobStatusRelayService`、`AiStreamRelayService`、
  `JobsService` 共 6 處），因此**不需逐檔改呼叫點**即可整批轉為結構化輸出。
- **worker（純 Node）**：以 pino logger 取代 `apps/worker/src/main.ts:35` 的手寫
  `log(level, msg)` helper。約 20 個呼叫點改為 `logger.info({ jobId, machineId }, msg)` 形式。

**Rationale**：
- pino 是指南 §15.2／ADR-002 §5.3 指名的 reference，生態成熟、輸出即 NDJSON，可被任何聚合器消費。
- api 走 adapter 而非逐檔改寫，是 FR-012「零行為回歸」成本最低的路徑——改動集中在單一注入點。
- 不採 `nestjs-pino`：它綁 `AsyncLocalStorage` 請求上下文與 Express middleware，對一個
  **以 WebSocket 為主、HTTP 端點極少**的服務是錯配的抽象，且多一層 DI 相依。

**Alternatives considered**：
- `winston`——設定面大、預設非 JSON、效能較差，無理由偏離指南指名。
- 自寫 JSON `console.log` wrapper——省一個相依，但要自行處理 level 過濾、序列化、錯誤物件展開、
  child logger，等於重造 pino 且更易錯。

### R1a — `fatal.ts` 是 FR-004 的**唯一例外**（不得改用 pino）

**Decision**：`apps/worker/src/lib/fatal.ts` 的致命訊息**維持 `writeSync(fd 2)` 同步寫出**，
不改走 pino。

**Rationale**：該檔註解已載明理由——POSIX 上寫到 pipe 的 stderr 是非同步的（容器內即 pipe），
致命後緊接 `process.exit(1)` 會讓非同步寫入**遺失最後一則致命訊息**。pino 的寫入同樣是非同步的，
改用它會直接破壞 007 的核心保證。此外 007 的
`specs/007-worker-process-supervision/contracts/supervision-runtime.md` 已把致命 log 格式定為
運維層契約，變更即破壞既有契約。

**落地要求**：FR-004「MUST NOT 留下兩套並存的日誌格式」須在 plan／tasks 明文承認此例外，
並在 `fatal.ts` 補一行註解指向本節，避免後續 review 誤判為漏改。

### R1b — 一次性 CLI 腳本不納入「服務日誌」

**Decision**：`apps/api/src/scripts/seed.ts`（1 處 `console.log`）與
`apps/worker/src/ai/smoke-gemini.ts`（3 處）**維持人類可讀的 CLI 輸出**，不轉結構化。

**Rationale**：SC-001 的標的是「api 與 worker 的**日誌輸出**」——即長駐服務行程在運行期產生、
需被聚合與過濾的紀錄。一次性 CLI 工具的輸出是給執行者當下看的終端回饋，轉成 NDJSON 反而降低可用性。

**已定案**（2026-07-20 analyze 收斂）：此界線是對 SC-001 字面「無殘留純文字 `console.log`」的收斂解釋，
已寫入 FR-004 與 SC-001 的範圍界定條款（「一次性 CLI 腳本不在此列，維持人類可讀輸出」），
並由 T021 在兩個腳本就地留註。**不再是待確認項**。

---

## R2 — 關聯鍵（jobId／machineId／clientId）的傳遞方式

**Decision**：**顯式 bindings**——呼叫點以 pino 的物件參數帶入
（`logger.info({ jobId, machineId }, "job active")`），長流程以 child logger 綁定
（`const jl = logger.child({ jobId })`）。**不引入 AsyncLocalStorage**。

**Rationale**：
- 現況程式**本來就顯式持有** `jobId`／`machineId`／`clientId`（見 worker `createProcessor`、
  Gateway `handleConnection`），改成物件欄位是零推導成本的機械轉換。
- ALS 的價值在「深呼叫鏈中隱式取得上下文」，但本專案的日誌點都在持有這些值的同一層，
  收益為零而代價（context 遺失除錯、效能開銷、與 BullMQ／ws callback 邊界的傳播陷阱）不低。
- 顯式 bindings 讓「哪一筆 log 帶哪個關聯鍵」在 code review 時直接可見，符合 FR-002 的可驗證性。

**欄位命名約定**（⚑ 回補指南 §15.3 Q1）：一律用 camelCase 的 `jobId`、`machineId`、`clientId`，
與 `packages/contracts` 既有欄位名逐字一致，避免同一概念兩種寫法。

**Alternatives considered**：把關聯鍵塞進訊息字串（如現況 `` `job active: ${jobId}` ``）——
可讀但**不可查詢**，正是 FR-002 要消滅的現況。

---

## R3 — 日誌呈現：dev pretty-print vs prod JSON

**Decision**：由 `LOG_PRETTY` 環境變數控制，**預設值取決於 `NODE_ENV`**——
非 production 預設 pretty（`pino-pretty`，devDependency）、production 預設純 JSON。
`LOG_PRETTY=true|false` 可顯式覆寫。

**Rationale**：dev 四終端機直跑時（指南 §16.1）NDJSON 幾乎不可讀，pretty 是實質可用性需求；
production／容器內必須是純 JSON 才可被聚合。以 `NODE_ENV` 推導預設值可讓兩種軌道**零設定**即正確。

**Constraint**：`pino-pretty` MUST 為 devDependency 且僅在 pretty 模式動態載入，
避免進入 production 容器 image。

---

## R4 — 健康端點設計（US2）

**Decision**：`GET /healthz`，NestJS controller，二態、200/503（依 Clarifications）。

| 面向 | 決定 |
| --- | --- |
| 路徑 | `/healthz`（指南 §15.2、008 clarify 已預留此名） |
| 方法 | `GET`，無認證（探測端點不得要求 secret，否則 compose healthcheck 無法用） |
| 狀態 | 二態：`healthy` → 200；`unhealthy` → 503 |
| 判準 | Redis `PING` 與 Mongo `{ping:1}` **皆** ok 才 healthy；任一失敗即 unhealthy |
| 逾時 | 每個依賴探測獨立逾時 `HEALTH_PROBE_TIMEOUT_MS`（預設 **2000ms**） |
| 併發 | 兩個探測 `Promise.all` 併行，總耗時 ≈ 單一逾時而非兩者相加 |
| Body | JSON，逐項列出各依賴 `up`/`down` 與 `error`（見 contracts/health-endpoint.md） |

**逾時值 rationale**：008 的 compose healthcheck `timeout: 5s` 是外層上限。2000ms × 併行
＋ HTTP 往返，最壞約 2.2s，留有充裕餘裕（FR-007／SC-003「數秒內」）。逾時以
`Promise.race` 實作，逾時分支回 `down` 並附 `timeout` 原因，**不拋錯**。

**Redis 連線**：health probe 使用**專屬** ioredis 連線（憲章 IV「連線分離」），
`maxRetriesPerRequest: null` 但**不啟用**無限重連阻塞——探測失敗即回 down。
MUST NOT 借用 relay 的 subscriber 連線執行 `PING`。

**Mongo 連線**：複用 `HistoryService` 已建立的 `Db`（避免第二條 Mongo 連線）；
`HistoryService` 需新增一個 `ping()` 方法暴露探測能力。`db` 未就緒（啟動中）視為 `down`。

**不納入**：worker 存活（依 Clarifications「各自獨立」——worker 由 007 的
`worker:heartbeat` 與其自身 compose healthcheck 承接，api 的 `/healthz` 不代 worker 發言）。

### R4a — 008 compose healthcheck 切換至 `/healthz` ⚑ 回補

**Decision**：`apps/api/src/healthcheck.ts` 由現行「連 `ws://127.0.0.1:PORT/ws` 等
`system/connected`」改為「`GET http://127.0.0.1:PORT/healthz`，HTTP 200 → exit 0，其餘 → exit 1」。

**Rationale**：這正是 008 clarify 明文劃歸 009 的交棒點——008 的探活只證明「HTTP server 在聽
且 Gateway 已 attach」，**不涵蓋 Redis／Mongo 連通性**。切換後容器就緒判定才具備依賴深度
（spec Dependencies 段、SC-003）。

**Constraint**：改寫後仍 MUST 只用 node 內建 `http`（不引入 wget／curl 相依，維持 008 已收斂的
「healthcheck 去 `--spider` 依賴」結論）；自我逾時維持 4000ms（< compose `timeout: 5s`）。

**⚑ 回補標的**：指南 §14（Feature 008 章節）中「api healthcheck 以 `/ws` 握手探活」的現況描述
須改為「已由 009 切換至 `/healthz`」；008 的 spec/plan 為歷史工件，不改寫。

---

## R5 — 指標蒐集與跨行程彙整（US3 的核心難題）

**問題**：FR-008 的四項指標**分屬兩個 process**，沒有單一行程能全部看見。

| 指標 | 資料來源 | 擁有者 |
| --- | --- | --- |
| 佇列深度 / active / failed | BullMQ `Queue.getJobCounts()` | api（`JobsService` 持有 Queue） |
| WebSocket 連線數 | `MonitoringGateway.clients.size` | api |
| LLM 呼叫延遲 | `ai.streamDiagnosis` 前後計時 | worker |
| 快取命中率 | `replyCached()` 命中／未命中計數 | worker |

**Decision**：**worker 週期性把自己那半寫入 Redis key `metrics:worker`（JSON，TTL = 3 × 間隔），
api 週期性讀取並與自己那半合併，輸出「一則」四項齊全的摘要**。

```
worker ──(每 60s SET metrics:worker, EX 180)──▶ Redis
                                                  │
api ──(每 60s GET metrics:worker + 自身兩項)──────┘──▶ 合併摘要 → log + WS 廣播
```

**Rationale**：
- 憲章 IV 明文「worker MUST NOT 直接 emit WebSocket」，跨行程資料一律走 Redis。
- 用**普通 key + TTL**（非 Pub/Sub）：讀取端要的是「當下快照」而非事件流，`GET` 語意正確，
  且**不需再開一條 subscriber 連線**（憲章 IV 連線分離的額外成本）。
- TTL = 3 × 間隔：worker 掛掉後最多 3 個週期，key 自然過期 → 合併時 worker 那半降級為
  **`worker: null`**（形狀契約見 data-model E3／contracts §5），摘要**仍照常輸出**
  （不因 worker 缺席而讓 api 的指標也一起消失）。

**worker 亦記錄自己那半**：worker 除了寫 Redis，也在同一週期把自身兩項指標記入**自己的日誌**。
理由：worker 的日誌必須可獨立判讀，不能要求讀者一定要同時拿到 api 的日誌才知道 worker 在做什麼。
SC-004 的「四項齊全的週期摘要」由 api 那一則滿足。

**延遲的統計形狀**：LLM 延遲取**該週期內的樣本數、平均、p95、max**（非單一數字）——單一平均值
在 LLM 這種長尾分布下幾乎沒有判讀價值。樣本以固定上限的環形陣列保存，每週期結算後清空
（避免無界成長）。

**快取命中率**：`hits / (hits + misses)`，**週期內計數**（非累計），每週期結算後清零，
使數值反映「當下」而非「開機以來」。分母為 0 時回 `null`（不是 0），避免「0% 命中率」的誤讀。

**Alternatives considered**：
- 各 process 各記各的、不合併——最省，但 SC-004 要求「找到含四項指標的摘要」，
  讀者需自行跨兩個日誌流拼裝，且 US3 的 web dev 面板無單一資料源。
- worker → Redis Pub/Sub → api——事件語意，需額外 subscriber 連線；且 api 若在 worker 發布時
  剛好重啟即永久錯過該筆，快照語意（key）比事件語意更穩健。

---

## R6 — 指標摘要不被 `LOG_LEVEL` 濾掉（Edge Case）

**Decision**：指標摘要走**專屬 child logger**（`context: "metrics"`），其 level 由
`METRICS_LOG_LEVEL`（預設 `info`）**獨立釘定**，不受根 logger 的 `LOG_LEVEL` 影響。

**Rationale**：pino 的 child logger 可設定自己的 `level`，且**可比 parent 更寬鬆**。這讓
「把 `LOG_LEVEL` 調到 warn 以壓低雜訊」與「仍要看得到週期指標」兩個需求同時成立——正是 spec
Edge Case「觀測能力不應隨一般過濾一起失效」與 SC-005 後半段的要求。

**Alternatives considered**：把摘要提升到 `warn` 級——語意錯誤（指標摘要不是警告），
且會污染真正的 warn 流；操作者若把 LOG_LEVEL 調到 `error` 仍會失效。

---

## R7 — web dev 面板的傳輸與呈現（FR-008a）

**傳輸 Decision**：新增 server→client 控制訊息 **`system/metrics`**，經既有 Gateway 於每個
指標週期**廣播給所有連線**。**不新增 HTTP 端點**（Clarifications 已排除 `/stats`）。

- 契約先行（憲章 III）：型別加在 `packages/contracts/src/events.ts`，並納入
  `ServerControlMessage` 聯集；同步更新 `asyncapi.yaml`。
- 型別來源分層（憲章 III）：`system/metrics` 是做 `switch(type)` 分派的傳輸訊息、
  由本系統自身產生（非外部不可信輸入），故**以 TS 型別定義**，與既有
  `system/connected`／`job/status`／`machine/data` 一致，不引入 Zod。

**高頻規則不適用、但必須明說**：憲章 IV 的「高頻事件 MUST 先進 buffer 再 rAF 批次提交」
針對的是 `machine/data`（每 50ms）。`system/metrics` 是 **60 秒一則**的低頻控制訊息，
直接寫入 reactive store 是正確的，**MUST NOT** 塞進 telemetry 的 rAF buffer 路徑
（那會讓它延遲到下一批遙測才顯示，且污染背壓比值的量測）。此點須在 plan／tasks／程式註解
三處寫明，避免 analyze 或後續 review 誤判為違反硬規則。

**呈現 Decision**：`MetricsPanel.vue`，掛在 TopBar 區域，**預設收合**，
以 `VITE_METRICS_PANEL` 旗標控制是否渲染（dev 預設開、production build 預設關）。

**Rationale**：
- 「dev 面板」的定位不應改變 demo 首屏（`design-spec.md`：首屏為可操作監控台）。旗標讓 demo
  可按需開啟，又不預設佔用視覺版面。
- 用具名 token 取色（憲章 II），沿用既有 `BackpressureBadge` 的視覺語彙——它已是 TopBar 上
  「開發者向資訊徽章」的先例（指南 §15.3 Q2 亦以它為參照）。

**Constraint**：面板為**唯讀**，MUST NOT 提供任何觸發後端動作的控制項（FR-008a、FR-012）。

---

## R8 — 有損寫入語意明文化（US4）

**Decision**：三處落地，敘述須逐字一致：

| 標的 | 內容 |
| --- | --- |
| `HistoryService.persistBatch` 註解 | 現有註解已提「fire-and-forget、不 await」，**補上後果**：「API 崩潰時 in-flight batch 直接丟失（可丟失最後數秒 telemetry），此為 ADR-002 §6.4 明文接受的取捨」 |
| `detectErrorTransitions` / `lastState` 註解 | 「去重狀態存於行程內 Map，**重啟後首筆會重複寫入**；多實例下判斷會錯。ADR-002 §6.4」 |
| `README.md` | 新增「已宣告的取捨」小節，載明兩項有損語意與升級路徑（寫入前先進佇列再批次落庫），引用 ADR-002 §6.4 |

**Rationale**：ADR-002 §6.4 的「落地」欄位明文指定 Feature 009 執行此事。SC-006 要求
「文件與行為一致、可由讀者一致驗證」，故三處敘述必須指向同一份事實，不得各自表述。

**Constraint**：US4 **MUST NOT 改動任何程式行為**——只加註解與文件。

---

## R9 — 測試策略（憲章「測試門檻」）

現況：`apps/api` 與 `apps/worker` 皆以 `vitest run --passWithNoTests` 執行，api 側既有純函式測試
（`errorlog-transition.test.ts`、`health-probe.test.ts`、`subscription-filter.test.ts`）已建立範式。
本 feature 沿用「**抽純函式 → 單測**」的既有做法：

| 純函式 | 檔案 | 測什麼 |
| --- | --- | --- |
| `aggregateHealth(probes)` | `apps/api/src/lib/health-aggregate.ts` | 二態邏輯：全 up→healthy(200)、任一 down→unhealthy(503)、多重 down 皆列出 |
| `mergeMetrics(apiPart, workerRaw)` | `apps/api/src/lib/metrics-merge.ts` | worker 快照缺席／過期／畸形 JSON 時仍回完整結構並降級為 `worker: null` |
| `summarizeLatency(samples)` | `apps/worker/src/lib/latency.ts` | 空樣本回 null、p95 邊界、單一樣本 |
| `hitRate(hits, misses)` | `apps/worker/src/lib/hit-rate.ts` | 分母為 0 回 `null`、比值正確、不受累計污染 |
| `resolveLogLevel(env)` | `packages/shared/src/logging/level.ts` | `LOG_LEVEL` 未設的預設、非法值的回退、`LOG_PRETTY` 由 `NODE_ENV` 推導 |
| `resolveMetricsInterval(env)` | `packages/shared/src/logging/interval.ts` | 預設 60000、低於下限 5000ms 回退預設、非數值回退、合法值原樣通過（analyze 補齊，見 R11） |

**零回歸驗證（SC-007）**：不寫新的整合測試，改以 quickstart 的逐項對照演練承接
（與 007／008 相同做法），因為「行為與改動前逐項一致」的判準本質是端到端觀察。

---

## R10 — 共用 logger 放哪裡

**Decision**：新增 `packages/shared/src/logging/`，並在 `packages/shared/package.json` 增設
**子路徑 export** `@flow-gatekeeper/shared/logging`。pino 加為 `packages/shared` 的 dependency。

**Rationale**：欄位約定（level／time／context／關聯鍵命名）必須有單一來源，否則 api 與 worker
會漸行漸遠——這正是 FR-001「統一格式」要防的。

**Constraint（重要）**：`apps/web` **也** 相依 `@flow-gatekeeper/shared`
（`telemetry-format.ts` 匯入 `METRIC_THRESHOLDS`）。若把 logger 從**根 export**（`.`）匯出，
pino 會被拉進瀏覽器 bundle。故 MUST 走**獨立子路徑**，且 `src/index.ts`
**MUST NOT** `export * from "./logging/*"`。tasks 須含一項驗證：`pnpm --filter web build`
後產物不含 pino。

**Alternatives considered**：
- 各 app 各寫一份 logger factory——省掉子路徑設定，但欄位約定立刻有兩份來源。
- 新增 `packages/observability`——多一個 package 的建置／tsconfig／CI 成本，
  為兩個小檔案不划算。

---

## R11 — 兩個門檻值的定案（2026-07-20 analyze 收斂）

analyze 發現 FR-008 的「間隔下限」與 FR-008a 的「合理週期數」都只有敘述、沒有具體值，
實作時會被迫臨場決定。經確認後釘定如下，並回填 spec／contracts／tasks／quickstart：

| 門檻 | 值 | Rationale |
| --- | --- | --- |
| `METRICS_INTERVAL_MS` 下限 | **5000ms** | 每 5 秒一則在 dev 觀察已足夠密集，又不至於讓週期摘要本身成為雜訊源而抵銷 FR-009 的意圖。低於此值一律回退預設 60000ms（**不是 clamp 到下限**——誤設應回到已知安全值，而非落在邊界上）。 |
| dev 面板快照過期門檻 | **2 × `METRICS_INTERVAL_MS`**（預設 120s） | `system/metrics` 的傳輸保證是 at-most-once、不補發（contracts §2），故漏收單一則屬正常，連續漏兩則才是真的停更。取 1.5× 會讓一次網路抖動就誤報過期；取 3× 則要三分鐘才看得出面板已停更。 |

**與 `metrics:worker` TTL（3 × 間隔）的區別**：TTL 管的是「Redis 快照何時消失」（後端降級為
`worker: null`），面板門檻管的是「前端多久沒收到廣播就不該假裝即時」。兩者是不同層的問題，
數值不必一致，MUST NOT 互相對齊。

**前端如何取得該間隔值**（2026-07-20 analyze 第二輪，E5）：`METRICS_INTERVAL_MS` 是後端環境變數，
前端讀不到，故門檻一律由**最近一則 payload 的 `windowMs`** 推導（data-model E3 已有此欄位），
MUST NOT 在前端硬編 60000。**收到第一則快照之前**沒有收訊時刻也沒有 `windowMs`，
面板狀態為 `empty`（尚無資料），MUST NOT 判為過期。

**age 以哪個時鐘量測**（2026-07-31 code review 後修訂）：原實作以 payload 的 `collectedAt`
（api 時鐘）減前端的「現在」（瀏覽器時鐘），會把兩機的時鐘偏差灌進 age——用戶端時鐘快超過
門檻時面板永久顯示過期。現改為**距本地收訊時刻**（`receivedAt`）計算，全程單一時鐘；門檻的
來源（payload `windowMs`）與 2× 倍數不變。詳見 contracts/metrics-summary.md §2.1。

---

## R12 — dev 面板的四態狀態機（2026-07-20 analyze 第二輪，E4）

**Decision**：面板 MUST 區分 `empty` / `live` / `stale` / `disconnected` 四態，其中 **`stale`
（ws 連著但後端停止廣播）與 `disconnected`（ws 斷線）MUST 在文案與視覺上可區分**。

**Rationale**：
- 兩者的排查方向完全相反——`stale` 要查 api 的指標收集器，`disconnected` 要查連線／後端存活。
  混為一態，面板作為「判讀工具」的價值歸零。
- **驗收可證性**：原 quickstart 6.2 以「停掉 api」演練過期，但停 api 會**同時斷 ws**，
  過期態與斷線態混在一起，`MUST NOT 讓過期數值看起來像即時值`（FR-008a）無從被證實。
  分態後，6.2 改以「保持 ws 連線但停止廣播」驗 `stale`、以「停 api」驗 `disconnected`，
  兩者各自可獨立觀察。

**Constraint**：此為**純呈現層**的狀態細分，不新增訊息、不改傳輸語意，
與 FR-012「不改變既有即時行為」不衝突。

---

## 新增環境變數彙總（須同步 `.env.example`）

| 變數 | 預設 | 作用 | 檔案 |
| --- | --- | --- | --- |
| `LOG_LEVEL` | `info` | 根 logger 等級（FR-003） | api、worker |
| `LOG_PRETTY` | 由 `NODE_ENV` 推導 | dev pretty-print、prod JSON（R3） | api、worker |
| `METRICS_INTERVAL_MS` | `60000` | 指標摘要週期，**下限 5000ms**，低於下限回退預設（FR-008／R11） | api、worker |
| `METRICS_LOG_LEVEL` | `info` | 指標摘要專屬等級，獨立於 `LOG_LEVEL`（R6） | api、worker |
| `HEALTH_PROBE_TIMEOUT_MS` | `2000` | 依賴探測逾時（FR-007） | api |
| `VITE_METRICS_PANEL` | dev `true` / prod `false` | 是否渲染 dev 指標面板（R7） | web |

**登錄位置**（2026-07-20 analyze 第二輪，E1）：前五個變數登錄於根 `.env.example` +
`apps/api/.env.example` + `apps/worker/.env.example`。`VITE_METRICS_PANEL` **MUST 另外登錄於
新增的 `apps/web/.env.example`**——`apps/web/vite.config.ts` 未設 `envDir`，Vite 的 env 根目錄
即為 `apps/web/`，根 `.env` 的 `VITE_` 變數**不會被讀取**。根 `.env.example` 仍保留一列作為
全案設定形狀總覽，但須註明實際生效來源。**MUST NOT 改設 `envDir`** ——那會產生兩個生效來源，
且偏離 Vite 預設行為、容器 build context 也須一併調整。此為全案第一個 `VITE_` 變數。

---

## ⚑ 跨 Feature 回補清單（收尾前 MUST 完成）

1. **指南 §15.2／§15.3**：四項 clarify 問題標記為「已定案」並填入答案；§15.2「要做」清單
   補上 web dev 面板（原僅列於 §15.3 Q2 選項）。
2. **指南 §14（008）**：api healthcheck 由 `/ws` 握手改為 `/healthz`（R4a）。
3. **指南 §15.4**：驗收清單補「web dev 面板」與「二態 200/503」判準。
4. **ADR-002 §6.4**：「落地」欄位由「Feature 009 將寫入…」改為已落地現況描述（保留原決策敘述）。
5. **README.md**：新增「已宣告的取捨」小節（R8）、`LOG_LEVEL` 等新環境變數說明、
   dev 指標面板開關說明。
6. **`asyncapi.yaml`**：新增 `system/metrics` 訊息定義（R7）。

無未解的 NEEDS CLARIFICATION。
