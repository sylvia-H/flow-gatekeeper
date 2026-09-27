# 2026-09-27 全面技術棧與架構審查（Research Review）

| 項目 | 內容 |
| --- | --- |
| 日期 | 2026-09-27 |
| 審查對象 | `main` @ `3e94ac2`（v1.0.0，Feature 001–009 全數併入） |
| 方法 | 6 個獨立審查 agent（Opus 5.5）分面向平行檢視，由統籌者（Fable 5.1）交叉比對、去重、排序後統整；全程只讀，未修改任何程式碼 |
| 面向 | ① api Gateway 後端 ② worker 與 AI 管線 ③ web 前端與 rAF gatekeeper ④ 契約、工具鏈、建置、相依 ⑤ 可觀測性、運維、安全 ⑥ 架構邊界、文件漂移、SDD 流程 |
| 本機驗證 | `typecheck`／`lint`／`contract:lint` 全綠；`test` 207 個測試全數通過（shared 16、contracts 5、api 33、worker 47、web 106） |
| 相關 | ADR-001、ADR-002、`CLAUDE.md`、`.specify/memory/constitution.md`、實作指南 §8／§13–§15 |

> **閱讀提示**：ADR-002 §3 已誠實承認的差距（Gateway 單實例、Pub/Sub at-most-once、靜態 secret、fire-and-forget 有損寫入、無 HA、CI 暫停）**不重複列為新發現**。本文只列「文件沒承認」、「比文件承認的更嚴重」或「宣稱與程式碼不符」的項目。標「**實測**」者有可重現證據；標「推測」者為依程式碼推論、未實際觸發。

---

## 0. 結論摘要

**總體判斷**：功能層選型（pnpm monorepo + Zod 契約、BullMQ 削峰、`AiProvider` 隔離、Redis Pub/Sub 雙通道）與邊界切分是對的；可觀測性、容器化監督、祕密衛生的細節超出一般 side project 水準。但三個核心賣點目前都有「宣稱與程式碼不符」的缺口，且存在數條**未授權即可觸發的 api 崩潰路徑**。整體屬「架構方向正確、實作有幾處關鍵缺口、證據鏈薄弱」。

三個賣點對應的缺口：

| 賣點 | 缺口 | 章節 |
| --- | --- | --- |
| ① 前端 rAF gatekeeper 背壓 | 比值定義混入伺服器端打包效果；README 數字自相矛盾；41:1 無可重現腳本 | §3.3、§5 |
| ② BullMQ 削峰 + cache/lock 去重 | 等待者取鎖後不再查 cache，去重在多數情況下不成立 | §1.3 |
| ③ AI 雙通道 streaming | 逾時不中止串流、重試 token 重播、cache 命中事件早於 HTTP 回應而被前端丟棄 | §2.1–§2.3 |

**建議修復順序**（詳見 §7）：Gateway 輸入加固 → 乾淨 clone 可建置 → dedupe double-check + AbortSignal + Gemini SDK 遷移 → `REDIS_PASSWORD` 與 ports → Zod 驗證 body 與 env → 重試語意與 jobId 前端產生。

---

## 1. P0：成本低、影響大，建議立即修

### 1.1 未授權一則 WS 訊息即可讓 api 崩潰（**實測**，三個 agent 各自重現）

- **位置**：`apps/api/src/modules/websocket/monitoring.gateway.ts:94-117`（`handleMessage`）、`:75`（`new WebSocketServer({ server, path: "/ws" })`）、`:87-90`（只掛 `message`／`pong`／`close`）。
- **兩條路徑**：
  1. **形狀未驗證**：`JSON.parse(raw) as typeof msg` 後直接 `switch (msg.type)`，`raw === "null"` 即 TypeError（在授權檢查之前）；`machineIds` 為數字或物件時 `new Set(machineIds)` 拋錯；字串會被拆成單字元。
  2. **無 `error` listener**：ws 8 遇協定錯誤（非法 opcode、未遮罩 frame、無效 UTF-8、超過 `maxPayload`）會 `emit('error')`，無 listener 時 EventEmitter 直接 throw。
- **後果**：例外在 ws `message` handler 內同步拋出、冒到 Receiver 成為 uncaughtException；api 沒有全域 fatal handler（`src/` 搜不到 `uncaughtException`），行程 exit 1。demo 的 `.env.demo` 刻意讓 `WS_AUTH_SECRET` 留空、`/ws` 經 nginx 8080 對外，`restart: on-failure:5` 用盡後 api **永久停擺**。nginx upgrade 後只轉 bytes，不擋畸形 frame。
- **附帶 DoS 面**：`maxPayload` 用 ws 預設 100 MiB；`machineIds` 無白名單、無數量上限；無 Origin 檢查（CSWSH）；無連線數上限。
- **修法**：
  - `packages/contracts` 新增 `ClientControlMessageSchema = z.discriminatedUnion("type", [...])`，`machineIds: z.array(z.string().max(64)).max(50)`；Gateway 改 `safeParse`，失敗忽略並記 log。憲章 III「需 runtime 驗證的 payload MUST 用 Zod」正適用於 client→server 的不可信輸入，不屬「純型別分派 MAY 用 TS」的豁免。
  - `socket.on("error", …)` 與 `wss.on("error", …)`；`maxPayload: 16 * 1024`；`verifyClient` 比對 Origin 白名單；`machineIds` 與已知機台取交集。
  - api 補 `uncaughtException`／`unhandledRejection` handler：與 worker 的 let-it-crash 語意對齊，且使崩潰時仍輸出合法 JSON log（009 FR-001 目前例外只涵蓋 worker）。
  - 新增 Gateway 整合測試（隨機 port 起真實 `http` + `ws`）：`null`、數字、非陣列 `machineIds`、畸形 frame 皆不得讓行程結束。

### 1.2 乾淨 clone 無法 typecheck／test；CI 打開即紅（**實測**）

- **位置**：`packages/contracts/package.json:6-13`、`packages/shared/package.json:6-17` 的 `exports` 只指向 `./dist`；`.github/workflows/ci.yml:20-24` install 後直接 typecheck、無 build；README 開發軌道亦無 build 步驟。
- **實測**：`git archive HEAD` 至暫存目錄，`pnpm install --frozen-lockfile --offline` 後跑 typecheck → api／worker／web 全出現 `TS2307 Cannot find module '@flow-gatekeeper/contracts'`；test 有 worker 3 檔、api 1 檔、web ≥1 檔失敗。
- **更嚴重的隱性風險**：改了 `packages/contracts/src` 忘記 build，各 app 仍以**舊 dist 型別**做 typecheck，契約破壞被靜默放過——正好違背「契約優先」的目的。三個 `contracts.check.ts` 讀的也是 dist，擋不住這點。
- **修法（由輕到重擇一）**：
  1. `exports` 加自訂 condition（如 `"development": "./src/index.ts"`），tsconfig `customConditions`、vite／vitest `resolve.conditions`、tsx `--conditions`；production 仍走 dist，不受影響。
  2. root `check` 前加 `pnpm -F ./packages/* build`（或 `prepare`）。
  3. TS project references（`composite` + `tsc -b`）——此規模偏重，不建議首選。

### 1.3 去重鎖在多數情況下沒有去重

