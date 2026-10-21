---
description: "Task list for 012-lite 串流韌性（Stream Resilience）"
---

# Tasks: 012-lite 串流韌性（Stream Resilience）

**Input**: `specs/012-stream-resilience/` 的 [spec.md](./spec.md)（FR-001～FR-047、SC-001～SC-011）、[plan.md](./plan.md)、[research.md](./research.md)（R1～R13、P1～P25）、[data-model.md](./data-model.md)、[contracts/](./contracts/)、[quickstart.md](./quickstart.md)；設計依據 [ADR-003](../../docs/adr-003-completion-semantics.md)（D1～D13、§6、§7 第 1～21 條）

**Prerequisites**: plan.md、spec.md、[checklists/resilience.md](./checklists/resilience.md)（52/52 通過，checklist 階段已修 spec 的 11 處見其 Notes）

**Tests**: 本專案要求純函式單元測試作為驗收佐證（憲章「測試門檻」、spec FR-045），測試任務與實作任務並列；整合測試標 **[Docker]**（需 `docker compose up -d`），e2e 場景標 **[Docker/e2e]**（需 Docker Desktop，`corepack pnpm test:e2e`，全套約 10～15 分鐘，不在 CI）。

**Organization**: 依 user story 分 phase；**US4 排在 US3 之前**（鎖參數調小會讓重複執行變常見，冪等 MUST 先到位，spec「US3 MUST 與 US4 同批交付」、plan 風險 2）。

## Format: `- [ ] T### [P] [US#] 描述（檔案路徑）`

