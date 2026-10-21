# Research：012-lite 串流韌性（Phase 0）

**Feature**：`012-stream-resilience` | **Date**：2026-10-21 | **Plan**：[plan.md](./plan.md)

設計決策的理由與替代方案以 [ADR-003](../../docs/adr-003-completion-semantics.md) D1～D13 與 §7 代理裁決第 1～21 條為準，
本檔**不重述**，只記「落地方式」：放在哪個檔、介面長什麼樣、與現有程式怎麼接。另有 plan 階段才浮現、spec／ADR 未定的
設計點，統一列在文末「plan 階段自行決定的設計點」（P1～P24），採「對使用者可見行為最保守、實作代價最小」的做法，
待使用者覆核後記入 ADR-003 §7（第 22 條起）。

**行號基準**：本檔引用的行號皆於 `012-stream-resilience` HEAD `bc969dc` 核對；程式檔自 2.1.0（`27bc587`）以來未變，
與 ADR-003、現況對照表的行號一致。

Technical Context 沒有 NEEDS CLARIFICATION：技術棧不換（BullMQ 5.79.2、ioredis、mongodb 6、NestJS、Vue 3.5／Pinia），
所需能力 ADR-003 §1 已確認存在於現有版本。

---

## R1. 契約：傳輸型別、`job/status` 擴充、GET schema、asyncapi 1.4.0

**Decision**：

- `packages/contracts/src/jobs.ts` 新增兩個 Zod 傳輸型別（憲章 III 例外 (c)，與 `DiagnosisJobPayload` 同檔、同屬 api↔worker
  的 BullMQ 內部傳輸，不進 asyncapi）：
  - `DiagnosisJobReturnValueSchema = z.object({ result: DiagnosisResultSchema, cached: z.boolean() })`（D1）。
  - `DiagnosisJobProgressSchema = z.object({ value: z.number().int().min(0).max(100), attempt: z.number().int().min(1), execution: z.number().int().min(1) })`（D7）。
  - `DiagnosisJobPayload` 維持 TS 型別（Zod 化屬 010-lite，Out of Scope）。
- `packages/contracts/src/job-status.ts` 的 `JobStatusSchema` 加 optional `attempt`、`execution`（`z.number().int().min(1)`）、
  `reason`（`z.string()`，JSDoc 列已知值 `"stalled"`）、`cached`（`z.boolean()`）。`status` enum 不變（delayed 仍以 `waiting` 轉發）。
  `cached` 不以 `refine` 綁「帶 `result` 必帶」，見 P8。
- `packages/contracts/src/http.ts` 新增：
  - `DiagnosisLookupParamsSchema = z.object({ jobId: z.uuid() })`；
  - `DiagnosisLookupQuerySchema = z.object({ socketId: z.uuid(), previousSocketId: z.uuid().optional() })`；
  - `DiagnosisLookupResponseSchema = z.discriminatedUnion("status", [completed, failed, waiting, active])`，四個分支都帶
    `jobId: z.uuid()`（P3）；completed `{ result, cached }`、failed `{ error: z.string() }`、waiting／active
    `{ progress?, attempt?, execution?, rebound: z.literal(true) }`。型別皆 `z.infer`。
- `asyncapi.yaml`：`info.version` 1.3.0 → **1.4.0**；`components.messages.JobStatus.payload` 補四個欄位（漂移測試
  `asyncapi-drift.test.ts` 以 `z.toJSONSchema` 結構比對，Zod 與 YAML 必須同步改）；`job/status` channel 描述改為實際行為
  （修 DOC-29）；`ai/done` 描述改為 ADR-003 D3 的英文段落；`AiError.code` 加 `description` 列已知值（`ai_timeout`、
  `provider_error`、`schema_invalid`、`no_context`、`persist_failed`、`worker_failed`），型別仍 `string`；`info.description`
  補一段 `GET /diagnoses/:jobId` 的 HTTP 語意摘要（400／404／409 兩種 code／429／503），明細記 `CHANGELOG.md` 契約小節
  （憲章 III 例外 (b)）。
- 新增測試：`http.test.ts`（GET query／params／response 的合法與非法樣本、discriminated union 各分支）、`jobs.test.ts`（新檔：
  兩個傳輸型別）、`asyncapi-drift.test.ts` 不需改程式（JobStatus 已在 `MESSAGE_SCHEMAS`），只會在 YAML 未同步時轉紅；
  `docs-contract-version.test.ts` 會逼 README／指南／CHANGELOG 的版本字串同步到 1.4.0。

**Rationale**：契約先行（憲章 III）；傳輸型別放 `jobs.ts` 讓 api（relay `safeParse`、GET 驗證 `returnvalue`）與 worker
（processor 回傳型別、`updateProgress` 參數）共用同一份；GET 的 HTTP 契約與 POST 同檔。

**Alternatives considered**：傳輸型別新開 `job-transport.ts`（多一個 re-export、與 `DiagnosisJobPayload` 分家，沒有收益）；
把 GET 寫進 asyncapi 結構（asyncapi 2.6 不描述 HTTP；POST 也只記在 CHANGELOG，維持同一做法）。

## R2. relay 轉發：`returnvalue`、progress 物件、`stalled`

**Decision**（`apps/api/src/modules/websocket/job-status-relay.service.ts`）：

- `completed` handler 改收 `({ jobId, returnvalue })`：`DiagnosisJobReturnValueSchema.safeParse(returnvalue)`（BullMQ
  `queue-events.js` 已 `JSON.parse`）。通過 → 送 `job/status { status:"completed", result, cached, attempt?, execution? }`；
  失敗或 `null`（舊版 worker）→ 照送不帶 `result` 的 `completed`，warn 記 `jobId` 與 issue 路徑／代碼（不記原文，比照
  `ai-stream-relay.service.ts:157-160`）。然後 `registry.markTerminal(jobId, "completed")`。
