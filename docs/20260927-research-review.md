# 2026-09-27 全面技術棧與架構審查（Research Review）

| 項目 | 內容 |
| --- | --- |
| 審查日期 | 2026-09-27 |
| 審查對象 | `main` @ `3e94ac2`（v1.0.0，Feature 001–009 全數併入） |
| 方法 | 6 個獨立審查 agent（Opus 5.5）分面向平行檢視，由統籌者交叉比對、去重、排序後統整 |
| 修復狀態 | **P0～P2 缺陷已於同日由 `fix/20260927-research-review`（17 個 commit）修復並 `--no-ff` 併入 `develop`（`a8ef62a`）**。修復後由 3 個獨立驗收 agent 逐項核對（比較基準 `1cfc8c0..a8ef62a`），P0 六項全部經實測重現「修復前會崩／修復後不會」確認 |
| 修復後檢查 | `contract:lint`／`-r typecheck`／`-r lint` 全綠；`-r test` 524 個測試通過（shared 16、contracts 58、api 155、worker 132、web 163）；乾淨 clone 不 build 直接 typecheck／test 全綠；`pnpm audit --prod` 由 19 項降至 3 項 moderate（全部經 `@nestjs/bullmq@10` 帶入，NestJS 11 升級後消除） |
| 本文現況 | **已修復項目已自本文移除**，只保留「部分修復」「未修復」「修復後新發現的殘留」與尚未執行的架構級建議。原始完整審查內容見 git 歷史 `fd34905` |
| 相關 | ADR-001、ADR-002（§3／§6／§7 已回補現況）、`CLAUDE.md`、實作指南 §15.6、`README.md` |

---

## 0. 已修復項目總帳（僅列標題，細節見 `git log 1cfc8c0..a8ef62a`）

| 原章節 | 修復內容 | 驗收狀態 |
| --- | --- | --- |
| §1.1 Gateway 輸入加固 | `ClientControlMessageSchema` safeParse、socket／wss `error` listener、`maxPayload` 16 KiB、Origin 白名單（可選）、machineIds 取交集、api fatal handler、真實 http+ws 整合測試 | 已修復（實測：`null`、數字 machineIds、opcode 3、未遮罩 frame、17 KiB 訊息皆不再讓行程結束） |
| §1.2 乾淨 clone | `exports` 加 `development` condition、`customConditions`、CI 讀 `.nvmrc` | 已修復（實測乾淨 clone 免 build 全綠） |
| §1.3 去重鎖 | 取鎖後 double-check cache、鎖值 uuid + Lua compare-and-del、`LOCK ≥ TIMEOUT` 設定驗證、並發測試 | 已修復 |
| §1.4 REDIS_PASSWORD／ports | api 五處連線統一 `redisOptions()`、compose 綁 `127.0.0.1`、relay 與 cache 讀回 safeParse | 已修復 |
| §1.5 POST /diagnoses | `CreateDiagnosisBodySchema`、非 JSON 回 415、jobId 冪等（409）、入列逾時 503 | 已修復 |
| §2.1 逾時不中止串流 | `AiProvider` 加 `AbortSignal`、`AbortSignal.timeout`、`@google/genai` 原生 `abortSignal`、舊 SDK 移除 | 已修復 |
| §2.2 重試語意 | 非最終不送 `ai/error`、契約加 `attempt`、`worker_failed` 改由 api 在刪綁定前送 | 已修復 |
| §2.3 前端事件早到 race | jobId 前端產生、送出前即建 active、`inFlight` 去重、api 在 await 前 bind | 已修復 |
| §2.4 a–h | cache/Mongo 順序＋unique index、cache 讀回驗證、限流改 Redis 固定窗、`PROMPT_VERSION` 移至 worker、Zod→JSON Schema 原生 structured output、`maxRetriesPerRequest` 分離、`AiProvider` 介面擴充、error listener | 已修復 |
| §3.1 telemetry 寫入 | 每秒 flush、上限 buffer、SingleFlight、log 節流、Mongo timeout、shutdown 先停 producer 再 flush、TTL `collMod`、errorlogs TTL | 已修復（殘留見 §1.3） |
| §3.2 compose／健康 | healthcheck + `service_healthy`、資源上限、log rotation、maxmemory、`isClosing` 交回佇列、image digest、nginx-unprivileged + 安全 header、heartbeat／metrics key 加 instanceId、Mongo `maxTimeMS`、BuildKit cache、`files`／`sideEffects` | 已修復（殘留見 §1.4、§1.5） |
| §3.3 前端 19 項 | `useHighFrequencyWs` 14 支測試、pump `try/finally`、入口型別守衛、溢位合併＋dropped 計數、pause 凍結 stale 時鐘、`text-number`／`fg-subtle`／`canvas` token 與 design-spec v0.5 同步、退避歸零時機、`shallowRef`、reduced-motion、觸控、`useDiagnoseTrigger`、nginx gzip、aria、focus trap | 已修復 |
| §5.1（部分） | `WorkerMetrics`／`CreateDiagnosisBody` Zod 化、asyncapi `1.1.0` | 已修復 |
| §6.2 AsyncAPI 同步 | `machine/data` 改陣列、`asyncapi-drift.test.ts` 11 支、`WS_MESSAGE_TYPES`、`contracts.check.ts` 刪除 | 已修復 |
| §6.3 Lint | `recommendedTypeChecked`、`no-floating-promises`、`no-restricted-imports` 架構邊界、plugin-vue 移 root、tsconfig 補三項 | 已修復 |
| §6.4 文件漂移 | 14 項中 13 項已更正（#13 見 §1.2） | 已修復 |
| §4 `@google/generative-ai` → `@google/genai` | 影響僅 adapter 與 smoke 兩檔 | 已修復 |

