# Data Model：012-lite 串流韌性（Phase 1）

**Feature**：`012-stream-resilience` | **Date**：2026-10-21 | **Plan**：[plan.md](./plan.md) | **Research**：[research.md](./research.md)

本檔描述本 feature 新增或改形的實體、欄位、驗證規則與狀態轉移。wire 層（WS／HTTP）的完整契約見
[contracts/job-lifecycle.contract.md](./contracts/job-lifecycle.contract.md) 與
[contracts/diagnosis-lookup.contract.md](./contracts/diagnosis-lookup.contract.md)；畫面文案見
[contracts/ui-copy.contract.md](./contracts/ui-copy.contract.md)。設計理由一律見 ADR-003（D 點）與 research（R／P 點）。

---

## 1. 契約型別（`packages/contracts`）

| 型別（schema） | 檔案 | 用途 | 欄位 | 驗證端 |
| --- | --- | --- | --- | --- |
| `DiagnosisJobReturnValue`（新） | `jobs.ts` | BullMQ `returnvalue`（worker → Redis → api） | `result: DiagnosisResult`、`cached: boolean` | api relay `completed`、GET 的 `Job.fromId` 讀回時 `safeParse`（D1） |
| `DiagnosisJobProgress`（新） | `jobs.ts` | `job.updateProgress()` 參數（worker → Redis → api） | `value: int 0–100`、`attempt: int ≥ 1`、`execution: int ≥ 1` | api relay `progress`、GET 讀 `job.progress` 時 `safeParse`；數字照舊接受（D7） |
| `JobStatus`（改） | `job-status.ts` | WS `job/status` | 既有 `type`／`jobId`／`machineId`／`status`／`progress?`／`result?`／`error?`，**新增** `attempt?`（int ≥ 1）、`execution?`（int ≥ 1）、`reason?`（string，已知值 `"stalled"`）、`cached?`（boolean） | web 入口 `safeParse`（既有） |
| `DiagnosisLookupParams`（新） | `http.ts` | GET path | `jobId: uuid` | api controller |
| `DiagnosisLookupQuery`（新） | `http.ts` | GET query | `socketId: uuid`、`previousSocketId?: uuid` | api controller |
| `DiagnosisLookupResponse`（新） | `http.ts` | GET 200 body（discriminated union on `status`） | 見下表 | web `getDiagnosis` |

`DiagnosisLookupResponse` 各分支（皆帶 `jobId: uuid`，P3）：

| `status` | 其餘欄位 | 何時回 |
| --- | --- | --- |
| `completed` | `result: DiagnosisResult`、`cached: boolean` | BullMQ completed 且 `returnvalue` 合法；或 job 已清、Mongo `diagnoses` 有合法結果（`cached:false`） |
| `failed` | `error: string`（BullMQ `failedReason` 原文） | BullMQ failed |
| `waiting` | `progress?`、`attempt?`、`execution?`、`rebound: true` | BullMQ waiting／delayed／prioritized／waiting-children，且綁定已指向本 socket |
| `active` | 同上 | BullMQ active，且綁定已指向本 socket |

不變的型別：`DiagnosisJobPayload`（仍 TS，010-lite）、`AiToken`／`AiDone`／`AiError` schema（只改 asyncapi 描述）、`DiagnosisResult`。

---

## 2. 綁定（`JobRoutingRegistry`，api 行程內）

### 2.1 `JobBinding`

| 欄位 | 型別 | 說明 |
| --- | --- | --- |
| `clientId` | string | 目前接收此 job 事件的 WS 連線 |
| `machineId` | string \| null | `job/status` 需要它路由到畫面；GET 在 api 重啟後暫定建立時為 `null`，`Job.fromId` 後補上（P1） |
| `boundAt` | number（epoch ms） | 建立或最近一次 rebind 的時刻；孤兒回收以此起算 10 分鐘（P23） |
| `terminal?` | `{ kind: "completed" \| "failed"; at: number }` | 已達終態；寬限 10 s 後刪除（D12） |
| `attempt?`／`execution?` | number | 最近一次 progress 物件帶來的值，`completed` 時沿用（P7） |
| `deferred?` | boolean | `machineId` 為 null 期間 relay 有 `job/status` 被擱置（P1） |