- **位置**：`apps/worker/src/main.ts:132-194`。
- **流程**：等待者 B 每輪「SET NX 失敗 → `replyCached()` → sleep 300ms → 回頂端 SET NX」。持鎖者 A 收尾順序是 `cache.set` → 兩筆 Mongo insert → `updateProgress` → `finally del lock`。B 只有在「A 已寫 cache 但尚未刪鎖」的數毫秒內剛好查 cache 才命中；其餘情況 A 在 B sleep 時已刪鎖，B 醒來 SET NX 成功後**直接呼叫 LLM、不回頭查 cache**。同 signature 的兩筆 job 從「去重」變成「串行各算一次」。硬規則 5 與 SC-004 實際不成立。
- **附帶**：鎖值固定 `"1"`、`finally` 無條件 `del`（`:181`）不驗持有者；`AI_DEDUPE_LOCK_SECONDS` 若被設得小於 `AI_TIMEOUT_MS`，會刪掉別人的鎖（無任何設定驗證擋住）。
- **修法**：取鎖後、呼叫 LLM 前先 `if (await replyCached()) { release; return; }`；鎖值改 `randomUUID()`，釋放用 Lua compare-and-del；補一支「兩個 processor 並發同 signature，FakeAiProvider 只被呼叫一次」的測試（目前會失敗）。

### 1.4 api 不讀 `REDIS_PASSWORD`；Redis／Mongo 免密碼綁 0.0.0.0

- **位置**：worker `apps/worker/src/redis.ts:12` 有讀 password；api 五條 Redis 連線都只傳 host/port：`jobs.module.ts:21`、`health.service.ts:28`、`metrics.service.ts:54`、`ai-stream-relay.service.ts:39`、`job-status-relay.service.ts:41`。`AppConfigService` 無此欄位。但 `apps/api/.env.example:15`、`.env.demo.example:21` 都登錄了它（FR-016 設定形狀單一來源在此不成立）。
- **compose**：`docker-compose.yml` redis `"6379:6379"`、mongo `"27017:27017"` 未綁 `127.0.0.1`，demo profile 亦照樣發佈；redis 無 `requirepass`，mongo 無 auth。README 「api 不對外暴露連接埠」的單一入口宣稱因此被打破。
- **後果**：同網段可 `PUBLISH ai-stream:<jobId>` 注入假結果（relay `ai-stream-relay.service.ts:83` 只 `JSON.parse … as AiStreamEvent`）、寫 `ai-cache:*` 汙染快取（worker `main.ts:119` 讀回也不驗 schema，等於繞過硬規則 6）、直接塞 BullMQ job、`FLUSHALL`、讀寫整個 Mongo。而若直接替 Redis 加密碼，api 五條連線全部 NOAUTH，ioredis 無限重連、`/healthz` 回 503、佇列全掛。
- **修法（兩者必須一起做）**：ports 改 `"127.0.0.1:6379:6379"`／`"127.0.0.1:27017:27017"`（或 demo profile 不發佈）；`AppConfigService` 加 `redisPassword` 並提供統一的 `redisOptions()` 供五處共用；relay 與 cache 讀回補 `DiagnosisResultSchema.safeParse`。

### 1.5 `POST /diagnoses` 無型別驗證：NoSQL 運算子注入、prompt injection、CSRF 式觸發 LLM

- **位置**：`apps/api/src/modules/jobs/jobs.controller.ts:22` 只做 truthy 檢查；`app.module.ts`／`main.ts` 無 `ValidationPipe`；Nest/express 預設同時掛 `json` 與 `urlencoded({extended:true})`。
- **後果**：`machineId[$ne]=x` 會被解析成 `{ $ne: "x" }` 物件，一路進 BullMQ payload、`context-builder.ts` 的 `find({"metadata.machineId": machineId})`、`buildPrompt`；form-urlencoded 屬 simple request 不觸發 preflight，任何網站都能在受害者瀏覽器觸發診斷（副作用：打 LLM、寫 Mongo）；`machineId` 任意長字串原樣進 prompt，是主要 prompt injection 入口與 token 成本放大點；`requestedBy` 無長度上限，會寫進日誌與 `diagnosisTriggers`。
- **修法**：contracts 新增 `CreateDiagnosisBodySchema`（`machineId` 限已知機台清單或 `^[a-z0-9-]{1,32}$`、`socketId` 限 uuid、`requestedBy` ≤ 64 字）與 Response 型別，controller 以 Zod `safeParse`（可包成 `ZodValidationPipe`）；關閉 urlencoded parser 或要求 `Content-Type: application/json`；web 端 `diagnose-api.ts:9-11` 改 import 契約而非自寫一份。

### 1.6 環境變數不 fail-fast

- **位置**：`apps/api/src/modules/config/config.service.ts:17-26`、worker `main.ts:79-81, 231, 247` 皆為 `Number(process.env.X ?? d)`；`??` 對空字串不生效。009 已為 `HEALTH_PROBE_TIMEOUT_MS`、`METRICS_INTERVAL_MS` 專門修過（`lib/health-probe-timeout.ts:13-16` 有註解說明），其餘變數未一併修。
- **後果**：`WS_HEARTBEAT_MS=` → 0 → `setInterval` 每 1ms sweep，所有連線秒斷；`MOCK_TELEMETRY_INTERVAL_MS=` → 0 → Mongo 寫入放大約 50 倍；`AI_DEDUPE_LOCK_SECONDS=` → `SET EX 0` 回錯、所有 job 失敗；`GEMINI_API_KEY` 空白時 worker 照樣啟動、照樣 healthy，每個 job 重試 3 次後才失敗；`TELEMETRY_TTL_SECONDS`、`REDIS_PORT`、`API_PORT` 同病。
- **修法**：兩端各一份 Zod env schema（空字串先 preprocess 成 undefined，`z.coerce.number().int().positive().default(...)`），bootstrap 最前面 `parse`，失敗 exit 1（配合監督者語意）；`GEMINI_API_KEY` 在 production 必填。不需引入 `@nestjs/config`。

---

## 2. P1：AI 管線語意（賣點 ③）

### 2.1 逾時不中止底層串流

- **位置**：`apps/worker/src/ai/gemini-provider.ts:35-52, 57-66`。`withTimeout` 只讓 `Promise.race` reject，`run()` 內的 `for await` 仍在背景跑且無 AbortSignal。
- **後果**：殭屍 `onToken` 繼續往同一 `ai-stream:<jobId>` publish（重試時 jobId 相同、seq 又從 0 起，前端看到兩段交錯）；`finally` 已放鎖，下一個等待者在殭屍仍在跑時再開一條 LLM 呼叫；limiter 只計 job 數、管不到實際進行中的連線；殭屍還會 `updateProgress(60)` 讓重試中的進度倒退。provider 變慢時最易觸發，正好放大負載。
- **修法**：`AiProvider` 介面加 `signal: AbortSignal`，逾時在核心以 `AbortSignal.timeout(aiTimeoutMs)` 統一處理；**順帶遷移到 `@google/genai`**（`@google/generative-ai` 0.21 已 EOL；現有程式已需手動擴充 `thinkingConfig` 型別即為症狀），新 SDK 原生支援 `abortSignal`、`responseMimeType`／`responseSchema`、正式 thinkingConfig 型別，並可拿掉 `result.response.catch` workaround。影響範圍僅 `gemini-provider.ts` 與 `smoke-gemini.ts`。注意新版 `chunk.text` 是 getter 非方法；`thinkingBudget: 0` 在 2.5 Pro 系列不被接受（推測），adapter 應依 model 決定是否送。