- `progress` handler：`DiagnosisJobProgressSchema.safeParse(data)` 通過 → `registry.noteProgress(jobId, attempt, execution)`，
  送 `job/status { status:"active", progress: value, attempt, execution }`；`typeof data === "number"` → 照舊；其他 → 送不帶
  progress 的 `active`（現行行為）。
- 新增 `stalled` handler：送 `job/status { status:"waiting", reason:"stalled" }`，warn 一則（`jobId`；FR-047）。BullMQ 的
  `moveStalledJobsToWait` 先寫 `waiting` 再寫 `stalled`，畫面依序收到兩則 `waiting`，第二則帶 `reason`。
- `completed` 的 `attempt`／`execution`：QueueEvents `completed` 事件不帶，改用 registry 綁定上記的最近一次 progress 值（P7）。
- `failed` handler：照舊先送 `ai/error(worker_failed)` 安全網、再送 `job/status: failed`，最後改為
  `registry.markTerminal(jobId, "failed")`（10 s 寬限，D12），不再立即刪綁定。
- 組裝 `job/status` 的邏輯抽成純函式 `apps/api/src/modules/websocket/job-status-payload.ts`（`completedStatus`、
  `progressStatus`），讓「`completed` 帶 `result` 必帶 `cached`」與 progress 拆解有獨立單元測試。

**Rationale**：D1、D7、D12；把 Redis 讀回的資料視為不受信任（憲章 III runtime 驗證、V）。

**Alternatives considered**：relay 在 `completed` 時 `Job.fromId` 讀 attempt／execution（每個完成多一次 Redis 讀，D1 方案 C
同理不選）；把 attempt／execution 塞進 `returnvalue`（改 D1 定案形狀）。

## R3. `JobRoutingRegistry` 的抽出

**Decision**：新檔 `apps/api/src/modules/websocket/job-routing-registry.ts`，`@Injectable()`，`AppModule` providers 加入。
介面（細節見 [data-model.md](./data-model.md) §2）：

```ts
bind(jobId, clientId, machineId): void
rebind(jobId, clientId): JobBinding | undefined          // 換接收連線、更新 boundAt，回傳被取代的舊綁定
get(jobId): Readonly<JobBinding> | undefined
owner(jobId): string | undefined                         // 目前接收連線 clientId
isBound(jobId): boolean
noteProgress(jobId, attempt, execution): void
markTerminal(jobId, kind: "completed" | "failed", now?): void  // 10 s 寬限後只刪「同一份」綁定
delete(jobId): void
claimForLookup({ jobId, socketId, previousSocketId, isOnline }): LookupClaim   // GET 的同步暫定綁定（FR-009）
resolveClaim(claim, machineId): { deferred: boolean }    // 補 machineId（P1）
revertClaim(claim): void                                 // 只撤回本次請求自己的動作（FR-010）
sweepOrphans(now): string[]
```

- 寬限計時器（原 `completedGraceTimers`）與孤兒回收 interval（原 `sweepTimer`）一併移進 registry，`onModuleInit` 啟動、
  `onModuleDestroy` 清除；常數 `TERMINAL_BINDING_GRACE_MS = 10_000` 取代 `COMPLETED_BINDING_GRACE_MS`（舊名只有測試引用，
  一併改名、不留別名），`ORPHAN_TTL_MS` 移入。rebind 時更新 `boundAt`，孤兒回收自改綁起算（P23）。
- `JobBinding` 由 `{ clientId, machineId, boundAt, completedAt? }` 改為
  `{ clientId, machineId: string | null, boundAt, terminal?: { kind, at }, attempt?, execution?, deferred? }`。
- 使用端改寫：`AiStreamRelayService` 移除 `jobRooms` 與 bind／get／markCompleted／delete／bindings，`handleMessage` 改查
  `registry.owner(jobId)`；`JobStatusRelayService` 的 `emit`、`handleDelayed`、`keepDelayedAlive` 改查 registry；`JobsService`
  的 `JobBindingStore` 型別改為 `Pick<JobRoutingRegistry, "bind" | "get" | "delete">`，`existing.completedAt` 判斷改為
  `existing.terminal !== undefined`（`completed` 與 `failed` 寬限內皆 409，FR-014）。`MonitoringGateway.cleanup` 照舊不動綁定。
- 抽出本身是行為不變的重構（`failed` 寬限除外），放在 Foundational phase、先於 US2 的 rebind。

**Rationale**：ADR-003 D8／D12、第三輪報告 §5.3；三處共用一個 Map 的 owner 不清（現況對照 A10），rebind 與終態寬限要有
單一實作。registry 不依賴 Gateway（`isOnline` 以參數傳入），避免 Nest provider 循環與方便純單元測試。

**Alternatives considered**：把 rebind 寫在 `AiStreamRelayService` 裡（現況 owner；但 job-status relay 與 GET 都要用，責任更混）；
registry 外置 Redis（多實例才需要，Out of Scope，ADR-003 §5）。

## R4. `GET /diagnoses/:jobId` 的落地

**Decision**：

- 路由：`JobsController` 新增 `@Get(":jobId")`，以 `DiagnosisLookupParamsSchema`／`DiagnosisLookupQuerySchema` `safeParse`
  `@Param()`、`@Query()`，失敗回 400（`issues[]` 只帶路徑與代碼，與 POST 同形）。controller 依賴型別
  `DiagnosisLookup = Pick<DiagnosisLookupService, "lookup">`。