- **[P]**：可與同 phase 其他 [P] 任務平行（不同檔、無未完成相依）
- **[US#]**：所屬 user story；Setup、Foundational、文件回補、Polish 不標
- 每個任務末尾括號標對應的 FR／SC／research 點；「相依」寫在描述內
- 指令以 PowerShell 為準，pnpm 以 `corepack pnpm` 呼叫（quickstart §0）

## Path Conventions

pnpm monorepo：`packages/contracts/src/`、`apps/api/src/`、`apps/worker/src/`、`apps/web/src/`、`tests/e2e/src/`；文件在 repo 根與 `docs/`。

---

## Phase 1: Setup

**Purpose**：無新相依；確認基線與 plan 的前提成立，不改產品程式。

- [X] T001 確認基線：`corepack pnpm check`、`corepack pnpm test:coverage` 綠；`docker compose up -d` 後 `corepack pnpm --filter @flow-gatekeeper/worker test:integration` 與 `--filter @flow-gatekeeper/api test:integration` 綠；任何一項紅就停下回報（不在本 feature 修既有紅燈）。結果記入本檔文末「驗收紀錄」（`specs/012-stream-resilience/tasks.md`）
- [X] T002 [P] 確認 BullMQ 版本為 5.79.2（`pnpm-lock.yaml`），並讀 `node_modules/bullmq/dist/esm/classes/queue-events.js` 確認 `completed` 事件帶已 parse 的 `returnvalue`、有 `stalled` 事件；不符即停下回報（ADR-003 §5「BullMQ 升 6.x 須重驗」）。結果記入「驗收紀錄」（`specs/012-stream-resilience/tasks.md`）
- [X] T003 [P] [Docker] 確認 redis 映像的 busybox 接受小數秒：`docker compose exec -T redis sh -c 'sleep 0.05 && echo ok'`；不接受時改用 `usleep 50000` 並把結論補進 research P19 的「理由」欄（`specs/012-stream-resilience/research.md`）

**Checkpoint**：基線綠、BullMQ 能力確認；可開始 Foundational。

---

## Phase 2: Foundational（Blocking Prerequisites）

**Purpose**：契約 1.4.0、`JobRoutingRegistry` 抽出（行為不變的重構＋`failed` 終態寬限）、worker 傳輸型別與尚未接線的純函式模組、e2e harness helper。

**⚠️ CRITICAL**：任何 user story 都要等本 phase 完成。

### 契約 1.4.0（U-contracts）

- [X] T004 [P] 在 `packages/contracts/src/jobs.ts` 新增 `DiagnosisJobReturnValueSchema`（`{ result: DiagnosisResultSchema, cached: z.boolean() }`）與 `DiagnosisJobProgressSchema`（`value` int 0–100、`attempt` int ≥ 1、`execution` int ≥ 1）及 `z.infer` 型別，`packages/contracts/src/index.ts` re-export；新檔 `packages/contracts/src/jobs.test.ts`：合法樣本、`value` 越界、`attempt: 0`、`result` 不合 schema、缺 `cached` 皆 `safeParse` 失敗（FR-031；contracts/job-lifecycle §5）
- [X] T005 [P] 在 `packages/contracts/src/job-status.ts` 的 `JobStatusSchema` 加 optional `attempt`、`execution`（`z.number().int().min(1)`）、`reason`（`z.string()`，JSDoc 列已知值 `"stalled"`）、`cached`（`z.boolean()`）；不以 `refine` 綁「帶 result 必帶 cached」（P8）；新檔 `packages/contracts/src/job-status.test.ts`：四欄缺省可過、`reason: "anything"` 可過、`attempt: 0` 失敗、舊形狀（無新欄位）可過（FR-030；contracts/job-lifecycle §1）
- [X] T006 [P] 在 `packages/contracts/src/http.ts` 新增 `DiagnosisLookupParamsSchema`（`jobId: z.uuid()`）、`DiagnosisLookupQuerySchema`（`socketId: z.uuid()`、`previousSocketId: z.uuid().optional()`）、`DiagnosisLookupResponseSchema`（`status` discriminated union：completed `{ jobId, result, cached }`／failed `{ jobId, error }`／waiting、active `{ jobId, progress?, attempt?, execution?, rebound: z.literal(true) }`）與 `z.infer` 型別；`packages/contracts/src/http.test.ts` 補四分支合法樣本、`rebound: false` 失敗、非 UUID `socketId`／`previousSocketId` 失敗、缺 `jobId` 失敗（FR-007、FR-032；P3、P22；contracts/diagnosis-lookup §1、§4）
- [X] T007 更新 `asyncapi.yaml`：`info.version` 1.3.0 → **1.4.0**；`components.messages.JobStatus.payload` 補 `attempt`／`execution`（integer, minimum 1）、`reason`（string）、`cached`（boolean），四者不進 `required`；`channels.job/status` 與 `channels.ai/done` 的 `subscribe.description` 換成 contracts/job-lifecycle §3 原文（修 DOC-29）；`AiError.code` 加 `description` 列已知值（含新增 `persist_failed`）；`info.description` 補 `GET /diagnoses/:jobId` 語意摘要（200 四種、400、404、409 兩種 `code`、429、503）。相依 T005、T006（FR-033；FR-032 錯誤 body 依憲章 III 例外 (b)）
- [X] T008 在 `packages/contracts/src/asyncapi-drift.test.ts` 新增斷言「`JobStatus.payload.properties.reason` 沒有 `enum`」，跑 `corepack pnpm --filter @flow-gatekeeper/contracts test` 確認漂移測試綠（`docs-contract-version.test.ts` 此時會紅，由 T009 收）。相依 T007（FR-033、SC-010；contracts/job-lifecycle §6）
- [X] T009 （U-contracts 代 U-docs，Phase 2-1 收尾、接在 T008 之後）只同步「現況版本宣稱」字串到 1.4.0，讓 `docs-contract-version.test.ts` 回綠：`README.md`、`docs/Flow-Gatekeeper-SDD-完整實作指南.md`（§7 現況註記、§15.6 契約版本）的 `` `info.version` `` 宣稱；`CHANGELOG.md` `[Unreleased]` 先開「契約 1.4.0」小節標題與一行摘要（完整內容於 T074）。不動歷史敘述。相依 T007（SC-010）

### `JobRoutingRegistry` 抽出（U-api-registry）

- [X] T010 新檔 `apps/api/src/modules/websocket/job-routing-registry.ts`（`@Injectable()`）：`JobBinding = { clientId, machineId: string | null, boundAt, terminal?: { kind: "completed" | "failed"; at }, attempt?, execution?, deferred? }`；方法 `bind`／`rebind`（更新 `boundAt`，P23；回傳被取代的舊綁定）／`get`／`owner`／`isBound`／`noteProgress`／`markTerminal(jobId, kind, now?)`（10 s 後只刪「同一份物件」）／`delete`／`sweepOrphans(now)`；常數 `TERMINAL_BINDING_GRACE_MS = 10_000`（取代 `COMPLETED_BINDING_GRACE_MS`，不留別名）、`ORPHAN_TTL_MS` 移入；寬限計時器與孤兒回收 interval 於 `onModuleInit`／`onModuleDestroy` 啟停；不依賴 Gateway（FR-014；R3；data-model §2.1、§2.2）
- [X] T011 新檔 `apps/api/src/modules/websocket/job-routing-registry.test.ts`（fake timer）：bind／get／owner；`markTerminal("completed")` 與 `("failed")` 皆 10 s 後刪；寬限內同 jobId 重新 bind 後，舊計時器不誤刪新綁定；`rebind` 回傳舊綁定並更新 `boundAt`；孤兒回收自 `boundAt` 起算 10 分鐘；`onModuleDestroy` 清計時器。相依 T010（FR-014、SC-008）
- [X] T012 改寫 `apps/api/src/modules/websocket/ai-stream-relay.service.ts`：移除 `jobRooms`、`bindJobToClient`、`getBinding`、`markCompleted`、`deleteBinding`，`handleMessage` 改查 `registry.owner(jobId)`；同步改 `apps/api/src/modules/websocket/ai-stream-relay.service.test.ts` 與 `apps/api/src/modules/websocket/relays.test.ts`（行為不變）。相依 T010（FR-014）
- [X] T013 改寫 `apps/api/src/modules/websocket/job-status-relay.service.ts`：`emit`、`handleDelayed`、`keepDelayedAlive` 改查 registry，移除本檔 `sweepOrphans`（移入 registry）；`handleCompleted` 結尾 `registry.markTerminal(jobId, "completed")`；`handleFailed` 照舊先送 `ai/error(worker_failed)` 再送 `failed`，結尾改 `markTerminal(jobId, "failed")`（不再立即刪，D12）；`apps/api/src/modules/websocket/job-status-relay.service.test.ts` 與 `relays.test.ts` 補「`failed` 後 10 s 內抵達的 `ai/error(persist_failed)` 仍轉發到原連線、10 s 後不再轉發」。相依 T012（`relays.test.ts` 共用，串行）（FR-014、SC-008；代理裁決第 12 條）
- [X] T014 改寫 `apps/api/src/modules/jobs/jobs.service.ts`：`JobBindingStore` 型別改為 `Pick<JobRoutingRegistry, "bind" | "get" | "delete">`，`existing.completedAt` 判斷改為 `existing.terminal !== undefined`（`completed`／`failed` 寬限內 POST 皆 409）；把私有 `withTimeout` 移到新檔 `apps/api/src/modules/jobs/with-timeout.ts` 並匯出（GET 於 T034 共用），`ENQUEUE_TIMEOUT_MS` 維持從 `jobs.service.ts` 匯出；POST 409 內嵌的「WebSocket 連線不存在或未授權，請重新連線後再發起診斷」抽成匯出常數 `SOCKET_UNAVAILABLE_MESSAGE`（GET 於 T034 import，analyze 階段補 2026-10-21）；`apps/api/src/app.module.ts` providers 加 `JobRoutingRegistry`；`apps/api/src/modules/jobs/jobs.service.test.ts` 補「`failed` 寬限內同 jobId POST → 409」。相依 T010（FR-014；R3）

### worker 傳輸型別與純函式模組（U-worker，尚未接線）

- [X] T015 [P] 新檔 `apps/worker/src/lib/bullmq-options.ts`：`LOCK_DURATION_MS = 15_000`、`STALLED_INTERVAL_MS = 5_000`、`MAX_STALLED_COUNT = 2`、`KEEPALIVE_INTERVAL_MS = 10_000`、`WORKER_LOCK_OPTIONS = { lockDuration, stalledInterval, maxStalledCount }`（不設 `lockRenewTime`）；檔頭註解寫 D4 公式 `K + L + 2S` 與「任一值調整須重算」；新檔 `apps/worker/src/lib/bullmq-options.test.ts` 斷言 `K + L + 2S ≤ 35_000` 且 `< 45_000`（FR-018、SC-001；R8；ADR-003 D4）
- [X] T016 [P] 新檔 `apps/worker/src/lib/keepalive.ts`：`createKeepalive({ intervalMs, onIdle, onError?, timers? })`（實作備註 2026-10-21：`onError` 為交叉審查後補的選填參數，承接 P12「每次執行至多一則 warn」；在途一輪未 settle 時略過本輪、固定節拍） 回 `{ touch(), stop() }`；閒置 `intervalMs` 呼叫 `onIdle` 後重新排程；`onIdle` 拋錯或 reject 吞掉、每個實例至多回報一次（交由呼叫端 warn，P12）；新檔 `apps/worker/src/lib/keepalive.test.ts`（`vi.useFakeTimers`）：10 s 無 touch 觸發一次、touch 重設、連續閒置每 10 s 觸發、`stop()` 後不再觸發、`onIdle` 失敗不中斷排程（FR-019、SC-009；R8）
- [X] T017 [P] 新檔 `apps/worker/src/cache/job-keys.ts`：`aiResultKey(jobId)`（`ai-result:`）、`aiMetricKey(jobId)`（`ai-metric:`）、`aiFailKey(sig)`（`ai-fail:`）與 `AI_RESULT_TTL_SECONDS = 3600`、`AI_METRIC_TTL_SECONDS = 86_400`、`AI_FAIL_TTL_SECONDS = 10`；新檔 `apps/worker/src/cache/job-keys.test.ts` 斷言鍵格式與 TTL（FR-026～FR-028、FR-043；data-model §3）
- [X] T018 [P] 在 `apps/worker/src/cache/redis-store.ts` 的 `ProcessorStore` 新增 `setIfAbsent(key, value, ttlSeconds): Promise<boolean>`（`SET NX EX`，回 OK 才 true）；`apps/worker/src/cache/redis-store.test.ts` 補單元案例；**[Docker]** `apps/worker/src/integration/redis-store.int.test.ts` 補「第二次 `setIfAbsent` 回 false、TTL 生效」（FR-026；P9）
- [X] T019 （實作備註 2026-10-21：`main.test.ts` 的 `FailedJobLike` 不含 `attemptsStarted`，不需補；只補 `processor.test.ts` 與整合測試的 fake job）worker 傳輸型別：`apps/worker/src/processor.ts` 的 `ProcessorJob` 介面加 `attemptsStarted: number`，`updateProgress` 參數型別放寬為 `number | DiagnosisJobProgress`（回傳型別留到 T023）；`apps/worker/src/processor.test.ts` 與 `apps/worker/src/main.test.ts` 的 fake job 補 `attemptsStarted`；`corepack pnpm --filter @flow-gatekeeper/worker typecheck` 綠。相依 T004（FR-020、FR-031；R8）

### e2e harness helper（U-nginx-e2e，只需 typecheck，不需 Docker）

- [X] T020 [P] 擴充 `tests/e2e/src/harness/ws-client.ts`：`ParsedMessage` 加 `receivedAt: number`（`performance.now()`）；新增 `maxGap(jobId, from?, to?)`（該 job 的 `job/status`＋`ai/*` 相鄰收到時間差最大值）、`getDiagnosis(jobId, socketId, previousSocketId?)`（`fetch(BASE_URL + "/diagnoses/…")` 回 `{ status, body }`）、`reconnectClient(old, machineIds)`（關舊連線、新建 `E2eClient`、`connect`＋`subscribe`，回新 client 與 `clientId`）。相依 T006（FR-046；plan「e2e harness」）
- [X] T021 [P] 擴充 `tests/e2e/src/harness/compose.ts`：`pauseRedis()`／`unpauseRedis()`、`restartApi()`、`waitHealthy(service, timeoutMs)`（輪詢 `compose ps --format json` 至 healthy）、`stopWorker()`／`startWorker()`（FR-046；D13、代理裁決第 6 條）
- [X] T022 [P] 新檔 `tests/e2e/src/harness/infra.ts`：`pubsubKillLoop(seconds)`（redis 容器內 `sh -c` 迴圈每 50 ms `redis-cli CLIENT KILL TYPE pubsub`，背景執行回 Promise，P19；有 `REDIS_PASSWORD` 時帶 `-a`）、`countTriggers(jobId)`（`mongosh --quiet` `countDocuments({ jobId })`）、`countLlmCalls(jobId)`（`compose logs --no-color worker` 逐行 JSON parse，數 `msg === "LLM call"` 且 `jobId` 相符）、`workerReadyAt(after)`（`compose logs --timestamps worker` 找 `after` 之後第一則 `worker ready`）、`nextMetricsSummary(after)`（等到 `after` 之後第一則 `worker metrics summary`，回其時間戳，作為窗界）、`cacheCounters(from, to)`（`compose logs --timestamps --no-color worker` 逐行 JSON parse，加總時間落在 `(from, to]` 的 `worker metrics summary` 之 `cache.hits + cache.misses`；這組計數是每窗結算後歸零的窗內值，且 Redis 停頓期間 Redis 快照寫不進去，MUST NOT 改成取 `system/metrics` 前後兩次相減，spec FR-046）；`docker-compose.e2e.yml` 的 api 與 worker `environment` 加 `METRICS_INTERVAL_MS: "5000"`（下限，兩端須相同；等窗界最多 5 s）；`corepack pnpm --filter @flow-gatekeeper/e2e typecheck` 綠（FR-046、FR-047；SC-001、SC-004；analyze 階段補 `cacheCounters` 2026-10-21）（實作備註 2026-10-21：密碼改走 `REDISCLI_AUTH` 環境變數而非 `-a`，避免密碼進行程參數；時間取 pino 每行 `time` 欄位（`compose logs --no-log-prefix`）而非 `--timestamps`，兩者皆容器時鐘；`workerReadyAt` 改以容器側時間或基線則數判定，避免 host／VM 時鐘混用；實測 kill 迴圈每輪約 75～85 ms）

**Checkpoint**：契約 1.4.0 與漂移／版本測試綠；registry 抽出後既有 api 測試全綠（行為只多 `failed` 寬限）；worker 新模組有單測但未接線；e2e harness 可編譯。建議 commit：`feat(012): [Phase 2: Foundational] 契約 1.4.0…`、`refactor(012): [Phase 2: Foundational] 抽出 JobRoutingRegistry…`、`feat(012): [Phase 2: Foundational] worker BullMQ 參數、keepalive 與鍵常數模組`、`test(012): [Phase 2: Foundational] e2e harness 時間戳與故障注入 helper`。

---

## Phase 3: User Story 1 - 後端完成的診斷，畫面一定看得到結果（Priority: P1）🎯 MVP

**Goal**：完成以 BullMQ `returnvalue` 為權威；Pub/Sub 斷線時畫面仍以帶 `result` 的 `job/status: completed` 收尾；`ai/done` 重複或順序不同都收斂到同一狀態。

**Independent Test**：e2e 場景 5（Pub/Sub 每 50 ms 斷線）以帶 `result` 的 `completed` 收尾；web 單元測試覆蓋三種到達順序與 `ai/done` 重複（第四種「無 result → GET」在 US2 補）。

- [X] T023 [US1] `apps/worker/src/processor.ts`：processor 回傳型別改 `Promise<DiagnosisJobReturnValue>`；快取命中路徑（`replyCached`）與 LLM 路徑（`callLlmAndReply`）都回 `{ result, cached }`（`result` 為已通過 `DiagnosisResultSchema` 者），維持「trigger → `updateProgress(100)` → `ai/done` → return」順序；`apps/worker/src/main.ts` 改 `new Worker<DiagnosisJobPayload, DiagnosisJobReturnValue>`；`apps/worker/src/processor.test.ts` 補兩路徑回傳值形狀、`DiagnosisJobReturnValueSchema.safeParse` 通過、呼叫順序斷言（FR-001、FR-003；D1）
- [X] T024 [P] [US1] 新檔 `apps/api/src/modules/websocket/job-status-payload.ts`：純函式 `completedStatus({ jobId, machineId, returnvalue, binding })` → `{ status: JobStatus; issues?: { path; code }[] }`：`DiagnosisJobReturnValueSchema.safeParse` 通過時帶 `result`、`cached` 與綁定上已知的 `attempt`／`execution`（P7），不通過或 `null` 時不帶 `result` 並回 issues（只路徑與代碼）；新檔 `apps/api/src/modules/websocket/job-status-payload.test.ts`：合法、不合法、`null`、`undefined`、帶 result 必帶 cached（FR-002、FR-030；P7、P8）
- [X] T025 [US1] `apps/api/src/modules/websocket/job-status-relay.service.ts`：`completed` 監聽改收 `({ jobId, returnvalue })` 並呼叫 `completedStatus`，驗證失敗記 warn（`jobId`＋issues，不記原文）後照送不帶 `result` 的 `completed`，最後 `markTerminal`；`job-status-relay.service.test.ts` 補三分支（合法／不合法／缺值）與「MUST NOT 轉發未驗證物件」。相依 T013、T024（FR-002、SC-002；憲章 V）
- [X] T026 [P] [US1] `apps/web/src/domains/ai-copilot/lib/copilot-reducer.ts`：completed 狀態加 `source: "ai/done" | "status" | "lookup"` 與 `streamIncomplete: boolean`；`job/status` completed 且帶 `result` → completed（`cached ?? false`、`source: "status"`、`streamIncomplete: true`），不帶 `result` 維持 active；`ai/done` → completed（`source: "ai/done"`、`streamIncomplete: state.reconnected === true`，`reconnected` 欄位於 T039 加入前視為 false）；「結果未送達」救回擴充到帶 `result` 的 `completed`；文案常數 `STREAM_LABEL_INCOMPLETE`；`apps/web/src/domains/ai-copilot/lib/copilot-reducer.test.ts` 補 `ai/done`→`completed+result`、`completed+result`→`ai/done`、`ai/done` 重複兩次三種順序收斂（`result`／`cached`／`jobId` 相同）與 `cached` 缺值當 false（FR-004、FR-005、FR-038、SC-006；data-model §6.2；代理裁決第 11、15 條）
- [X] T027 [US1] `apps/web/src/domains/ai-copilot/stores/copilot.store.ts`：`applyEvent` 對帶 `result` 的 `completed` 照 `ai/done` 路徑收尾（清 2 s 未送達計時起點 `backendCompletedAt`、`settleTiming` 只呼叫一次）；之後同 jobId 的 `ai/done` 不再結算；`apps/web/src/domains/ai-copilot/stores/copilot.store.test.ts` 補「兩來源都到、耗時只結算一次」「帶 result 的 completed 不觸發 2 s 未送達」。相依 T026（FR-004、SC-006）
- [X] T028 [US1] `apps/web/src/domains/ai-copilot/components/CopilotDrawer.vue`：completed 且 `streamIncomplete` 時串流標題用 `STREAM_LABEL_INCOMPLETE`（`StreamDisclosure.vue` 只吃 `label`，不改）；`apps/web/src/domains/ai-copilot/components/CopilotDrawer.test.ts` 補標題四態，`apps/web/src/domains/ai-copilot/components/CopilotDrawer.watch.test.ts` 補「`completed+result` 後再到 `ai/done`，螢幕閱讀器公告只一次」。相依 T026（FR-035、FR-038、SC-006；contracts/ui-copy §2）
- [X] T029 [US1] [Docker/e2e] `tests/e2e/src/diagnosis.e2e.test.ts`：場景 1 斷言 `completed` 帶通過 `DiagnosisResultSchema` 的 `result` 與 `cached: false`；場景 2 斷言 `completed` 帶 `cached: true`；場景 4a／4b 不變。相依 T023、T025（SC-002、SC-011）
- [X] T030 [US1] [Docker/e2e] 新檔 `tests/e2e/src/pubsub-loss.e2e.test.ts`（場景 5）：POST 後立即 `pubsubKillLoop(20)`，斷言以帶 `result` 的 `job/status: completed` 收尾、`result` 通過 schema、無 `ai/error`；`ai/done` 可有可無。相依 T022、T029（SC-002；quickstart 演練 2）

**Checkpoint**：US1 可獨立驗收——Pub/Sub 故障不再造成假失敗；2 s「結果未送達」路徑行為暫同 2.1.0（GET 退路於 US2）。建議 commit：`feat(012): [Phase 3: US1] worker 回傳值與 relay 以 returnvalue 完成`、`feat(012): [Phase 3: US1] web 三來源先到者收尾`、`test(012): [Phase 3: US1] e2e 場景 5 Pub/Sub 斷線`。

---

## Phase 4: User Story 2 - 重連或 api 重啟後，續接原本的診斷（Priority: P1）

**Goal**：`GET /diagnoses/:jobId?socketId=[&previousSocketId=]` 讀回結果並改綁進行中任務；web 在授權成功後逐台續接；2 s 未送達與 45 s watchdog 先 GET 一次。

**Independent Test**：e2e 場景 6a／6b（api 重啟）與場景 8（GET 回應形狀）；api／web 單元測試覆蓋 claim 判斷表、七種回應與三種 GET 用途。

### api（U-api-registry → U-api-lookup）

- [ ] T031 [US2] `apps/api/src/modules/websocket/job-routing-registry.ts` 新增 `claimForLookup({ jobId, socketId, previousSocketId, isOnline })` → `LookupClaim`（kind `created`／`terminal`／`unchanged`／`rebound`（含 `viaPreviousSocketId`）／`conflict`，依 data-model §2.3 六列順序、同步執行）、`resolveClaim(claim, machineId)` → `{ deferred }`（補 `machineId: null` 綁定，P1）、`revertClaim(claim)`（以參照比對，只撤回自己建立或改綁的那份）；`job-routing-registry.test.ts` 窮舉六列、撤回只撤自己（他人已改綁時不還原；撤回時綁定已被 `markTerminal` 標為 terminal 就不還原原綁定）、`previousSocketId` 等於在線原綁定 → `rebound` 且不終止舊連線（FR-009、FR-010、SC-005；代理裁決第 17 條；P1、P22、P23）
- [ ] T032 [US2] `apps/api/src/modules/websocket/job-status-relay.service.ts` 的 `emit`：綁定 `machineId === null` 時不送、在 registry 記 `deferred: true`（P1）；`job-status-relay.service.test.ts` 補擱置與補上 machineId 後照常送。相依 T031（FR-009；R13 最後一點）
- [ ] T033 [P] [US2] `apps/api/src/modules/history/history.service.ts` 新增唯讀 `findDiagnosisResult(jobId): Promise<unknown | null>`（`diagnoses.findOne({ jobId }, { projection: { result: 1 }, maxTimeMS: 3000 })`，db 未就緒即 reject，不建索引）；`apps/api/src/modules/history/history.service.test.ts` 補案例；**[Docker]** 新檔 `apps/api/src/integration/diagnosis-reader.int.test.ts`：讀真 Mongo 取回 worker 形狀的文件、查無回 null（FR-012；P5）
- [ ] T034 [US2] 新檔 `apps/api/src/modules/jobs/diagnosis-lookup.service.ts`（`DiagnosisLookupService.lookup({ jobId, socketId, previousSocketId })`），依 research R4 步驟：`gateway.isAuthorized(socketId)` 為 false → 409 `{ code: "socket_unauthorized", message: <POST 同句> }`（句子 import 自 `jobs.service.ts` 的匯出常數 `SOCKET_UNAVAILABLE_MESSAGE`（T014 抽出），不複製字串）；**任何 await 之前** `registry.claimForLookup`；`withTimeout(Job.fromId → getState, ENQUEUE_TIMEOUT_MS)`（`with-timeout.ts`）；`created` 時 `resolveClaim` 回 `deferred` 就再查一次 state；completed → 驗 `returnvalue`（不合法 warn 後退 Mongo，代理裁決第 16 條）、failed → `failedReason`、waiting／delayed／prioritized／waiting-children／active → `conflict` 回 409 `job_bound_elsewhere`，否則 200 `rebound: true`（progress 以 `DiagnosisJobProgressSchema`／number 解析、`attempt = attemptsMade + 1`、`execution = attemptsStarted`）；無 job → `reader.findDiagnosisResult` 經 `DiagnosisResultSchema` → 200 completed（`cached: false`）或 404；Redis／Mongo 錯誤或逾時 → 503；非保留 claim 一律 `revertClaim`；日誌依 contracts/diagnosis-lookup §7（rebind、衝突 409 為 info，`socket_unauthorized` 沿用 POST 的 30 s 全域節流 warn）。相依 T014、T031、T033（FR-008～FR-013、FR-047；P2、P4）
- [ ] T035 [US2] 新檔 `apps/api/src/modules/jobs/diagnosis-lookup.service.test.ts`（fake queue／reader／presence／registry 實體）：200 completed／failed／active／waiting、404、409 `socket_unauthorized`、409 `job_bound_elsewhere`、503（Redis 逾時、Mongo 錯誤）、`returnvalue` 不合法退 Mongo、Mongo 結果不合法 → 404、`previousSocketId` 等於在線原綁定 → 200 `rebound`、已完成任務原綁定在線也照常回、**先綁定後查詢**（`Job.fromId` 未 resolve 前觸發 relay `completed`，事件送到新 socket）、`deferred` 再查一次、每種非保留結果都撤回暫定動作。相依 T034（FR-045、SC-005）
- [ ] T036 [US2] `apps/api/src/modules/jobs/jobs.controller.ts` 新增 `@Get(":jobId")`：以 `DiagnosisLookupParamsSchema`／`DiagnosisLookupQuerySchema` `safeParse` `@Param()`／`@Query()`，失敗回 400（`issues[]` 只帶 path 與 code、不回顯輸入；重複 query key 解析成陣列 → 400），依賴 `DiagnosisLookup = Pick<DiagnosisLookupService, "lookup">`；`apps/api/src/app.module.ts` providers 加 `DiagnosisLookupService`（owner 交接見「實作單位切分建議」）；`apps/api/src/modules/jobs/jobs.controller.test.ts` 補 400 形狀、委派 lookup。相依 T034（FR-007、SC-005；contracts/diagnosis-lookup §5）

### nginx（U-nginx-e2e）

- [X] T037 [P] [US2] `apps/web/nginx.conf`：檔頭新增 `limit_req_zone $binary_remote_addr zone=diag_read:1m rate=60r/m;`（附 Docker Desktop 共用一桶註解）；在 `location /diagnoses` **之前**新增 `location ~ ^/diagnoses/[0-9a-fA-F-]{36}$`（`limit_req zone=diag_read burst=10 nodelay`、`limit_req_status 429`、沿用 `proxy_pass http://$api_upstream;` 等三行、**不寫** `add_header`）；CSP 註解補一句同源 GET 已涵蓋；**[Docker]** `docker compose --profile demo up -d --build web` 後 `curl.exe -i` 驗 GET 走新桶且回應帶 server 層安全 header（FR-015；R5；代理裁決第 8 條）

### web（U-web）

- [X] T038 [P] [US2] `apps/web/src/domains/ai-copilot/lib/diagnose-api.ts` 新增 `getDiagnosis(jobId, socketId, previousSocketId?)`（同源 GET、逾時 `DIAGNOSE_REQUEST_TIMEOUT_MS`、`DiagnosisLookupResponseSchema.safeParse` 並比對 `jobId`）與 `DiagnoseLookupError { status?, code? }`（409 讀 body 的 `code`；格式不符、網路錯誤、逾時皆拋）；`apps/web/src/domains/ai-copilot/lib/diagnose-api.test.ts` 補 200 四分支、`jobId` 不符、404／409 兩種 code／429／503／網路錯誤、query 帶 `previousSocketId`（FR-017、SC-005；contracts/diagnosis-lookup §8）
- [ ] T039 [US2] `apps/web/src/domains/ai-copilot/lib/copilot-reducer.ts`：新增 web 內部事件 `LookupResultEvent = { type: "lookup/result"; jobId; response }`；active 加 `resume?: "pending"`、`reconnected?: true`；`lookup/result` completed → completed（`source: "lookup"`、`streamIncomplete: true`）、failed → failed（`humanizeError(error)`）、waiting／active → 維持 active、清 `resume`、更新 progress；`ai/done` 收尾時 `reconnected` 使 `streamIncomplete: true`；「結果未送達」可被 `lookup/result` completed 救回；文案常數 `RESUMING_NOTICE`、`RECOVERED_META`、`WATCHDOG_UNKNOWN_ERROR`、`LOOKUP_EXPIRED_ERROR`、`LOOKUP_ELSEWHERE_ERROR`、`LOOKUP_DISCONNECTED_ERROR`；`copilot-reducer.test.ts` 補第四種順序（`completed` 無 result → `lookup/result` completed → 遲到 `ai/done` 被忽略）、重連旗標使 `ai/done` 收尾也標不完整、`lookup/result` 各分支、`ai/error`／`failed` 之後到的同 jobId 結果（`ai/done`、帶 `result` 的 `completed`、`lookup/result` completed）不救回（只有 `undelivered` 可救回，FR-005）。相依 T026（FR-004、FR-005、FR-016、FR-038、SC-006；代理裁決第 20 條；data-model §6）
- [ ] T040 [P] [US2] `apps/web/src/domains/ai-copilot/lib/diagnosis-timing.ts`：`DiagnosisTiming` 加 `lastRecoveredMs`、`lastKind` 加 `"recovered"`；`settleTiming(…, opts?)` 的 `opts.recovered` 只寫 `lastRecoveredMs`，不動 `lastUncachedMs`／`lastCachedMs`；`compareLabel` 對 `recovered` 回主字、`compareBars` 回 null；`apps/web/src/domains/ai-copilot/lib/diagnosis-timing.test.ts` 補案例（FR-035；P16；data-model §6.4）
- [ ] T041 [US2] `apps/web/src/domains/ai-copilot/stores/copilot.store.ts` 續接：新增 plain Map／Set `boundSocketIds`、`pendingResume`、`lookupInFlight`；`diagnose()` 送 POST 前記 `boundSocketIds`；`onReconnect(newClientId)` 改為 clientId 變更時把 active 任務標 `resume: "pending"`、`reconnected: true`、`touch()`、加入 `pendingResume`（不轉失敗）；新 action `onAuthorized(socketId)` 逐台對仍 active 且 jobId 未變者 `lookup(…, "resume")` 並清空集合（同一連線多次授權只消化一次）；`lookup(machineId, jobId, socketId, purpose)` 以 `lookupInFlight` 去重、帶 `previousSocketId = boundSocketIds.get(jobId)`、回 `rebound: true` 時改記本次 socketId、回應包成 `lookup/result` 經 `applyEvent`、錯誤依 contracts/ui-copy §3 的 `resume` 欄對映、抵達時任務已不是同一 jobId 的 active 就丟棄；GET 收尾以 `settleTiming(…, { recovered: true })`；`cancel` 與新任務清 `boundSocketIds`；`copilot.store.test.ts` 補 onReconnect → onAuthorized → GET 的 completed／failed／active／404／409 兩種／503／網路錯誤、GET 帶 `previousSocketId`、`rebound` 後改記、授權前不 GET、重複授權只 GET 一次。相依 T038、T039、T040（FR-016、FR-045、SC-003；P20、P22）
- [ ] T042 [US2] `apps/web/src/domains/ai-copilot/stores/copilot.store.ts` 的 `checkStalls`（兩種退路共用「GET 回 failed → `humanizeError(error)`」規則，analyze 階段修正 2026-10-21）：
  - **2 s 未送達退路**：寬限到期改 `lookup(…, "undelivered")`（GET 期間不重觸發）；completed → 收尾；failed → 依 `humanizeError(error)` 轉失敗（不標 `undelivered`、不可救回）；其餘（waiting／active（P21）、404、409、503、429、網路錯誤、格式不符）→ `UNDELIVERED_ERROR`（可救回）。
  - **45 s watchdog 退路**：改 `lookup(…, "watchdog")`；completed → 照常公告；failed → 依 `humanizeError(error)` 轉失敗；waiting／active → `touch()`＋`console.warn`、維持 active；其餘（404、409、503、429、網路錯誤、格式不符）→ `WATCHDOG_UNKNOWN_ERROR`。
  - 無 `lastClientId` 時直接走該 purpose 的「其餘」失敗；移除舊 watchdog 文案「診斷逾時或無回應，請重試」（`copilot.store.ts` 內嵌字串）與其測試斷言（`copilot.store.test.ts`、`copilot-reducer.test.ts` 現有引用處改為新常數或刪除）。
  - `copilot.store.test.ts` 補兩種退路的各分支（含兩種退路下 GET 回 failed 時以 `humanizeError` 轉失敗、且 2 s 退路的這種失敗不被遲到 `ai/done` 救回）與 `lookupInFlight` 去重。相依 T041（同檔串行）（FR-005、FR-022；代理裁決第 7 條；contracts/ui-copy §3）
- [ ] T043 [US2] `apps/web/src/App.vue`：`onAuthResult` 改為 `(ok) => { store.setAuthorized(ok); if (ok && store.clientId) copilot.onAuthorized(store.clientId); }`，`onConnected` 照舊呼叫 `copilot.onReconnect(clientId)`；`corepack pnpm --filter @flow-gatekeeper/web typecheck` 綠（行為由 T041 的 store 測試承接）。相依 T041（FR-016；P20）
- [ ] T044 [US2] `apps/web/src/domains/ai-copilot/components/CopilotDrawer.vue`：進行中區塊步驟列下新增說明行（`data-testid="copilot-progress-note"`，`resume === "pending"` 顯示 `RESUMING_NOTICE`，`text-xs ink-3`，沿用面板既有 sr-only `aria-live="polite"` 公告區，不新增色值或 chip）；完成 meta 在 `source === "lookup"` 時加中性小字 `RECOVERED_META`（`data-testid="copilot-recovered-meta"`）；`CopilotDrawer.test.ts` 補兩者出現與否、卡片 chip 仍為「診斷中 N%」。相依 T039（FR-035、FR-037；R10；contracts/ui-copy §4、§5）

### e2e（U-nginx-e2e）

- [ ] T045 [US2] [Docker/e2e] 新檔 `tests/e2e/src/api-restart.e2e.test.ts`：6a 串流中 `restartApi()`＋`waitHealthy("api")`，`reconnectClient` 後以新 socketId `getDiagnosis` → 200 completed＋result；6b 先 `stopWorker()` → POST → `restartApi()` → 重連 GET → 200 waiting `rebound: true` → `startWorker()` → 新連線收到帶 `result` 的 `completed`；兩者皆在 api healthy 後 60 s 內。相依 T020、T021、T034、T036、T037（SC-003；P18）
- [ ] T046 [US2] [Docker/e2e] 新檔 `tests/e2e/src/diagnosis-lookup.e2e.test.ts`（場景 8）：隨機 jobId → 404；他人在線 socketId 查進行中 → 409 `job_bound_elsewhere`；同情境帶 `previousSocketId`＝原 socketId → 200 `rebound: true`；隨機 UUID socketId → 409 `socket_unauthorized`；`socketId=abc` → 400；已完成任務以他人 socketId 查 → 200 completed。相依 T045（e2e 循序）（SC-005；quickstart §3）

**Checkpoint**：US1＋US2 合起來達成「後端完成的結果一定回得到畫面」；可做 quickstart 演練 3。建議 commit：`feat(012): [Phase 4: US2] JobRoutingRegistry claim 與 GET /diagnoses/:jobId`、`feat(012): [Phase 4: US2] nginx diag_read 獨立限流`、`feat(012): [Phase 4: US2] web 重連續接與 2 s／watchdog 退路`、`test(012): [Phase 4: US2] e2e 場景 6、8`。

---

## Phase 5: User Story 4 - 同一請求被重跑時，不重打 LLM、不重複記錄（Priority: P2）

**Goal**：同一 jobId 的任何再執行只有一個結果、一筆 trigger、一次 hit／miss、一次 LLM；寫庫失敗以 `persist_failed` 收尾且不重打 LLM。**MUST 先於 US3 落地。**

**Independent Test**：worker 單元測試（fake repo 拒寫、trigger 失敗）計數 LLM 呼叫；e2e 場景 7（Redis 停頓 50 s，於 US3 checkpoint 執行）。

- [ ] T047 [US4] `apps/worker/src/diagnosis-repository.ts`：新增 `findDiagnosisResult(jobId): Promise<DiagnosisResult | null>`（`DiagnosisResultSchema.safeParse`，不合法回 null）；`insertTrigger` 改名 `upsertTrigger`（`updateOne({ jobId }, { $setOnInsert: { machineId, jobId, requestedBy, cached, createdAt } }, { upsert: true })`，E11000 視為成功，P10）；`ensureUniqueJobIdIndex` 泛化為接受 collection 與日誌標籤，`ensureTriggerIndexes` 加 `{ jobId: 1 }` unique（既有重複資料時退回非 unique＋記 error）；`apps/worker/src/diagnosis-repository.test.ts` 補案例；**[Docker]** `apps/worker/src/integration/diagnosis-repository.int.test.ts` 補 unique＋upsert、併發兩次 upsert 只一筆、有重複資料時退回非 unique、`findDiagnosisResult`（FR-024、FR-025；D6）
- [ ] T048 [US4] `apps/worker/src/main.ts` 的 `createFailedHandler` 改呼叫 `upsertTrigger`（已有成功紀錄時不覆寫）；`apps/worker/src/main.test.ts` 補「先有成功 trigger 再進 failed handler 仍只一筆」。相依 T047（FR-025）
- [ ] T049 [US4] `apps/worker/src/processor.ts` 冪等短路：`updateProgress(0)` 之後、`buildContext` 之前依序查 (i) `store.get(aiResultKey(jobId))` 經 `DiagnosisResultSchema`（不合法 DEL 並視為無）→ `insertDiagnosis`（失敗走 T051 的 `persist_failed`）→ DEL 暫存；(ii) `repo.findDiagnosisResult(jobId)`；命中任一 → `upsertTrigger(cached: false)` → `updateProgress(100)` → `ai/done(cached: false)` → `return { result, cached: false }`，info 記 `idempotent short-circuit`（`jobId`、`source: "ai-result" | "diagnoses"`）；不建 context、不取鎖、不打 LLM、不回填 `ai-cache`（P11）；所有 `insertTrigger` 呼叫點改 `upsertTrigger`；`processor.test.ts` 補兩種來源命中、LLM 呼叫 0 次、不取鎖。相依 T017、T023、T047（FR-024、FR-047、SC-004；data-model §5 步驟 2～4）
- [ ] T050 [US4] `apps/worker/src/processor.ts`：移除 `isFirstAttempt`，`replyCached` 與 `callLlmAndReply` 內 hit／miss 改為 `if (await store.setIfAbsent(aiMetricKey(jobId), "1", AI_METRIC_TTL_SECONDS))` 才記；`setIfAbsent` 失敗照常拋出走重試；`processor.test.ts` 補「stalled 重派第二次執行不再記 hit」「限流延後後才打 LLM 的那次仍記 miss 一次」。相依 T018、T049（同檔串行）（FR-026、SC-004）
- [ ] T051 [US4] `apps/worker/src/processor.ts` 寫庫暫存與 `persist_failed`：`parseResult` 通過、`updateProgress(80)` 之後改為 SET `ai-result`（`AI_RESULT_TTL_SECONDS`）→ `insertDiagnosis`（catch → `fail(PERSIST_FAILED_CODE, PERSIST_FAILED_MESSAGE, true, err)`，Mongo 原始錯誤只進 `err`）→ DEL `ai-result`（失敗只 warn）→ SET `ai-cache` → `upsertTrigger(cached: false)` → `updateProgress(100)` → `ai/done` → return；常數 `PERSIST_FAILED_CODE = "persist_failed"`、`PERSIST_FAILED_MESSAGE = "persist_failed: diagnosis record could not be written"`；`processor.test.ts` 補：fake repo 拒寫 3 次 → LLM 只 1 次、只在最終 attempt 送 `ai/error(persist_failed)`、`ai/error.message` 與拋出的訊息皆為固定句（不含原始錯誤字串）；`diagnoses` 寫成功後 trigger 失敗 → 重試走短路、不重打 LLM、`cached: false`（US4 情境 2、3）。相依 T050（同檔串行）（FR-027、FR-045、SC-008；代理裁決第 5、18 條）
- [ ] T052 [P] [US4] `apps/web/src/domains/ai-copilot/lib/copilot-reducer.ts` 的 `humanizeError`：在既有判斷**之前**加 `code === "persist_failed"` 或訊息含 `persist_failed` → `PERSIST_FAILED_ERROR`（「診斷結果無法寫入資料庫，請稍後重試」）；`copilot-reducer.test.ts` 補 `ai/error(persist_failed)`、`ai/error(worker_failed, message=固定句)`、`job/status: failed` 與 `lookup/result` failed 帶固定句三種來源皆得同一文案（FR-027、FR-035、SC-008；P14；contracts/ui-copy §1）
- [ ] T053 [US4] [Docker/e2e] 新檔 `tests/e2e/src/redis-pause.e2e.test.ts`（場景 7）：POST 前先 `nextMetricsSummary(now)` 取窗界 `from`；收到該 jobId 第 3 個 `ai/token` 後 `pauseRedis()`（停頓在 exec1 首 token 之後開始，research P25）、50 s 後 `unpauseRedis()`，等 `completed`，再以完成後第一則 summary 為 `to`；斷言 `countTriggers(jobId) === 1`、`countLlmCalls(jobId) === 1`、`cacheCounters(from, to) === 1`（場景前後兩個窗界之間的 hit＋miss 合計；全套 e2e 循序執行）、`completed.cached === false`，**且**收到該 jobId 的 `reason: "stalled"` 或 `execution ≥ 2`（未重派即判失敗並印「未重現 AR-4」，不放寬判準）；另從 worker 日誌印出重派那次 `idempotent short-circuit` 的 `source`（`ai-result` 或 `diagnoses`）作為證據。**撰寫於本 phase，執行點在 US3 checkpoint**（鎖參數 15／5／2 就位後才是驗收條件）。相依 T021、T022、T051（SC-004、FR-046；代理裁決第 6 條；checklist CHK052；research P25；analyze 階段修正 2026-10-21）

**Checkpoint**：冪等就位（單元測試證明 LLM 次數、trigger 筆數）；此時才可縮短鎖期限。建議 commit：`feat(012): [Phase 5: US4] trigger unique＋upsert 與 diagnoses 唯讀查詢`、`feat(012): [Phase 5: US4] processor jobId 冪等短路、hit／miss 只計一次、persist_failed`、`test(012): [Phase 5: US4] e2e 場景 7 Redis 停頓`。

---

## Phase 6: User Story 3 - worker 崩潰時不被誤判失敗（Priority: P2）

**Goal**：鎖參數 15／5／2＋worker keepalive 10 s，SIGKILL 後最長無事件 < 45 s（設計上界 35 s）；relay 轉發 `stalled`；畫面顯示「重新排入佇列」說明與多次中斷文案。**相依 Phase 5。**

**Independent Test**：e2e 場景 3a／3b `maxGap < 45 s` 並印 `W`；worker keepalive 單測（fake timer）；場景 7 在本 checkpoint 執行。

- [ ] T054 [US3] `apps/worker/src/main.ts` 的 Worker options 展開 `WORKER_LOCK_OPTIONS`（取代 `main.ts:147-152` 的預設）；`apps/worker/src/main.test.ts` 斷言傳入的 `lockDuration`／`stalledInterval`／`maxStalledCount` 為 15000／5000／2 且未設 `lockRenewTime`。相依 T015、T048（同檔串行）（FR-018；代理裁決第 1 條）
- [ ] T055 [US3] `apps/worker/src/processor.ts` keepalive 接線：每次執行建 `createKeepalive({ intervalMs: KEEPALIVE_INTERVAL_MS, onIdle })`；以 `report(value)` 取代所有 `job.updateProgress(n)`（含 T049／T051 新增者與首 token 的 60）：送 `{ value, attempt: job.attemptsMade + 1, execution: max(1, job.attemptsStarted) }`、記 `milestone`、`touch()`；`onToken` 內 `touch()`；`onIdle` 送 `{ value: milestone, attempt, execution }`，失敗每次執行至多 warn 一則（P12）；`finally` `stop()`；不逐次記日誌；`processor.test.ts`（fake timer）補「等待去重鎖 25 s 期間每 10 s（± 1 s）至少一次 progress」「首 token 前 20 s 等待至少兩次」「`insertDiagnosis` 慢 15 s 期間至少一次」「串流中 token 持續時不補送」「所有 progress 皆為物件且 `execution ≥ 1`」。相依 T016、T051（同檔串行）（FR-019、FR-020、SC-009；D2；代理裁決第 14 條）
- [ ] T056 （實作備註 2026-10-21：progress 物件拆解、noteProgress 與 completed 帶 attempt/execution 已於 US1 T024/T025 一併落地，本任務只剩補 tasks 列的額外案例與勾選）[US3] `apps/api/src/modules/websocket/job-status-payload.ts` 新增 `progressStatus(data)`：通過 `DiagnosisJobProgressSchema` → `{ progress: value, attempt, execution }`；`number` → `{ progress }`；其他 → `{}`；`job-status-relay.service.ts` 的 `progress` 監聽改用它，物件時 `registry.noteProgress(jobId, attempt, execution)`，送 `job/status: active`；`job-status-payload.test.ts` 與 `job-status-relay.service.test.ts` 補三種形狀、`completed` 沿用綁定上的 attempt／execution（P7）。相依 T025（FR-020、SC-009；contracts/job-lifecycle §2）
- [ ] T057 [US3] `apps/api/src/modules/websocket/job-status-relay.service.ts` 新增 QueueEvents `stalled` 監聽：送 `job/status { status: "waiting", reason: "stalled" }` 到綁定連線並 warn（`jobId`）；`job-status-relay.service.test.ts` 補「`waiting` 後接 `stalled` 依序送出兩則、第二則帶 reason」「無綁定時不送」。相依 T056（同檔串行）（FR-021、FR-047、SC-001）
- [ ] T058 [US3] `apps/web/src/domains/ai-copilot/lib/copilot-reducer.ts`：active 加 `execution`（起始 1）與 `stalledNotice?: { execution }`；`job/status`／`lookup/result` 帶更大 `execution` → 清 `streamText`、`lastSeq = -1`（`seq <= lastSeq` 保留為備援）；`reason === "stalled"` → `stalledNotice = { execution: state.execution + 1 }`；之後 `execution` 遞增且非 stalled → 移除說明（P15）；`humanizeError` 在既有判斷前加「含 `job stalled more than allowable limit`」→ `STALLED_LIMIT_ERROR`；常數 `STALLED_NOTICE(n)`；`copilot-reducer.test.ts` 補 stalled 設說明、N 的估算與校正、execution 遞增清串流、多次中斷文案。相依 T039、T052（同檔串行）（FR-006、FR-023、FR-035；代理裁決第 13 條）
- [ ] T059 [US3] `apps/web/src/domains/ai-copilot/components/CopilotDrawer.vue`：`copilot-progress-note` 在 `stalledNotice` 存在時顯示 `STALLED_NOTICE(n)`（與 `RESUMING_NOTICE` 同時成立只顯示後者）；`CopilotDrawer.test.ts` 補說明行、面板 chip 維持「進行中」，並斷言面板與卡片渲染文字不含「worker」「stalled」、診斷任務不用「停滯」。相依 T044、T058（FR-035～FR-037）
- [ ] T060 [US3] [Docker/e2e] 改寫 `tests/e2e/src/worker-kill.e2e.test.ts` 為 3a（第 3 個 token 後 SIGKILL）與 3b（收到 progress 20 即 SIGKILL，P24）：compose 重啟 worker 後斷言 `maxGap(jobId) < 45_000`、收到 `waiting`＋`reason: "stalled"`、`execution` 遞增、最終 `completed`、無 `ai/error`；以 `workerReadyAt` 印出 `W` 與 `maxGap`。相依 T020～T022、T054、T055、T057（SC-001；plan 風險 1）
- [ ] T061 [US3] [Docker] 新檔 `apps/worker/src/integration/bullmq-lifecycle.int.test.ts`：真 BullMQ＋QueueEvents——processor 回傳值在 `completed` 讀回 `{ result, cached }`、`updateProgress` 物件在 `progress` 事件讀回 `{ value, attempt, execution }`、Worker 帶 `WORKER_LOCK_OPTIONS` 可啟動並處理一個 job。相依 T023、T054、T055（FR-001、FR-018、FR-020；SC-002、SC-009）

**Checkpoint**：執行 T053（場景 7）與 T060（場景 3a／3b）；`W > 15 s` 時依 plan 風險 1 改用 `K + W + 2S` 判讀，`W > 25 s` 停下回報；場景 7 未重現重派時停下回報（不放寬）。可做 quickstart 演練 1、4。建議 commit：`feat(012): [Phase 6: US3] BullMQ 鎖參數 15／5／2 與 worker keepalive`、`feat(012): [Phase 6: US3] relay 轉發 progress 物件與 stalled`、`feat(012): [Phase 6: US3] web 重新排入佇列說明與多次中斷文案`、`test(012): [Phase 6: US3] e2e 場景 3a／3b 與 BullMQ 整合測試`。

---

## Phase 7: User Story 5 - 供應商故障時不放大計費（Priority: P3）

**Goal**：同簽章 LLM 階段失敗寫 `ai-fail:<sig>`（10 s），其他請求在取鎖前與限流計數前看到即拿同一錯誤、不打 LLM、不吃 `AI_RPM`。

**Independent Test**：worker 單元測試兩個同簽章 job、fake provider 持續錯誤，LLM 呼叫 ≤ 4、錯誤碼相同、`ai-rpm` 不因第二個 job 增加。web 不需改動（FR-029：沿用既有分類文案，由 T052／既有 `humanizeError` 測試承接）。

- [ ] T062 [US5] `apps/worker/src/processor.ts` 寫入標記：worker 內部 `AiFailMarkerSchema = z.object({ code, message, jobId, at })`（不進 contracts，P9）；`callLlmAndReply` 的 `ai_timeout`、`provider_error`、`schema_invalid`（含 safety、max_tokens）失敗點在 `fail()` 前 `setWithTtl(aiFailKey(sig), marker, AI_FAIL_TTL_SECONDS)`（寫入失敗只 warn），info 記 `ai-fail written`（`sig`、`code`）；`no_context`、`persist_failed`、限流延後不寫；成功路徑 SET `ai-cache` 之後 `del(aiFailKey(sig))`。相依 T017、T055（同檔串行）（FR-028、FR-047）
- [ ] T063 [US5] `apps/worker/src/processor.ts` 讀取標記：取鎖迴圈每輪開頭，與取得鎖、double-check `replyCached()` 之後、`incrementWindow` 之前兩處讀（P13）；解析失敗 DEL 並視為無；`jobId === 自己` 忽略；命中 warn `ai-fail hit`（`sig`、`code`）→ `fail(marker.code, marker.message, true, null)`；`processor.test.ts`（fake store／timer／provider）補：兩同簽章 job 持續錯誤 → LLM 總數 ≤ 4、第二個 job 錯誤碼相同、`ai-rpm` 計數不因第二個 job 增加、持鎖者自己的重試忽略自己的標記、成功時 DEL、標記過期後新 job 照常呼叫 LLM、「持鎖者寫標記放鎖、等待者剛好搶到鎖」窗口被第二處讀取擋下。相依 T062（同檔串行）（FR-028、SC-007；代理裁決第 4 條）
- [ ] T064 [P] [US5] [Docker] `apps/worker/src/integration/redis-store.int.test.ts` 補 `ai-fail:<sig>` 以 `setWithTtl(…, 10)` 寫入後 10 s 內可讀、逾時消失、`del` 生效。相依 T018（SC-007）

**Checkpoint**：SC-007 單元與整合測試綠。建議 commit：`feat(012): [Phase 7: US5] 同簽章 LLM 失敗標記 ai-fail`。

---

## Phase 8: User Story 6 - 嘗試次數與執行次數可見（Priority: P3）

**Goal**：面板「嘗試 N / 3」由 `job/status.attempt` 推進（等待中、快取命中、無 token 的輪次也正確）；`execution` 因重試或限流延後遞增只清串流、不顯示「重新排入佇列」。

**Independent Test**：web reducer 單元測試以帶 `attempt`／`execution` 的事件序列驅動；e2e 場景 3 的 `execution` 遞增斷言（T060）。

- [ ] T065 [US6] `apps/web/src/domains/ai-copilot/lib/copilot-reducer.ts`：`job/status`／`lookup/result` 帶 `attempt > state.attempt` → 換輪（清 `streamText`、`lastSeq = -1`、更新 `attempt`），`ai/token` 的 attempt 判斷保留；`copilot-reducer.test.ts` 補 US6 情境 1（`attempt: 2` 無 token 時即推進）、情境 2（stalled 重派 `execution` 遞增、`attempt` 不變）、情境 3（重試或限流延後 `execution` 遞增、無 `reason` → 不出現說明）。相依 T058（同檔串行）（FR-006；US6）
- [ ] T066 [US6] `apps/web/src/domains/ai-copilot/components/CopilotDrawer.vue`：job meta `<dl>` 維持「佇列」「嘗試」兩項，「嘗試 N / 3」讀 `state.attempt`；`CopilotDrawer.test.ts` 補「等待中收到 `attempt: 2` 即顯示 2 / 3」「快取命中輪次顯示正確」。相依 T059、T065（FR-006、FR-035）

**Checkpoint**：六個 user story 全部可獨立驗收。建議 commit：`feat(012): [Phase 8: US6] 嘗試次數由 job/status.attempt 推進`。

---

## Phase 9: 文件回補（merge 回 `develop` 前 MUST）

**Purpose**：依 CLAUDE.md「跨 Feature 決策 MUST 回補真實來源」與 spec FR-039～FR-041、ADR-003 §6；回補**不重寫歷史**（原敘述保留、改過去式並標「已落地／已變更，現況見 ADR-003」）。

**ADR-003 §6 清單 → 任務對照**（每一項都要在本 phase 勾掉 ADR-003 §6 的對應 `[ ]`，於 T075 統一勾選）：

| ADR-003 §6 項目 | 任務 |
| --- | --- |
| ADR-002 §6.2「生產路徑：改用 Redis Streams」改寫為已拒絕；「已變更」註記收斂；「更正」段讀取端點標已落地 | T067 |
| ADR-002 §3 第 5 列加「已變更（012-lite）」 | T067 |
| ADR-002 §6.1 單實例狀態第 4 項改指 `JobRoutingRegistry` | T067 |
| ADR-002 §6.5「結果讀取與完成語意」列改已落地、92 秒改過去式、升級路徑指 ADR-003 §5 | T068 |
| ADR-002 §6.5「api 行程內單實例狀態」列：已移（012-lite） | T068 |
| ADR-002 §6.5.1 WK-4／AR-F4 列標已落地 | T068 |
| ADR-002 §6.5.1「失敗終態沒有 relay 寬限」列標已落地（D12） | T068 |
| ADR-002 §6.5.1 末尾補「review03 roadmap 012-lite：已落地」列 | T068 |
| 指南 §15.5 Redis Streams 標已拒絕、§15.7 藍圖新增 | 立案時已完成（ADR-003 §6 已勾），T073 只複核 |
| 指南 §15.7 落地回補、§15.6 e2e 實測發現註記 | T073 |
| 指南 §16.3 第 6 列、§17「streaming 推不到前端」列（T075 步驟 1 先補進 ADR-003 §6） | T073 |
| README「已知限制」四條＋「第三輪審查的現況」 | T069 |
| README 資料表 | T070 |
| README 契約版本字串、nginx GET 獨立桶、BullMQ 具名常數 | T070（版本字串已於 T009 先改） |
| `apps/web/PRODUCT.md` 已知產品限制、失敗段、新術語 | T071 |
| `tests/e2e/README.md` 場景 3 與「注意」段 | T072 |
| `asyncapi.yaml` 與 `CHANGELOG.md` | T007（asyncapi）、T074（CHANGELOG） |
| 憲章 Principle III（**待使用者**） | **不列為任務**；T075 只確認 spec 與 ADR-003 保留「建議修訂、待使用者」註記 |
| repo `CLAUDE.md` 開頭現況段 | T076 |
| ADR-003 本文同步（§2(e)、D8、D10、D11、D13）與 §7 補記 | T075 |

- [ ] T067 [P] `docs/adr-002-productionization-scope.md`：§6.2「生產路徑：改用 Redis Streams」改寫為「已拒絕（2026-10-21，ADR-003）：結果改以 BullMQ `returnvalue`＋`job/status.result`＋`GET /diagnoses/:jobId` 取回；token 串流維持 at-most-once，重連後直接顯示結果」，「已變更」註記的「Streams 降為備選」收斂，「更正」段「目前沒有任何結果讀取端點」標已落地；§3 第 5 列後段加「已變更（012-lite）」；§6.1 單實例狀態第 4 項改為 `JobRoutingRegistry`（FR-039；ADR-003 §6）
- [ ] T068 `docs/adr-002-productionization-scope.md`：§6.5「結果讀取與完成語意」列改「已落地（012-lite，ADR-003）」＋一句摘要（`returnvalue` 權威、GET＋rebind、`stalled` 帶 `reason`、keepalive 10 s、lock 15／5／2），92 秒實測改過去式、升級路徑指 ADR-003 §5；「api 行程內單實例狀態」列改「已移（012-lite），外置見 ADR-003 §5」；§6.5.1 WK-4／AR-F4 列與「review03 新增：失敗終態沒有 relay 寬限」列標已落地（後者原「使用者 2026-10-18 裁決接受」改過去式保留）；§6.5.1 末尾補「review03 roadmap 012-lite：已落地」列（AR-4、AR-S7、WK-13、WK-4 補強、AR-5 根治含失敗終態寬限、WK-20、WEB-20 attempt 部分、DOC-29，指向 ADR-003 與 CHANGELOG）。相依 T067（同檔串行）（FR-039）
- [ ] T069 [P] `README.md`「已知限制」：「重連不 rebind」改為「重連以 jobId 續接（GET＋rebind），原連線仍在線時不改綁」；「診斷結果目前沒有讀取端點」改為「快取命中的結果 1 小時後無法以 GET 取回」；「worker 崩潰後的重派有長時間靜默」改為「設計上界約 35 秒無事件，超過 45 秒才標『結果未知』」；at-most-once 條改寫為「重連後直接顯示結果、不續播」；補「重新整理頁面後不續接進行中的診斷」與「jobId 與 `previousSocketId` 會進 nginx access log」兩條；「第三輪審查的現況」把 AR-4、AR-S7、WK-13、WK-4 補強、AR-5 根治移到「已修（012-lite）」（FR-039；代理裁決第 19 條；plan 風險 3）
- [ ] T070 `README.md` 資料與設定段：`diagnoses` 的「目前只寫不讀」改為「api 經 `GET /diagnoses/:jobId` 讀取（`returnvalue` 過期後的第二來源）」；`diagnosisTriggers` 補「`jobId` unique，每個 jobId 一筆」；Redis 職責補 `ai-fail:*`／`ai-result:*`／`ai-metric:*`（含 TTL）；確認所有契約版本字串為 1.4.0；nginx 限流敘述補 GET `diag_read` 60 r/m、burst 10；BullMQ 參數具名常數（`apps/worker/src/lib/bullmq-options.ts`，15／5／2、keepalive 10 s、上界公式）說明；API 段補 `GET /diagnoses/:jobId`。相依 T069（同檔串行）（FR-018、FR-039）
- [ ] T071 [P] `apps/web/PRODUCT.md`：「已知產品限制」改為「AI token 串流 at-most-once（重連後不續播動畫，直接顯示結果）、快取命中的結果 1 小時後無法以 GET 取回、重新整理頁面後不續接進行中的診斷（再按一次診斷會命中快取或等待同簽章的去重鎖）、Mock 頻率控制無後端作用」；失敗段「只在後端完成後約 10 秒內、而且中間沒有重連時才救得回來」改為 2 s 退路先 GET 的新規則；新增術語「重新排入佇列」（內部稱重新派送）「取回」「結果未知」（FR-036、FR-039；代理裁決第 19 條）
- [ ] T072 [P] `tests/e2e/README.md`：場景表加 3a／3b、5、6a／6b、7、8；場景 3「反映的現況語意」改為 relay 監聽 `stalled` 並送 `reason`、最長無事件間隔斷言 < 45 s、attempt／execution 由 `job/status` 帶；「注意」段補 GET 走獨立限流桶、新故障場景、全套耗時 10～15 分鐘、場景 7 未重現重派時的判讀（FR-039、FR-046）
- [ ] T073 [P] `docs/Flow-Gatekeeper-SDD-完整實作指南.md`：§15.7 012-lite 藍圖狀態改「已落地」；§15.6「e2e 實測發現（留給 012-lite）」條加「已落地（012-lite）」；§15.6「1.0.0 之後的現況摘要」補 012-lite 一段；§16.3 第 6 列「目前無結果讀取端點」改寫；§17「streaming 推不到前端」列的「重連後舊 jobId 不會改綁」改寫；複核 §15.5 已拒絕註記仍在（FR-039）（另補：`specs/009-observability-baseline/contracts/log-fields.md` §3 api context 清單加 `JobRoutingRegistry`——孤兒回收 warn 的 context 自 relay 移入 registry，交叉審查 L3）
- [ ] T074 [P] `CHANGELOG.md` `[Unreleased]`：契約小節記 asyncapi **1.4.0**（WS：`job/status` 新增 optional `attempt`／`execution`／`reason`（開放字串）／`cached`、`completed` 帶 `result`；`ai/done` 可重複可遺失；`ai/error.code` 新增 `persist_failed`。HTTP：`GET /diagnoses/:jobId?socketId=[&previousSocketId=]` 的 200 四種、400、404、409 `socket_unauthorized`／`job_bound_elsewhere`、429、503，依 contracts/diagnosis-lookup §9）；「相容性注意」逐條記：`ai/done` 可重複、可遺失（自寫 client 須以 jobId 去重）、BullMQ job `progress` 改為物件、BullMQ lock 15／5／2、新增 GET 與 nginx 獨立 60 r/m 桶、`job/status` 新欄位、**升級順序先 api 後 worker（web 不限）**、jobId 與 `previousSocketId` 進 nginx access log 的曝險；記 `[2.1.0]` 帶著發布的 AR-4、AR-S7、WK-13、WK-4 補強、AR-5 根治已由 012-lite 修掉（在 `[Unreleased]` 記已修，`[2.1.0]` 原文不改寫，只在該條末加「已修，見 [Unreleased]」註）（FR-034；R12；checklist CHK046、CHK047）
- [ ] T075 `docs/adr-003-completion-semantics.md`，依序三步（analyze 階段修正 2026-10-21）：
  1. **勾選前**先把 §6 各項文字改到與 spec FR-039、FR-034 一致：`apps/web/PRODUCT.md` 項補「重新整理頁面後不續接」，術語改「重新排入佇列（內部稱重新派送）」；README「已知限制」項補「重新整理不續接」「jobId 與 `previousSocketId` 進 access log」；新增「指南 §16.3 第 6 列、§17『streaming 推不到前端』列」一項；`asyncapi.yaml` 與 `CHANGELOG.md` 項的相容性注意改為 FR-034 的 7 條。
  2. **同步 ADR-003 本文、消除矛盾**（以「（clarify／checklist 階段更新，2026-10-21）」標註、不刪原敘述；GET 回 failed 的規則標「（analyze 階段更新，2026-10-21）」）：§2(e) 端點改 `?socketId=[&previousSocketId=]` 並補 rebind 條件（原綁定已離線、綁定不存在，或原綁定等於 `previousSocketId`）；D8 第 1 點補 `previousSocketId` 的 UUID 驗證；第 3 點補第 17 條列（原綁定在線但等於 `previousSocketId` → 暫定改綁、不主動終止舊連線）；第 2／4 點補 409 兩種 `code`（`socket_unauthorized`／`job_bound_elsewhere`）與 503（BullMQ 5 s、Mongo 3 s，spec FR-010），第 4 點的進行中 state 補 `waiting-children`、未知 state 視同查無 job；D10 失敗對映補 503 與 409 依 `code` 分流，並補「GET 回 failed → 依 `humanizeError(error)` 轉失敗，其餘才用『結果未送達』」（spec FR-005）；D11 同 spec FR-022 補 failed 分支（failed → `humanizeError(error)`，其餘才用「結果未知」文案）；D13「不完整」補「或執行期間經歷過重連（第 20 條）」。
  3. §6 清單逐項勾選（對照上表）；§7 補記 research P1～P25 為第 22～46 條（每條含影響範圍、裁決、理由、替代方案，標「待覆核」），另記 checklist 階段推導的兩點（重連後授權失敗交給 watchdog、SC-004 必須證明重派發生）為第 47、48 條；檔頭與 §7 的「代理裁決、待覆核」註保留；確認 spec FR-041 與 ADR-003 §6 憲章項保留「建議修訂、待使用者」註記（FR-039、FR-040、FR-041）
- [ ] T076 repo `CLAUDE.md` 開頭現況段：merge 前改為「最近一次完成的是 012-stream-resilience（…）」並保留 013 為前一次；只改現況段、不動規則內文（FR-039）

**Checkpoint**：ADR-003 §6 全勾（憲章項除外，保留待使用者）；`docs-contract-version.test.ts` 綠。建議 commit：`docs(012): [Phase 9: 文件回補] ADR-002／README／PRODUCT／e2e README／指南`、`docs(012): [Phase 9: 文件回補] CHANGELOG 契約 1.4.0 與相容性注意、ADR-003 §7 補記 P1～P25 與本文同步`。

---

## Phase 10: Polish／驗收

**Purpose**：全套驗收、不退步、quickstart 演練；結果寫入本檔「驗收紀錄」。

- [ ] T077 `corepack pnpm check`（contract lint＋typecheck＋lint＋test）全綠，含 `packages/contracts/src/asyncapi-drift.test.ts`、`packages/contracts/src/docs-contract-version.test.ts`；結果記入「驗收紀錄」（`specs/012-stream-resilience/tasks.md`）（SC-010、SC-011）
- [ ] T078 `corepack pnpm test:coverage`：全域與十個核心檔逐檔門檻（`vitest.config.ts`）照過；`job-status-relay.service.ts`、`ai-stream-relay.service.ts` 因程式移出 registry 而下降時以補測試維持，**不調低門檻**（plan 風險 5；FR-044）
- [ ] T079 [Docker] `docker compose up -d` 後 `corepack pnpm --filter @flow-gatekeeper/worker test:integration` 與 `--filter @flow-gatekeeper/api test:integration` 全綠（`apps/worker/src/integration/*.int.test.ts`、`apps/api/src/integration/*.int.test.ts`；結果記入 `specs/012-stream-resilience/tasks.md`「驗收紀錄」）（SC-004、SC-005、SC-007、SC-009）
- [ ] T080 [Docker/e2e] `corepack pnpm test:e2e` 全套：場景 1／2／4a／4b 照過（SC-011），3a／3b、5、6a／6b、7、8 通過（SC-001～SC-005）；把 `maxGap`、`W`、場景 7 的重派證據與全套耗時寫進 `specs/012-stream-resilience/tasks.md`「驗收紀錄」；`W > 25 s` 或場景 7 未重現時停下回報、不改判準
- [ ] T081 [Docker] quickstart §4 手動演練 1～4（一鍵 demo、`AI_PROVIDER=fake`），記錄演練 1 的 `W` 與各演練畫面是否符合 contracts/ui-copy（說明行、取回 meta、「原始串流（不完整）」、無「worker」「stalled」字樣）；收尾把 `apps/worker/.env` 的 `AI_PROVIDER` 改回 `gemini`（quickstart；SC-001～SC-004）
- [ ] T082 收尾複核：硬規則 1（`ai/token` 寫 reactive 的範圍未擴大，新增 Map／Set 皆非 reactive）、憲章 IV（無新 WS channel、worker 不直接 emit）、spec FR-001～FR-047 皆有對應已完成任務（見下方「FR／SC 覆蓋」）、本檔所有任務勾 `[X]`、`checklists/resilience.md` 仍成立（FR-042～FR-044）

---

## 驗收紀錄

（implement 期間填寫：T001 基線、T002 BullMQ 版本確認、T003 busybox 結論、T080 的 `maxGap`／`W`／場景 7 重派證據／全套耗時、T081 演練結果。）

### Phase 1 Setup（主 session 實測，2026-10-21）

- **T001 基線**：`pnpm check`、`pnpm test:coverage`、`pnpm build` 以分支基底 develop `e1cdb69` 的 Linux CI run 39596446920（on.push 自動觸發、success）為證；本機 `docker compose up -d` 後 `corepack pnpm --filter @flow-gatekeeper/worker test:integration` 20/20、`--filter @flow-gatekeeper/api test:integration` 7/7（21:04，`--maxWorkers=1`）。全綠，無既有紅燈。
- **T002 BullMQ 能力**：`pnpm-lock.yaml` 的 bullmq 為 5.79.2；`node_modules/.pnpm/bullmq@5.79.2/node_modules/bullmq/dist/esm/classes/queue-events.js:99` 對 `completed` 執行 `args.returnvalue = JSON.parse(args.returnvalue)`（listener 拿到已 parse 的 `returnvalue`）；`'stalled'` 事件見同版本的 `scripts.js`／`worker.js`。與 plan 前提一致。
- **T003 busybox 小數秒**：`docker compose exec -T redis sh -c 'sleep 0.05 && echo ok'` 輸出 `ok`，busybox 接受小數秒；research P19 不需改。

---

## FR／SC 覆蓋

| 需求 | 任務 |
| --- | --- |
| FR-001～FR-003 | T023、T024、T025、T061 |
| FR-004、FR-005 | T026、T027、T039、T041、T042 |
| FR-006 | T058、T065、T066 |
| FR-007～FR-013 | T006、T031、T032、T033、T034、T035、T036 |
| FR-014 | T010～T014 |
| FR-015 | T037 |
| FR-016、FR-017 | T038、T041、T043 |
| FR-018～FR-021 | T015、T016、T054、T055、T056、T057 |
| FR-022、FR-023 | T042、T058 |
| FR-024～FR-027 | T017、T018、T047～T051 |
| FR-028、FR-029 | T062、T063、T064（FR-029 無需改 web） |
| FR-030～FR-033 | T004～T008 |
| FR-034 | T074 |
| FR-035～FR-038 | T026、T028、T039、T040、T044、T052、T058、T059、T066 |
| FR-039～FR-041 | T009、T067～T076 |
| FR-042～FR-044 | T077、T078、T082 |
| FR-045 | 各實作任務並列的測試 |
| FR-046 | T020～T022 |
| FR-047 | T034、T049、T055、T057、T062、T063 |
| SC-001 | T015、T055、T060 |
| SC-002 | T025、T029、T030 |
| SC-003 | T041、T045 |
| SC-004 | T049～T051、T053 |
| SC-005 | T035、T036、T046 |
| SC-006 | T026～T028、T039 |
| SC-007 | T063、T064 |
| SC-008 | T013、T051、T052 |
| SC-009 | T016、T055、T056 |
| SC-010 | T004～T009、T074、T077 |
| SC-011 | T029、T077、T078、T080 |

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**：無相依。
- **Foundational (Phase 2)**：相依 Setup；**阻擋所有 user story**。內部：T004～T006 → T007 → T008 → T009；T010 → T011、T012 → T013；T010 → T014；T015～T018 互不相依；T004 → T019；T006 → T020。
- **US1 (Phase 3)**：相依 Phase 2。
- **US2 (Phase 4)**：相依 Phase 2；web 端 T039 相依 US1 的 T026（同檔 `copilot-reducer.ts`）。
- **US4 (Phase 5)**：相依 Phase 2；processor 任務相依 US1 的 T023（同檔）。
- **US3 (Phase 6)**：**相依 US4（Phase 5）**；relay 任務相依 US1 的 T025；web 任務相依 US2 的 T039、T044 與 US4 的 T052。
- **US5 (Phase 7)**：相依 US3 的 T055（同檔 `processor.ts`）。
- **US6 (Phase 8)**：相依 US3 的 T058、T059（同檔）。
- **文件回補 (Phase 9)**：相依 Phase 3～8 的行為定案（可在 Phase 7／8 進行時起草，commit 仍在 Phase 9）。
- **Polish (Phase 10)**：相依全部。

### User Story Dependencies

- US1、US2 皆只相依 Foundational，可各自獨立驗收；US2 的 2 s 退路 GET 讓 US1 情境 3 完整。
- US4 獨立於 US1／US2 的行為，但 processor 檔案串在 US1 之後。
- US3 MUST 在 US4 之後（spec、plan 風險 2）。
- US5、US6 皆相依 US3 的同檔改動，行為上互不相依（可平行，見下節）。

### Within Each User Story

- 契約與純函式先於接線；同檔任務依編號串行（`processor.ts`：T019 → T023 → T049 → T050 → T051 → T055 → T062 → T063；`copilot-reducer.ts`：T026 → T039 → T052 → T058 → T065；`copilot.store.ts`：T027 → T041 → T042；`job-status-relay.service.ts`：T013 → T025 → T032 → T056 → T057；`CopilotDrawer.vue`：T028 → T044 → T059 → T066）。
- e2e 場景在其 story 的 api／worker 改動完成後才跑；全套循序（`fileParallelism: false`）。

### Parallel Opportunities

- Phase 2：T004／T005／T006 平行；T015／T016／T017／T018 平行；T020／T021／T022 平行；U-contracts 與 U-api-registry 兩個單位可平行。
- Phase 3：T024（api）與 T026（web）平行；T023（worker）與 T024 平行。
- Phase 4：T033、T037、T038、T040 互不相依。
- Phase 5：T052（web）與 T047～T051（worker）平行。
- Phase 7 與 Phase 8：U-worker（T062～T064）與 U-web（T065～T066）可平行，commit 依 phase 順序分開提交。
- Phase 9：T067、T069、T071、T072、T073、T074 不同檔，可平行。

---

## Parallel Example: Phase 2

```text
# 單位 A（U-contracts）
T004 jobs.ts 傳輸型別 → T005 job-status.ts → T006 http.ts → T007 asyncapi.yaml → T008 漂移測試 → T009 文件版本字串（代 U-docs）
# 單位 B（U-api-registry）
T010 job-routing-registry.ts → T011 測試 → T012 ai-stream-relay → T013 job-status-relay → T014 jobs.service＋app.module
# 之後
單位 C（U-worker）：T015、T016、T017、T018 → T019
單位 D（U-nginx-e2e）：T020、T021、T022
```

## Parallel Example: User Story 2

```text
# 第一輪
U-api-registry：T031 claim → T032 relay deferred
U-web：T038 getDiagnosis、T040 timing recovered
# 第二輪
U-api-lookup：T033 → T034 → T035 → T036
U-web：T039 → T041 → T042 → T043 → T044
# 第三輪
U-nginx-e2e：T037 → T045 → T046
```

---

## Implementation Strategy

### MVP First（US1）

1. Phase 1、Phase 2。
2. Phase 3（US1）：Pub/Sub 故障不再假失敗。
3. **STOP and VALIDATE**：web 單元測試三順序、e2e 場景 5。

### Incremental Delivery

1. US1 → US2（P1 兩條合起來：結果一定回得到畫面）→ 驗收場景 6、8、演練 3。
2. US4 → US3（MUST 同批，順序不可倒）→ 驗收場景 3a／3b、7、演練 1、4。
3. US5、US6 → 文件回補 → Polish。
4. 每個 phase 依 CLAUDE.md 的 phase-by-phase 規則 commit（標題 `<type>(012): [Phase <n>: <名稱>] <中文描述>`，tasks 勾選併入該 phase 收尾 commit）；Phase 7／8 平行時以明確路徑 `git add`，不用 `git add -A`。

---

## 實作單位切分建議

本專案 implement 由主 session 只調派、每次**最多 2 個實作單位平行**，共用檔案串行；findings 回原作者修完才 commit（見使用者 memory「implement 分派模式」）。下表單位之間檔案不重疊；「共用檔案」欄列出唯一 owner，其他單位不得改動。

| 單位 | 任務 | 主要檔案 | 相依 | 建議順序 |
| --- | --- | --- | --- | --- |
| **U-contracts** | T004～T008；T009（代 U-docs，Phase 2-1 收尾） | `packages/contracts/src/{jobs,job-status,http}.ts`、`jobs.test.ts`、`job-status.test.ts`、`http.test.ts`、`asyncapi-drift.test.ts`、`asyncapi.yaml`；T009 只動 `README.md`、指南、`CHANGELOG.md` 的版本宣稱字串 | Phase 1 | 1（Phase 2 第一輪，與 U-api-registry 平行） |
| **U-api-registry** | T010～T014、T024、T025、T031、T032、T056、T057 | `apps/api/src/modules/websocket/{job-routing-registry,job-status-payload,job-status-relay.service,ai-stream-relay.service}.ts` 與其測試、`relays.test.ts`、`apps/api/src/modules/jobs/{jobs.service,with-timeout}.ts`、`jobs.service.test.ts`、`apps/api/src/app.module.ts`（Phase 2） | T010 起無外部相依；T024 起需 T004 | 1（Phase 2）→ 3（US1）→ 4（US2 第一輪）→ 6（US3） |
| **U-api-lookup** | T033～T036 | `apps/api/src/modules/history/history.service.ts`＋測試、`apps/api/src/integration/diagnosis-reader.int.test.ts`、`apps/api/src/modules/jobs/{diagnosis-lookup.service,jobs.controller}.ts` 與測試、`apps/api/src/app.module.ts`（T036 一行 provider，見下方交接） | T006、T014、T031 | 4（US2 第二輪，與 U-web 平行） |
| **U-worker** | T015～T019、T023、T047～T051、T054、T055、T061～T064 | `apps/worker/src/{processor,main,diagnosis-repository}.ts` 與其測試、`lib/{bullmq-options,keepalive}.ts`、`cache/{job-keys,redis-store}.ts`、`integration/*.int.test.ts` | T004 | 2（Phase 2 第二輪）→ 3（US1）→ 5（US4）→ 6（US3）→ 7（US5） |
| **U-web** | T026～T028、T038～T044、T052、T058、T059、T065、T066 | `apps/web/src/domains/ai-copilot/lib/{copilot-reducer,diagnose-api,diagnosis-timing}.ts`、`stores/copilot.store.ts`、`components/CopilotDrawer.vue` 與測試、`apps/web/src/App.vue` | T004～T006；T039 起需 US1 的 T026 | 3（US1）→ 4（US2）→ 5（T052）→ 6（US3）→ 8（US6） |
| **U-nginx-e2e** | T020～T022、T029、T030、T037、T045、T046、T053、T060 | `apps/web/nginx.conf`、`docker-compose.e2e.yml`（T022 的 `METRICS_INTERVAL_MS`）、`tests/e2e/src/harness/{ws-client,compose,infra}.ts`、`tests/e2e/src/*.e2e.test.ts` | T006；各場景相依其 story 的 api／worker 任務 | 2（Phase 2 第二輪）→ 各 story 收尾 |
| **U-docs** | T067～T076（T009 由 U-contracts 代做） | `README.md`、`CHANGELOG.md`、`docs/adr-002-productionization-scope.md`、`docs/adr-003-completion-semantics.md`、`docs/Flow-Gatekeeper-SDD-完整實作指南.md`、`apps/web/PRODUCT.md`、`tests/e2e/README.md`、`CLAUDE.md` | Phase 3～8 行為定案（T067 起） | 9（可於 Phase 7／8 時起草） |
| **主 session** | T001～T003、T077～T082 | `specs/012-stream-resilience/tasks.md`、`research.md`（T003 備註） | — | 1、10 |

### 建議調度順序（每輪最多 2 單位）

| 輪 | 單位 A | 單位 B |
| --- | --- | --- |
| Phase 2-1 | U-contracts（T004～T008，收尾接手 T009） | U-api-registry（T010～T014） |
| Phase 2-2 | U-worker（T015～T019） | U-nginx-e2e（T020～T022） |
| US1-1 | U-worker（T023） | U-api-registry（T024、T025） |
| US1-2 | U-web（T026～T028） | U-nginx-e2e（T029、T030，需 Docker） |
| US2-1 | U-api-registry（T031、T032） | U-web（T038、T040） |
| US2-2 | U-api-lookup（T033～T036） | U-web（T039、T041～T044） |
| US2-3 | U-nginx-e2e（T037、T045、T046） | — |
| US4 | U-worker（T047～T051） | U-web（T052）→ U-nginx-e2e（T053 撰寫） |
| US3-1 | U-worker（T054、T055、T061） | U-api-registry（T056、T057） |
| US3-2 | U-web（T058、T059） | U-nginx-e2e（T060；並執行 T053） |
| US5／US6 | U-worker（T062～T064） | U-web（T065、T066） |
| 文件 | U-docs（T067～T076） | — |
| Polish | 主 session（T077～T082） | — |

### 共用檔案的唯一 owner

| 檔案 | owner | 其他單位的規則 |
| --- | --- | --- |
| `asyncapi.yaml` | U-contracts | U-docs 只讀；契約後續若需改動回 U-contracts |
| `packages/contracts/src/*` | U-contracts | 其他單位只匯入 |
| `CHANGELOG.md` | U-docs | T009（U-contracts 代做）只開 `[Unreleased]` 契約小節標題；其餘內容一律 T074 |
| `README.md`、`docs/**`、`apps/web/PRODUCT.md`、`tests/e2e/README.md`、`CLAUDE.md` | U-docs | 實作單位發現文件矛盾時回報，不直接改；例外：T009 由 U-contracts 只改版本宣稱字串 |
| `apps/web/src/domains/ai-copilot/stores/copilot.store.ts` | U-web | — |
| `apps/web/src/domains/ai-copilot/lib/copilot-reducer.ts`（含 `humanizeError` 與所有文案常數） | U-web | — |
| `apps/web/src/domains/ai-copilot/components/CopilotDrawer.vue` | U-web | — |
| `apps/worker/src/processor.ts`、`processor.test.ts`、`main.ts` | U-worker | — |
| `apps/api/src/modules/websocket/job-status-relay.service.ts`、`relays.test.ts` | U-api-registry | — |
| `apps/api/src/modules/websocket/job-routing-registry.ts` | U-api-registry | U-api-lookup 只呼叫公開方法 |
| `apps/api/src/app.module.ts` | U-api-registry（Phase 2 的 T014）→ **交接** U-api-lookup（Phase 4 的 T036） | 兩次改動分屬不同 phase、不會同時進行；T036 只加一行 provider |
| `apps/web/nginx.conf`、`tests/e2e/src/**` | U-nginx-e2e | — |
| `specs/012-stream-resilience/tasks.md` | 主 session | 實作單位回報完成項，由主 session 勾選 |

### 單位交付的驗證邊界

- 每個單位交付時 MUST 附：該單位改動檔的 `typecheck`、`lint` 與相關 `vitest run <檔案>` 結果；整合與 e2e 任務另附 Docker 執行輸出摘要。
- 交叉審查以單位為範圍（乾淨 Opus），findings 回原作者修完才 commit；phase commit 由主 session 以明確路徑 `git add`。