### 2.2 重試語意錯亂

1. **`schema_invalid` 在非最終嘗試就送 `ai/error`**（`main.ts:163-167`），與 `:276-277` 註解「僅在 attempts 用盡後通知」矛盾。前端 `copilot-reducer.ts:139-146` 收到即轉 failed，且 `:109` 之後只有 active 才消費事件——第 2、3 次重試即使成功（已寫 cache 與 Mongo），畫面仍停在「AI 回傳格式不符」。
2. **重試 token 重播**：`main.ts:137` 每次嘗試 `seq = 0`；`copilot-reducer.ts:126` 直接 append，`streamText` 變成「第一輪半截 + 第二輪完整」。這是 ADR-002 §6.2 未記錄的另一種語意（重複 token，而非丟 token）。
3. **`ai/error(worker_failed)` 幾乎到不了前端**（推測）：`failed` 事件寫入 stream 早於 worker 的 `PUBLISH`，api `job-status-relay.service.ts:55-58` 收到 `failed` 即 `deleteBinding`，relay `:80` 查無綁定就丟棄。前端仍能從 `job/status failed` 拿到終態，但此路徑近乎 dead code。stalled 用盡（`maxStalledCount` 預設 1）或 `UnrecoverableError` 時 `attemptsMade < attempts`，handler 走 else 分支，不送 `ai/error` 也不補寫 trigger。
- **修法**：非最終嘗試只記 log 後 throw，由 `failed` handler 統一通知；契約加 `attempt`（`job.attemptsMade + 1`）欄位或 `ai/reset` 事件，前端換輪即清空 `streamText`；終態判定改用「不會再重試」（`UnrecoverableError` 或 `attemptsMade >= attempts`）。

### 2.3 前端事件早到 race 與 in-flight 重複送出

- **位置**：`apps/web/src/domains/ai-copilot/stores/copilot.store.ts:68-69` 要等 POST 回來才建立 active；`:94-97` `applyEvent` 用 `findMachineByJobId` 反查，idle 狀態一律判為過期。後端 `jobs.service.ts:33-53` 先 `bindJobToClient` 再 `queue.add` 最後才 return。
- **後果**（推測，時序）：cache 命中時 worker 幾乎瞬間 publish `ai/done`，經 Pub/Sub → Gateway → WS 可能早於 HTTP 回應（還要過 nginx／vite proxy）；早到的 `job/status waiting`、前幾個 token、甚至 `ai/done` 被丟，drawer 卡在 active 直到 45 秒 watchdog（`App.vue:125-131`）誤判逾時——正好打在 cache 賣點上。另 `canDiagnose`（`:42-45`）只看 `status !== "active"`，POST 往返期間連點（TopBar、卡片 icon、drawer 三個入口）會建兩個 job。
- **修法**：jobId 改由前端 `crypto.randomUUID()` 產生放進 POST body 當 idempotency key，送出前即建 `pending/active`（需先改 contracts 與 asyncapi）；或 store 維護 `pendingEvents: Map<jobId, CopilotEvent[]>` 暫存後 replay。

### 2.4 其他管線問題

| # | 問題 | 位置 | 修法 |
| --- | --- | --- | --- |
| a | 先寫 cache 再寫 `diagnoses`，中間失敗則重試命中 cache、該筆診斷永不落地、trigger 被記成 `cached:true` | `main.ts:172-176` | 先 insert 再 set cache；`diagnoses` 建 `{jobId:1}` unique index 做冪等 |
| b | cache 讀回 `JSON.parse(raw) as DiagnosisResult` 不驗 schema；signature 含 `promptVersion` 不含 schema 版本 | `main.ts:119` | `safeParse` 失敗即 `del` 並視為 miss |
| c | limiter 計 job 啟動數而非 LLM 呼叫數：cache 命中、等待者、每次重試都吃 8/min 額度；`.env.example:31` 描述不符；等待者最長 80s 佔住 concurrency 2 的一半 | `main.ts:246-247` | 修文件，或 LLM 限流移到取鎖後用 `INCR`+`EXPIRE` |
| d | `promptVersion` 寫死在 api（`jobs.service.ts:41`），prompt 內容在 worker（`ai/prompt.ts`）；改 prompt 極易忘記升版，舊 cache 續服務至 TTL | | `prompt.ts` 匯出 `PROMPT_VERSION`，worker 自行放進 signature |
| e | structured output 只靠 prompt 指示 + 「第一個 `{` 到最後一個 `}`」擷取；prompt 內的結構描述是手寫、非由 `DiagnosisResultSchema` 產生（平行真實來源） | `ai/prompt.ts:39-50`、`lib/parse-result.ts:12-19` | Zod → JSON Schema 交 adapter 用原生 structured output；`parseResult` 留作最後防線 |
| f | `maxRetriesPerRequest: null` 套到一般連線：worker `cache`／`pub`（`redis.ts:13` 共用），api producer（`jobs.module.ts:21`）、health、metrics。Redis 斷線時命令無限排隊不 reject——processor 卡住不走 `ai/error`／重試，`POST /diagnoses` 永久掛住，與 `main.ts:44-47`、`job-status-relay.service.ts:37` 註解的假設相反 | | 只有 BullMQ Worker／QueueEvents／subscriber 保留 `null`；其餘 `maxRetriesPerRequest: 3` + `commandTimeout`（或 `enableOfflineQueue: false`）；controller 對 `queue.add` 加逾時回 503 |
| g | `AiProvider` 介面太薄：無取消、無 finishReason（偵測不到 `MAX_TOKENS`／`SAFETY` 截斷）、無 usage/成本記錄（全專案不記 token 用量）、錯誤不分類（401/403/400 也照 `attempts: 3` 退避重試）、model 名取自 `GEMINI_MODEL` 綁死 provider、signature 無 provider 名 | `ai/provider.ts:13`、`main.ts:78` | 介面加 `id`／`model`／`signal`／回傳 `{text, finishReason, usage}`；adapter 丟 `AiProviderError{retryable}`，不可重試者轉 BullMQ `UnrecoverableError`；signature 用 `provider.id + model` |
| h | 無 `worker.on("error")`；`pub`／`cache` 無 `error` 監聽（bullmq 5.79 的 `emit` 有 try/catch，不會崩潰但**完全靜默**） | `main.ts:251-293` | 各掛一個 error 監聽寫 log |

**若要支援 Claude（Anthropic）作第二 provider**：以 g 的介面形狀為基礎，需 system／user 分開、`max_tokens` 必填、messages stream 的 text delta 對應 `onToken`、`stop_reason` 對應 finishReason、錯誤分類（`overloaded`／`rate_limit` 可重試，`authentication`／`invalid_request` 不可）；設定改 `AI_PROVIDER`／`AI_MODEL` + 各家金鑰，由 factory 建立。

---

## 3. P1：資料寫入、運維、前端

### 3.1 telemetry 寫入路徑