- 服務：新檔 `apps/api/src/modules/jobs/diagnosis-lookup.service.ts`（P6），依賴 `Queue`（producer 連線，`@InjectQueue`）、
  `JobRoutingRegistry`、`MonitoringGateway`（`isAuthorized`／`isOnline`）、`DiagnosisReader`（Mongo 唯讀，見下）。流程：
  1. `presence.isAuthorized(socketId)` 為 false → 409 `{ code:"socket_unauthorized", message: <與 POST 相同中文句> }`（P2）。
  2. `claim = registry.claimForLookup(...)`——**在任何 await 之前**（FR-009）。
  3. `withTimeout(Job.fromId(queue, jobId) → job.getState(), 5 s)`（沿用 `ENQUEUE_TIMEOUT_MS`）；逾時或 Redis 錯誤 → 撤回、503（P4）。
  4. 有 job：若 claim 需要 machineId（kind `created`）→ `registry.resolveClaim(claim, job.data.machineId)`；回傳 `deferred: true`
     （補上之前 relay 已有 `job/status` 被擱置）就再查一次 state（P1）。依 state 分支（FR-010）：
     - `completed` → `DiagnosisJobReturnValueSchema.safeParse(job.returnvalue)`：通過 → 撤回、200 completed；不通過 → warn、
       落到 Mongo 查詢（FR-013，代理裁決第 16 條）。
     - `failed` → 撤回、200 `{ status:"failed", error: job.failedReason }`。
     - `waiting`／`delayed`／`prioritized`／`waiting-children`／`active` → claim 為 `conflict` → 409
       `{ code:"job_bound_elsewhere", message:"此診斷仍綁定在另一條連線" }`；否則保留綁定、200
       `{ status: state === "active" ? "active" : "waiting", progress?, attempt?, execution?, rebound: true }`
       （progress 由 `job.progress` 以 `DiagnosisJobProgressSchema`／number 解析；attempt＝`attemptsMade + 1`、
       execution＝`attemptsStarted`）；info 記 rebind（`jobId`、`fromClientId`、`toClientId`、`viaPreviousSocketId`）。
     - 其他未知 state → 視同查無 job。
  5. 無 job → `reader.findDiagnosisResult(jobId)`：有且通過 `DiagnosisResultSchema` → 撤回、200 completed（`cached:false`）；
     無 → 撤回、404 `{ message:"查無此診斷（可能已過期）" }`。Mongo 錯誤 → 撤回、503。
- Mongo 唯讀：`HistoryService` 新增 `findDiagnosisResult(jobId): Promise<unknown | null>`（`findOne({ jobId }, { projection:
  { result: 1 } })`，`maxTimeMS` 3 s；db 未就緒即 reject），由 lookup service 驗證。jobs 模組以介面
  `DiagnosisReader = Pick<HistoryService, "findDiagnosisResult">` 注入（P5）。不建索引（`diagnoses.jobId` unique 由 worker 建）。
- 日誌（FR-047）：rebind 與衝突 409 記 info；`socket_unauthorized` 409 沿用 POST 的全域節流 warn。

**Rationale**：D8、FR-007～FR-013；GET 只做有上限的讀取（憲章 IV「api 不跑 long-running」）；Redis 讀取走 producer 的
command 連線（憲章 IV 連線分離：不借 subscriber、不借 QueueEvents 的 blocking 連線）。

**Alternatives considered**：把 GET 寫進 `JobsService`（檔案已 216 行、職責是入列，混進讀取與綁定判斷會讓覆蓋率門檻檔更難維護）；
api 另開一條 Mongo 連線給讀取（多一組連線與關閉流程，HealthModule 已立下「複用 HistoryService 連線」的先例）。

## R5. nginx `diag_read`

**Decision**：`apps/web/nginx.conf` 檔頭新增 `limit_req_zone $binary_remote_addr zone=diag_read:1m rate=60r/m;`（與 `diag` 並列、
同樣附 Docker Desktop 共用一桶的註解），server 區塊在 `location /diagnoses` **之前**新增：

```nginx
location ~ ^/diagnoses/[0-9a-fA-F-]{36}$ {
    limit_req zone=diag_read burst=10 nodelay;
    limit_req_status 429;
    proxy_pass http://$api_upstream;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
}
```

不寫 `add_header`（繼承 server 層安全 header，`nginx.conf:44-45`）。regex location 優先於前綴匹配；query string 不參與比對。
CSP `connect-src 'self'` 已涵蓋同源 GET，註解補一句。Vite dev proxy 的 `/diagnoses` 是前綴，GET 已涵蓋，不改。

**Rationale**：D9。非 UUID 形狀的路徑落回 `/diagnoses` 前綴（POST 桶）並由 api 回 400，接受（只有手動或惡意請求會走到）。

## R6. worker 冪等：查詢順序、三種鍵、trigger upsert、`persist_failed`

**Decision**（`apps/worker/src/processor.ts`、`diagnosis-repository.ts`、`cache/redis-store.ts`、新檔 `cache/job-keys.ts`）：

- 鍵與 TTL 常數集中於 `cache/job-keys.ts`：`aiResultKey(jobId)`（`ai-result:`，`AI_RESULT_TTL_SECONDS = 3600`）、
  `aiMetricKey(jobId)`（`ai-metric:`，`86400`）、`aiFailKey(sig)`（`ai-fail:`，`10`）。既有 `ai-cache:`／`ai-lock:`／`ai-rpm:`
  仍在 processor 內組字串（集中到 contracts 屬 010-lite）。
- `ProcessorStore` 新增 `setIfAbsent(key, value, ttlSeconds): Promise<boolean>`（`SET NX EX`，回 OK 才 true）；`ai-result`／`ai-fail`
  用既有 `get`／`setWithTtl`／`del`。