**不變量**：每個 jobId 至多一份綁定；只有 registry 能改寫；寬限期滿與撤回都只刪「當初那一份物件」（以參照比對），不誤刪之後
以同一 jobId 新建的綁定。

### 2.2 生命週期

```text
(無) ──POST bind──▶ 進行中 ──rebind（GET：原連線離線／等於 previousSocketId）──▶ 進行中（新 clientId）
  │                   │
  │                   ├──completed／failed（QueueEvents）──▶ 終態寬限 10 s ──▶ (刪除)
  │                   └──10 分鐘未終態（孤兒回收）──────────────────────────▶ (刪除)
  └──GET claim created（machineId=null）──resolveClaim──▶ 進行中（或撤回 → 無）
```

### 2.3 `claimForLookup`（GET 在任何 await 之前，FR-009）

依序判斷，第一個成立者決定 `kind`：

| # | 現有綁定 | 條件 | `kind` | 同步動作 |
| --- | --- | --- | --- | --- |
| 1 | 無 | — | `created` | `bind(jobId, socketId, null)` |
| 2 | 有 | `terminal` 已設 | `terminal` | 不動 |
| 3 | 有 | `clientId === socketId` | `unchanged` | 不動 |
| 4 | 有 | `!isOnline(clientId)` | `rebound` | `rebind` 到 socketId，記下原綁定 |
| 5 | 有 | `clientId === previousSocketId`（仍在線） | `rebound`（`viaPreviousSocketId: true`） | 同上；不主動終止舊連線 |
| 6 | 有 | 其他（原連線在線、不是本 socket、不等於 `previousSocketId`） | `conflict` | 不動 |

`claim` 只代表「await 之前」的判斷；BullMQ 查詢期間綁定可能被另一個 GET 改綁走，所以 §2.4「進行中」列回 `rebound:true` 前
MUST 再核對一次 owner（實作交叉審查補，2026-10-21）。

### 2.4 查詢結果 × claim 的處置（FR-010）

| 查詢結果 | `created` | `rebound` | `unchanged` | `terminal` | `conflict` |
| --- | --- | --- | --- | --- | --- |
| completed（`returnvalue` 合法） | 撤回（刪）→ 200 | 撤回（還原原綁定）→ 200 | 200 | 200 | 200 |
| failed | 撤回 → 200 | 撤回 → 200 | 200 | 200 | 200 |
| 進行中 | 保留＋補 machineId → 200 `rebound:true` | 保留 → 200 `rebound:true` | 200 `rebound:true` | **503**（不可達、不重判：終態事件晚於 state 寫入且 registry 禁止改綁終態綁定；寬限 10 s 後再查走 created 路徑。實作時更新，2026-10-21） | **409** `job_bound_elsewhere` |
| 無 job → Mongo 有 | 撤回 → 200 completed | 撤回 → 200 | 200 | 200 | 200 |
| 無 job、Mongo 無（或兩來源皆不合法） | 撤回 → 404 | 撤回 → 404 | 404 | 404 | 404 |
| Redis／Mongo 錯誤或逾時 | 撤回 → 503 | 撤回 → 503 | 503 | 503 | 503 |

「撤回」＝`revertClaim`：`created` 只在目前綁定仍是自己建立的那份時刪除；`rebound` 只在目前綁定仍是自己改綁的那份時還原原綁定。

**回 `rebound:true` 前核對 owner**（實作交叉審查補，2026-10-21；ADR-003 D8 第 4 點、§7.1）：「進行中」列的 `created`／`rebound`／
`unchanged` 三欄，回 200 之前 MUST 確認 `registry.owner(jobId) === socketId`；BullMQ 查詢期間綁定已被另一個 GET（例如以
`previousSocketId`）改綁走時，與 `conflict` 同樣回 **409** `job_bound_elsewhere`。不核對時兩個 GET 都會回 `rebound:true`，
其中一個分頁以為自己在收事件、實際收不到，只能等 45 s watchdog。

---

## 3. Redis 鍵（worker 寫；皆帶 TTL）