- **每 50ms 一次 `insertMany`**（`history.service.ts:93-100`）：每秒 20 次 round-trip；每天約 864 萬點、TTL 7 天約 6 千萬點，此量級從未被宣告；文件攤開 `...point` 把 `type`、`machineId` 重複存一份（`:82-86`）。
- **Mongo 故障時 in-flight 無上限堆積**：每個 `insertMany` 卡 server selection 約 30s，同時約 600 個 promise 各持一批；逾時後每秒約 20 行 `persistBatch failed` error log，json-file 不輪替。比 ADR §6.4 承認的「崩潰時丟最後幾秒」嚴重。`lastState` 在寫入成功前就更新（`:88-91`），寫入失敗時該次狀態轉換的 errorlog 永久遺失。
- **關閉順序錯誤**（`main.ts:68` `app.close()`）：Nest 依模組 distance 由遠到近呼叫 `onModuleDestroy`、不反轉，`HistoryModule` 等比 `AppModule` 先 destroy，Mongo 先關而 Gateway 的 `producerTimer` 仍在跑，最後一批拿到 `MongoTopologyClosedError`。
- **`TELEMETRY_TTL_SECONDS` 改了不生效**：`expireAfterSeconds` 只在建 collection 時生效，`history.service.ts:53-60` 對 code 48 直接吞掉；`.env.example:32` 卻寫「本機 demo 可調小」。
- **修法（一次改動）**：有上限的記憶體 buffer、每 1 秒 flush、同時只允許一個 in-flight、buffer 滿丟最舊並計數進 metrics；error log 節流（同類每 30s 一則附累計）；`serverSelectionTimeoutMS: 3000`；shutdown 先 `gateway.stopProducer()` + flush 再 `app.close()`（或 History 移到 `onApplicationShutdown`）；遇 48 接著 `collMod` 更新 TTL 並檢查 collection 類型；demo 預設 TTL 降到 1 天；`errorlogs`／`diagnosisTriggers` 加 TTL index；文件只存 `timestamp`／`metadata`／`telemetry`／`state`。

### 3.2 compose 與健康訊號

| 問題 | 位置 | 修法 |
| --- | --- | --- |
| redis／mongo 無 healthcheck，api／worker／seed 的 `depends_on` 只等 `service_started`；Mongo 冷啟動超過 30s 時 api/worker 各消耗一次 on-failure 額度 | `docker-compose.yml` | 加 `redis-cli ping`／`mongosh --eval` healthcheck，改 `condition: service_healthy` |
| 無 `mem_limit`／`cpus`、無 `logging.options.max-size`、redis 無 `--maxmemory`（BullMQ 要求 noeviction） | 同上 | 加 log rotation 與 `--maxmemory 256mb --maxmemory-policy noeviction` |
| worker `stop_grace_period: 45s` < dedupe 等待上限 80s（`main.ts:131`：30s + 45s + 5s）；輪詢迴圈不理會關閉訊號，被 SIGKILL 後靠 stalled 重派（`maxStalledCount=1`，第二次即失敗） | | 迴圈觀察 `closing` 旗標提早 throw；或 grace 調 90s |
| base image 全浮動 tag（`node:22-alpine`、`nginx:alpine`、`redis:7-alpine`、`mongo:7`）；web 用 root nginx、無 `server_tokens off`、無安全 header | 三份 Dockerfile、`nginx.conf` | 釘 digest；改 `nginxinc/nginx-unprivileged`；補 header |
| Node 版本四處不一：README 20+、CI 24、Dockerfile 22、本機 24.20；無 `engines`／`.nvmrc`；`packageManager: pnpm@9.0.0` 是 9.x 最早版；`@types/node` 未宣告、transitive 解析到 26.0.1 | | `.nvmrc`、`engines`、pnpm 10 + hash、明確宣告 `@types/node@~22` |
| `worker:heartbeat`／`metrics:worker` 為單一 key（`heartbeat.ts:13`、`metrics-collector.ts:21`）：水平擴展 worker 時任一副本活著即掩蓋其他死亡，指標互相覆寫只剩 1/N；ADR 未承認此限制 | | key 加 `<hostname>`；指標 `HINCRBY` 或每實例一 key 由 api 加總 |
| heartbeat false negative：`buildDiagnosisContext` Mongo 查詢無逾時（驅動預設 `socketTimeoutMS: 0`），兩個 concurrency 槽卡死時 heartbeat 仍新鮮；`GEMINI_API_KEY` 無效同樣 healthy | | `socketTimeoutMS`／`maxTimeMS`；heartbeat 改記「最近處理迴圈進度時間戳」 |
| `/healthz` 把依賴連通性當唯一判準（liveness／readiness 混用）；驗的是專屬 PING 連線，驗不到 relay 的 psubscribe、QueueEvents、Gateway 是否 attach | | 拆 `/livez`／`/readyz`（低優先，compose 目前不因 unhealthy 重啟） |
| 三份 Dockerfile 各自完整安裝整個 workspace（含 web 的 vite／tailwind devDeps），無 BuildKit cache mount | `apps/*/Dockerfile:15-30` | `RUN --mount=type=cache … pnpm fetch` 後 `install --offline --filter` |
| `packages/*` 無 `files`／`sideEffects: false`：runtime image 帶進 `src`、`*.test.ts`；web bundle 含未使用的 zod runtime（`CopilotDrawer.vue:4` 只 import 一個常數） | | 加 `"files": ["dist"]`、`"sideEffects": false` |
| Redis 職責：ADR §3 #8 寫「四職」，實際加 heartbeat 與 metrics 快照為五到六職 | | 文件更正 |

### 3.3 前端

| 嚴重度 | 問題 | 位置 | 修法 |
| --- | --- | --- | --- |
| High | `useHighFrequencyWs` **零測試**：批次一幀一次、`maxBufferSize` 丟最舊、pause 續存／resume 一次沖出、pong 逾時重連、重連重訂閱、unmount 清理皆無回歸保護——而這正是憲章 IV 與硬規則 1 的實作本體 | `composables/useHighFrequencyWs.ts` | FakeWebSocket + `vi.useFakeTimers({toFake:[…,'requestAnimationFrame']})`，包在 `effectScope()`；至少 6 支 |
| Medium | rAF pump 無 `try/finally`：`onBatch` 一次例外（如陣列混入 `null`）下一幀不再排程，buffer 卡在 2000 上限、畫面凍結，但連線 chip 仍 Connected、延遲照常更新——無聲故障 | `useHighFrequencyWs.ts:92-96` | `try { … } finally { rafId = requestAnimationFrame(pump) }` |
| Medium | WS 入口全 `as` 斷言（`ws-message.ts:38, 46, 53`）：畸形 telemetry 讓 `MachineNodeCard.vue:69` 的 `.toFixed` 在 render 炸；畸形 `ai/done.result` 讓 `DiagnosisResultView` 炸 | | 高頻路徑用手寫型別守衛 `isTelemetryPoint`（不用 zod）；低頻 `ai/done`／`system/metrics` 用 `safeParse` |
| Medium | buffer 溢位只截斷最舊、無 coalesce、無 dropped 計數：背景分頁或 Pause 超過約 20s 後，狀態轉換在 Event Stream 永久消失；`receivedMessages` 不含被丟筆數，背壓比值偏低且無標示 | `useHighFrequencyWs.ts:159-161`、`monitoring.store.ts:130-131` | 溢位改「每台保留最新一筆 + state 轉換點」；store 加 `droppedMessages`；可選 `visibilitychange` 時改 `setTimeout` flush |
| Medium | Pause 期間 `now` 照走，10 秒後所有卡片標 Stale、Fleet Health 全算 stale，與 design-spec §8.3 的 stale 語意矛盾 | `App.vue:127-131`、`TopologyCanvas.vue:24`、`fleet-health.ts:37` | paused 時凍結 `now` 或抑制 stale |
| Medium | `text-number` token 未定義於 `tailwind.config.ts`，**實測**不產生任何 CSS，卡片數值非規格 22px（design-spec §4.2／§7.3）；Tailwind 3 對未知 class 靜默略過 | `MachineNodeCard.vue:140` | `theme.extend.fontSize` 加 `md`／`number`，回補 design-spec §5 |
| Medium | `fg-subtle`（#687684）對 `surface` 對比約 3.8:1 未達 AA，大量用於 10–12px 文字（EventStrip、FleetHealth、CopilotDrawer、空狀態） | design-spec §4.1 | 先改 spec 再同步 config（提亮到約 4.6:1 或改用 `fg-muted`） |
| Low | 退避次數在 `open` 就歸零（`:201-203`），「連上又立刻被關」會以約 1s 週期無限重連；無 `online` 事件快速重連（筆電睡醒最多等約 39s） | | 收到 `system/connected` 才歸零；監聽 `window.online` |
| Low | `machines` 用深層 `ref<Map>`，批次內每筆 `set` 各觸發一次 trigger（render 層仍被 scheduler 合併為每幀一次，但語意上非「一批一次」） | `monitoring.store.ts:41, 115-128` | `shallowRef` + `markRaw` + 迴圈後 `triggerRef` 一次 |
| Low | `text-[10px]`／`text-[11px]` 共 16 處不在 token 內；`colors.base` 與內建 `fontSize.base` 撞名（**實測** `text-base` 同時輸出 font-size 與 color，靠 `text-sm` 順序才沒出錯）；無 `prefers-reduced-motion`；觸控裝置上 `opacity-0` 的 Diagnose icon 仍可點到；診斷觸發邏輯重複三份、clientId 存三處、`machineList`／`batchRatio` 為死 getter；nginx 無 gzip 與 `immutable` cache；串流 `aria-live` 逐 token 朗讀；行動版 bottom sheet 缺 `role="dialog"` 與 focus trap | 各檔 | 見各項 |