- `DiagnosisRepository`：新增 `findDiagnosisResult(jobId): Promise<DiagnosisResult | null>`（`DiagnosisResultSchema.safeParse`，
  不合法 → null 並由呼叫端 warn）；`insertTrigger` 改名 **`upsertTrigger`**，實作 `updateOne({ jobId }, { $setOnInsert: {…,
  createdAt } }, { upsert: true })`，E11000（併發 upsert）視為成功（P10）。`ensureTriggerIndexes` 加 `{ jobId: 1 }` unique，
  `ensureUniqueJobIdIndex` 泛化成接受 collection 與日誌標籤，衝突時同樣退回非 unique＋記 error。
- processor 流程（完整步驟表見 data-model §5）：`report(0)` 之後、`buildContext` 之前插入「冪等短路」：
  (i) `ai-result:<jobId>` 有值且通過 schema → `insertDiagnosis`（失敗 → `fail("persist_failed", …)`）→ DEL 暫存；
  (ii) 否則 `repo.findDiagnosisResult(jobId)`；命中任一 → `upsertTrigger(cached:false)` → `report(100)` → `ai/done(cached:false)`
  → `return { result, cached:false }`，info 記 `idempotent short-circuit`（`source: "ai-result" | "diagnoses"`）。
- hit／miss：`replyCached` 與 `callLlmAndReply` 內的 `if (isFirstAttempt)` 改為 `if (await store.setIfAbsent(aiMetricKey(jobId), "1", 86400))`；
  `isFirstAttempt` 變數移除。`setIfAbsent` 失敗（Redis 錯誤）→ 照常拋出走重試（與其他 cache 指令一致）。
- LLM 成功、`parseResult` 通過、`report(80)` 之後：`setWithTtl(ai-result)` → `insertDiagnosis`（try/catch：失敗 →
  `fail(PERSIST_FAILED_CODE, PERSIST_FAILED_MESSAGE, true, err)`）→ `del(ai-result)`（失敗只 warn，TTL 兜底）→
  `setWithTtl(ai-cache)` → `del(ai-fail:<sig>)` → `upsertTrigger(cached:false)` → `report(100)` → `ai/done` → return。
- 常數：`PERSIST_FAILED_CODE = "persist_failed"`、`PERSIST_FAILED_MESSAGE = "persist_failed: diagnosis record could not be written"`
  （代理裁決第 18 條；Mongo 原始錯誤只進 `fail()` 的 `err` 欄位）。
- 快取命中路徑：`upsertTrigger(cached:true)` → `report(100)` → `ai/done(cached:true)` → `return { result, cached:true }`。
- `main.ts` failed handler 改呼叫 `upsertTrigger`（`$setOnInsert`，已有成功紀錄時不覆寫）。
- 冪等短路**不回填** `ai-cache:<sig>`、不 DEL `ai-fail`（短路刻意不建 context，沒有簽章；P11）。

**Rationale**：D6、FR-024～FR-027；trigger 一 jobId 一筆由 unique＋upsert 雙重保證，退回非 unique 時仍以 upsert 冪等。

**Alternatives considered**：`insertTrigger` 名稱不變只改實作（呼叫端讀起來仍像「每次插入一筆」，審查時容易誤解）；hit／miss
去重沿用 `tryAcquireLock`（語意是鎖，拿來當計數標記會讓讀者以為要釋放）。

## R7. `ai-fail:<sig>`

**Decision**（`processor.ts`）：

- 值形狀以 worker 內部 Zod `AiFailMarkerSchema = { code, message, jobId, at }` 驗證（寫讀都在 worker 同一份程式碼，不是
  api↔worker 傳輸，不進 contracts；P9）。解析失敗視為無標記並 DEL。
- **寫入**：`callLlmAndReply` 的 LLM 階段失敗點（`ai_timeout`、`provider_error`、`schema_invalid` 三處含 safety／max_tokens）在呼叫
  `fail()` 之前 `setWithTtl(aiFailKey(sig), marker, 10)`；寫入失敗只 warn。info 記 `ai-fail written`（`sig`、`code`）。
  `no_context`、`persist_failed`、限流延後不寫。
- **讀取**（P13）：(a) 取鎖迴圈每輪開頭（涵蓋新 job 第一輪與等待者每次輪詢）；(b) 取得鎖、double-check `replyCached()` 之後、
  `incrementWindow` 之前。標記 `jobId === 自己` → 忽略。命中 → warn `ai-fail hit`（`sig`、`code`）→
  `fail(marker.code, marker.message, true, null)`（非最終 attempt 只記 warn 並拋可重試錯誤；最終 attempt 送同 code 的 `ai/error`）。
- **清除**：LLM 成功路徑寫入 `ai-cache` 之後 `del(aiFailKey(sig))`；否則等 TTL。

**Rationale**：D5；(b) 那一處是「持鎖者寫標記、放鎖後，等待者恰好在兩者之間通過 (a) 又搶到鎖」的窗口，不補會讓等待者吃
`AI_RPM` 並再打一次 LLM。

## R8. BullMQ 參數、keepalive 與 D4 上界的驗證

**Decision**：

- 新檔 `apps/worker/src/lib/bullmq-options.ts`：`LOCK_DURATION_MS = 15_000`、`STALLED_INTERVAL_MS = 5_000`、`MAX_STALLED_COUNT = 2`、
  `KEEPALIVE_INTERVAL_MS = 10_000`，以及 `WORKER_LOCK_OPTIONS = { lockDuration, stalledInterval, maxStalledCount }`；`main.ts:147-152`
  的 Worker options 展開它（`lockRenewTime` 不設，維持 `L/2`）。檔頭註解寫 D4 的上界公式 `K + L + 2S ≤ 45 s` 與「任一值調整須重算」。
