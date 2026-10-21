# Implementation Plan: 012-lite 串流韌性（Stream Resilience）

**Branch**: `012-stream-resilience` | **Date**: 2026-10-21 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/012-stream-resilience/spec.md`（FR-001～FR-047、SC-001～SC-011、Clarifications 兩輪共 19 題）；
設計依據 [ADR-003](../../docs/adr-003-completion-semantics.md)（D1～D13、§6 回補清單、§7 代理裁決第 1～21 條，皆待使用者覆核）。

> **使用者離席期間產出**：技術決策沿用 ADR-003 代理裁決；plan 階段才浮現、spec／ADR 未定的設計點（P1～P24；analyze 階段補 P25）一律採
> 「對使用者可見行為最保守、實作代價最小」的做法，列於 [research.md](./research.md) 文末，待覆核後記入 ADR-003 §7（第 22 條起）。

---

## Summary

讓「後端已完成的 AI 診斷」一定回得到畫面，且重複執行不多付 LLM 費用。四條主線（ADR-003 §2）：

- **完成以 BullMQ `returnvalue` 為權威**（US1）：processor 回傳 `{ result, cached }`，api relay 驗證後放進 `job/status: completed`；
  `ai/done` 降為可重複、可遺失的提前通知；web 以 `ai/done`、帶 `result` 的 `completed`、GET 三者先到者收尾。
- **結果讀取與重連續接**（US2）：新增 `GET /diagnoses/:jobId?socketId=[&previousSocketId=]`，綁定抽成 `JobRoutingRegistry`
  （rebind、`completed`／`failed` 共用 10 s 終態寬限）；web 在授權成功後逐台 GET 續接；2 s 未送達與 45 s watchdog 先 GET 一次。
- **崩潰重派在 watchdog 之前**（US3）：BullMQ lock 15 s／stalled 5 s／maxStalled 2，worker 10 s 無對外事件即 `updateProgress` 補送；
  relay 監聽 `stalled` 送 `reason:"stalled"`；SIGKILL 後最長無事件設計上界 35 s。
- **jobId 冪等與成本**（US4、US5）：processor 開頭以 jobId 查 `ai-result:<jobId>` → Mongo `diagnoses` 短路；trigger unique＋upsert；
  hit／miss 以 `ai-metric:<jobId>` 只計一次；寫庫失敗以 `persist_failed` 重試只重做寫庫；同簽章 LLM 失敗寫 `ai-fail:<sig>`（10 s）擋下其他請求。

US6（嘗試／執行次數可見）隨 `job/status.attempt`／`execution` 一併落地。技術棧不換、不實作 Redis Streams；契約 asyncapi 1.3.0 → **1.4.0**
（向後相容 minor）。US3 的鎖參數 MUST 與 US4 的冪等同批交付（phase 順序先 US4 後 US3）。

---

## Technical Context

**Language/Version**: TypeScript 5.6（strict）、Node.js 22（`.nvmrc`）、ESM

**Primary Dependencies**（全部既有，不新增 runtime 相依）：NestJS 11、BullMQ 5.79.2（`returnvalue`、`stalled` 事件、`attemptsStarted`、
`Job.fromId` 語意以此版為準）、ioredis 5、mongodb 6、zod 4、`ws` 8、pino 9；web：Vue 3.5、Pinia 3、Vite 7；nginx（web 映像）

**Storage**：Redis 新增三種帶 TTL 的鍵 `ai-result:<jobId>`（3600 s）、`ai-fail:<sig>`（10 s）、`ai-metric:<jobId>`（86400 s）；BullMQ job hash 的
`progress` 改存物件、`returnvalue` 改存 `{ result, cached }`。MongoDB：`diagnosisTriggers` 新增 `{ jobId: 1 }` unique 並改 upsert；
api 新增 `diagnoses` 唯讀（見 [data-model.md](./data-model.md) §3、§4）

**Testing**：vitest 4（三端單元＋元件）、worker／api 整合測試（`test:integration`，真 Redis 7＋Mongo 7）、跨 process e2e（`pnpm test:e2e`，
compose 全棧＋fake provider）；`pnpm check`、`pnpm test:coverage`（全域與十個核心檔逐檔門檻）

**Target Platform**：本機 Windows＋Docker Desktop（四終端機直跑與一鍵 demo）、Linux 容器（compose）

**Project Type**：pnpm monorepo — web application（Vue SPA＋nginx）＋雙後端行程（NestJS api、Node worker）

**Performance Goals**：worker 被 SIGKILL 後畫面最長無事件 < 45 s（設計上界 `K + L + 2S` = 35 s，SC-001）；重連後續接在 api healthy 後 60 s 內
完成（SC-003）；keepalive 每 10 s（± 1 s）至少一次進度（SC-009）；同簽章供應商故障 2 請求合計 LLM ≤ 4 次（SC-007）

**Constraints**：憲章 IV 雙通道分流（結果走 QueueEvents、token 走 Pub/Sub、worker 不直接 emit ws）與 Redis 連線分離；不新增 WS channel；
`job/status` 新欄位皆 optional（舊 client 照常）；高頻規則 1 不惡化（`ai/token` 寫 reactive 的既有範圍不擴大）；`system/metrics`／
`WorkerMetrics` 不加欄位；不自動執行 `/speckit-constitution`；e2e 不在 CI（只手動）

**Scale/Scope**：demo 規模（worker concurrency 個位數、每分鐘數次診斷、5 台機台、單一 api 實例）；新增約 19 個檔（含 12 個測試檔），
修改約 40 個（含測試與文件）；確切清單以 tasks.md 為準

---

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

對照 `.specify/memory/constitution.md` v1.6.0：

| 原則 | 判定 | 依據 |
| --- | --- | --- |
| **I. 規格驅動開發** | ✅ PASS | `012-stream-resilience` 自 `develop` 開出，已走 specify → clarify → plan；merge 以 `--no-ff`；implement 以 phase 為遞交單位。 |
| **II. 單一真實來源** | ✅ PASS | 新文案依 `apps/web/PRODUCT.md`／`DESIGN.md`，不新增色值與 chip 種類；架構取捨已在 ADR-003；跨 feature 決策的回補清單見下方「文件回補」（ADR-003 §6），merge 前 MUST 完成。 |
| **III. 契約優先與型別安全** | ⚠️ PASS（需記錄） | 先改 `packages/contracts`（`job-status.ts`、`http.ts`、`jobs.ts`）與 `asyncapi.yaml` 1.4.0，再改三端；`JobStatus` 以 Zod 定義並納入漂移比對；api↔worker 的 `returnvalue`／progress 依例外 (c) 以 Zod 定義、消費端 `safeParse`；不另寫平行型別。**需記錄**：Principle III 的列舉只寫 `POST /diagnoses`，`GET /diagnoses/:jobId` 不在列舉內——本 feature 仍以 Zod 定義其 query 與成功回應（spec FR-032），憲章補列為建議修訂（PATCH 1.6.0 → 1.6.1），待使用者決定（FR-041，見 Complexity Tracking）。GET 錯誤 body 依例外 (b) 不另定 schema，語意記於 asyncapi `info.description` 與 CHANGELOG。`ai-fail` 標記為 worker 自寫自讀的內部值，以 worker 內部 Zod 驗證、不進 contracts（research P9）。 |
| **IV. 即時通道架構紀律** | ✅ PASS | 原生 `ws` 不變、不新增 channel；結果經 BullMQ QueueEvents（lifecycle 通道）送出，keepalive 也是 `updateProgress`（同一通道），token 仍走 Pub/Sub，不混流（FR-042）；worker 不直接 emit ws；api 不跑 long-running——GET 只做有 5 s 上限的 Redis 讀與一次 Mongo `findOne`；Redis 連線分離：GET 的 `Job.fromId` 用 producer 的 command 連線，不借 subscriber 或 QueueEvents 的 blocking 連線；worker 新增的三種鍵（`ai-result`／`ai-metric`／`ai-fail`）走既有 cache 連線（`ProcessorStore`），不借 BullMQ Worker 或 Pub/Sub 的連線；`ai/token` 仍逐筆進 store 的既有範圍不擴大（硬規則 1）。 |
| **V. AI 診斷紀律** | ✅ PASS | `AiProvider` interface 不動；cache before API 與簽章去重不變，另加負向標記 `ai-fail:<sig>`（同一簽章的成本控制，與原則同向）；所有結果在每個邊界都經 `DiagnosisResultSchema` 驗證：`returnvalue`（relay、GET）、`ai-result` 暫存、Mongo 讀回；不合法者不轉發、改走退路。 |
| **VI. 祕密與設定衛生** | ✅ PASS | 無新環境變數與祕密（BullMQ 參數是具名常數，FR-018）；日誌不記 MongoDB 原始錯誤以外的敏感值，`persist_failed` 訊息為固定句（代理裁決第 18 條）。 |
| **VII. 資料可追溯性** | ⚠️ PASS（需記錄） | 診斷結果仍持久化於 Mongo `diagnoses`、觸發紀錄每 jobId 一筆（FR-043）。**需記錄**：`ai-result:<jobId>` 是結果在 Redis 的暫時副本（≤ 1 h），只用來讓寫庫失敗的重試不重打 LLM；寫庫終究失敗時 job 以 `persist_failed` 收尾、使用者看到失敗，該副本隨 TTL 消失，不被當作歷史資料（見 Complexity Tracking）。 |
| **測試門檻** | ✅ PASS | 純函式單元測試：registry 判斷表、`job/status` 組裝、keepalive、reducer 收斂、`humanizeError` 對映、timing；另補整合與 e2e（見「測試策略」）。 |
| **可重播驗收** | ✅ PASS | e2e fake provider 可重播；[quickstart.md](./quickstart.md) 四個故障演練可在一鍵 demo 重現；mock producer 與 seed 不動。 |
| **Phase 化可追溯遞交** | ✅ PASS | tasks 依下方 phase 預告切分，每 phase 勾選後 commit，標題標記 phase。 |

**Post-design 複查（Phase 1 後）**：data-model 與 contracts 未新增 WS channel、package 或框架；新增的 api provider（`JobRoutingRegistry`、
`DiagnosisLookupService`）沿用 Nest DI 與既有模組；Redis 新鍵皆帶 TTL；契約變更皆為 optional 欄位與新 HTTP 端點。判定不變（兩項需記錄）。

---

## Project Structure

### Documentation (this feature)

```text
specs/012-stream-resilience/
├── plan.md                              # 本檔
├── spec.md                              # 含 Clarifications 兩輪
├── research.md                          # Phase 0：R1–R13 落地方式＋ P1–P25 plan／analyze 階段自行決定的設計點
├── data-model.md                        # Phase 1：契約型別、綁定與 claim 判斷表、Redis 鍵、Mongo、worker 步驟表、web 狀態
├── quickstart.md                        # Phase 1：單元／整合／e2e 指令與四個故障演練
├── contracts/
│   ├── job-lifecycle.contract.md        # job/status 1.4.0、relay 對映、ai/done 描述、ai/error code、傳輸型別
│   ├── diagnosis-lookup.contract.md     # GET /diagnoses/:jobId、錯誤碼、nginx、日誌
│   └── ui-copy.contract.md              # 面板文案、串流標題、GET 三種用途的對映（非通訊契約）
├── checklists/
│   ├── requirements.md                  # 既有（spec 品質檢查）
│   └── resilience.md                    # checklist 階段：韌性需求檢查表 52 項
└── tasks.md                             # Phase 2（/speckit-tasks 產出，非本指令）
```

### Source Code (repository root)

圖例：➕ 新增、✏️ 修改；括號為主要對應 FR。

```text
packages/contracts/src/
├── jobs.ts                         ✏️ DiagnosisJobReturnValueSchema、DiagnosisJobProgressSchema（FR-031）
├── jobs.test.ts                    ➕
├── job-status.ts                   ✏️ attempt／execution／reason／cached（FR-030）
├── http.ts                         ✏️ DiagnosisLookupParams／Query／ResponseSchema（FR-007、FR-032）
├── http.test.ts                    ✏️
└── asyncapi-drift.test.ts          ✏️ 加「reason 不是 enum」斷言（其餘比對自動涵蓋）
asyncapi.yaml                       ✏️ info.version 1.4.0、JobStatus payload、job/status 與 ai/done 描述、ai/error code、HTTP 摘要（FR-033）