XSS 方面確認無問題：全程 `{{ }}` 插值，repo 內無 `v-html`／`innerHTML`、無 Markdown 渲染。殘留風險：schema 無 `.max()` 長度上限；LLM 生成的 `suggestedActions.command` 被當可照抄指令顯示，prompt injection 可藉此做社交工程，UI 應標示「AI 建議，執行前請審閱」。

---

## 4. 技術棧選型檢討（2026-09 視角）

實測 `pnpm outdated -r`（current → latest）：NestJS 10.4.22 → 12.1（11 於 2025-01 發布）；`@nestjs/bullmq` 10.2.3 → 12.0；vite 5.4.21 → 8.3.1；`@vitejs/plugin-vue` 5 → 6；tailwindcss 3.4.19 → 4.3.3；zod 3.25.76 → 4.6.5；vitest 2.1.9 → 5.0.2；pinia 2.3.1 → 4.0.3；eslint 9.39 → 10.11；eslint-plugin-vue 9 → 10；vue-tsc 2.2 → 3.3；typescript 5.9.3 → 7.0.2；bullmq 5.79 → 6.3.9；ioredis 5.11 → 6.0；mongodb 6.21 → 7.6；pino 9 → 10；dotenv 16 → 18。

`pnpm audit`：53 項（1 critical／31 high／16 moderate／5 low）；`--prod` 19 項（9 high／8 moderate／2 low）。runtime 相關：`@nestjs/core <=11.1.17` injection（moderate，**修補只在 11.1.18 以上，Nest 10 線無修補**）、multer（6 則 DoS）、qs、body-parser 皆經 `@nestjs/platform-express@10.4.22` 帶入——multer 無 upload endpoint 碰不到，qs／body-parser 在 `POST /diagnoses` 的 urlencoded／JSON 解析路徑上可觸達。dev 側 vitest 2.1.9 有 critical（<3.2.6）、vite 5.4.21 有 dev server fs.deny 類 CVE。

| 項目 | 建議 | 理由 |
| --- | --- | --- |
| NestJS 10 | **升 11**，穩定後評估 12 | 唯一有具體安全理由的升級；Express 5 路由語法變更但本專案只有兩個端點；不換 Fastify／Hono——換不到可見價值，還失去「會用企業級框架」的訊號 |
| `@google/generative-ai` 0.21 | **換 `@google/genai`**（高優先） | 已 EOL；一次解決 §2.1 與 §2.4e；只動兩檔，正好示範 adapter 隔離的承諾 |
| BullMQ 5／ioredis 5／mongodb 6 | 維持 | 皆為各自 major 最新線；bullmq 6 與 ioredis 6 剛發布、breaking 未查證；mongodb 7 已近一年可考慮 |
| Vite 5 / vitest 2 / plugin-vue / vue-tsc | 升（一起綁一個 build feature） | 解掉 critical；`vite.config` 極簡風險低；Vite 7 需 Node 20.19+；vitest 4 browser mode 可測 rAF／WS |
| Vue 3.5 / Pinia 2 | Pinia 順手升；Vue 等 3.6 穩定 | gatekeeper 與框架無關 |
| Tailwind 3.4 | **暫緩** | v4 `@theme` 對 token 化更貼合，但 `@tailwind`→`@import`、`theme()` 呼叫、ring／border／shadow 尺度更名、`text-base` 撞名需先處理；視覺回歸風險高、收益低 |
| Zod 3.25 | 升 4，與 AsyncAPI 漂移測試一起做 | 內建 `z.toJSONSchema` 可比對 asyncapi、可餵 Gemini `responseSchema`；schema 很少、API 大致相容 |
| pnpm 9.0.0 | 升 10.x 並附 hash | Node 25 起 corepack 不再內建，Dockerfile 需改 `npm i -g pnpm` 或官方 image |
| TypeScript 7（Go 版） | 不建議 | 等 vue-tsc 與 typescript-eslint 正式支援 |
| ESM + NestJS | 維持 | 相對 import 全帶 `.js`（grep 0 漏網）、`import.meta.url` 取代 `__dirname`；建議 Node 端 tsconfig 改 `NodeNext` 讓漏 `.js` 在 tsc 期就炸，web 維持 `Bundler` |
| Mongo time-series 存遙測 | 維持；ADR-002 §7 拒絕 TSDB 成立 | 問題在寫入批次化（§3.1），不在選庫 |

**升級建議順序**：pnpm 10 + `.nvmrc`／`engines`／`@types/node` → `pnpm.overrides` 壓 multer／qs／body-parser → Vite／vitest／plugin-vue → NestJS 11 + `@nestjs/bullmq` → `@google/genai` → Zod 4 + 漂移測試 → eslint 10 + type-aware 規則 → Pinia／Tailwind 最後或不做。

---

## 5. 架構層結論

### 5.1 單一來源缺席（跨 process 隱性耦合）