- 新檔 `apps/worker/src/lib/keepalive.ts`：`createKeepalive({ intervalMs, onIdle, timers? })` 回 `{ touch(), stop() }`；processor 每次執行
  建一個：`report(value)`（取代所有 `job.updateProgress(n)`：送 `{ value, attempt, execution }`、記目前里程碑、`touch()`）、
  `onToken` 內 `touch()`；到期 `onIdle` → `job.updateProgress({ value: 目前里程碑, attempt, execution })` 後重新排程。
  失敗吞掉、每次執行至多 warn 一則（P12）；`finally` 內 `stop()`。不逐次記日誌（FR-047）。
- `ProcessorJob` 介面加 `attemptsStarted: number`，`updateProgress` 參數型別改為 `number | DiagnosisJobProgress`（只會送後者）；
  processor 回傳型別 `Promise<DiagnosisJobReturnValue>`；`new Worker<DiagnosisJobPayload, DiagnosisJobReturnValue>`。
- `execution`＝`job.attemptsStarted`（BullMQ 於 `moveToActive` 遞增，處理中的值 ≥ 1）；若讀到 0（非 BullMQ 呼叫的單元測試）
  以 1 代入。
- **D4 上界驗證**：e2e 場景 3 改寫為兩次 kill（串流中、首 token 前），斷言最長無事件間隔 < 45 s，並把實測 `W`（`start worker`
  到 worker 日誌 `worker ready` 的時間）與最長間隔印在場景輸出；quickstart 演練 1 要求手動記錄一次 `W`。`W > 15 s` 時上界
  公式改為 `K + W + 2S`，仍 < 45 s 需 `W ≤ 25 s`；超過即回報（風險見 plan）。

**Rationale**：D2、D4、FR-018～FR-020。

**Alternatives considered**：keepalive 用 `setInterval` 固定節拍（不論有無事件都補送，寫入量加倍且偏離「10 s 無事件才補」）；
參數改 env 可設（FR-018 要具名常數；開放 env 會讓 D4 的上界被任意破壞而無人察覺）。

## R9. web 的收斂、續接與退路

**Decision**（`copilot-reducer.ts`、`copilot.store.ts`、`diagnose-api.ts`、`App.vue`；狀態形狀見 data-model §6）：

- reducer：
  - `job/status: completed` 且帶 `result` → 轉 completed（`cached: event.cached ?? false`、`source:"status"`、
    `streamIncomplete:true`）。不帶 `result` 維持 active（store 記 `backendCompletedAt`，與現行同）。
  - 新增 web 內部事件 `{ type: "lookup/result", jobId, response }`（不是通訊契約，型別放 reducer 檔）：completed → 轉 completed
    （`source:"lookup"`）；failed → failed（`humanizeError(response.error)`）；waiting／active → 維持 active、清 `resume`、更新
    progress／attempt／execution。
  - `job/status` 帶 `attempt > state.attempt` → 換輪（清 `streamText`、`lastSeq = -1`）；帶 `execution > state.execution` → 清串流
    （`seq <= lastSeq` 保留為備援，FR-006）；`reason === "stalled"` → 設 `stalledNotice`（P15）。
  - 「結果未送達」救回擴充為三來源（`ai/done`、帶 `result` 的 completed、lookup completed），其他失敗態不覆蓋（代理裁決第 15 條）。
  - `humanizeError` 在既有判斷之前加兩條：`code === "persist_failed"` 或訊息含 `persist_failed` → 「診斷結果無法寫入資料庫，請稍後重試」；
    訊息含 `job stalled more than allowable limit` → 「後端處理程序多次中斷，診斷已停止，請重試」。
- store：
  - `boundSocketIds: Map<jobId, socketId>`（plain Map，非 reactive）：`diagnose()` 送出前記 POST 的 socketId；lookup 回 `rebound:true`
    時改記本次 socketId；所有 GET 帶 `previousSocketId = boundSocketIds.get(jobId)`（FR-016）。
  - `onReconnect(newClientId)`：clientId 變更時，active 任務改設 `resume:"pending"`、`reconnected:true`（不轉失敗、`touch()` 重設
    watchdog），並加入 `pendingResume` 集合。
  - 新 action `onAuthorized(socketId)`：App 在 `onAuthResult(true)` 時呼叫（P20）；逐台對 `pendingResume` 內仍 active、jobId 未變的
    任務 `lookup(…, purpose:"resume")`，清空集合（同一連線多次 `machine/subscribed` 只消化一次）。
  - `lookup(machineId, jobId, socketId, purpose)`：`lookupInFlight: Set<jobId>` 去重；`getDiagnosis()` 結果包成 `lookup/result`
    丟給 `applyEvent`；錯誤依 purpose 對映（resume：404／409 `job_bound_elsewhere`／其他；undelivered：一律「結果未送達」；
    watchdog：一律「超過 45 秒沒有收到進度，結果未知，請重試」；見 [contracts/ui-copy.contract.md](./contracts/ui-copy.contract.md)）。
    回應或錯誤抵達時任務已不是同一 jobId 的 active（或可救回的未送達）→ 丟棄。
  - `checkStalls`：2 s 寬限到期 → 不直接轉失敗，改 `lookup(purpose:"undelivered")`（GET 期間不重複觸發）；45 s 無進展 →
    `lookup(purpose:"watchdog")`；watchdog GET 回 active／waiting → `touch()` 並 `console.warn`（FR-022）。lookup 的 socketId 用
    `lastClientId`；沒有時直接走該 purpose 的失敗分支。
  - 耗時：lookup 收尾以 `settleTiming(…, { recovered: true })` 記到 `lastRecoveredMs`／`lastKind:"recovered"`（P16）。
- diagnose-api：新增 `getDiagnosis(jobId, socketId, previousSocketId?)`：`GET /diagnoses/<jobId>?socketId=…&previousSocketId=…`，
  逾時 15 s（沿用 `DIAGNOSE_REQUEST_TIMEOUT_MS`），`DiagnosisLookupResponseSchema.safeParse`、`jobId` 比對；失敗拋
  `DiagnoseLookupError { status?, code? }`（409 時讀 body 的 `code`），文案對映由 store 依 purpose 決定（FR-017）。