| 鍵 | 值 | TTL | 寫入時機 | 讀取時機 | 刪除 |
| --- | --- | --- | --- | --- | --- |
| `ai-result:<jobId>`（新） | `DiagnosisResult` JSON | 3600 s（對齊 `removeOnComplete`） | LLM 成功、`parseResult` 通過後、寫 `diagnoses` 之前 | processor 開頭的冪等短路 (i) | `diagnoses` 寫入成功後 DEL |
| `ai-fail:<sig>`（新） | `{ code, message, jobId, at }` JSON | 10 s | LLM 階段失敗（`ai_timeout`／`provider_error`／`schema_invalid`），`fail()` 之前 | 取鎖迴圈每輪開頭；取鎖後、限流 INCR 前（P13） | 持鎖者 LLM 成功寫 `ai-cache` 後 DEL；否則 TTL |
| `ai-metric:<jobId>`（新） | `"1"` | 86400 s（對齊 `removeOnFail`） | 記 hit／miss 前 `SET NX`，回 OK 才記 | — | TTL |
| `ai-cache:<sig>`（既有） | `DiagnosisResult` JSON | `AI_CACHE_TTL_SECONDS` | `diagnoses` 寫入成功後（不變量：快取有值就代表已落庫） | 不變 | 讀回不合法時 DEL（不變） |
| `ai-lock:<sig>`、`ai-rpm:<window>`（既有） | — | 不變 | 不變 | 不變 | 不變 |

驗證：`ai-result` 讀回以 `DiagnosisResultSchema.safeParse`、`ai-fail` 讀回以 worker 內部 `AiFailMarkerSchema`（P9）；不合法者 DEL
並視為無值。BullMQ job hash 的 `progress` 欄位改存 `DiagnosisJobProgress` 物件、`returnvalue` 改存 `DiagnosisJobReturnValue`。

---

## 4. MongoDB

| collection | 變更 | 規則 |
| --- | --- | --- |
| `diagnosisTriggers` | 新增 `{ jobId: 1 }` unique 索引（衝突時退回非 unique＋error 日誌，沿用 `ensureUniqueJobIdIndex` 邏輯）；寫入改 `updateOne({ jobId }, { $setOnInsert: { machineId, jobId, requestedBy, cached, createdAt } }, { upsert: true })` | 每個 jobId 恰一筆：成功（`cached` true／false）或最終失敗，先寫者勝；TTL 30 天不變；併發 upsert 撞 E11000 視為成功 |
| `diagnoses` | worker 新增 `findDiagnosisResult(jobId)`；api 新增唯讀 `HistoryService.findDiagnosisResult(jobId)`（`projection: { result: 1 }`、`maxTimeMS` 3 s） | 只收 LLM 路徑結果（快取命中不寫，不變）；api 不寫、不建索引 |

---

## 5. worker 執行流程（每次執行）

`report(v)` ＝ `job.updateProgress({ value: v, attempt, execution })`＋記 `milestone = v`＋keepalive `touch()`；
`attempt = job.attemptsMade + 1`、`execution = max(1, job.attemptsStarted)`。