---

## 1. 部分修復：殘留差距

### 1.1 §1.1 WS 連線數上限（未修復、未記錄延後）

- `apps/api/src` 無任何連線數上限；`maxPayload`、Origin、machineIds 上限皆已做，唯獨每 IP／全域連線數未限制。ADR／README 亦無延後紀錄。
- 建議：`MAX_WS_CONNECTIONS` 於 upgrade 階段拒絕，或至少在 ADR-002 §6.3 記為已知未做。

### 1.2 §1.6 env fail-fast 殘留

- `apps/api/src/healthcheck.ts:17` 仍為 `Number(process.env.API_PORT ?? 3000)`；compose 已把 `API_PORT` 釘為 `"3000"`，host 直跑且留空時探針會連 port 0。
- `apps/api/src/scripts/seed.ts:1, 11-12` 仍用 `dotenv/config`（依 cwd）與 `??`，與 `main.ts` 明確路徑做法不一致（原 §6.4 #13 只文件化、程式未統一）。
- 建議：兩檔改用 `lib/env-schema.ts` 的同一份 schema。

### 1.3 §3.1 telemetry 寫入殘留

- `HistoryService.getWriteStats()`（丟棄／失敗批數）只在關閉時自用（`history.service.ts:148`），未接進 `system/metrics`；原建議是「丟失預算可量測」。
- demo 預設 `TELEMETRY_TTL_SECONDS` 仍為 `604800`（`.env.demo.example:50`），原建議降到 1 天。
- 建議：`system/metrics` 加 `persist: { dropped, failed }`；demo env 範本 TTL 改 86400。

### 1.4 §3.2 pnpm 版本（實際已造成問題）

- `packageManager` 仍為 `pnpm@9.0.0`（無 hash）。本機 Node 24.20 配此版本執行 `pnpm install` 會在 postinstall lifecycle 崩潰（`Error: readStream must be readable`），乾淨 clone 需加 `--ignore-scripts` 才能安裝；`.nvmrc` 已釘 22 但無法約束本機。
- root `lint`／`typecheck`／`test` script 內部呼叫裸 `pnpm`，PATH 無 pnpm 的環境會失敗（本機需 `corepack pnpm -r <script>` 繞過）。
- 建議：升 `pnpm@10.x` 並附 hash（`corepack use pnpm@10`）；Node 25 起 corepack 不再內建，Dockerfile 改 `npm i -g pnpm@<ver>` 或官方 image。**已納入升級分支第一階段。**