- **Redis key／channel**：`metrics:worker` 在 `apps/api/src/modules/metrics/metrics.service.ts:11` 與 `apps/worker/src/lib/metrics-collector.ts:21` 各定義一份；`ai-stream:` worker `main.ts:48` 組字串、api `ai-stream-relay.service.ts:43, 78` `psubscribe`／`slice`。
- **Mongo collection 與文件形狀**：`"telemetry"`／`"errorlogs"`／`"maintenanceRecords"` 在 `history.service.ts`、`seed.ts`、`worker/context-builder.ts` 各寫一次；worker 查 `metadata.machineId`、`$telemetry.temperature` 的形狀由 api `persistBatch` 決定；worker 讀維修紀錄用 `doc.summary ?? doc.notes ?? doc.description ?? doc.type` 猜欄位——缺乏 schema 單一來源的直接症狀。collection index 建立責任也分散（api 建 telemetry／errorlogs，worker 建 diagnoses／diagnosisTriggers）。
- **機台名冊三份**：`mock-telemetry.service.ts:6`、`web/.../machine-labels.ts:5`、`seed.ts`；前端用寫死名冊，新機台不會出現在畫面。
- **`packages/shared` 定位混雜**：根 export 是瀏覽器可用的門檻常數，`./logging` 是 Node-only 的 pino；`packages/shared/src/index.ts:13-16` 靠「MUST NOT re-export logging」註解防止 pino 進瀏覽器 bundle，等於用紀律補結構缺口，且無 lint 強制。
- **契約驗證強度不一致**：只有 `DiagnosisResult` 是 Zod；`TelemetryPoint`、`WorkerMetrics` 為純 TS，api 手寫 `parseWorkerMetrics`（`metrics-merge.ts:19`）在 contracts 之外另寫平行驗證；`POST /diagnoses` 的 HTTP 契約不在 contracts（api `jobs.controller.ts:6-10`、web `diagnose-api.ts:9-11` 各一份）；WS 事件無協定版本，`asyncapi info.version: 0.1.0` 未隨 009 新增 `system/metrics` 而 bump。
- **建議**：contracts 加 `infra.ts` 集中 key/channel 產生函式（如 `aiStreamChannel(jobId)`）與 collection 常數，Mongo 文件型別放此或另開 `packages/persistence`；`shared` 拆 `domain`（跨執行環境）與 `observability`（Node-only）；`WorkerMetrics`、`CreateDiagnosisBody` 改 Zod；`system/connected` 加 `protocolVersion`。

### 5.2 職責邊界與資料流

api 同時是 Gateway、mock telemetry producer、BullMQ producer、Pub/Sub 轉發、HTTP API、seed 入口。demo 規模可接受，但 **mock producer 寫死在 Gateway 的 `setInterval`**（`monitoring.gateway.ts:51`）使「遙測從哪來」與「往哪送」綁死。建議先抽 `TelemetrySource` 介面（Gateway 只訂閱「新批次」事件，mock 為其一實作），是否升級成 `apps/simulator` 獨立 process 等真要接 ingestion 再決定。

實際資料流：

```
[Gateway setInterval] MockTelemetry.nextBatch()
   ├─ 依訂閱表 send(clientId, TelemetryPoint[]) ── ws ──▶ web buffer → rAF flush → Pinia
   └─ void persistBatch() ─▶ Mongo telemetry（time-series + TTL）
                           └─ detectErrorTransitions（lastState 在 process 內 Map）─▶ Mongo errorlogs
web POST /diagnoses {machineId, socketId} ─▶ JobsService：bindJobToClient（process 內 Map）─▶ BullMQ "diagnosis"
worker：Mongo（telemetry 聚合、errorlogs、maintenanceRecords）→ 簽章 → ai-cache 命中?
   ├─ 命中：publish ai/done(cached) ─▶ diagnosisTriggers
   └─ 未命中：ai-lock NX → Gemini 串流 → 每 token publish ai-stream:<jobId> → Zod parse
            → SET ai-cache → insert diagnoses → diagnosisTriggers → publish ai/done
api：psubscribe ai-stream:* → 查 jobRooms Map → gateway.send；QueueEvents → job/status → 解除綁定
worker 每 60s：SET metrics:worker；api 讀取合併 → system/metrics 廣播
```

**讀回路徑不存在**：HTTP 只有 `POST /diagnoses` 與 `GET /healthz`；`diagnoses`／`errorlogs`／`telemetry` 對前端只寫不讀。ADR-002 §6.2 與 README「已知限制」寫「重連後可拿完整結果」「最終結果不受影響」——資料確實落庫，但使用者**沒有任何管道取回**；重連後拿到新 clientId、綁定失效，前端只能顯示「中斷 + Retry」。

### 5.3 擴展性天花板

- **接真實 ingestion**：無 ingestion 邊界；`TelemetryPoint` 無 runtime 驗證；機台名冊寫死；errorlog 去重狀態在 process 內。
- **多 Gateway**：第一個斷點比 ADR-002 §6.1 列的 `psubscribe *` 更早——`POST /diagnoses` 帶 `socketId` 把 HTTP 資源綁在收到 WS 連線的那個實例上，LB 把 HTTP 與 WS 分到不同實例時 `jobRooms` 查不到對象；訂閱表、`lastState`、heartbeat／metrics 單一 key 同樣在 process 內或單 key。
- **多租戶**：契約、Mongo 文件、Redis key、cache 簽章皆無 tenant 維度；簽章不含 tenant 會跨租戶命中快取，屬安全問題。

### 5.4 建議 roadmap（010–012）

| # | 一句話目標 | 作品集價值 | 工程價值 |
| --- | --- | --- | --- |
| 010 資料層單一來源 + ingestion 邊界 | 抽 `TelemetrySource` 介面；contracts 集中 Redis key/channel、collection 常數與文件型別；`TelemetryPoint` 改 Zod；機台名冊由後端下發；順手遷移 `@google/genai` | 中 | **高** |
| 011 效能證據自動化 | Playwright + CDP trace 在 5/10/50ms 三節拍量測 WS 訊息數、遙測點數、flush 次數、掉幀率；修正比值定義；腳本與結果固化進 README | **高** | 中 |
| 012 串流韌性 | token 改走 Redis Streams 並支援 last-id 續傳；重連時以 jobId rebind；新增 `GET /diagnoses/:jobId`（讓 ADR-002 §6.2 與 README 的宣稱成真；指南 §15.5 本列為候選） | 高 | 高 |

### 5.5 ADR-002 §6／§7 逐條評估

- §6.1 Gateway 水平擴展：同意，但須補 `jobId → clientId` 綁定外置到 Redis 或 HTTP/WS 共用 sticky key，以及 heartbeat／metrics 單 key 問題。
- §6.2 Redis Streams：同意；需 `MAXLEN`／TTL、token 帶 attempt、前端依 seq 去重；且須先修 §2.1 殭屍串流，否則回放會忠實重播錯亂內容。
- §6.3 認證升級：方向同意；但 JWT 不應放 query string（會進 nginx access log），改 `Sec-WebSocket-Protocol` 或 cookie；Origin 檢查、輸入驗證、`maxPayload` 成本近零，不該與 OIDC 綁在一起延後。
- §6.4 有損寫入：同意宣告有損；但「未來改走 BullMQ／Stream 佇列」對每秒 20 批太重，改為有上限 buffer + 單一 in-flight + 丟棄計數進 metrics 即可。
- §7 五項拒絕（K8s、Kafka/MQTT、TSDB、OIDC/IAM、Redis/Mongo HA）：全部同意維持。但「拒絕 IAM」不應涵蓋基本加固（§1.1、§1.4、§1.5），「單節點」也不等於「可以不設認證、可以對外綁定、可以沒有 maxmemory」。

---

## 6. 測試策略、契約同步、Lint、文件與流程

### 6.1 測試金字塔只有底層