| 步驟 | 動作 | 失敗時 |
| --- | --- | --- |
| 0 | 建 keepalive（10 s 閒置 → `updateProgress({ value: milestone, … })`） | — |
| 1 | `report(0)` | 拋出 → 重試 |
| 2 | **冪等短路** (i)：`ai-result:<jobId>` 合法 → `insertDiagnosis` → DEL 暫存 → 跳步驟 4 | `insertDiagnosis` 失敗 → `fail("persist_failed", PERSIST_FAILED_MESSAGE, true, err)` |
| 3 | **冪等短路** (ii)：`repo.findDiagnosisResult(jobId)` 合法 → 步驟 4；兩者皆無 → 步驟 5 | 拋出 → 重試 |
| 4 | `upsertTrigger(cached:false)` → `report(100)` → `ai/done(cached:false)` → `return { result, cached:false }`（info `idempotent short-circuit`，`source`） | trigger 失敗 → 拋出 → 重試（下次仍短路） |
| 5 | `buildContext` → `report(20)` → 空脈絡短路（不變） → 簽章 | 不變 |
| 6 | `replyCached()`：命中 → `setIfAbsent(ai-metric)` 為真才記 hit → `upsertTrigger(cached:true)` → `report(100)` → `ai/done(cached:true)` → `return { result, cached:true }` | 不變 |
| 7 | 取鎖迴圈每輪開頭：查 `ai-fail:<sig>`（非自己）→ 命中即 `fail(marker.code, marker.message, true)` | — |
| 8 | 取得鎖 → double-check `replyCached()` → 查 `ai-fail` → 限流 INCR（超限 → 延後，不變） | — |
| 9 | `report(40)` → `setIfAbsent(ai-metric)` 為真才記 miss → LLM 串流（每個 token `touch()`；首 token `report(60)`） | LLM 失敗：寫 `ai-fail` → `fail(code, …)`（不變的分類） |
| 10 | `parseResult` → `report(80)` → SET `ai-result` → `insertDiagnosis` → DEL `ai-result` → SET `ai-cache` → DEL `ai-fail` → `upsertTrigger(cached:false)` → `report(100)` → `ai/done(cached:false)` → `return { result, cached:false }` | （實作交叉審查更新，2026-10-21；ADR-003 代理裁決第 50 條）SET `ai-result` 失敗 → 只 warn、照常 `insertDiagnosis`（best-effort）；`insertDiagnosis` 失敗 → `fail("persist_failed", PERSIST_FAILED_MESSAGE, true, err)`（重試時若暫存在，步驟 2 只重做寫庫）；DEL `ai-result`、DEL `ai-fail` 失敗 → 只 warn、由 TTL 回收；SET `ai-cache`、`upsertTrigger`、`report(100)` 失敗 → 拋出 → 重試（`diagnoses` 已落地，下次步驟 3 短路、不打 LLM） |
| 11 | 未取得鎖：`replyCached()` → 關閉中交回（不變）→ deadline（不變）→ sleep → 回步驟 7 | 不變 |
| finally | keepalive `stop()`、`liveness.end` | — |

**BullMQ Worker options**（`apps/worker/src/lib/bullmq-options.ts`）：

| 常數 | 值 | BullMQ 預設 | 說明 |
| --- | --- | --- | --- |
| `LOCK_DURATION_MS` | 15000 | 30000 | `L`；`lockRenewTime` 維持預設 `L/2`＝7.5 s（不另設），續租計時器每 `lockRenewTime/2` 約 3.75 s 觸發、最慢 7.5 s，Redis 卡頓容忍約 11.25～15 s（合併門第 2 輪更正，原寫「續租 `L/2`＝7.5 s」） |
| `STALLED_INTERVAL_MS` | 5000 | 30000 | `S` |
| `MAX_STALLED_COUNT` | 2 | 1 | 一次額度留給 Redis 卡頓、一次給真的崩潰 |
| `KEEPALIVE_INTERVAL_MS` | 10000 | — | `K`（worker 自訂） |

設計上界：被 SIGKILL 後畫面最長無事件 `K + L + 2S` ＝ 35 s（`W ≤ L` 時；ADR-003 D4）。

---

## 6. web 呈現狀態（`copilot-reducer.ts` 的 `CopilotJobState`，web 內部、非契約）

### 6.1 欄位變更

| 狀態 | 新增／改動欄位 | 說明 |
| --- | --- | --- |
| `active` | `execution: number`（起始 1） | 目前呈現的執行序號；`job/status.execution` 更大時清串流 |
| `active` | `resume?: "pending"` | 重連後、續接 GET 回應前；面板顯示「已重新連線，正在取回診斷狀態…」 |
| `active` | `reconnected?: true` | 執行期間經歷過 WS 重連（FR-016）；收尾時轉成 `streamIncomplete` |
| `active` | `stalledNotice?: { execution: number; confirmed?: true }` | 收到 `reason:"stalled"`；面板顯示「…（第 N 次執行）」（P15） |
| `completed` | `source: "ai/done" \| "status" \| "lookup"` | 收尾來源；`lookup` 時完成 meta 加「重新連線後取回」（實作更新 2026-10-21，ADR-003 代理裁決第 53 條：改為 `source === "lookup"` **且** `reconnected` 才顯示，2 s／watchdog 退路沒有重連時不顯示） |
| `completed` | `reconnected?: true` | 自 active 帶入（執行期間經歷過重連）；供「重新連線後取回」小字（第 53 條）與耗時 recovered 判定 `source === "lookup" \|\| reconnected`（第 52 條，§6.4）使用 |
| `completed` | `streamIncomplete: boolean` | `source !== "ai/done"` 或 `reconnected` 時為 true → 標題「原始串流（不完整）」（FR-038） |
| `failed` | `reason?: "undelivered"`（不變） | 只有它可被三種結果來源救回 |