### 1.5 §3.2 `/livez`／`/readyz` 未拆（低優先、未記錄延後）

- `/healthz` 仍把依賴連通性當唯一判準；compose 目前不因 unhealthy 重啟故暫時無害，但 ADR-002 §9 預留 k8s 路線時會連鎖重啟。
- 建議：至少在 ADR-002 §6 記為已知未做。

### 1.6 §5.1 `packages/shared` 未拆包

- 結構仍為根 export（瀏覽器可用門檻）+ `./logging` 子路徑（Node-only pino）；已改以 `no-restricted-imports` 強制 web 不得匯入 logging，紀律缺口已補、結構缺口未補。可接受，若做 010 再一併拆 `domain`／`observability`。

### 1.7 §6.1 `GeminiProvider` 測試

- `ai/gemini-provider.test.ts` 只測 `thinkingConfigFor`、`classifyGeminiError`、缺金鑰；逾時中止串流是在 processor 以 fake provider 測的，未 mock SDK 直接驗證 `abortSignal` 有傳入、abort 後迴圈 break、`finishReason`／`usage` 對應。
- Lua 腳本只驗送出的參數（`redis-store.test.ts`），`FakeStore` 自行重寫語意，無真 Redis 整合測試。

---

## 2. 未修復：明文延後或尚未排程

### 2.1 §5.1 跨 process 單一來源（延後到 roadmap 010，指南 §15.6 已記）

- **Redis key／channel**：`ai-stream:` 仍散在 `ai-stream-relay.service.ts:43, 78` 與 worker；`metrics:worker` 集中在 worker `lib/redis-keys.ts` 但 api 另持一份字串（註解自承屬後續 feature）。
- **Mongo collection 名稱與文件形狀**：`"telemetry"`／`"errorlogs"`／`"maintenanceRecords"` 仍分別寫在 `history.service.ts:53-96`、`seed.ts:18`、`worker/context/context-builder.ts:52-103`；worker 讀維修紀錄仍用 `summary ?? notes ?? description ?? type` 猜欄位。
- **機台名冊三份**：`mock-telemetry.service.ts:9`、`web/.../machine-labels.ts:5`、`seed.ts`；前端寫死名冊，新機台不會出現。
- **`system/connected` 加 `protocolVersion`**：全 repo 無此欄位，**亦無延後紀錄**。
- 建議（010）：contracts 加 `infra.ts` 集中 key/channel 產生函式與 collection 常數，Mongo 文件型別放此或另開 `packages/persistence`；機台名冊由後端下發；`system/connected` 加 `protocolVersion`。

### 2.2 §6.1 測試基礎建設

- `context-builder`、`prompt` 零測試（worker 無對應測試檔）。
- 無 root `vitest.workspace`／`projects`，無 v8 coverage 與門檻；`apps/api`、`apps/worker` 新增的 `vitest.config.ts` 只處理 NODE_ENV condition。
- web 測試仍跑在 node 環境，無 jsdom／`@vue/test-utils` 元件測試。
- 無 e2e（WS 全鏈路）、無 testcontainers 跨 process 整合測試、無負載腳本（屬 roadmap 011）。

### 2.3 §6.2 AsyncAPI 漂移測試的覆蓋缺口

- `TelemetryPoint`、`SystemConnected`、`Pong`、`MachineSubscribed`、`SystemMetrics` 外層仍為純 TS 型別，漂移測試對這些 message 只驗 `type` const、結構未比對。
- `normalize()` 略過 `format`、`additionalProperties`，`jobId` 的 uuid 格式差異抓不到。
- 建議：Zod 4 升級後改用內建 `z.toJSONSchema`，並將上述五個型別 Zod 化納入比對。**已納入升級分支第三階段。**