apps/worker/src/
├── processor.ts                    ✏️ 回傳值、冪等短路、metric once、ai-result／persist_failed、ai-fail、keepalive、progress 物件（FR-001、003、019、020、024、026～028）
├── processor.test.ts               ✏️
├── main.ts                         ✏️ Worker<Payload, ReturnValue>、WORKER_LOCK_OPTIONS、failed handler 改 upsertTrigger（FR-018、025）
├── main.test.ts                    ✏️
├── diagnosis-repository.ts         ✏️ findDiagnosisResult、upsertTrigger、triggers jobId unique（FR-024、025）
├── diagnosis-repository.test.ts    ✏️
├── cache/redis-store.ts            ✏️ setIfAbsent（FR-026）
├── cache/redis-store.test.ts       ✏️
├── cache/job-keys.ts               ➕ ai-result／ai-metric／ai-fail 鍵與 TTL 常數
├── lib/bullmq-options.ts           ➕ LOCK_DURATION_MS／STALLED_INTERVAL_MS／MAX_STALLED_COUNT／KEEPALIVE_INTERVAL_MS（FR-018）
├── lib/bullmq-options.test.ts      ➕ 上界不變量 K + L + 2S < 45 s
├── lib/keepalive.ts                ➕ 10 s 閒置計時器（FR-019）
├── lib/keepalive.test.ts           ➕
└── integration/
    ├── diagnosis-repository.int.test.ts  ✏️ triggers unique＋upsert、findDiagnosisResult
    ├── redis-store.int.test.ts           ✏️ setIfAbsent
    └── bullmq-lifecycle.int.test.ts      ➕ 真 BullMQ：returnvalue／progress 物件經 QueueEvents 讀回、15／5／2 options