`CopilotEvent` 聯集新增 web 內部事件 `LookupResultEvent = { type: "lookup/result"; jobId; response: DiagnosisLookupResponse }`。

### 6.2 reducer 轉移（只列本 feature 新增或改動者；前提：事件 jobId 等於目前任務）

| 目前狀態 | 事件 | 新狀態 |
| --- | --- | --- |
| active | `job/status` completed＋`result` | completed（`cached ?? false`、`source:"status"`、`streamIncomplete:true`） |
| active | `job/status` completed 無 `result` | active（progress 更新；store 記 2 s 寬限起點，不變） |
| active | `job/status` 帶 `attempt > state.attempt` | active，換輪：清 `streamText`、`lastSeq=-1`、`attempt` 更新 |
| active | `job/status` 帶 `execution > state.execution` | active，清 `streamText`、`lastSeq=-1`、`execution` 更新；若 `stalledNotice.execution < 新 execution` 且本則不是 stalled → 移除說明 |
| active | `job/status` waiting＋`reason:"stalled"` | active，`stalledNotice = { execution: max(state.execution, 既有 N) + 1 }`（未確認）；之後帶 `execution ≥ 估計值` 的事件校正並 `confirmed`，小於者視為遲到事件忽略；確認後 execution 再增且無新 stalled 才移除（實作時依 P15 修正，2026-10-21） |
| active | `lookup/result` completed | completed（`source:"lookup"`、`streamIncomplete:true`） |
| active | `lookup/result` failed | failed（`humanizeError(error)`） |
| active | `lookup/result` waiting／active | active，清 `resume`，更新 progress／attempt／execution（遞增規則同上） |
| active | `ai/done` | completed（`source:"ai/done"`、`streamIncomplete = reconnected === true`） |
| failed `undelivered` | `ai/done`／`job/status` completed＋`result`／`lookup/result` completed | completed（三來源皆可救回；`streamIncomplete` 依來源規則） |
| completed／failed（非 undelivered） | 任何事件 | 不變（先到者為準，FR-004） |

### 6.3 store 側附屬表（plain Map／Set，非 reactive；只有副作用路徑讀）

| 名稱 | 鍵 → 值 | 寫入 | 讀取 | 清除 |
| --- | --- | --- | --- | --- |
| `boundSocketIds`（新） | jobId → socketId | `diagnose()` 送 POST 前；lookup 回 `rebound:true` | 每次 GET 的 `previousSocketId` | 該台開新任務、`cancel` |
| `pendingResume`（新） | machineId 集合 | `onReconnect`（clientId 變更且該台 active） | `onAuthorized` | `onAuthorized` 消化後；任務離開 active |
| `lookupInFlight`（新） | jobId 集合 | `lookup()` 發出 | `checkStalls` 跳過重複觸發 | GET 回應或失敗 |
| `lastActivityAt`、`backendCompletedAt`（既有） | 不變 | `onReconnect` 另 `touch()` | 不變 | 不變 |

### 6.4 耗時（`diagnosis-timing.ts`）

`DiagnosisTiming` 新增 `lastRecoveredMs?: number`、`lastRecoveredCached?: boolean`（實作時改為 optional 並補快取旗標供 `compareLabel` 決定主字，2026-10-21），`lastKind` 增加 `"recovered"`；recovered 判定為「以 GET 收尾或執行期間經歷過重連」（代理裁決 52）。`settleTiming(timing, jobId, cached, now, opts?)`
的 `opts.recovered === true` 時只寫 `lastRecoveredMs`／`lastKind:"recovered"`，不動 `lastUncachedMs`／`lastCachedMs`；`compareLabel`
對 `recovered` 回主字（快取與否照 `cached`）、`compareBars` 回 null（P16）。

注（合併門第 2 輪，2026-10-22）：耗時以 `performance.now()` 計（單調時鐘）；部分平台在系統掛起（筆電睡眠）時它不前進，睡醒後取回的任務 `lastRecoveredMs` 可能少算掛起的時間。只影響完成 meta 的顯示，recovered 本來就不作對比基準。