- 207 個測試幾乎全為純函式或 import smoke；lockfile 無 playwright、testcontainers、supertest、k6、autocannon、mongodb-memory-server。
- **零測試的關鍵路徑**：Gateway `handleMessage`（§1.1 所在）、`createProcessor`（未匯出，§1.3／§2.1／§2.2 所在）、`useHighFrequencyWs`（§3.3）、兩個 relay、`JobsController` 400 路徑、`GeminiProvider` 逾時、`startHeartbeat`、`context-builder`、`prompt`。
- **無 coverage 設定**、無 `vitest.config.*`、web 測試跑在 node 環境無元件測試。
- **建議**：Gateway 整合測試（真實 http + ws，History/Telemetry stub）；匯出 `createProcessor` 注入 fake Redis／AiProvider／Db／Job，至少覆蓋「並發同 signature 只呼叫 LLM 一次」「持鎖者失敗等待者接手」「非最終 schema 錯誤不送 ai/error」「逾時後不再有 ai/token」「cache 命中不寫 diagnoses」；testcontainers 一支跨 process 整合測試；WS 全鏈路 e2e；root `vitest.workspace` 開 v8 coverage，門檻從實測值起跳、只對 `lib/**` 設。

### 6.2 AsyncAPI 與 Zod 無同步機制，已有漂移

- `asyncapi.yaml:33-39, 140-142` 把 `machine/data` payload 寫成單一 `TelemetryPoint`，實際傳輸是**陣列、無 envelope**（gateway `send(clientId, selected)`；web `ws-message.ts:38` 以 `Array.isArray` 分流）。
- `DiagnosisResult` 在 `schemas.ts` 與 `asyncapi.yaml:348-` 各寫一份靠人工對齊；Spectral 只檢查 YAML 合規、不比對 Zod。
- 三個 `contracts.check.ts` 只證明「import 得到、能賦值一個樣本」，typecheck 已涵蓋，屬 001 骨架期冗餘。
- **建議**：contracts 加一支 vitest 讀 `asyncapi.yaml`，以 `zod-to-json-schema`（Zod 4 後用 `z.toJSONSchema`）轉出 `DiagnosisResultSchema` 深度比對 `components.schemas.DiagnosisResult`；匯出 runtime 常數 `WS_MESSAGE_TYPES`（`satisfies` 綁住 union 的 `type` 字面值）斷言與 asyncapi `messages[*].payload.properties.type.const` 集合相等；修正 `machine/data` 為 `type: array, items: $ref TelemetryPoint`；`contracts.check.ts` 刪除或改寫成 exhaustive switch（`const _x: never = ev`）。

### 6.3 Lint 強度

- `eslint.config.js:11` 只用 `tseslint.configs.recommended`（非 type-checked），`no-floating-promises`／`no-misused-promises` 未開——對大量 Redis/BullMQ/ws 非同步程式碼是最易漏 await 之處。
- 架構邊界（shared 不得 re-export logging、worker 不得 emit ws、web 不得用 socket.io）全靠註解，無 `no-restricted-imports`。
- `eslint-plugin-vue` 只宣告在 `apps/web` 卻由 root config import，靠 pnpm `public-hoist-pattern: *eslint*` 巧合能跑；`eslint src` 不 lint 設定檔。
- tsconfig strict 已優於平均（`noUncheckedIndexedAccess`、`verbatimModuleSyntax`、`isolatedModules`），可再補 `noImplicitOverride`、`noFallthroughCasesInSwitch`、`noImplicitReturns`；`exactOptionalPropertyTypes` 維持關閉（與 Zod 3 `.optional()` 摩擦大）。
- **建議**：`recommendedTypeChecked` + `parserOptions.projectService: true`；`no-restricted-imports`（web 禁 `pino`／`@flow-gatekeeper/shared/logging`／`socket.io*`，worker 禁 `ws`）；`eslint-plugin-vue` 移到 root devDeps；`.gitignore` 補 `*.tsbuildinfo`、`.vite/`。

### 6.4 文件漂移

CLAUDE.md「跨 Feature 決策 MUST 回補真實來源」在指南 §13–§15 執行良好（皆有「已落地」標頭、歷史敘述保留），ADR-002 §6.4 亦有回補；以下未同步：

| # | 漂移 | 位置 |
| --- | --- | --- |
| 1 | ADR-002 §3 差距表第 1–3 列「現況」仍寫 `tsx watch`／無 Dockerfile、log + 續跑、只有 console log；§4.4「留給 007/008 clarify」未回填 | `docs/adr-002-productionization-scope.md` |
| 2 | README:97「50ms 節拍約 11:1」與 :117 截圖「505 msgs · 101 frames · 5:1」矛盾 | `README.md` |
| 3 | README:250「定義 6 條即時通道事件」，實際 `asyncapi.yaml` 有 12 個 channel | |
| 4 | README 架構圖寫 `DiagnosesController`，實際類別為 `JobsController`；Redis 表漏 `worker:heartbeat`、`metrics:worker` | |
| 5 | ADR-002 §6.2 與 README「已知限制」的「重連後可拿完整結果」無讀取端點支撐（§5.2） | |
| 6 | 指南 §2.1 目錄樹列了不存在的 `apps/worker/src/processors/`；§2.2 說 `shared` 是「純工具與 domain types」未反映 logging 子路徑 | `docs/Flow-Gatekeeper-SDD-完整實作指南.md` |
| 7 | 指南 §18 用 `cp .env.example apps/api/.env`，與根目錄 `.env.example` 自身「不要複製這份」的警告衝突，且違反 CLAUDE.md PowerShell 慣例；`# checks` 段漏 `pnpm test`／`pnpm check` | |
| 8 | 指南 §16 開頭承諾「009 完成後補故障演練劇本」，§16.2 未補 | |
| 9 | `asyncapi.yaml` `info.version: 0.1.0`，專案已 v1.0.0 | |
| 10 | 006、007 及數個 fix/docs 分支的 merge commit 為 git 預設 `Merge branch '…'`，未依 `merge(<feature>): 併入 …` | `git log --merges` |
| 11 | CLAUDE.md 開頭仍指向 `specs/009-…/plan.md` 為 current plan；`main` 的 release 流程未寫進任何規範 | `CLAUDE.md` |
| 12 | `apps/api/Dockerfile:9` 註解仍寫 `healthcheck.js` 是 /ws 握手探針（009 已改 /healthz） | |
| 13 | `MONGO_URL` 自帶 db 名又另有 `MONGO_DB`；`seed.ts` 用 `dotenv/config`（依 cwd）與 `main.ts` 明確路徑做法不一致 | |
| 14 | `.env.example` 的 `REDIS_PASSWORD` 為 api 端死設定（§1.4） | |

### 6.5 SDD 流程成本效益

量測：`specs/` 10,605 行（約 58.9 萬字元）；程式碼 8,276 行（非測試 6,336、測試 1,940，約 29.7 萬字元）；`docs/` 約 4,200 行（指南 3,188）。各 feature 工件量逐步膨脹：001 為 937 行，008 為 1,449，**009 為 2,189**（內容僅日誌 + healthz + 指標）。工件別：tasks 2,056、spec 1,624、quickstart 1,336、plan 1,253、contracts 1,208、checklists 1,128、research 1,062、data-model 938。程式碼中 164 處 `FR-xxx`／`SC-xxx`／`T0xx`／`research Dx` 引用，註解約占程式碼字元 20%，不看 specs 讀不懂。