- App.vue：`onAuthResult: (ok) => { store.setAuthorized(ok); if (ok && store.clientId) copilot.onAuthorized(store.clientId); }`；
  `onConnected` 仍呼叫 `copilot.onReconnect(clientId)`（行為改為「標記待續接」）。

**Rationale**：D10、D11、FR-004～FR-006、FR-016、FR-022；收斂規則全部落在純函式 reducer，四種到達順序可用單元測試窮舉（SC-006）。

**Alternatives considered**：把 lookup 回應直接在 store 改 state、不經 reducer（三個來源的「先到者為準」會散在兩處，SC-006 難測）；
在 `system/connected` 就 GET（有 `WS_AUTH_SECRET` 時會 409，D10 已否決）。

## R10. UI 落點

**Decision**：依 FR-035 表落地，元件改動：

- `CopilotDrawer.vue` 進行中區塊：步驟列下新增一行說明（`resume === "pending"` →「已重新連線，正在取回診斷狀態…」；`stalledNotice`
  →「後端處理程序中斷，任務已重新排入佇列（第 N 次執行）」；兩者同時成立時只顯示續接那行）；`text-xs ink-3`、`aria-live="polite"`
  沿用面板既有的 sr-only 公告區，不新增色值或 chip。
- 完成 meta：`source === "lookup"` 時加中性小字「重新連線後取回」；耗時照常顯示（`compareLabel` 對 `recovered` 回主字、`compareBars` 回 null）。
- 原始串流標題：completed 且 `streamIncomplete` → 「原始串流（不完整）」；否則維持現行（完成「原始串流」、失敗「原始串流（中斷前）」、
  未送達「原始串流」）。`StreamDisclosure.vue` 只吃 `label`，不改。
- 螢幕閱讀器公告：沿用 `CopilotDrawer.vue:179-195` 的「active → completed」邊緣觸發，reducer 保證只轉一次，因此只念一次。
- 卡片 chip（`diagnosis-badge.ts`）不新增 kind；`apps/web/PRODUCT.md` 補術語（重新派送、取回、結果未知）。

**Rationale**：FR-035～FR-038、DESIGN.md「徽章出現或消失不改變容器高度」、代理裁決第 10、13、20 條。

## R11. 測試策略與 e2e 基礎建設

**Decision**：三層，詳表見 plan「測試策略」與 [quickstart.md](./quickstart.md)。

- **純單元（不需 Docker）**：contracts、worker processor（fake store／repo／publisher、`vi.useFakeTimers` 驗 keepalive）、worker
  keepalive／bullmq-options、api registry／payload 組裝／lookup service（fake queue、fake reader、fake presence）／relays／controller、
  web reducer／store／diagnose-api／timing／元件。
- **整合（需 `docker compose up -d` 的 Redis 7＋Mongo 7）**：worker `diagnosis-repository.int.test.ts`（triggers unique＋upsert、
  `findDiagnosisResult`）、`redis-store.int.test.ts`（`setIfAbsent`、TTL）、**新增** `bullmq-lifecycle.int.test.ts`（真 BullMQ：
  processor 回傳值經 QueueEvents `completed` 讀回、progress 物件經 `progress` 事件讀回、Worker 帶 15／5／2 options 可啟動）；
  api 新增 `diagnosis-reader.int.test.ts`（`HistoryService.findDiagnosisResult` 讀真 Mongo）。
- **e2e（需 Docker，`pnpm test:e2e`）**：harness 擴充（`ParsedMessage` 加 `receivedAt`、`maxGap()`、`getDiagnosis()`、
  `pubsubKillLoop()`、`pauseRedis()`、`restartApi()`、`countTriggers()`、`countLlmCalls()`、`workerReadyAt()`），新場景
  5（Pub/Sub）、6a／6b（api 重啟）、7（Redis 停頓）、8（GET 404／409／previousSocketId／400），場景 3 改寫為 3a／3b。
- Pub/Sub 斷線迴圈在 redis 容器內以 `sh -c 'while …; do redis-cli CLIENT KILL TYPE pubsub; sleep 0.05; done'` 執行（P19；
  redis 映像為 alpine，busybox `sleep` 接受小數，implement 時以一次手動執行確認）。
- e2e SC-003「仍進行」以「停 worker → POST → restart api → 重連 GET（waiting、`rebound:true`）→ 啟動 worker → 收到 completed」
  重現（P18）。
- 不改 `vitest.config.ts` 的十個核心檔門檻；新檔 `job-routing-registry.ts` 不加入逐檔門檻（全域門檻照算），implement 後若
  `job-status-relay.service.ts`／`ai-stream-relay.service.ts` 的逐檔覆蓋率因程式移出而變動，以補測試維持門檻、不調低。

## R12. 相容性（舊新混跑）

**Decision**：在 `CHANGELOG.md` 相容性注意寫明，並以 relay 的容錯分支吸收：

| 組合 | 行為 |
| --- | --- |
| 舊 web＋新 api | `job/status` 新欄位被舊 Zod 物件略過；舊 reducer 仍等 `ai/done`，行為同 2.1.0 |
| 新 web＋舊 api | `completed` 不帶 `result` → 2 s 後 GET → 舊 api 無此路由回 404 → 「結果未送達」（同 2.1.0）；重連 GET 404 →「連線中斷期間的診斷結果已無法取回」 |
| 新 api＋舊 worker | `returnvalue` 為 null → 不帶 `result` 的 `completed`＋warn；progress 為數字照舊；鎖參數仍 30／30／1 |
| 舊 api＋新 worker | progress 物件不被舊 relay 認得 → `active` 不帶 progress，進度條變 indeterminate；`returnvalue` 被忽略 |
| 新舊 worker 混跑 | 新 worker 每 5 s 的 stalled 檢查只搬「lock 已不存在」的 job；舊 worker 以 30 s lock、15 s 續租，不會被誤判 |