### 2.4 §6.5 SDD 流程未精簡

- `git diff 1cfc8c0..a8ef62a -- specs` 無任何變更；tasks／quickstart／checklists／data-model 未壓縮；無機械化「feature 收尾清單」（CLAUDE.md release 流程第 1 步僅涵蓋部分檢查點）。
- 程式碼註解含 FR／SC／T0xx／research 引用由 248 行降至 202 行（程式碼量增加），新碼傾向寫「為什麼」，舊註解未系統性清理。
- 原量測：`specs/` 10,605 行對程式碼 8,276 行；009 單一 feature 2,189 行。建議保留 spec／research／contracts，精簡 tasks／quickstart／checklists，data-model 由程式碼型別取代。

---

## 3. 修復後新發現的殘留（皆為 Low，供後續追蹤）

### 3.1 worker／AI 管線

| # | 問題 | 位置 | 建議 |
| --- | --- | --- | --- |
| a | `GEMINI_API_KEY` 在 production 不 fail-fast（**刻意偏離**審查建議，已寫入 README／`.env.example`／指南）：缺金鑰時只 warn，worker 仍 healthy，第一筆診斷才以不可重試錯誤失敗 | `worker/lib/env-schema.ts:57, 89-93`；`env-schema.test.ts:56` 明確斷言此行為 | 在 `/healthz` 或 `system/metrics` 暴露 `aiConfigured:false`，或加可選 `AI_REQUIRE_KEY=true` 讓 production 能 fail-fast |
| b | 鎖 TTL 驗證無餘裕：`superRefine` 允許 `LOCK*1000 == AI_TIMEOUT_MS`（測試 `:52` 斷言恰等於通過），但持鎖期間還含 parse、Mongo insert（`socketTimeoutMS` 20s）、寫 cache，相等時鎖可能在寫 cache 前過期 | `worker/lib/env-schema.ts:68` | 要求 TTL ≥ timeout + 餘裕（預設 45/30 無問題） |
| c | Redis 固定窗限流：窗邊界可在數秒內放行最多 2×`AI_RPM`；被擋 job 集中在下一窗開頭醒來；延後次數無上限，長期超載時前端靠 keepalive 一直顯示 waiting；窗序號用各 worker 本機時鐘 | `worker/processor.ts:309-321`、`cache/redis-store.ts:28` | 至少寫進文件；可選滑動窗或延後次數上限 |
| d | dedupe 等待者仍佔 concurrency 槽最長 `aiTimeout + lockTtl + 5s ≈ 80s`，只在關閉中才提早交回；`WORKER_CONCURRENCY=2` 時等於一半處理能力（原 §2.4c 殘留） | `worker/processor.ts:296` | 等待超過門檻即 `moveToDelayed` |
| e | `processor.ts:352-357` 註解稱「stalled 用盡時 BullMQ 不 emit `failed`、不補 trigger」，實查 bullmq 5.79.2 會以 `UnrecoverableError` 走 `handleFailed` 並 emit，`isTerminalFailure` 會判 true、trigger 會補寫——行為比註解好，註解錯誤 | | 修正註解 |
| f | `usage`（token 用量）只記 log（`processor.ts:262`）未持久化，009 指標未涵蓋成本 | | 併入 `metrics:worker` 快照 |

### 3.2 api／運維

| # | 問題 | 位置 | 建議 |
| --- | --- | --- | --- |
| a | `REDIS_PASSWORD` 分散設定：compose 的 redis 從根 `.env` 插值讀取 `--requirepass`，api／worker 容器各自從 `env_file` 讀取，兩邊不一致時 NOAUTH，目前只靠註解提醒（`docker-compose.yml:25`） | | compose `environment` 統一插值，或文件明列同步步驟 |
| b | `packages/shared/tsconfig.json` include `src/**/*.ts`，build 會把 `*.test.ts` 編進 dist | | `exclude: ["**/*.test.ts"]` |
| c | Mongo 仍無 auth（原修法只要求綁 `127.0.0.1`，已達成） | | 記為已知 |