apps/api/src/
├── app.module.ts                                   ✏️ providers 加 JobRoutingRegistry、DiagnosisLookupService
├── modules/websocket/job-routing-registry.ts       ➕ 綁定、rebind、終態寬限、claim／revert、孤兒回收（FR-009、014）
├── modules/websocket/job-routing-registry.test.ts  ➕
├── modules/websocket/job-status-payload.ts         ➕ completed／progress 組裝純函式（FR-002、020）
├── modules/websocket/job-status-payload.test.ts    ➕
├── modules/websocket/job-status-relay.service.ts   ✏️ returnvalue、progress 物件、stalled、failed 寬限（FR-002、014、020、021）
├── modules/websocket/job-status-relay.service.test.ts ✏️
├── modules/websocket/ai-stream-relay.service.ts    ✏️ 移除 jobRooms，改查 registry
├── modules/websocket/ai-stream-relay.service.test.ts ✏️
├── modules/websocket/relays.test.ts                ✏️
├── modules/jobs/jobs.controller.ts                 ✏️ @Get(":jobId")（FR-007、008）
├── modules/jobs/jobs.controller.test.ts            ✏️
├── modules/jobs/diagnosis-lookup.service.ts        ➕ 先綁定後查詢、BullMQ → Mongo → 404（FR-009～013）
├── modules/jobs/diagnosis-lookup.service.test.ts   ➕
├── modules/jobs/jobs.service.ts                    ✏️ 改用 registry、terminal 寬限內 409（FR-014）
├── modules/jobs/jobs.service.test.ts               ✏️
├── modules/history/history.service.ts              ✏️ findDiagnosisResult 唯讀（FR-012）
├── modules/history/history.service.test.ts         ✏️
└── integration/diagnosis-reader.int.test.ts        ➕

apps/web/
├── nginx.conf                                      ✏️ diag_read 區與 GET regex location（FR-015）
├── PRODUCT.md                                      ✏️ 已知產品限制、失敗語意、新術語（FR-036、039）
└── src/
    ├── App.vue                                     ✏️ onAuthResult(true) → copilot.onAuthorized（FR-016）
    └── domains/ai-copilot/
        ├── lib/copilot-reducer.ts                  ✏️ 三來源收斂、lookup/result、execution／stalled、humanizeError、文案常數（FR-004～006、023、035、038）
        ├── lib/copilot-reducer.test.ts             ✏️
        ├── lib/diagnose-api.ts                     ✏️ getDiagnosis（FR-017）
        ├── lib/diagnose-api.test.ts                ✏️
        ├── lib/diagnosis-timing.ts                 ✏️ recovered 耗時（FR-035）
        ├── lib/diagnosis-timing.test.ts            ✏️
        ├── stores/copilot.store.ts                 ✏️ onReconnect／onAuthorized／lookup／checkStalls 退路、boundSocketIds（FR-005、016、022）
        ├── stores/copilot.store.test.ts            ✏️
        ├── components/CopilotDrawer.vue            ✏️ 說明行、取回 meta、串流標題（FR-035～038）
        └── components/CopilotDrawer.test.ts        ✏️