**升級順序：先 api、後 worker、web 不限**（避免「舊 api＋新 worker」的進度條退化）；一鍵 demo 為同時重建，不受影響。

## R13. 接受的殘餘風險（不加機制）

- Pub/Sub 斷線＋worker 串流中被 SIGKILL：最長無事件約 55 s，先觸發 watchdog → GET（代理裁決第 14 條）。
- Redis 停頓 > 45 s 且落在 LLM 串流中：第二次執行可能再打一次 LLM（ADR-003 §4）。
- api 重啟後 delayed 中的 job 沒有 `waiting` 補送（`delayedUntil` 表隨行程清空）：畫面最長 45 s 後由 watchdog GET 得到 waiting 而
  維持進行中（P17）。
- Redis 整個凍結超過 45 s（`docker compose pause redis` 50 s 即是）：api 收不到任何 QueueEvents、keepalive 也寫不進 Redis，
  畫面在 45 s 觸發 watchdog，GET 讀 Redis 逾時回 503 → 顯示「超過 45 秒沒有收到進度，結果未知，請重試」；Redis 恢復後後端照常
  完成並寫快取，使用者按重試以新 jobId 命中快取、不多打 LLM。這正是 D11「結果未知」的語意；SC-004 驗的是後端計數（trigger 一筆、
  LLM 一次），e2e 的 ws client 不跑 watchdog，會在恢復後收到 `completed`。
- GET 在 `claimForLookup` 暫定建立綁定、machineId 尚未補上的那一個 Redis 往返內，若 relay 要送 `job/status`，該則被擱置；
  由 P1 的「deferred 就再查一次」補回，`ai/*` 不受影響（只看 clientId）。

---

## plan 階段自行決定的設計點（spec／ADR 未定，待覆核）

依「對使用者可見行為最保守、實作代價最小」採下列做法；使用者覆核後記入 ADR-003 §7（第 22 條起），推翻則照 FR-040 以 fix 分支修正。