### 3.3 web

| # | 問題 | 位置 | 建議 |
| --- | --- | --- | --- |
| a | 硬規則 1 邊緣：`onDrop` → `store.recordDropped` 在 onmessage 路徑直接寫 reactive ref（`droppedMessages`／`invalidMessages`）。只在溢位或畸形點時觸發，但長時間 Pause 加大量轉換、或持續收到畸形資料時會變成逐則 reactive 寫入 | `useHighFrequencyWs.ts:198, 214` | 先累計於非 reactive 計數器，flush 時一次提交 |
| b | coalesce 病態情境：只在合併後仍超過 max 才降到 `lowWater`；合併結果略小於 max 時（轉換點多），每則訊息都重跑 O(n) 合併並觸發 a | `lib/telemetry-coalesce.ts` | 合併後一律降到 `lowWater` |
| c | 依賴方向反轉：`shared/composables/useDiagnoseTrigger.ts` 從 `shared/` 匯入 `domains/monitoring` 與 `domains/ai-copilot` 的 store | | 移至 `domains/ai-copilot/composables/` |
| d | `copilot.store.lastClientId` 與 `monitoring.store.clientId` 並存（語意不同：前者用於重連偵測），composable 已不再回傳 clientId | | 可接受 |

---

## 4. 技術棧升級（尚未執行部分）

實測 `pnpm outdated -r`（2026-09-27，current → latest）：NestJS 10.4.22 → 12.1（11 於 2025-01 發布）；`@nestjs/bullmq` 10.2.3 → 12.0；vite 5.4.21 → 8.3.1；`@vitejs/plugin-vue` 5 → 6；tailwindcss 3.4.19 → 4.3.3；zod 3.25.76 → 4.6.5；vitest 2.1.9 → 5.0.2；pinia 2.3.1 → 4.0.3；eslint 9.39 → 10.11；eslint-plugin-vue 9 → 10；vue-tsc 2.2 → 3.3；typescript 5.9.3 → 7.0.2；bullmq 5.79 → 6.3.9；ioredis 5.11 → 6.0；mongodb 6.21 → 7.6；pino 9 → 10；dotenv 16 → 18。

| 項目 | 建議 | 理由 | 狀態 |
| --- | --- | --- | --- |
| NestJS 10 | **升 11**，穩定後評估 12 | `@nestjs/core` moderate advisory 修補只在 11.1.18 以上，Nest 10 線無修補；`file-type` 2 項 moderate 亦經 `@nestjs/bullmq@10` 帶入；Express 5 路由語法變更但本專案只有兩個端點 | 升級分支第一階段 |
| pnpm 9.0.0 | 升 10.x 並附 hash | §1.4 | 升級分支第一階段 |
| Vite 5 / vitest 2 / plugin-vue 5 / vue-tsc 2 | 升（一起綁） | vitest 2.1.9 有 critical（<3.2.6）、vite 5.4.21 有 dev server fs.deny CVE；`vite.config` 極簡風險低；Vite 7 需 Node 20.19+ | 升級分支第二階段 |
| Vue 3.5 / Pinia 2 | Pinia 順手升；Vue 更新 patch、等 3.6 穩定 | gatekeeper 與框架無關 | 升級分支第二階段 |
| Zod 3.25 | 升 4，漂移測試改用內建 `z.toJSONSchema`，並補 §2.3 的五個型別 | 可拿掉 `zod-to-json-schema`；可餵 Gemini `responseSchema` | 升級分支第三階段 |
| `@google/generative-ai` | 換 `@google/genai` | | **已完成** |
| BullMQ 5／ioredis 5／mongodb 6 | 維持 | 皆為各自 major 最新線；bullmq 6 與 ioredis 6 剛發布、breaking 未查證 | 不排程 |
| Tailwind 3.4 | **暫緩** | v4 CSS-first 對 token 化更貼合，但 `@tailwind`→`@import`、`theme()`、尺度更名需先處理；視覺回歸風險高、收益低 | 不排程 |
| TypeScript 7（Go 版） | 不建議 | 等 vue-tsc 與 typescript-eslint 正式支援 | 不排程 |
| ESM + NestJS | 維持；建議 Node 端 tsconfig 改 `NodeNext` 讓漏 `.js` 在 tsc 期就炸，web 維持 `Bundler` | 相對 import 全帶 `.js`（grep 0 漏網） | 可選 |
| Mongo time-series 存遙測 | 維持；ADR-002 §7 拒絕 TSDB 成立 | 寫入批次化已完成 | 已結案 |