tests/e2e/
├── README.md                                       ✏️ 場景表、場景 3 語意、注意段（FR-039）
└── src/
    ├── harness/ws-client.ts                        ✏️ receivedAt、maxGap、getDiagnosis（FR-046）
    ├── harness/compose.ts                          ✏️ pause／unpause、restartApi、waitHealthy
    ├── harness/infra.ts                            ➕ pubsubKillLoop、countTriggers、countLlmCalls、workerReadyAt
    ├── worker-kill.e2e.test.ts                     ✏️ 3a／3b、maxGap < 45 s、記錄 W（SC-001）
    ├── pubsub-loss.e2e.test.ts                     ➕ 場景 5（SC-002）
    ├── api-restart.e2e.test.ts                     ➕ 場景 6a／6b（SC-003）
    ├── redis-pause.e2e.test.ts                     ➕ 場景 7（SC-004）
    └── diagnosis-lookup.e2e.test.ts                ➕ 場景 8（SC-005）

# 文件（merge 前回補，見「文件回補」）
README.md、CHANGELOG.md、CLAUDE.md、docs/adr-002-productionization-scope.md、docs/adr-003-completion-semantics.md、
docs/Flow-Gatekeeper-SDD-完整實作指南.md
```

**Structure Decision**：沿用既有 monorepo 佈局，不新增 package。api 的新能力依 Nest 慣例落位：綁定是 websocket 模組的共用狀態
（`job-routing-registry.ts` 與兩支 relay 同層），GET 是 jobs 模組的另一個 service（與 `JobsService` 並列）；worker 無 DI，新邏輯放 `lib/`、
`cache/` 並由 `createProcessor`／`bootstrap()` 組裝；web 依 `domains/ai-copilot/` 既有分層（純函式 lib＋薄殼 store＋元件）。

---

## 關鍵設計的落地方式

設計理由見 ADR-003 對應 D 點；細節見 research（R）、data-model（§）、contracts。

| 主題 | 落地 | 依據 |
| --- | --- | --- |
| 傳輸型別放哪 | `DiagnosisJobReturnValueSchema`、`DiagnosisJobProgressSchema` 放 `packages/contracts/src/jobs.ts`（與 `DiagnosisJobPayload` 同檔），api 與 worker 共用；relay 與 GET 讀回一律 `safeParse` | D1、D7；R1；[job-lifecycle §5](./contracts/job-lifecycle.contract.md) |
| `job/status` 擴充 | 四個 optional 欄位；`reason` 開放字串；`cached` 不 `refine`、由 relay 組裝函式保證（P8）；asyncapi `JobStatus` payload 同步、漂移測試自動比對 | D7；R1；[job-lifecycle §1](./contracts/job-lifecycle.contract.md) |
| GET schema | `http.ts`：`DiagnosisLookupParamsSchema`、`DiagnosisLookupQuerySchema`（`socketId` 必填、`previousSocketId` optional，皆 `z.uuid()`）、`DiagnosisLookupResponseSchema`（`status` discriminated union，四分支皆帶 `jobId`，P3） | D8；R1；[diagnosis-lookup §1、§4](./contracts/diagnosis-lookup.contract.md) |
| asyncapi 1.4.0 | `info.version`、`JobStatus` payload、`job/status`／`ai/done` 描述（D3 原文）、`AiError.code` 已知值、`info.description` 的 HTTP 摘要；`docs-contract-version.test.ts` 逼文件版本字串同步 | FR-033；R1 |
| `JobRoutingRegistry` | 新 provider；`bind`／`rebind`／`get`／`owner`／`isBound`／`noteProgress`／`markTerminal(kind)`（10 s 寬限，只刪同一份）／`delete`／`claimForLookup`／`resolveClaim`／`revertClaim`／`sweepOrphans`；寬限計時器與孤兒回收移入；不依賴 Gateway（`isOnline` 以參數傳入）；兩支 relay、`JobsService`、GET 都經它 | D8、D12；R3；[data-model §2](./data-model.md) |
| GET controller 流程 | 400（params／query）→ 409 `socket_unauthorized` → **同步 claim** → `Job.fromId`＋`getState`（5 s）→ completed（驗 `returnvalue`，不合法退 Mongo）／failed／進行中（`conflict` → 409 `job_bound_elsewhere`，否則 200 `rebound:true`）／無 job → Mongo → 404；非保留的 claim 一律撤回；Redis／Mongo 錯誤 503 | D8；FR-007～013；R4；[data-model §2.3、§2.4](./data-model.md) |
| `previousSocketId` | claim 判斷表第 5 列：原綁定在線但等於 `previousSocketId` → 比照離線改綁、不終止舊連線；web 以 `boundSocketIds` 記每個 job 最後一次成功綁定的 socketId，所有 GET 帶上 | 代理裁決第 17 條；FR-009、016 |
| worker keepalive | `lib/keepalive.ts`：每次執行一個 10 s 閒置計時器；`report(v)`（取代所有 `updateProgress(n)`）與 `onToken` 重設；到期送 `{ value: 目前里程碑, attempt, execution }`；失敗吞掉、每執行至多 warn 一則；不逐次記日誌 | D2；FR-019、020；R8 |
| 三種鍵與 TTL | `cache/job-keys.ts`：`ai-result:<jobId>` 3600 s、`ai-metric:<jobId>` 86400 s（`setIfAbsent`）、`ai-fail:<sig>` 10 s | D5、D6；[data-model §3](./data-model.md) |
| 冪等短路 | `report(0)` 後、`buildContext` 前：`ai-result` → Mongo `diagnoses`；命中即補 trigger、`report(100)`、`ai/done(cached:false)`、回傳；不建 context、不取鎖、不打 LLM | D6；FR-024；[data-model §5](./data-model.md) |
| trigger unique＋upsert | `ensureUniqueJobIdIndex` 泛化給 `diagnosisTriggers`；`upsertTrigger` 以 `$setOnInsert`；四個寫入點（快取命中、LLM、短路、failed handler）全改 | D6；FR-025；P10 |
| `persist_failed` | SET `ai-result` → `insertDiagnosis` 失敗 → `fail("persist_failed", "persist_failed: diagnosis record could not be written", true, err)`；重試由短路 (i) 只重做寫庫；Mongo 原始錯誤只進 `err` | D6；FR-027；代理裁決第 18 條 |
| `ai-fail` | LLM 階段三類失敗在 `fail()` 前寫；取鎖迴圈每輪開頭與取鎖後限流 INCR 前讀（P13）；自己的 jobId 忽略；命中 `fail(code, message, true)`；成功寫快取後 DEL | D5；FR-028；R7 |
| BullMQ 參數 | `lib/bullmq-options.ts` 具名常數 15000／5000／2，`main.ts` 展開；`lockRenewTime` 用預設；README 說明 | D4；FR-018；R8 |
| web 收斂 | reducer：帶 `result` 的 `completed`、`lookup/result` completed、`ai/done` 三者先到者轉 completed，之後忽略；未送達失敗可被三來源救回；`execution` 遞增清串流；`reason:"stalled"` 設說明行 | D10；FR-004～006；R9；[data-model §6](./data-model.md) |
| `onReconnect` 等授權後 GET | `onReconnect` 只標 `resume:"pending"`＋`reconnected`、加入 `pendingResume`；App 於 `onAuthResult(true)` 呼叫 `onAuthorized(socketId)` 逐台 GET | D10；FR-016；P20 |
| 2 s／watchdog 退路 | `checkStalls`：2 s 寬限到期 → `lookup(undelivered)`；45 s → `lookup(watchdog)`，回進行中則重設並 `console.warn`；`lookupInFlight` 去重 | D10、D11；FR-005、022；[ui-copy §3](./contracts/ui-copy.contract.md) |
| 文案對映 | 文案常數集中 reducer 檔；`humanizeError` 先判 `persist_failed`、`job stalled more than allowable limit`；GET 失敗依 purpose 對映 | FR-023、035；[ui-copy §1](./contracts/ui-copy.contract.md) |
| nginx `diag_read` | `limit_req_zone … zone=diag_read:1m rate=60r/m`；`location ~ "^/diagnoses/[0-9a-fA-F-]{36}$"`（`burst=10 nodelay`、429、不寫 `add_header`），放在 `location /diagnoses` 之前 | D9；FR-015；R5 |

---

## 測試策略

### 對應 SC 的測試清單

| SC | 單元（不需 Docker） | 整合（需 `docker compose up -d`） | e2e（需 Docker，`pnpm test:e2e`） |
| --- | --- | --- | --- |
| SC-001 SIGKILL 最長無事件 < 45 s | `bullmq-options.test.ts`（`K + L + 2S` 不變量）、`keepalive.test.ts`、processor（等待鎖與首 token 前的補送）、relay `stalled` 轉發 | `bullmq-lifecycle.int.test.ts`（options 生效、progress 物件讀回） | 場景 3a（串流中 kill）、3b（progress 20 時 kill，P24）：`maxGap < 45 s`、印 `W` |
| SC-002 Pub/Sub 斷線仍以 result 完成 | processor 回傳值形狀；`job-status-payload.test.ts`（合法／不合法／null）；relay `completed` 三分支；reducer `completed+result` | `bullmq-lifecycle.int.test.ts`（returnvalue 經 QueueEvents 讀回） | 場景 5：容器內 50 ms 迴圈 `CLIENT KILL TYPE pubsub` |
| SC-003 api 重啟續接 | registry claim（無綁定 → created）、lookup service（進行中 → 200 rebound、completed → 撤回）、store `onReconnect`／`onAuthorized` | — | 場景 6a（期間完成 → 200 completed）、6b（停 worker → 200 waiting → 收到 completed，P18） |
| SC-004 Redis 停頓 50 s：trigger 1、LLM 1、hit／miss 1、cached false | processor：stalled 重派情境的短路、metric once、trigger upsert | `diagnosis-repository.int.test.ts`（unique＋upsert、併發 upsert）、`redis-store.int.test.ts`（`setIfAbsent`） | 場景 7：第 3 個 token 後 `compose pause redis` 50 s（research P25）、`countTriggers`、`countLlmCalls`（`LLM call` 日誌，FR-047）、`cacheCounters`（窗內 hit／miss 加總，FR-046） |
| SC-005 GET 七種回應 | `job-routing-registry.test.ts`（判斷表 6 列、撤回只撤自己）、`diagnosis-lookup.service.test.ts`（200×3、400、404、409×2、503、`returnvalue` 不合法退 Mongo、`previousSocketId` 改綁、先綁定後查詢：查詢期間到的 `completed` 送得到新連線）、`jobs.controller.test.ts`（400 形狀）、contracts `http.test.ts` | `diagnosis-reader.int.test.ts`（`removeOnComplete` 後由 Mongo 取回的讀取端） | 場景 8：404、409 `job_bound_elsewhere`、`previousSocketId` → 200、409 `socket_unauthorized`、400（非 UUID socketId）、他人查已完成 → 200 |
| SC-006 四種完成順序收斂 | reducer 四順序 × `result`／`cached`／`jobId` 相同、store 耗時只結算一次、`CopilotDrawer` 公告只一次；AR-6 救回擴充到三來源 | — | — |
| SC-007 同簽章失敗 ≤ 4 次 LLM | processor（fake store／timer／provider）：兩 job 持續錯誤、錯誤碼相同、`ai-rpm` 不因第二個 job 增加、自己的標記忽略、成功時 DEL | `redis-store.int.test.ts`（`ai-fail` TTL 10 s） | — |
| SC-008 persist_failed、failed 寬限 | processor：`insertDiagnosis` 拒寫 → LLM 1 次、最終 `persist_failed`、訊息不夾帶原始錯誤；relay：`failed` 後 10 s 內的 `ai/error` 仍轉發；reducer `humanizeError` | 可選：Mongo validator 拒寫 | — |
| SC-009 keepalive 10 s ± 1 s | `keepalive.test.ts`（fake timer）、processor（等鎖、首 token 前、寫庫期間）、relay progress 物件拆成 `active` | — | （場景 3 的 `maxGap` 間接佐證） |
| SC-010 契約與文件一致 | contracts `jobs.test.ts`、`http.test.ts`、`asyncapi-drift.test.ts`、`docs-contract-version.test.ts` | — | — |
| SC-011 不退步 | 既有全部單元；`pnpm test:coverage` 十個核心檔門檻 | 既有整合 | 場景 1／2／4a／4b 照過 |

### e2e harness 需要新增的 helper

| helper | 檔案 | 做法 | 用於 |
| --- | --- | --- | --- |
| 收到時間戳 | `ws-client.ts` | `ParsedMessage` 加 `receivedAt: number`（`performance.now()`） | 所有場景 |
| `maxGap(jobId, from?, to?)` | `ws-client.ts` | 該 job 的 `job/status`＋`ai/*` 相鄰收到時間差的最大值 | 3a／3b |
| `getDiagnosis(jobId, socketId, previousSocketId?)` | `ws-client.ts` | `fetch(BASE_URL + /diagnoses/…)`，回 `{ status, body }` | 6、8 |
| 重連流程 | `ws-client.ts` | 舊 client 關閉後新建 `E2eClient`、`connect`＋`subscribe`，取新 `clientId` | 6a／6b |
| `pauseRedis()`／`unpauseRedis()` | `compose.ts` | `compose(["pause","redis"])`／`unpause` | 7 |
| `restartApi()`＋`waitHealthy("api")` | `compose.ts` | `compose(["restart","api"])` 後輪詢 `compose ps --format json` 直到 healthy | 6a／6b |
| `stopWorker()`／`startWorker()` | `compose.ts` | 既有 `compose()` 包裝 | 3、6b |
| `pubsubKillLoop(seconds)` | `infra.ts` | `compose exec -T redis sh -c '…while…; redis-cli CLIENT KILL TYPE pubsub; sleep 0.05; done'`（容器內迴圈，P19），背景執行、場景結束 await | 5 |
| `countTriggers(jobId)` | `infra.ts` | `compose exec -T mongo mongosh --quiet <MONGO_DB> --eval …countDocuments({jobId})` | 7 |
| `countLlmCalls(jobId)` | `infra.ts` | `compose logs --no-color worker` 逐行 JSON parse，數 `msg === "LLM call"` 且 `jobId` 相符 | 7 |
| `workerReadyAt(after)` | `infra.ts` | `compose logs --timestamps worker` 找 `after` 之後第一則 `worker ready` | 3a／3b（記錄 W） |
| `cacheCounters(from, to)` | `infra.ts` | `compose logs --timestamps --no-color worker` 逐行 JSON parse，加總時間落在 `(from, to]` 的 `worker metrics summary` 之 `cache.hits + cache.misses`（窗內值、結算後歸零，不能取 `system/metrics` 前後相減）；`from` 取 POST 前等到的一則 summary（窗界，避免前一場景的計數混進同一窗）、`to` 取完成後第一則 summary；e2e override 把 api 與 worker 的 `METRICS_INTERVAL_MS` 設 5000（下限，兩端須相同），等窗界最多 5 s（FR-046） | 7 |

場景各自一個檔（全套循序）。nginx POST 桶（10 r/m、burst 5）：全套 POST 由 5 次增為約 11 次，但新場景每檔耗時 ≥ 30 s，期間回補 ≥ 5 次，
不加自動重試；GET 走獨立 60 r/m 桶。

---

## Phase 2 預告（由 `/speckit-tasks` 產出）

| Phase | 內容 | 對應 |
| --- | --- | --- |
| 1. Setup | 無新相依；確認基線、BullMQ 5.79.2 能力與 busybox 小數秒 | — |
| 2. Foundational | 契約 1.4.0（三個 contracts 檔、asyncapi、漂移與版本測試）；`JobRoutingRegistry` 抽出（行為不變的重構＋`failed` 寬限）；`bullmq-options.ts`／`keepalive.ts`／`job-keys.ts` 純函式與單測（尚未接線）；e2e harness helper | FR-014、030～033、046 |
| 3. US1 | worker 回傳值；relay `completed` 讀 `returnvalue`；web reducer 三來源收斂（GET 退路留到 US2）；e2e 場景 1／2 斷言、場景 5 | FR-001～005；SC-002 |
| 4. US2 | GET（lookup service、controller、Mongo 唯讀）、nginx `diag_read`；web `getDiagnosis`、`onReconnect`／`onAuthorized`、2 s 與 watchdog 退路、文案；e2e 場景 6a／6b、8 | FR-005、007～017、022、035～038；SC-003、SC-005 |
| 5. US4 | 冪等短路、trigger unique＋upsert、metric once、`ai-result`／`persist_failed`；e2e 場景 7 撰寫（執行點在 US3 checkpoint） | FR-024～027；SC-004 |
| 6. US3 | 鎖參數接線、keepalive 接線、progress 物件、relay `stalled`、web 說明行與 stalled 上限文案（**MUST 在 US4 之後**）；e2e 場景 3a／3b、執行場景 7 | FR-018～023；SC-001 |
| 7. US5 | `ai-fail` | FR-028、029 |
| 8. US6 | `attempt`／`execution` 的 web 消費與「嘗試 N / 3」 | FR-006 |
| 9. 文件回補 | 下節「文件回補」與 ADR-003 本文同步 | FR-039～041 |
| 10. Polish | `pnpm check`／`test:coverage`／整合測試／`test:e2e` 全套、quickstart 演練 | FR-044；SC-010、SC-011 |

e2e 場景隨各 story 交付（不另立 e2e phase）；與 tasks.md 的 phase 切分一致（analyze 階段修正 2026-10-21）。

---

## 風險

1. **D4 上界依賴實測冷啟動 `W`**：35 s 上界在 `W ≤ L`（15 s）時成立；`W` 為 compose 重啟延遲＋Node 載入＋Mongo 連線＋建索引＋Redis ready，
   預估 3～8 s 但未實測。**處置**：e2e 場景 3a／3b 印出 `W` 與 `maxGap`；quickstart 演練 1 手動記錄一次。`15 s < W < 25 s` 時上界改為
   `K + W + 2S`，仍 < 45 s；`W ≥ 25 s` 即上界破功（合併門第 2 輪更正等號：`W` 正好 25 s 時上界等於 45 s），回報使用者（候選：縮短 worker 冷啟動，或把 watchdog 門檻改由 `system/connected` 下發，屬 010-lite）。
   `diagnosisTriggers` 新增 unique 索引會讓第一次啟動多一次建索引時間，計入 `W`。
2. **`lockDuration` 縮短造成的雙重執行**：Redis 卡頓或 worker 事件迴圈被佔住 > 15 s 就觸發 stalled 重派，同 jobId 雙重執行比現在常見。
   **處置**：US4 冪等先於 US3 落地（phase 5 → 6）；e2e 場景 7 驗「trigger 1、LLM 1、hit／miss 1」；`maxStalledCount` 2 留一次額度。殘餘：
   停頓 > 45 s 且落在 LLM 串流中時可能再打一次 LLM（ADR-003 §4，接受）（已變更：ADR-003 §4 改寫為「停頓開始於取得 `ai-lock` 之後、送出 LLM 請求之前，且長於 `AI_DEDUPE_LOCK_SECONDS`」）。另需注意 fake provider 與 context 查詢都不應同步阻塞事件迴圈
   > 7.5 s（續租間隔）；processor 沒有同步重運算，風險低。（合併門第 2 輪更正：續租計時器每約 3.75 s 觸發，事件迴圈阻塞超過約 11.25～15 s 才會讓 lock 過期，見 ADR-003 D4。）
3. **`previousSocketId` 的安全邊界**：它讓「原綁定仍在線」的進行中任務也能被改綁，前提是請求者知道原 socketId。clientId 只經
   `system/connected` 送給連線本身，不出現在 URL 以外的地方；但 GET 的 query 會出現在 nginx access log（與 jobId 相同的既有曝險，
   ADR-002 §6.3）。能讀 log 的人可同時取得 jobId 與 previousSocketId，進而在原連線仍在線時搶走進行中的串流——後果是 demo 的 mock 診斷
   結果被另一條已授權連線收到。**處置**：接受（與 jobId 即 bearer capability 同一模型、同一曝險面）；不主動終止舊連線，原分頁仍收得到
   已送出的 token；記於 CHANGELOG 相容性注意與 README「已知限制」。不採「`previousSocketId` 必須已離線」：那正是代理裁決第 17 條要解的半開連線情境。
4. **舊新混跑**：「舊 api＋新 worker」時 progress 物件不被舊 relay 認得，進度條退化為 indeterminate。**處置**：CHANGELOG 寫明升級順序
   「先 api、後 worker」；其餘組合由容錯分支吸收（research R12）。一鍵 demo 同時重建，不受影響。
5. **逐檔覆蓋率門檻**：程式自 `ai-stream-relay.service.ts`、`job-status-relay.service.ts` 移到 registry 後，兩檔分母變小、門檻可能波動。
   **處置**：以補測試維持，不調低門檻；registry 本身以判斷表窮舉測試。
6. **Redis 凍結 > 45 s 時畫面先顯示「結果未知」**：見 research R13；這是 D11 的預期語意，quickstart 演練 4 寫明。

---

## 文件回補（merge 回 `develop` 前 MUST；取自 ADR-003 §6）

- [x] ADR-002 §6.2「生產路徑：改用 Redis Streams」改寫為「已拒絕（2026-10-21，ADR-003）」；「已變更」註記收斂；「更正」段的「沒有讀取端點」標已落地。
- [x] ADR-002 §3 第 5 列加「已變更（012-lite）」。
- [x] ADR-002 §6.5「結果讀取與完成語意」列改「已落地（012-lite，ADR-003）」＋一句摘要；92 秒實測改過去式；升級路徑指 ADR-003 §5。
- [x] ADR-002 §6.5「api 行程內單實例狀態」列：`JobRoutingRegistry` 已移（012-lite），外置見 ADR-003 §5。
- [x] ADR-002 §6.5.1 WK-4／AR-F4 列標已落地；「review03 新增：失敗終態沒有 relay 寬限」列標已落地（D12）。
- [x] ADR-002 §6.5.1 末尾補「review03 roadmap 012-lite：已落地」列（AR-4、AR-S7、WK-13、WK-4 補強、AR-5 根治含失敗終態寬限、WK-20、WEB-20 attempt 部分、DOC-29）。
- [x] ADR-002 §6.1 單實例狀態第 4 項改指 `JobRoutingRegistry`。
- [x] 指南 §15.7 狀態改「已落地」；§15.6「e2e 實測發現（留給 012-lite）」條加已落地註記；§15.6 現況摘要補 012-lite；§16.3 第 6 列「目前無結果讀取端點」改寫；§17「streaming 推不到前端」列的「重連後舊 jobId 不會改綁」改寫。
- [x] README「已知限制」四條改寫（重連以 jobId 續接、快取命中 1 h 後 GET 404、上界約 35 s／45 s 才標結果未知、at-most-once 重連後直接顯示結果）＋補「重新整理頁面後不續接」；「第三輪審查的現況」把 012-lite 各項移到已修。
- [x] README 資料表：`diagnoses`「目前只寫不讀」改寫、`diagnosisTriggers` 補 jobId unique、Redis 職責補 `ai-fail:*`／`ai-result:*`／`ai-metric:*`；契約版本字串 1.3.0 → 1.4.0；nginx GET 60 r/m 獨立桶；BullMQ 參數具名常數說明；`previousSocketId` 與 jobId 進 access log 的曝險（風險 3）。
- [x] `apps/web/PRODUCT.md`：已知產品限制改寫（含「重新整理頁面後不續接」）、失敗段改為 2 s 退路先 GET、新術語（重新排入佇列（內部稱重新派送）、取回、結果未知）。
- [x] `tests/e2e/README.md`：場景表（3a／3b、5～8）、場景 3 的現況語意、「注意」段（GET 獨立桶、新場景與耗時；實測約 4.6 分鐘（278 s，第 3 輪），規劃時估 10～15 分鐘）。
- [x] `asyncapi.yaml`（FR-033）與 `CHANGELOG.md`（FR-034：契約 1.4.0、相容性注意四條＋升級順序、`[2.1.0]` 帶著發布的 012-lite 項標已修）。
- [ ] 憲章 Principle III 補列 GET：**建議**、待使用者；merge 前仍未確認則 spec 與 ADR-003 保留「建議修訂、待使用者」註記（FR-041）。（2026-10-22 合併門第 1 輪：保留未勾——憲章修訂待使用者確認）
- [x] ADR-003：§6 勾選；§7 補記 plan／analyze 階段的 P1～P25（第 22 條起，待覆核）；檔頭「待覆核」註保留到使用者覆核（FR-040）。
- [ ] repo `CLAUDE.md` 開頭現況段：落地後改為最近一次完成的 feature。（2026-10-22 合併門第 1 輪：保留未勾——merge 時改（T076））

---

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
| --- | --- | --- |
| 憲章 III 的列舉只涵蓋 `POST /diagnoses`，新增的 `GET /diagnoses/:jobId` 不在條文內（需記錄，非違反） | 重連續接與 Pub/Sub 遺失的退路都需要讀取端點（US2、US1 情境 3） | 「不加 GET、只靠 `job/status.result`」解不了 api 重啟（QueueEvents 從 `$` 讀、錯過重啟期間的 `completed`）；改用 WS 控制訊息 `job/resume` 要新增第 13 個 channel（ADR-003 D8 方案 D）。處置：GET 照樣以 Zod 定義 query 與成功回應，憲章補列為建議 PATCH，待使用者以 `/speckit-constitution` 決定（FR-041，不在本 feature 自動執行） |
| 憲章 VII：`ai-result:<jobId>` 讓診斷結果短暫只存在 Redis（需記錄，非違反） | 寫庫失敗時不重打 LLM（WK-4 補強，每 job 省 2 次計費） | 只加 `persist_failed`、接受重打（Mongo 拒寫時每 job 3 次 LLM 全數計費，2.1.0 已揭露的成本問題不消失）；先寫快取再寫 `diagnoses`（重試會回 `cached:true`、`diagnoses` 永遠缺這筆）。處置：TTL 1 h、寫庫成功即 DEL；寫庫終究失敗時 job 以 `persist_failed` 收尾，副本不被當作歷史資料 |
| 新增兩個 api provider（`JobRoutingRegistry`、`DiagnosisLookupService`） | 綁定原由三處共用一個 Map、owner 不清；rebind、claim／撤回與終態寬限需要單一實作與窮舉測試 | 把 rebind 寫進 `AiStreamRelayService`（GET 與 job-status relay 都要跨服務改它的內部狀態，責任更混）；GET 塞進 `JobsService`（覆蓋率門檻檔、入列與讀取混在一起） |