| # | 設計點 | 採用做法 | 理由（實際代價） | 替代方案 |
| --- | --- | --- | --- | --- |
| P1 | api 重啟後 GET 暫定建立綁定時 machineId 未知 | 綁定先以 `machineId: null` 建立；relay 對 null 綁定的 `job/status` 先擱置並記 `deferred`；`Job.fromId` 後補上 machineId，`deferred` 為真就再查一次 state 回應 | 不改 GET query 形狀；擱置窗只有一個 Redis 往返，再查一次的代價是一次 HGETALL；`ai/*` 照常送達 | GET query 加 `machineId`（契約多一欄、與 spec FR-032 不符）；接受窗內遺失、等 45 s watchdog（使用者多等 45 s） |
| P2 | GET 的兩種 409 如何讓 web 區分 | GET 的 409 body 加機器可讀 `code`：`socket_unauthorized`／`job_bound_elsewhere`；POST 的 409 不動 | 不加的話，連線未授權也會顯示「正由另一個視窗接收」，使用者會去找不存在的視窗；只多一個欄位，記於 asyncapi `info.description` 與 CHANGELOG（憲章 III 例外 (b)） | web 比對中文 message（改字就壞）；web 以自身授權狀態推斷（watchdog／2 s 退路 GET 時推斷不準） |
| P3 | GET 回應是否帶 `jobId` | 四個分支都帶 `jobId`，web 比對不符視為格式錯誤 | 與 `postDiagnose` 的 jobId 比對同一道防線；成本一個欄位 | 不帶（web 無法發現 proxy 錯路由） |
| P4 | GET 遇 Redis／Mongo 不可用或逾時 | 5 s 上限（沿用 `ENQUEUE_TIMEOUT_MS`）→ 503；web 對 503 與其他非列舉狀態碼比照「網路錯誤」文案 | 不設上限時 GET 會掛到 Redis 恢復，使用者看到的是 15 s 後 fetch 逾時；503 讓 nginx／日誌看得出是後端依賴 | 500（看起來像程式錯誤）；無上限 |
| P5 | api 讀 `diagnoses` 的連線 | `HistoryService` 新增唯讀 `findDiagnosisResult`，複用其 Mongo 連線，不建索引 | 不多一組連線與關閉流程；HealthModule 已有複用先例 | 另開 MongoClient |
| P6 | GET 邏輯放哪 | 新 `DiagnosisLookupService`（jobs 模組），`JobsController` 加 `@Get(":jobId")` | `JobsService` 是覆蓋率門檻檔且職責是入列；分開後兩者各自好測 | 寫進 `JobsService` |
| P7 | `completed` 的 `attempt`／`execution` 從哪來 | registry 綁定記最近一次 progress 帶的值；不知道就省略 | QueueEvents `completed` 不帶這兩欄；省一次 Redis 讀 | relay 在 `completed` 時 `Job.fromId`；塞進 `returnvalue` |
| P8 | `cached` 的「帶 result 必帶」放哪一層 | schema 層維持 optional（不 `refine`），由 relay 的組裝純函式保證並單元測試；web 收到帶 `result` 缺 `cached` 時當 false | `refine` 不會出現在 `z.toJSONSchema`，漂移比對看不到，等於兩邊規則不一致；web 端當 false 最多少顯示一個「快取」字樣 | `superRefine`（漂移測試無法覆蓋） |
| P9 | `ai-metric` 與 `ai-fail` 的 store／驗證 | `ProcessorStore.setIfAbsent`；`ai-fail` 值以 worker 內部 Zod 驗證，不進 contracts | 讀寫都在 worker 同一份程式碼，不是 api↔worker 傳輸；放 contracts 會讓 web bundle 多一個用不到的 schema | 借 `tryAcquireLock`；放 contracts |
| P10 | trigger 寫入的命名與併發 | `insertTrigger` 改名 `upsertTrigger`（`$setOnInsert`），E11000 視為成功；unique 建立泛化 `ensureUniqueJobIdIndex` | 名稱反映冪等語意，審查時不會誤讀；E11000 只在兩個 upsert 同時插入時出現，結果已是一筆 | 保留舊名 |
| P11 | 冪等短路是否回填快取 | 不回填 `ai-cache`、不 DEL `ai-fail` | 短路刻意不建 context（省 4 支 Mongo 查詢），沒有簽章就無從組鍵；快取在第一次執行已寫入或之後的新請求會重寫 | 短路也建 context 以回填（每次再執行多 4 支查詢） |
| P12 | keepalive 失敗的處理 | 吞掉、每次執行至多 warn 一則、下一個 10 s 再試；`finally` 停止計時器 | Redis 斷線時其他指令會拋錯走既有失敗路徑；逐次記 warn 會在故障期間每 10 s 每 job 一行 | 失敗即讓 job 失敗（keepalive 不該決定 job 成敗） |
| P13 | `ai-fail` 檢查位置 | 取鎖迴圈每輪開頭＋取得鎖後、限流 INCR 前兩處 | 只放開頭會漏「持鎖者寫標記放鎖、等待者剛好搶到鎖」的窗口，該等待者會吃 `AI_RPM` 並再打一次 LLM | 只放一處 |
| P14 | `failed` 先到時籠統的 `worker_failed` 是否被後到的具體 `ai/error` 覆寫 | web 不新增覆寫規則；具體文案由 `failedReason`（＝worker 的 `ai/error.message`，同源）與 `persist_failed` 固定句承接 | `fail()` 拋出的訊息就是 `failedReason`，`humanizeError` 對兩者的結果相同或相近；不多一條「非 active 也吃事件」的例外 | reducer 允許具體 `ai/error` 覆寫籠統失敗（多一條例外與測試） |
| P15 | 「第 N 次執行」的 N | 收到 `reason:"stalled"` 時 N＝`(目前 execution ?? 1) + 1`，之後由下一則帶 `execution` 的 `job/status` 校正；`execution` 再遞增而沒有新的 stalled 時移除說明 | `stalled` 事件本身不帶 execution；先估再校正，畫面不會出現「第 1 次執行」這種錯值 | 不顯示 N（spec 文案帶 N） |
| P16 | GET 收尾的耗時記錄 | `settleTiming(…, { recovered: true })` 寫 `lastRecoveredMs`、`lastKind:"recovered"`，不動 `lastUncachedMs`／`lastCachedMs`，不畫對比橫條 | 重連取回的耗時含斷線時間，拿來當「上一次」基準會讓下一次快取對比失真（FR-035） | 不記耗時（完成 meta 少一項資訊） |
| P17 | api 重啟後 delayed job 的補送 | 不補建 `delayedUntil`；由 watchdog GET 承接 | 補建要讓 lookup service 回頭操作 job-status relay 的內部表；最壞情況是使用者看到 45 s 後仍「進行中」，不轉失敗 | lookup 時依 `job.delay` 補登記 |
| P18 | e2e 如何重現「api 重啟後 job 仍進行」 | 先停 worker → POST → `restart api` → 重連 GET（waiting、`rebound:true`）→ 啟動 worker → 收到 completed；active 狀態的改綁由 api 單元測試與場景 8 的 `previousSocketId` 覆蓋 | fake 串流約 10 s，短於 api 冷啟動 10～17 s，串流中重啟 api 時 job 一定先完成；改 fake 延遲會牽動既有場景的等待上限 | e2e override 拉長 `FAKE_AI_TOKEN_DELAY_MS`（影響全部場景） |
| P19 | Pub/Sub 斷線迴圈的執行位置 | redis 容器內 `sh -c` 迴圈 | Windows 上每次 `docker exec` 數百 ms，做不到 50 ms 間隔 | harness 每 50 ms spawn 一次 |
| P20 | web 何時觸發續接 GET | 新 store action `onAuthorized(socketId)`，App 於 `onAuthResult(true)` 呼叫；同一連線多次 `machine/subscribed` 只消化一次待續接清單 | 維持 copilot store 與 monitoring store 不互相匯入的現行分工；App 是唯一同時知道兩者的地方 | copilot store watch monitoring store 的授權狀態（store 互相依賴） |
| P21 | 2 s 退路 GET 回 waiting／active（理論上不會發生：`completed` 已到） | 視同取不到結果，轉「結果未送達」（可被後到的結果救回） | 留在 active 會讓已完成的任務再等 45 s；轉成可救回的失敗，結果一到仍會改回已完成 | 留在 active |
| P22 | GET 回 `rebound` 的語意 | 綁定原本就是本 socket（`unchanged`）時也回 `rebound: true`，意思是「之後的事件送到這條連線」 | 讓 web 只有一條規則（收到 `rebound:true` 就把 `previousSocketId` 改成本次 socketId） | 新增 `rebound:false` 分支（契約多一種值） |
| P23 | rebind 後孤兒回收的起算點 | rebind 時更新 `boundAt` | 改綁後還要再跑的 job 不該因原始建立時間被提早回收 | 沿用原 `boundAt` |
| P24 | e2e「首 token 前」kill 的時點 | 收到 `job/status` progress 20（context 已返回、尚未呼叫 LLM）即 kill | fake 第一個 token 約在 progress 40 後 500 ms，以 20 為觸發點確定落在首 token 前 | 收到 progress 40 才 kill（與首 token 只差 500 ms，容易落到之後） |