- **值得保留**：spec（含 out-of-scope 與 SC）、research（取捨理由）、contracts。
- **可精簡**：tasks（實作完即一次性，merge 時壓成 phase 摘要）、quickstart（與 README／指南重疊）、checklists（多為 spec 品質自檢）、data-model（由程式碼型別取代，正好補 §5.1 的 persistence 單一來源）。
- 程式碼註解應寫「為什麼」，不寫「對應哪個 FR」；追溯交給 commit 訊息。
- 回補規則有效，但需一份機械化的「feature 收尾清單」（ADR §3 現況欄、README 數字、asyncapi version、指南目錄樹），不能只靠 agent 記得。

---

## 7. 建議修復順序與不必做的事

### 7.1 修復順序

1. **§1.1 Gateway 輸入加固**（約 30 行 + 一組 Gateway 整合測試）。
2. **§1.2 乾淨 clone 可建置**（source condition 或 build 步驟），順帶 `.nvmrc`／`engines`／pnpm 10。
3. **§1.3 dedupe double-check + §2.1 AbortSignal + `@google/genai` 遷移**，同時補 processor 測試。
4. **§1.4 `REDIS_PASSWORD` 與 ports** 一起修。
5. **§1.5、§1.6 Zod 驗證 body 與 env**，關閉 urlencoded。
6. **§2.2、§2.3 重試語意與 jobId 前端產生**（先改 contracts 與 asyncapi）。
7. §3.1 telemetry buffer 化 + shutdown 順序 + TTL `collMod`；§3.2 compose healthcheck／log rotation／maxmemory。
8. `pnpm.overrides` 壓 prod high → Vite／vitest → NestJS 11 → Zod 4 + 漂移測試 → type-aware lint。
9. §6.4 文件回補（每項修完即同步 ADR-002 §3 現況欄）。

### 7.2 不必做（六個面向意見一致）

- 把 NestJS 換成 Fastify／Hono；用 Redis Streams 取代 BullMQ 當 job queue（Streams 只用在 token）。
- 專用時序資料庫、Kafka／MQTT、Kubernetes、OIDC／完整 IAM、Redis Sentinel／Mongo replica set、distroless／SBOM 簽章。
- Prometheus／Grafana／OTel、log aggregation（頂多修正 `queue.failed` 語意為窗內增量並加 `persistFailures` 計數）。
- Gateway 水平擴展、綁定外置、鎖續租（watchdog 延長 TTL）、Redlock 多節點鎖、provider 自動 failover。
- 為 telemetry 寫入另建佇列；為 limiter 精準度另建分散式 token bucket。
- 機台列表／EventStrip 虛擬化；每幀 filter/sort 的 memo 最佳化；AI token 也走 rAF 批次；i18n 框架；light/dark 雙主題。
- 現在就升 Tailwind 4、Pinia 3/4、TypeScript 7；改用 `@nestjs/platform-ws`／`@nestjs/config`／`@nestjs/terminus`；強行合併三份 Dockerfile；TS project references；開 `exactOptionalPropertyTypes`。
- 現在就把 mock producer 拆成獨立 process（先抽介面即可）；為規格完整度繼續擴張 tasks／checklists／quickstart。

---

## 8. 通過驗證、無問題的項目

- **祕密衛生**：`git log --all --diff-filter=A` 只加過 5 份 `.env*.example`；以 `AIza…`、`sk-`、`ghp_`、`AKIA`、`BEGIN`、帶帳密 mongodb URL 等模式掃 history 無命中；唯一值為 `WS_AUTH_SECRET=replace_me_dev_only` 佔位；`.gitignore` 與 `.dockerignore` 對 `**/.env*` 覆蓋正確（`git check-ignore` 驗證）。`worker.log` 未被追蹤（`*.log` 已 ignore），為 7/4 遺留的 UTF-16 舊檔，本機刪除即可。
- **Log 洩漏**：授權失敗只記 clientId 不記 token；Redis／Mongo 錯誤訊息不含密碼或連線字串。（pino 未設 `redact`，缺縱深防禦。）
- **nginx WS 反代**：`Upgrade`／`Connection`／`http_version 1.1` 齊全；變數 upstream 延後 DNS 解析正確；`proxy_read_timeout 3600s` 搭配 15s 應用層 ping 無問題。
- **關閉流程**：api 15s 寬限、SIGTERM → `app.close()` → `exit(0)` 與 `on-failure` 語意一致；worker `fatal()` 以 `writeSync` 同步寫出，所有 fire-and-forget（`publish`、heartbeat、metrics、failure trigger、`result.response`）皆有 `.catch`，無繞過致命處理器的浮空 rejection。
- **健康端點與指標**：`/healthz` 探測逾時、依賴併行探測、全掛不拋錯；metrics 重入防護與 `worker: null` 降級與 spec 一致；heartbeat（10s／TTL 30s）與 healthcheck `PTTL > 0` 判定一致。
- **jobId 關聯**：api 建 job 與 worker 整個生命週期皆以 `jobId` 獨立欄位記錄，SC-002 成立（HTTP 層仍無 request id、job 建立日誌未記 `clientId`）。
- **Redis 記憶體**：`ai-cache:*` 600s、`ai-lock:*` 45s、`worker:heartbeat` 30s、`metrics:worker` 3 倍間隔、BullMQ `removeOnComplete`／`removeOnFail` 皆有上限；無無 TTL 的 key。
- **AiProvider 隔離**：Gemini 型別未洩漏進主邏輯，`thinkingConfig` 封在 adapter 內。
- **型別安全**：全棧無 `any`；斷言集中在 §1.4／§3.3 列出的 WS 入口與 cache 讀回，及 context-builder 的 Mongo 文件轉型（可接受）。

---

## 附錄：審查方法與可重現證據

- **實測指令**（以 `corepack pnpm` 執行，本機 PATH 無 pnpm）：`contract:lint`、`-r typecheck`、`-r lint`、`-r test`、`-r outdated`、`audit`、`audit --prod`；乾淨 clone 模擬（`git archive HEAD` + `install --frozen-lockfile --offline`）。
- **WS 崩潰 PoC**：三個 agent 各自以專案安裝的 `ws@8.21.0` 起最小 server，分別送 `null`、`{"type":"x","machineIds":5}`、opcode 3 frame、未遮罩 frame，行程皆以非零碼結束。
- **Tailwind 實測**：以 repo 內 tailwindcss 3.4.19 編譯，`text-number` 不產生 CSS；`text-base` 同時產生 font-size 與 color。
- **Bundle**：`apps/web/dist/assets/index-*.js` 含 zod runtime，JS 約 180 kB（gzip 約 59 kB）。
- **BullMQ 行為**：於 `node_modules/bullmq@5.79.2` 確認 `queue-base.js:86-95` 的 `emit` 有 try/catch（無 error listener 時靜默）。
- **各面向各自「最優先前 3 項」**：api（§1.1／§1.6+§1.4／§3.1）、worker（§1.3／§2.1／§2.2）、web（§2.3／§3.3 pump+守衛／§3.3 測試+溢位）、工具鏈（§1.1／§1.2／audit+§6.2）、運維安全（§1.1／§1.4／§1.5+§1.6）、架構（§5.1／§5.4-011／§5.4-012）。本文的優先順序為六者交集後的統整結果。