---

## 5. 架構層結論（未執行部分）

### 5.1 讀回路徑不存在（ADR-002 §6.2 與 README 已更正描述）

HTTP 只有 `POST /diagnoses` 與 `GET /healthz`；`diagnoses`／`errorlogs`／`telemetry` 對前端只寫不讀。資料確實落庫但使用者無管道取回；重連後拿到新 clientId、綁定失效，前端只能顯示「中斷 + Retry」。屬 roadmap 012。

### 5.2 職責邊界

api 同時是 Gateway、mock telemetry producer、BullMQ producer、Pub/Sub 轉發、HTTP API、seed 入口，demo 規模可接受；但 mock producer 仍寫死在 Gateway 的 `setInterval`，使「遙測從哪來」與「往哪送」綁死。建議（010）先抽 `TelemetrySource` 介面，是否升級成 `apps/simulator` 獨立 process 等真要接 ingestion 再決定。

### 5.3 擴展性天花板

- **接真實 ingestion**：無 ingestion 邊界；`TelemetryPoint` 仍為純 TS 無 runtime 驗證（前端已有手寫守衛，後端無）；機台名冊寫死；errorlog 去重狀態在 process 內。
- **多 Gateway**：`POST /diagnoses` 帶 `socketId` 把 HTTP 資源綁在收到 WS 連線的實例上，LB 分流時 `jobRooms` 查不到對象（比 ADR-002 §6.1 列的 `psubscribe *` 更早）；訂閱表、`lastState` 仍在 process 內（heartbeat／metrics 單 key 已修）。
- **多租戶**：契約、Mongo 文件、Redis key、cache 簽章皆無 tenant 維度；簽章不含 tenant 會跨租戶命中快取。

### 5.4 建議 roadmap（010–012，未排程）

| # | 一句話目標 | 作品集價值 | 工程價值 |
| --- | --- | --- | --- |
| 010 資料層單一來源 + ingestion 邊界 | 抽 `TelemetrySource` 介面；contracts 集中 Redis key/channel、collection 常數與文件型別；`TelemetryPoint` 改 Zod；機台名冊由後端下發；`protocolVersion`；`shared` 拆包 | 中 | **高** |
| 011 效能證據自動化 | Playwright + CDP trace 在 5/10/50ms 三節拍量測 WS 訊息數、遙測點數、flush 次數、掉幀率；腳本與結果固化進 README（README 已移除固定比值宣稱，但仍無可重現腳本） | **高** | 中 |
| 012 串流韌性 | token 改走 Redis Streams 並支援 last-id 續傳（需 `MAXLEN`／TTL；前端依 seq 去重）；重連時以 jobId rebind；新增 `GET /diagnoses/:jobId` | 高 | 高 |

### 5.5 ADR-002 §6／§7 評估（仍成立）

- §6.1：同意，但 `jobId → clientId` 綁定須外置到 Redis 或 HTTP/WS 共用 sticky key。
- §6.2：同意；殭屍串流已修，回放前提已具備。
- §6.3：JWT 不應放 query string（會進 nginx access log），改 `Sec-WebSocket-Protocol` 或 cookie；基本加固（已完成）不與 OIDC 綁定。
- §6.4：同意宣告有損；buffer + 單一 in-flight 已完成，丟棄計數進 metrics 尚缺（§1.3）。
- §7 五項拒絕全部同意維持；「拒絕 IAM」不涵蓋基本加固（已完成），「單節點」不等於可免認證／對外綁定／無 maxmemory（已完成）。

