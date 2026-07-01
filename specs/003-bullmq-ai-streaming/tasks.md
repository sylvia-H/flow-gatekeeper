---
description: "Task list for 003-bullmq-ai-streaming implementation"
---

# Tasks: 診斷任務佇列、AI 串流診斷與 Redis 快取

**Input**: Design documents from `/specs/003-bullmq-ai-streaming/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/jobs.contract.md,
contracts/ai-relay.contract.md, quickstart.md

**Tests**: 本 feature **要求**至少一支實際純函式單元測試（spec FR-018）。下列 T010、T023 為必需
測試任務（非 optional）；其餘行為以 quickstart 手動驗收。

**Organization**: 依 user story（US1 P1 / US2 P2 / US3 P3）分相，使每相為可獨立驗收的增量。範圍
動 `apps/api`（jobs module + AI/job-status relay）、`apps/worker`（BullMQ 處理主體）、
`packages/contracts`（jobs 契約）與 `.env.example`。`apps/web` 不在本 feature。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 可平行（不同檔案、無未完成相依）
- **[Story]**: US1 / US2 / US3；Setup、Foundational、Polish 無 story 標籤
- 每個任務含明確檔案路徑

## Path Conventions

monorepo：`apps/api/src/...`、`apps/worker/src/...`、`packages/contracts/src/...`、repo 根的
`.env.example`。

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: 補齊本 feature 需要的相依、指令與環境範例

- [X] T001 在 `apps/api/package.json` 新增相依 `@nestjs/bullmq`、`bullmq`、`ioredis`（api 端產 job 與 QueueEvents／psubscribe 轉發）
- [X] T002 在 `apps/worker/package.json` 新增相依 `mongodb`、`@google/generative-ai`、`dotenv` 與 devDependency `tsx`；`scripts` 新增 `"start:dev": "tsx watch src/main.ts"` 與 `"smoke:gemini": "tsx src/ai/smoke-gemini.ts"`
- [X] T003 在 `.env.example` 的「AI provider」段新增 `AI_TIMEOUT_MS=30000`（其餘 `GEMINI_*`／`AI_RPM`／`AI_CACHE_TTL_SECONDS`／`AI_DEDUPE_LOCK_SECONDS`／`REDIS_*` 已存在）
- [X] T004 於 repo 根執行 `pnpm install` 安裝新相依並更新 `pnpm-lock.yaml`（依賴 T001、T002 同檔，須先完成）

**Checkpoint**: 相依與環境範例就緒，可開始 Foundational。

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: 契約擴充（contract-first）與 api/worker 的共用骨架——所有 user story 的前提

**⚠️ CRITICAL**: 完成本相之前，任何 user story 不得開工

- [X] T005 [P] 新增 `packages/contracts/src/jobs.ts`：`export const DIAGNOSIS_QUEUE = 'diagnosis'` 與 `DiagnosisJobPayload` 型別（`jobId`/`machineId`/`requestedBy`/`requestedAt`/`windowMinutes`/`promptVersion`，依 contracts/jobs.contract.md）；在 `packages/contracts/src/index.ts` 補 `export * from './jobs.js'`；`pnpm --filter @flow-gatekeeper/contracts build` 更新 dist 供 api/worker 取用
- [X] T006 [P] 新增 `apps/worker/src/redis.ts`：`createRedisConnection()`（`ioredis`，`host/port` 取自 `REDIS_HOST`/`REDIS_PORT`，`maxRetriesPerRequest: null`），供 main 產出分離的 queue/pub/cache 連線（憲章 IV、research D3）
- [X] T007 [P] 新增 `apps/worker/src/ai/provider.ts`：`AiProvider` interface（`streamDiagnosis(prompt, onToken): Promise<string>`；JSON 解析與 schema 驗證**不在** provider 內，憲章 V、research D4）
- [X] T008 擴充 `apps/api/src/modules/config/config.service.ts`：新增 `redisHost`(預設 `127.0.0.1`)、`redisPort`(預設 6379) 型別化 getter，供 jobs module 與 subscriber 連線使用

**Checkpoint**: 契約已擴充（api/worker 皆 import 得到 `DIAGNOSIS_QUEUE`/`DiagnosisJobPayload`）、Redis 連線工廠與 provider interface 就緒。

---

## Phase 3: User Story 1 - 觸發診斷並即時看到串流結果與任務狀態 (Priority: P1) 🎯 MVP

**Goal**: `POST /diagnoses` 建立 job → worker 讀 Mongo 脈絡、透過 `AiProvider` 串流診斷 → 每個 token
經 Redis Pub/Sub → Gateway 轉給發起連線 → 最終結果經 `DiagnosisResultSchema.parse()` 驗證後
`ai/done` 並寫 `diagnoses`；job 生命週期經 QueueEvents 組 `job/status` 推回。

**Independent Test**: 對有近期歷史的機台 POST `/diagnoses`，取得 `jobId` 後於即時通道依序收到
`ai/token`（seq 遞增）→ `ai/done`（含通過 schema 的 result），並收到 `job/status` waiting→active→completed
（對應 SC-001）；schema 驗證失敗時收到 `ai/error`（SC-007）。

### Tests for User Story 1 (FR-018 必需)

- [X] T009 [P] [US1] 新增純函式 `apps/worker/src/lib/parse-result.ts`：`parseResult(text): DiagnosisResult`——由串流文字抽第一個 `{` 到最後一個 `}`，`JSON.parse` 後 `DiagnosisResultSchema.parse()`；無 JSON 或驗證失敗則 throw（FR-012）
- [X] T010 [P] [US1] 新增 `apps/worker/src/lib/parse-result.test.ts`（Vitest）：斷言合法 JSON 通過、無 `{}`／壞 JSON／缺欄位丟錯（SC-007／SC-009 佐證）

### Implementation for User Story 1

- [X] T011 [P] [US1] 新增 `apps/worker/src/ai/prompt.ts`：`buildPrompt({machineId, context})` 依指南 §8.9 產出含近期 errorlogs/telemetry 彙總/maintenance 的 prompt，並要求回傳指定 JSON 結構
- [X] T012 [P] [US1] 新增 `apps/worker/src/context/context-builder.ts`：`buildDiagnosisContext({mongo, machineId, windowMinutes})` 讀 `telemetry` 彙總（avg/max temperature/vibration/errorRate + count）、近 5 筆 `errorlogs`、近 3 筆 `maintenanceRecords`、最近 1 筆的 `latestState`，並組 `topErrorCodes`（供 US2 簽章；本相僅回傳、暫不用於 cache）
- [X] T013 [US1] 新增 `apps/worker/src/ai/gemini-provider.ts`：`GeminiProvider implements AiProvider`（`@google/generative-ai` `generateContentStream`，逐 chunk 呼叫 `onToken` 並累加回傳全文），以 `AI_TIMEOUT_MS`（預設 30000）包一層逾時（`Promise.race`／`AbortController`），逾時 throw（FR-020，依賴 T007）
- [X] T014 [US1] 新增 `apps/worker/src/ai/smoke-gemini.ts`：`import 'dotenv/config'`，用 `GEMINI_API_KEY`/`GEMINI_MODEL` 呼叫一次 `generateContent` 印出回覆（FR-017，接 queue 前的護欄）
- [X] T015 [US1] 改寫 `apps/worker/src/main.ts`（US1 compute path，**尚無 cache**）：`import 'dotenv/config'`；用 `createRedisConnection()` 產 `queueConnection`/`pub`；連 Mongo；`const ai: AiProvider = new GeminiProvider(...)`；`new Worker(DIAGNOSIS_QUEUE, processor, { connection: queueConnection })`；processor：`buildDiagnosisContext` → `buildPrompt` → `ai.streamDiagnosis`（每 token `pub.publish('ai-stream:<jobId>', {type:'ai/token',seq,text})`）→ `parseResult`（try/catch：失敗 `publish {type:'ai/error',code:'schema_invalid',...}` 後 throw）→ 寫 `diagnoses`(`cached:false`) + `diagnosisTriggers`(`cached:false`) → `publish {type:'ai/done',cached:false,result}`；`updateProgress(5/20/100)`（依賴 T006/T011/T012/T013/T009）
- [X] T016 [P] [US1] 新增 `apps/api/src/modules/jobs/jobs.module.ts`：`BullModule.forRoot`（connection 取 `redisHost`/`redisPort`，`maxRetriesPerRequest: null` 供 BullMQ blocking 操作）+ `BullModule.registerQueue({ name: DIAGNOSIS_QUEUE })`；export 供 JobsService 注入。註：T020 的 `QueueEvents` 另建**獨立 blocking 連線**、與此 producer 連線分離（憲章 IV／F4）
- [X] T017 [US1] 新增 `apps/api/src/modules/websocket/ai-stream-relay.service.ts`：`OnModuleInit` 建**專用 subscriber**（`ioredis`）`psubscribe('ai-stream:*')`；`jobRooms: Map<jobId,{clientId,machineId,boundAt}>` 與 `bindJobToClient(jobId, clientId, machineId)`（`socketId===clientId`，見 data-model §4）；`pmessage` → 取 `jobId` → 查 `clientId` → `gateway.send(clientId, event)`。**本 relay 只轉發、不清綁定**——避免 `ai/done`（早於 QueueEvents `completed`）先清掉綁定，害 T020 的 `job/status:completed` 查不到對象（F1）。綁定清理由 T020 單一負責（依賴 002 的 `MonitoringGateway.send`）
- [X] T018 [US1] 新增 `apps/api/src/modules/jobs/jobs.service.ts`：`createDiagnosis(machineId, requestedBy, socketId)`——`jobId=randomUUID()`；`relay.bindJobToClient(jobId, socketId, machineId)`；**組完整 `DiagnosisJobPayload`**（勿漏欄位，依 data-model §1.1）：`{ jobId, machineId, requestedBy: requestedBy ?? 'demo-user', requestedAt: new Date().toISOString(), windowMinutes: 5, promptVersion: 'diagnosis-v1' }`（`windowMinutes` 預設 5、`promptVersion` 預設 `'diagnosis-v1'`）；`queue.add('diagnose-machine', payload, { jobId, attempts:3, backoff:{type:'exponential',delay:5000}, removeOnComplete:{age:3600,count:1000}, removeOnFail:{age:86400,count:5000} })`；回 `{ jobId, machineId, status:'waiting' }`（依賴 T016/T017）
- [X] T019 [US1] 新增 `apps/api/src/modules/jobs/jobs.controller.ts`：`@Controller('diagnoses')` `@Post()` 接 `{ machineId, requestedBy?, socketId }`，委派 `JobsService.createDiagnosis`（**開發階段免授權**，FR-021；`requestedBy` 預設 `'demo-user'`，依賴 T018）
- [X] T020 [US1] 新增 `apps/api/src/modules/websocket/job-status-relay.service.ts`：以**獨立 blocking 連線**建 `QueueEvents(DIAGNOSIS_QUEUE)`（`ioredis` `maxRetriesPerRequest: null`，與 T016 的 producer 連線分離，憲章 IV／F4）監聽 `waiting`/`active`/`completed`/`failed`/`progress` → 組 `JobStatus`（`machineId` 由 relay 綁定 Map 取得）→ `gateway.send(clientId, jobStatus)`。**本 relay 為綁定清理的單一 owner**：僅在 `completed`/`failed`（job 的最終終態，晚於 `ai/done`）後 `delete(jobId)`，確保終態 `job/status` 一定送得出去（F1）；另加一個以 `boundAt` 為準的定期掃描，回收超過安全期（如 10 分鐘）仍未終態的孤兒綁定，避免 QueueEvents 異常時 Map 洩漏（依賴 T017）
- [X] T021 [US1] 更新 `apps/api/src/modules/jobs/jobs.module.ts` 掛入 `JobsController`/`JobsService`，並在 `apps/api/src/app.module.ts` `imports: [JobsModule]`、`providers` 加 `AiStreamRelayService`、`JobStatusRelayService`（注入 `MonitoringGateway`）；`pnpm --filter @flow-gatekeeper/api typecheck` 通過

**Checkpoint**: US1 可獨立驗收——MVP 達成（觸發→串流→結構化結果→job 狀態）。

---

## Phase 4: User Story 2 - 可重複情境命中快取、不重複消耗 LLM 額度 (Priority: P2)

**Goal**: worker 呼叫 LLM 前先以簽章查 cache，命中直接回 `ai/done`(`cached:true`)且不打 LLM、不重寫
`diagnoses`（僅記 `diagnosisTriggers`）；同簽章並發以 `ai-lock` 去重；worker limiter 保護 `AI_RPM`。

**Independent Test**: 同機台同狀態連兩次 POST，第二次 `ai/done` 帶 `cached:true` 且 worker 無新 LLM
呼叫（SC-002）；一分鐘連發 20 個，實際 LLM 呼叫 ≤ `AI_RPM`（SC-003）；同簽章並發只 1 次真呼叫
（SC-004）。

### Tests for User Story 2 (FR-018 必需)

- [X] T022 [P] [US2] 新增純函式 `apps/worker/src/cache/signature.ts`：`buildDiagnosisSignature({machineId,state,topErrorCodes,promptVersion,model})`——`topErrorCodes` 排序後 `JSON.stringify` → `sha256` 取前 24 hex（指南 §8.7）
- [X] T023 [P] [US2] 新增 `apps/worker/src/cache/signature.test.ts`（Vitest）：斷言相同輸入決定性一致、`topErrorCodes` 順序不影響、不同 `state`／不同 `topErrorCodes`／不同 `model` 產生不同簽章（SC-009）

### Implementation for User Story 2

- [X] T024 [US2] 在 `apps/worker/src/main.ts` 加入 cache-aside 與去重（依賴 T015/T022）：用 `createRedisConnection()` 產 `cache` 連線；processor 內以 `buildDiagnosisSignature` 算 `sig`——**五個欄位全帶**：`machineId`、`state=context.latestState`、`topErrorCodes=context.topErrorCodes`、`promptVersion=payload.promptVersion`、`model=GEMINI_MODEL`（勿漏 `promptVersion`／`topErrorCodes`，否則簽章與 data-model §2 不一致）；`replyCached()`：`cache.get('ai-cache:'+sig)` 命中 → `publish {type:'ai/done',cached:true,result}` + 寫 `diagnosisTriggers`(`cached:true`) + `updateProgress(100)` 後回 `true`（**不**寫 `diagnoses`，FR-013/FR-013a），未命中回 `false`；miss → 進入**「取鎖或等待」迴圈**：`cache.set('ai-lock:'+sig,'1','EX',AI_DEDUPE_LOCK_SECONDS,'NX')` 取鎖；取到鎖者算完後 `cache.set('ai-cache:'+sig, result,'EX',AI_CACHE_TTL_SECONDS)`、`finally` `cache.del('ai-lock:'+sig)`；**取不到鎖者**有界輪詢 `replyCached()`（間隔如 300ms、總等待上限如 `AI_DEDUPE_LOCK_SECONDS` + 緩衝）等他人算完共用（SC-004）——**若輪詢期間鎖已消失但 cache 仍為空（持鎖者逾時／崩潰，FR-006／Edge Case），MUST 重新嘗試 `SET ai-lock … NX`：搶到鎖者改走計算路徑重算，未搶到者繼續輪詢**，確保「放行重算」、不永久卡死
- [X] T025 [US2] 在 `apps/worker/src/main.ts` 的 `Worker` options 加入 `concurrency: 2` 與 `limiter: { max: Number(process.env.AI_RPM ?? 8), duration: 60_000 }`（FR-003／SC-003，同檔接 T024）

**Checkpoint**: US1 + US2 皆可獨立驗收——串流診斷 + 快取/去重/限流。

---

## Phase 5: User Story 3 - Worker 隔離：耗時工作不拖垮即時服務 (Priority: P3)

**Goal**: 診斷工作全在 worker process；worker 停擺/崩潰時 API 與即時通道不崩潰、待恢復後消化積壓；
失敗任務依 `attempts`/指數退避重試，用盡後 `ai/error` 通知。

**Independent Test**: worker 未運行時 POST `/diagnoses` → API 仍回 `jobId`、ws 不崩潰、job 進 waiting；
重啟 worker 後積壓被消化（SC-005）；處理中途關 worker，API/ws 存活（SC-006）。

### Implementation for User Story 3

- [ ] T026 [US3] 在 `apps/worker/src/main.ts` 加入 `worker.on('failed', (job, err) => publish {type:'ai/error',code:'worker_failed',message})`（`attempts` 用盡後通知），以及 `SIGTERM`/`SIGINT` 優雅關閉：`worker.close()` → `mongo.close()` → 各 Redis 連線 `quit()`（同檔接 T025；確保崩潰/關閉不殘留、可被 BullMQ 重派）
- [ ] T027 [US3] 強化 api 端 relay 韌性：`ai-stream-relay.service.ts` 與 `job-status-relay.service.ts` 的 `onModuleInit` 以 try/catch 包 subscribe/QueueEvents 初始化並 Logger 記錄，確保 worker/Redis 狀態異常時 **api 仍能啟動**且 `POST /diagnoses` 照回 `jobId`（SC-005/SC-006，跨 T017/T020 兩檔）

**Checkpoint**: 三個 user story 皆可獨立驗收。

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: 跨故事的驗證與品質門檻

- [ ] T028 [P] 於 repo 根執行 `pnpm contract:lint`（asyncapi 未新增 WS 訊息，維持 0 違規）、`pnpm -r typecheck`、`pnpm -r lint`：全 workspace 通過、無 `any` 洩漏
- [ ] T029 [P] 執行 `pnpm --filter @flow-gatekeeper/worker test` 與全 workspace 測試：`parse-result`（T010）與 `signature`（T023）通過（FR-018/SC-009）
- [ ] T030 補齊 FR-019 記錄（worker `main.ts` + api jobs/relays）：任務建立、任務進入處理、快取命中、LLM 呼叫、任務完成、任務失敗六類事件分 `log`/`warn`/`error` 記錄
- [ ] T031 本機驗收（依 quickstart.md）：`smoke:gemini`（Step 0）→ 觸發串流（SC-001，含首個 token ≤ 5 秒）→ cache hit（SC-002）→ 20 連發限流與並發去重（SC-003/SC-004）→ worker 韌性（SC-005/SC-006，**明確驗證：worker 停機時入列的 job，於 worker 重啟後被消化**）→ 驗證失敗路徑（SC-007）→ `diagnoses`/`diagnosisTriggers` 追溯（SC-008）；記錄已觀察與未量測項

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: 無相依，立即可開始
- **Foundational (Phase 2)**: 依賴 Setup 完成——**阻擋所有 user story**
- **User Stories (Phase 3–5)**: 皆依賴 Foundational 完成
  - 因 worker `main.ts` 與 api relay 為跨相共用檔，建議**依優先序 P1 → P2 → P3** 進行
- **Polish (Phase 6)**: 依賴所有目標 user story 完成

### User Story Dependencies

- **US1 (P1)**: Foundational 後即可開始；為 MVP，端到端串流診斷的最小可行路徑（無 cache）
- **US2 (P2)**: 在 US1 的 worker processor 上加 cache/lock/limiter；驗收（cache hit/限流/去重）獨立可測
- **US3 (P3)**: 在 US1 的 job 建立與 relay 上加失敗處理/優雅關閉/韌性；驗收（worker 韌性）獨立可測

### Within Each User Story

- 純函式測試（T010、T023）與其對應純函式（T009、T022）一起完成，先寫測試再實作
- provider/context/prompt/parse 純模組先於掛入 worker processor（T013/T012/T011/T009 → T015）
- api：jobs.module/relay 先於 service/controller（T016/T017 → T018 → T019）

### Parallel Opportunities

- Foundational：T005（contracts）/T006（redis）/T007（provider）不同檔，可平行；T008 為 api 端獨立
- US1：T009+T010（parse 純函式+測試）、T011（prompt）、T012（context）彼此不同檔，可平行；T016（jobs.module）與 worker 端任務不同 app，可平行
- US2：T022+T023（signature 純函式+測試）可與 US1 收尾平行準備
- Polish：T028（lint/typecheck）與 T029（測試）可平行
- 同檔不可平行：worker `main.ts` 的 T015 → T024 → T025 → T026 **必須依序**；api `ai-stream-relay.ts` 的 T017 → T027、`job-status-relay.ts` 的 T020 → T027 依序

---

## Parallel Example: Foundational 骨架

```bash
# 同時進行（不同檔）：
Task: "新增 packages/contracts/src/jobs.ts + index re-export + build"   # T005
Task: "新增 apps/worker/src/redis.ts 連線工廠"                          # T006
Task: "新增 apps/worker/src/ai/provider.ts AiProvider interface"        # T007
```

## Parallel Example: US1 純模組 + 測試

```bash
# 彼此獨立檔案，可平行：
Task: "lib/parse-result.ts + lib/parse-result.test.ts"   # T009 + T010
Task: "ai/prompt.ts buildPrompt"                          # T011
Task: "context/context-builder.ts buildDiagnosisContext"  # T012
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. 完成 Phase 1 Setup（相依/指令/env 範例）
2. 完成 Phase 2 Foundational（jobs 契約 + redis 工廠 + provider interface，阻擋所有故事）
3. 完成 Phase 3 US1（端到端串流診斷）
4. **STOP & VALIDATE**：用 quickstart Step 0–2 獨立驗收（smoke → 觸發 → 串流 → 結構化結果）
5. 即可作為可展示 MVP