---

## 6. 不必做的事（六個面向意見一致，仍適用）

- 把 NestJS 換成 Fastify／Hono；用 Redis Streams 取代 BullMQ 當 job queue（Streams 只用在 token）。
- 專用時序資料庫、Kafka／MQTT、Kubernetes、OIDC／完整 IAM、Redis Sentinel／Mongo replica set、distroless／SBOM 簽章。
- Prometheus／Grafana／OTel、log aggregation。
- Gateway 水平擴展、綁定外置、鎖續租、Redlock、provider 自動 failover。
- 為 telemetry 寫入另建佇列；為限流精準度另建分散式 token bucket。
- 機台列表／EventStrip 虛擬化；AI token 走 rAF 批次；i18n 框架；light/dark 雙主題。
- 現在就升 Tailwind 4、TypeScript 7；改用 `@nestjs/platform-ws`／`@nestjs/config`／`@nestjs/terminus`；強行合併三份 Dockerfile；TS project references；開 `exactOptionalPropertyTypes`。
- 現在就把 mock producer 拆成獨立 process；為規格完整度繼續擴張 tasks／checklists／quickstart。

---

## 7. 剩餘項目建議處理順序

1. **升級分支**（進行中）：pnpm 10 + NestJS 11（§4）→ Vite／vitest／Vue／Pinia → Zod 4 + 漂移測試補五個型別（§2.3）。
2. **小修一批**（可併入升級分支收尾或獨立 `fix:`）：§1.2 healthcheck／seed env、§1.3 TTL 與 `persist` 指標、§3.1 b／e、§3.2 b、§3.3 a／b／c。
3. **文件記錄延後項**：§1.1 連線數上限、§1.5 `/livez`／`/readyz`、§2.1 `protocolVersion` 寫進 ADR-002 §6。
4. **010–012 roadmap** 依 SDD 流程另開 feature。
5. **§6.5 SDD 精簡**與 feature 收尾清單，於下一個 feature 起草時一併處理。

---

## 8. 通過驗證、無問題的項目（修復後回歸確認仍成立）

- **祕密衛生**：git history 只加過 5 份 `.env*.example`，模式掃描無命中；新增 env 錯誤訊息對 `WS_AUTH_SECRET`／`REDIS_PASSWORD` 不回顯原值；Gateway 忽略訊息時只記 issue 路徑不記原文。
- **AI 輸出渲染**：全程 `{{ }}` 插值，無 `v-html`／`innerHTML`；元件內無散落 hex，design-spec v0.5 與 `tailwind.config.ts` 逐項一致。
- **nginx WS 反代**：`Upgrade`／`Connection`／`http_version 1.1` 齊全，變數 upstream 延後解析正確。
- **關閉流程**：api／worker 皆以 `writeSync` 同步寫出 fatal；fire-and-forget 現由 `no-floating-promises` 強制檢查。
- **CLAUDE.md 硬規則 1–7**：修復未引入衝突（ws 仍原生、worker 已被 lint 禁止 import `ws`、AI 結果與 relay 皆經 schema 驗證、cache→鎖→double-check 順序正確）。
- **Redis 記憶體**：所有 key 含新增 `ai-rpm:*` 皆有 TTL。

---

## 附錄：驗收方法

- 比較基準 `1cfc8c0..a8ef62a`；3 個驗收 agent 分別負責 api／運維、worker／AI、web／contracts，逐項讀 diff 與現行檔案，不以 commit 訊息為據。
- 實測：乾淨 clone（`git archive` + `install --frozen-lockfile --offline`，不 build）typecheck／lint／test 全綠；Gateway PoC 以真實 `MonitoringGateway` + fatal handler 送七種畸形輸入，行程存活且新連線可訂閱；web build 191 kB（gzip 63 kB）。
- 原始審查（含全部已修復項目的 `file:line` 證據）見 git 歷史 `fd34905`。