### Incremental Delivery

1. Setup + Foundational → 地基就緒
2. US1 → Step 1–2 驗收 → MVP demo
3. US2 → Step 3–4 驗收（cache hit / 限流 / 去重）
4. US3 → Step 5 驗收（worker 韌性）
5. Polish → 全工件 lint/typecheck/test + Step 6–8 手動驗收

### Phase 化遞交（憲章 / CLAUDE.md）

`/speckit-implement` 期間每完成一個 Phase 即勾選並 commit，標題標記 phase；大 phase（如 US1）可依
「worker 純模組 / worker processor / api jobs+relay」拆成數個同 phase commit，使 git 歷史能還原
建置順序。

---

## Notes

- [P] = 不同檔、無相依；同檔任務一律依序
- worker `main.ts` 為跨多相中心檔，務必依 T015 → T024 → T025 → T026 順序演進（compute → cache/lock → limiter → 失敗/關閉）
- contract-first：T005 MUST 先於任何 api/worker 對 `DIAGNOSIS_QUEUE`/payload 的使用
- 雙通道分流：token 走 Pub/Sub（T017）、job 生命週期走 QueueEvents（T020），MUST NOT 混流（憲章 IV）
- Redis 連線分離：worker queue/pub/cache（T006 產出）+ api subscriber（T017），subscriber MUST NOT 跑一般 command（憲章 IV）
- cache-hit MUST NOT 重寫 `diagnoses`，僅記 `diagnosisTriggers`（FR-013/FR-013a，T024）
- 祕密：`GEMINI_API_KEY` 只放本機 `.env`，只提交 `.env.example`（憲章 VI，T003）
- 每個 task 或邏輯群組完成後 commit；於各 checkpoint 可停下獨立驗收
