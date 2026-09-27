# 2026-09-27 第二輪全面技術棧與架構審查（Research Review 02）

| 項目 | 內容 |
| --- | --- |
| 審查日期 | 2026-09-27（第一輪修復與技術棧升級併入 `develop` 之後） |
| 審查對象 | `develop` @ `6be71c6`（`merge(upgrade): 併入 upgrade/20260927-tech-stack`；其下為 `eab5db4` 審查報告更新、`a8ef62a merge(fix-review)`；尚未 push） |
| 與前輪關係 | 前輪 `docs/20260927-research-review.md` 審 `main` @ `3e94ac2`（v1.0.0）。本輪三個目標：(a) 驗證前輪宣稱「已修復」與升級是否屬實、有無回歸；(b) 找前輪未發現的缺陷；(c) 給架構級優化方向。**前輪已列且本輪無新證據的殘留項不重複**（前輪 §1.1–§3.3 仍以前輪為準） |
| 方法 | 8 個獨立審查 agent（Opus 5.5）分面向平行審查：api、worker、web、contracts／shared／asyncapi、infra／CI、測試與程式品質、文件與 SDD 流程、跨 process 架構；全程唯讀，由統籌者（Fable 5.1）交叉比對、去重、抽查證據後統整。實測項目標「實測」，推論項目標「推理」 |
| 全套檢查（實跑） | `contract:lint` 0 error；`-r typecheck` 5/5；`-r lint` 0 error 0 warning；`-r test` **583 passed / 0 failed**（shared 16、contracts 113、api 155、worker 136、web 163，wall 35 s）；web build 224.32 kB（gzip 75.62 kB）；`pnpm audit` 0。**前輪與升級分支的宣稱數字全部屬實** |
| Finding 編號 | 本文採穩定 ID（`API-`／`WK-`／`WEB-`／`CT-`／`INF-`／`TQ-`／`DOC-`／`AR-`），行號會隨修改漂移，引用時以 ID 為準 |
| 各面向完整報告 | 統籌者 scratchpad `review02/{api,worker,web,contracts,infra,tests-quality,docs-process,architecture}.md`（含全部 `file:line` 證據、重現腳本與變異測試記錄；未納入 repo） |

---

## 0. 結論摘要

1. **前輪修復與升級皆屬實，沒有回歸。** 八個面向逐項核對前輪 §0 總帳與升級清單，全部成立；Zod 4、NestJS 11／Express 5、`@google/genai`、pnpm 10、vitest 4 皆未引入行為缺陷。單一 process 內的防禦已經完整，本輪問題集中在**跨 process 的語意縫隙**與**測試斷言面**。
2. **一個真正的祕密外洩（列 P1，因觸發需設定錯誤）**：Redis 密碼錯誤時，`REDIS_PASSWORD` 會以明文、每次重連反覆寫進 api／worker 日誌（三個 agent 各自實測重現）。前輪 §8「祕密衛生」結論被推翻。修法只有一處（shared logger 加 `redact`）。
3. **一個自 004 起就存在、三輪審查都沒抓到的 UI 缺陷**：機台卡片的選取態在畫面上幾乎不可見（Tailwind 色名 `inset` 與內建 `ring-inset` 撞名 + class 輸出順序）。headless Chrome 實測選取與未選取的邊框／底色完全相同。
4. **免授權入口形成一條完整的濫用鏈**：任何連得上 8080 的客戶端（compose 綁 `0.0.0.0`）→ 開 WS 拿 clientId（不需 token）→ `POST /diagnoses` 帶任意 machineId／已斷線的 socketId → 每筆都真的打 LLM，且能繞過 `WS_AUTH_SECRET` 取得遙測衍生資料；再加上 WS 無背壓、未經請求的 pong 可騙過心跳、無連線數上限。
5. **AI 管線的「完成」語意只靠 Pub/Sub 的 `ai/done` 單一訊號**，契約的 `job/status.result` 欄位從未被填；`ai/done` 遺失、等待者無事件、首 token 前無 keepalive、`stalled` 未監聽，最後都收斂成「後端成功、畫面顯示逾時」。LLM 成功後的落庫／快取步驟失敗會**重打 LLM 且落庫與畫面結果不一致**。
6. **測試「量」足、「斷言面」不足**：39 個手工變異有 24 個存活，包括 `ai/token` 的 `seq` 不遞增、Gateway 不依訂閱過濾、WS composable 不分流診斷事件，三者在全套測試下都是綠燈。
7. **文件層有兩個 release 閘門未過**：asyncapi `info.version` 仍 1.1.0（契約已加嚴且新增消費端義務）、指南 §15.6 完全沒有升級分支摘要；前輪 §7 第 3 步「延後項寫進 ADR-002」未執行。
8. **建議 roadmap 順序改為 010-lite → 012-lite → 011**：以 BullMQ `returnvalue` + `job/status.result` + `GET /diagnoses/:jobId` 取代 Redis Streams，涵蓋面更大、成本更低。

---

## 1. 前輪修復與升級的回歸驗證

| 面向 | 驗證方式 | 結果 |
| --- | --- | --- |
| api §1.1／§1.4／§1.5／§2.2／§2.3／§3.1／§3.2 | 逐項讀碼；真實 NestJS 11 + Express 5 app 打畸形 JSON／413／415／charset／尾斜線／`/healthz` 503（實測） | 全部成立。Express 5 空 body 為 `undefined` 由 Zod 擋下；body-parser 2 錯誤由 Nest 轉 JSON；`HttpException(body, 503)` 的自訂 body 與 `Cache-Control: no-store` 保留 |
| worker §1.3／§2.1／§2.2／§2.4 | 逐項讀碼；查 `@google/genai` 2.24／bullmq 5.79.2 原始碼；`toGeminiJsonSchema` 邊界實測 | 去重順序 cache→鎖→double-check→限流→LLM 正確；`abortSignal` 經 SDK 串到 `fetch`；逾時後 token 有兩道閘門；`moveToDelayed(skipAttempt)` 不消耗 attempts；structured output 只用 SDK 允許的鍵 |
| web §2.2／§2.3／§3.3 | 逐項讀碼；typecheck／lint／build 實跑 | 全部成立；bundle 與升級報告一致 |
| contracts §2.3／§6.2／§1.2／§3.2b | 113 支測試實跑；Zod 4 語意逐項實測；漂移測試變異探測 | `WS_MESSAGE_TYPES` 型別綁定有效；覆蓋率測試能抓新增 message；`io:"input"` 用法正確；workspace 只有一份 `zod@4.6.5`，無 dual-package hazard |
| infra §3.2 全部 | `docker save` 解開 image 最後一層、`docker history`／`inspect`、`compose config -q`、`pnpm audit`（實測） | healthcheck／資源上限／log 輪替／maxmemory／digest 雙釘／非 root／祕密不進 image／prod image 無 dev 依賴／contracts+shared 只帶 dist：全部屬實 |
| 測試與 lint §6.3 | 四道檢查實跑；grep 統計 | production 程式碼 `any`／`eslint-disable`／`@ts-*`／`as unknown as`／TODO 皆為 0；額外開 5 條 strict 規則只 8 處命中 |

**唯一有分歧的驗證**：`pnpm deploy --legacy` 是否依 lockfile 解析（見 INF-6）。

---

## 2. P1：應立即修（成本低、影響大）

### 2.1 CT-1／API-1／WK-1｜Redis 認證失敗時 `REDIS_PASSWORD` 明文進日誌（**實測**，三個 agent 各自重現）

- **成因**：ioredis `DataHandler.js:40-43` 把整條命令掛在 error 上（`err.command = { name, args }`），AUTH 失敗（`WRONGPASS`／`NOAUTH`）時 `args` 就是密碼；`packages/shared/src/logging/index.ts:44` 只設 `serializers: { err: pino.stdSerializers.err }`、**沒有 `redact`**，std serializer 會複製 error 上所有可列舉屬性。
- **觸發點**：`apps/worker/src/main.ts:81-82`（pub／cache 連線）、`:138`（BullMQ worker error）、`apps/api/src/modules/metrics/metrics.service.ts:53`。
- **實測輸出**：`"command":{"name":"auth","args":["SuperSecret-Worker-Pass"]}`，每 100–270 ms 重連一次、兩條連線各自洗版，`waitForReady` 10 s 後 fatal，`restart: on-failure` 重啟再洗一輪。
- **為何嚴重**：觸發條件正是前輪 §3.2a 與 `.env.example` 都點名「最常見」的設定錯誤（compose 的 redis 與 api／worker `env_file` 的密碼不一致）。密碼會進 docker json-file log 與任何日誌收集端。違反硬規則 7。
- **修法**：`createLogger` 加 `redact: { paths: ["err.command.args", "*.err.command.args"], censor: "[redacted]" }`（或自訂 err serializer 只留 `command.name`），api／worker 同時受益；補一支單元測試餵帶 `command.args` 的 Error 斷言輸出不含原值；Redis 連線錯誤日誌加轉態節流（比照 `history.service` 的 `ERROR_LOG_THROTTLE_MS`）。同型態的 `jobs.service.ts:103`、`job-status-relay.service.ts:141` 會把 BullMQ Lua 的 `evalsha` 參數整包記下，不是祕密但會讓日誌暴肥，一併受益。

### 2.2 WEB-1｜機台卡片選取態幾乎不可見（**實測**，自 004 起存在）

- **成因**（三層疊加）：
  1. `apps/web/tailwind.config.ts:23` 定義色票 `inset: '#0E151B'`，與 Tailwind 內建 `ring-inset` 工具撞名，`MachineNodeCard.vue:46,112` 的 `ring-1 ring-inset ring-accent` 中 `ring-inset` 被解讀成「環顏色 = 深色背景色」。
  2. 卡片狀態 class（`border-subtle bg-surface` 等）在 CSS 輸出順序上排在選取 class（`border-accent bg-accent-wash`）之後，把選取的邊框與底色蓋掉。
  3. critical 卡片的閃爍動畫也會蓋掉選取框。
- **實測**：headless Chrome 讀取 computed style，選取與未選取卡片的 `border-color`／`background-color` 完全相同。與 `apps/web/design/design-spec.md` §7.3 及 README 描述不符。行動版 sidebar 隱藏，手機上完全看不出選了哪台。
- **修法**：色票改名（如 `surface-inset`）；選取態改用 `data-selected` 屬性選擇器或把選取 class 放在狀態 class 之後；加一支 Playwright 截圖回歸測試涵蓋五種狀態 × 選取／未選取。這是三輪審查、163 支 web 測試都沒抓到的缺陷，根因是**沒有任何元件／視覺層測試**（見 §3.6）。

### 2.3 AR-1／WK-2／AR-3｜「完成」只靠 `ai/done` 單一訊號，等待與首 token 前沒有事件，`stalled` 未監聽

- **證據**：
  - 前端只在 `ai/done` 轉 `completed`（`copilot-reducer.ts:153-155`）；契約 `JobStatusSchema.result`（`contracts/src/job-status.ts:16`）已有欄位，但 api relay 從不填（`job-status-relay.service.ts:167-176`），processor 回傳 `void`。
  - dedupe 等待者送 progress 20 後進 `for(;;)` 等待迴圈（`processor.ts:297-345`），最長 `aiTimeout + lockTtl + 5s ≈ 80s` 不送任何事件；持鎖者送 progress 40 後要等首 token 才有下一個事件。前端 watchdog `STALL_TIMEOUT_MS = 45_000`（`App.vue:123`）只由當前 job 的事件重置。
  - relay 沒有監聽 QueueEvents `stalled`；worker 崩潰後重派要 0–60 s（BullMQ 預設 30 s／30 s／1，推理）才被偵測，前端 45 s 多半先觸發。
  - env 只驗 `LOCK×1000 ≥ TIMEOUT`，沒限制 `AI_TIMEOUT_MS` 上限；為 thinking 模型調到 60 s 是合法設定，但首 token 常在 45 s 後才出。
- **使用者可見結果**：持鎖者被 SIGKILL／OOM → 等待者 45 s 判「診斷逾時」→ worker 隨後算完並送 `ai/done` 但前端已不接收 → 使用者按 Retry 多打一次 LLM。
- **修法**（合併處理）：
  1. processor 回傳 `DiagnosisResult`，經 BullMQ `returnvalue` → QueueEvents `completed` → relay 填進 `job/status.result`，前端 `completed` 事件帶 result 亦可收尾（`ai/done` 遺失也能完成）。
  2. 等待迴圈與首 token 前每約 10 s 節流 `job.updateProgress(<同值>)`（BullMQ 會 XADD progress 事件 → `job/status active` → 重置前端計時）。
  3. relay 監聽 `stalled` 並下發 `job/status`。
  4. 逾時常數（web 45 s、worker `AI_TIMEOUT_MS`、api `DELAYED_KEEPALIVE_MS` 15 s、compose `stop_grace_period`）目前只靠註解同步（AR-A1）；至少在文件寫明 `AI_TIMEOUT_MS` 必須小於前端 watchdog，理想是由 `system/connected` 下發。

### 2.4 TQ-1～TQ-3｜測試斷言面缺口：三類使用者可見錯誤可無聲上線（**變異測試實測**）

| ID | 存活變異 | 後果 | 全套結果 |
| --- | --- | --- | --- |
| TQ-1 | `processor.ts:246` `ai/token` 的 `seq` 恆為 0 | 前端 `seq === 0` 重設 `streamText`（`copilot-reducer.ts:149`），串流只剩最後一段 | worker 136 支全綠 |
| TQ-2 | `monitoring.gateway.ts:209` 遙測不依訂閱過濾（違反 FR-004）；`:226` 心跳永不回收半死連線（違反 SC-005）；`:217` 遙測不落地（違反 FR-009） | 未訂閱者收全量、殭屍連線永存、history 無資料 | api 155 支全綠（`monitoring.gateway.test.ts:44` 刻意不呼叫 `onModuleInit`，producer／心跳／metrics 廣播在整個套件都沒執行過） |
| TQ-3 | `useHighFrequencyWs.ts:214-219` 不分流 `ai/*`／`job/status`／`system/metrics`；`:233` `system/connected` 不歸零退避（前輪 §3.3 修過的行為） | Copilot 收不到事件、指標面板空白、退避不重置 | web 163 支全綠 |

- **修法**：TQ-1 一行斷言（`ofType("ai/token").map(e => e.seq)` 等於 `[0,1]`）；TQ-3 三支測試（約 1–2 小時）；TQ-2 沿用既有 harness 改呼叫 `onModuleInit()`、把 tick 與心跳調到 20／100 ms，補四支（約 0.5 天）。

### 2.5 DOC-2｜asyncapi `info.version` 未升版，release 閘門必卡

- `asyncapi.yaml:4` 仍 `1.1.0`，但 1.1.0 之後（`git diff cffb306 6be71c6 -- asyncapi.yaml`）：新增五處 `minimum`；`AiToken`／`AiDone`／`AiError` 的 `attempt` 描述新增「同一 attempt 內收到 seq 0 也要清空」這種**消費端義務**；runtime 接受範圍變窄（`snapshotAt` 由 `z.string()` 改 RFC 3339、`z.uuid()`）；HTTP 400 的 `issues[].code` 由 `invalid_string` 變 `invalid_format`。「純加嚴不升版」的判斷不成立。CLAUDE.md release 流程第 1 步要求契約變更即升版。
- **建議**：升 **1.2.0**（向後相容的 minor），README:255／:366、指南:652／:3160 同步；asyncapi 旁或 README 加簡短 changelog，HTTP 契約變化寫進同一份。另外 v1.0.0 發布時是 `0.1.0` 直接跳 `1.1.0`，中間沒有 1.0.0，版本語意不清，changelog 一併說明。

---

## 3. P2：應排程修

### 3.1 免授權入口的濫用鏈（api／worker／infra／web 四方互相印證）

| ID | 問題 | 證據 | 建議 |
| --- | --- | --- | --- |
| INF-2 | demo 入口 8080 綁所有介面且無認證 | `docker-compose.yml:238` `"8080:8080"`（redis／mongo 已收 `127.0.0.1`）；`.env.demo.example` 的 `WS_AUTH_SECRET`／`WS_ALLOWED_ORIGINS` 刻意留空；`nginx.conf:69-74` `/diagnoses` 無 `limit_req` | `ports: ["${WEB_BIND:-127.0.0.1}:8080:8080"]`；nginx `limit_req_zone $binary_remote_addr zone=diag:1m rate=10r/m` |
| API-3／WK-5 | `POST /diagnoses` 接受任意 machineId，每個亂數 id 必 cache miss 並真的打 LLM；空脈絡（無 telemetry／errorlog／維修紀錄）照樣呼叫 LLM | `contracts/src/http.ts:20` 只驗 regex；`jobs.service.ts:58-73` 不比對名冊（api 手上有 `MACHINE_IDS`）；`context-builder.ts:69-87` 空脈絡照組 prompt；簽章含 machineId、`AI_RPM` 全域共用 | api 先比對名冊回 400／404（與 010「名冊由後端下發」同向）；worker 空脈絡短路送不可重試 `ai/error(no_context)`，不打 LLM |
| API-4／AR-F2／WEB-3 | `WS_AUTH_SECRET` 可經 `POST /diagnoses` 繞過；斷線後仍可送出診斷 | 任何連線立刻收到 `system/connected{clientId}`（`monitoring.gateway.ts:132-137`）；`jobs.service.ts:73` 把任意 socketId 綁成接收者，不檢查是否在線／已授權；relay `send()` 不檢查授權；`broadcastMetrics`（`:257-261`）推給所有連線；前端斷線不清空 `clientId`（`monitoring.store.ts:159-167`），`useDiagnoseTrigger.ts:27` 只看「曾拿到過 clientId」 | Gateway 維護 `authorized: Set<clientId>`，AI／job 路徑只送已授權連線；JobsService 綁定前確認 socketId 在線且已授權，否則 409；前端定義「連線真的活著」（收到 `system/connected` 且心跳未逾時）並只在該狀態啟用 Diagnose；ADR-002 §6.3 記一筆「FR-021 免授權會讓 WS 授權形同虛設」 |
| API-2 | WS 無背壓：慢讀者讓 `bufferedAmount` 無上限成長；未經請求的 pong 騙過心跳（**實測**） | `send()`（`:264-268`）只看 `readyState`；`:143` 任何 protocol pong 都設 `alive`。實測 client `_socket.pause()` + 每 200 ms 主動 `pong()`：`bufferedAmount` 12 s 內由 74 KB 單調成長至 890 KB，心跳從未回收 | `send()` 設高水位（如 1 MiB）超過即略過該筆、連續 N tick 超標則 `terminate()`；心跳改 `ping(nonce)` 比對 pong payload；與前輪 §1.1 連線數上限一起做，補慢讀者測試 |
| API-6 | 同一連線錯誤 token／畸形訊息次數無上限，每則寫一行 warn（日誌放大、無限暴力猜 token）；`msg.token !== secret` 非常數時間比較 | `monitoring.gateway.ts:157,167,181,183` | 每連線違規計數超過 N 次 `close(1008)`；沿用 `LogThrottle`；`timingSafeEqual` |

> 以上合併為一個「Gateway 出口閘門 + HTTP 入口收斂」批次：`send()` 統一處理「已授權才送、背壓高水位、違規計數」，`createDiagnosis` 統一處理「名冊、在線、授權」。預估 1–2 個檔案、約 100 行，外加慢讀者與未授權整合測試。

### 3.2 AI 管線語意（worker 為主）

| ID | 問題 | 證據 | 建議 |
| --- | --- | --- | --- |
| WK-4／AR-F4 | LLM 成功後任一後續步驟（寫 `diagnoses`、寫 cache、寫 trigger）失敗就整個 attempt 重來：**重打 LLM**，且 attempt 2 的結果 B 寫 cache、前端看到 B，`diagnoses` 因 unique 衝突被吞掉永遠只有 A | `processor.ts:282-288` 順序 `insertDiagnosis → setWithTtl → insertTrigger → progress 100 → ai/done`；`diagnosis-repository.ts:336-344` 吞 11000 | `callLlmAndReply` 前（至少 `attempt > 1` 時）先以 jobId 查 `diagnoses`，查得到就沿用該結果補 cache／trigger／`ai/done`；repository 加 `findByJobId`（走既有 unique 索引）。架構 agent 另建議「先寫 cache、Mongo 改 best-effort」，這會推翻前輪「先 Mongo 再 cache」的決定，屬跨 feature 決策，若採用須回補指南 |
| WK-3 | 沒設 `maxOutputTokens`／`temperature`，`finishReason === "max_tokens"` 分支實際走不到；JSON mode 陷入重複迴圈時只能靠 30 s 逾時截斷，期間每 chunk 都 publish + relay safeParse + WS 送出；`max_tokens` 又被標可重試，同樣輸入重試多半仍截斷 | `gemini-provider.ts:48-54`；`processor.ts:269-271` | 加 `maxOutputTokens`（1–2k 足夠，可開 env）與較低 `temperature`；`max_tokens` 改不可重試或重試時放寬上限 |
| WK-6 | `smoke:gemini` 沒驗 production 實際送出的設定（`responseJsonSchema`／`propertyOrdering`／`thinkingConfig`），用 `generateContent` 非 stream，且 `trim()` 金鑰而 worker 不 trim | `ai/smoke-gemini.ts:14,21-26` vs `gemini-provider.ts:48-54` | smoke 改直接用 `GeminiProvider` + `DIAGNOSIS_RESULT_JSON_SCHEMA` 跑一次 `parseResult`，印 `finishReason`／`usage` |
| AR-A9／API-7 | 錯誤碼沒有列舉，前端靠訊息原文關鍵字判斷；Mongo 故障會被顯示成「AI 診斷逾時」；`failedReason` 原文（可能含 Mongo 主機名或 SDK 錯誤）原樣下發瀏覽器 | `copilot.store` 錯誤對映；`job-status-relay.service.ts:122,126` | 契約定義 `AiErrorCode` enum，`worker_failed` 改固定文案，細節只寫日誌 |

### 3.3 跨 process 設定與時鐘耦合

| ID | 問題 | 證據 | 建議 |
| --- | --- | --- | --- |
| CT-2 | `METRICS_INTERVAL_MS` 沒驗整數與上限：設 `5000.5` 時 api 送出的每則 `system/metrics` 都違約（`windowMs` 須 int），web 整則丟棄、面板永遠 `empty`，api 無任何警告；設 > 2^31-1 時 Node 退化成每 1 ms 觸發（**實測** 100 ms 內 9 次），api 每毫秒 SCAN／MGET／廣播、web 每則直寫 reactive state | `packages/shared/src/logging/interval.ts:26-27` 只查 `isFinite && >= 5000`；`metrics.service.ts:67,116` | `Number.isSafeInteger && >= MIN && <= 2_147_483_647`，不合法回退預設；api 出口在 dev／test 以 `SystemMetricsSchema.parse` 自檢 |
| API-8／AR-A2／DOC-11 | api 以**自己的** `windowMs × 2.5` 且用 api 時鐘減 worker 時鐘判斷 worker 快照是否過期；兩份 `.env` 的 `METRICS_INTERVAL_MS` 必須相同只靠註解；`.env.demo.example` 根本沒列這個變數。例如 api=5000、worker=60000 時 `worker: null` 永遠成立 | `metrics-merge.ts:112-121,314-323`；`apps/worker/.env.example:73` | `WorkerMetrics` 加 `windowMs`，讀取端依各快照自己的窗長判斷；demo 範本列出變數 |
| AR-A1 | 逾時鏈常數三端各寫一份（web 45 s、worker `AI_TIMEOUT_MS`、api 15 s keepalive、compose `stop_grace_period`）只靠註解同步 | 見 §2.3 | 由 `system/connected` 下發 watchdog 門檻與 `protocolVersion`（010-lite） |
| CT-4 | 「新鮮度」語意三方矛盾：asyncapi:290 與 `events.ts:122` 說以 `collectedAt` 判定，web `metrics.store.ts:22-36` 刻意改用收訊時刻（避免時鐘偏差，`a85509d` 定案） | 漂移測試不比 `description` | 契約描述改為「僅供顯示與稽核；新鮮度以收訊時刻判定」，併入 1.2.0 |

### 3.4 前端

| ID | 問題 | 證據 | 建議 |
| --- | --- | --- | --- |
| WEB-2 | 網路靜默斷線時重連延遲數十秒：pong 逾時只 `ws.close()`，要等瀏覽器送 close 事件才重連，期間狀態仍顯示綠燈 Connected；測試用假 WebSocket 立刻觸發 close 所以抓不到 | `useHighFrequencyWs.ts:176-178` | pong 逾時直接視為斷線：清 socket 引用、立即進入退避重連、狀態改 reconnecting |
| WEB-4 | 行動版關掉 Copilot sheet 後再點同一張卡片不會重開（面板只在「選取機台改變」時開），無其他入口 | `App.vue:44-52` | 點擊已選取卡片也觸發開啟 |
| WEB-10 | 前端逾時 45 s 短於後端去重等待最長約 80 s 靜默期 | 同 §2.3 | 同 §2.3 |

### 3.5 運維

| ID | 問題 | 證據 | 建議 |
| --- | --- | --- | --- |
| INF-1 | 一鍵 demo 容器內 `WORKER_CHAOS` 演練**一律不生效**：worker image `ENV NODE_ENV=production`，`main.ts:156` 在 production 只記 error 不武裝 chaos，compose 未覆寫 `NODE_ENV`；但指南 §16.3 第 5 列與 `specs/007-.../quickstart.md:35-60` 都寫「設 `WORKER_CHAOS=uncaught` 後重建 worker」預期 `exit(1)` 被重啟 | `apps/worker/Dockerfile:64`；`docker-compose.yml:114-127` | 劇本改成同時設 `NODE_ENV=development`（`env_file` 蓋過 image ENV，`LOG_PRETTY` 已釘 false），或守衛改看獨立開關 `WORKER_CHAOS_ALLOW_IN_PRODUCTION`；指南 §16.3 與 007 quickstart 同步 |
| INF-6／CT-3／DOC-1（**待查證，四方證據分歧**） | `pnpm deploy --legacy` 是否依 lockfile 解析。Dockerfile 註解（`apps/api/Dockerfile:61`）自承「不讀 lockfile、會重新解析版本」，契約／api／文件三個 agent 據此指出 image 相依可能與 CI 測過的 lockfile 分岔、`audit 0` 不保證適用 image；infra agent 解開本機 image 比對 `.pnpm` 內 api 151／worker 95 個套件**全部**與 lockfile 一致，且範圍內已有更新版（`ws` 8.22.0、`bullmq` 5.81.5）未被選入 | 兩方皆為實測，差異在「本機 metadata 快取可能剛好停在 lockfile 版本」 | 統籌判斷：**本機觀察一致，機制上不保證**。應在乾淨 BuildKit cache 下 build 一次比對；若確實分岔，擇一：builder stage 寫 `inject-workspace-packages=true` 走非 legacy deploy、或 deploy 後 `pnpm list --prod --json` 與 lockfile 比對失敗即中止、或 runtime 直接相依改精確版號。無論結果，Dockerfile 註解與 README:285／:418 的「可重現」描述須對齊實況 |
| INF-3／WK-12 | api／worker runtime image 帶進整份 `src`（含 19／17 支測試）、Dockerfile、tsconfig、vitest 設定、`dist/ai/smoke-gemini.js` | 兩個 app 的 `package.json` 無 `files` 欄位，`pnpm deploy` 依 `npm pack` 語意帶走整個目錄（**實測**解開 image） | 加 `"files": ["dist"]`；worker `tsconfig.build.json` exclude `smoke-gemini.ts`；`.dockerignore` 的 `coverage`／`*.log`／`*.md` 補 `**/` 前綴（INF-9） |
| INF-4／INF-5 | redis／mongo 沒有 `restart:`（redis AOF rewrite 可能被 OOM kill 後不會回來，api／worker 只能靠無限重連撐著）；web `depends_on: - api` 仍是短式 | `docker-compose.yml:12-83,240-241` | 各加 `restart: unless-stopped`；web 改 `service_healthy`。皆在 ADR-002 §7「拒絕 HA ≠ 不設防」邊界內 |

### 3.6 測試基礎建設（TQ-4～TQ-13 摘要）

- **TQ-4**：processor 的進度里程碑（0→20→40→60→80→100）、trigger `cached` 旗標、metrics 呼叫次數、`liveness.begin/end` 全無斷言（M4–M7、M11、M12 存活）。
- **TQ-5**：`ProcessorDeps` 提供 `now`／`sleep` 注入點但測試全用真實 `setTimeout`，等待 deadline 完全沒測（M8），「等待者搶到鎖先 double-check」靠 50 ms 輪詢對 5 ms script 的時序，負載高時假綠。
- **TQ-6**：`JobStatusRelayService` 的 QueueEvents 接線與 `sweepOrphans` 沒執行過（R1–R4 存活：`completed` 不刪綁定、progress 丟數值、孤兒不回收）。
- **TQ-7**：`HistoryService.writeOnce`／`flush` 的計數協調沒測（正是前輪 §1.3 要接進 metrics 的 `getWriteStats` 來源）。
- **TQ-8**：`metrics.store` 四態判定（empty／disconnected／stale／live）零測試，註解強調的不變量只靠註解維持。
- **TQ-9**：`PinoLoggerService` 仿 Nest `ConsoleLogger` 的參數拆解（註解自承曾出 bug）無測試，NestJS 11 已升卻沒有回歸保護。
- **TQ-10**：worker `bootstrap()` 失敗用非同步 pino logger 後立刻 `process.exit(1)`（`main.ts:222-230`），與同檔 `fatal.ts` 明文「exit 前 MUST `writeSync`」矛盾；api 同位置用 `fatalExit`。
- **TQ-11／CT-12**：Gateway `send(clientId, payload: unknown)` 是對前端的唯一出口卻無型別約束；契約 `ServerMessage` 聯集在 repo 內沒有使用者（死型別），且把 `TelemetryPoint` 列為單則而線上送的是陣列。改 `send(payload: ServerMessage | TelemetryPoint[])` 零 runtime 成本。
- **TQ-13**：`FakeStore` 忽略 TTL 參數，cache TTL 誤傳 lock TTL（M13）測不出。
- **CT-8**：`DiagnosisJobPayload` 只有 TS 型別，worker `job.data` 經 Redis 跨 process 卻無 runtime 驗證，與 `metrics.ts` 自立的「跨 process 必須驗證」原則不一致。

### 3.7 文件與流程

| ID | 問題 | 證據 |
| --- | --- | --- |
| DOC-3／C2 | 指南 §15.6「現況摘要」**完全沒有升級分支**（NestJS 11／Express 5、Vite 7、vitest 4、Pinia 3、Zod 4 與 bundle 取捨、pnpm 10），仍寫 `engines >=22`（:3164）；CLAUDE.md:3-5 指 §15.6 為現況入口，新 session 會漏掉 Zod 4／NestJS 11 現況 | `docs/Flow-Gatekeeper-SDD-完整實作指南.md:3153-3216` |
| DOC-8 | 前輪 §7 第 3 步未執行：WS 連線數上限、`/livez`／`/readyz`、`protocolVersion` 在 ADR／README／指南查無延後紀錄。依 CLAUDE.md 規則，這些延後決策「未落地」 | `grep` 四份文件無命中 |
| DOC-5 | 指南 §9.1（:2112-2122）仍指示 `Copy-Item docs/design-spec.md apps/web/design/design-spec.md`，§9.7 驗收「兩者未分岔」；照做會用 v0.3 歷史檔**覆蓋** canonical 的 v0.5 | `docs/design-spec.md:3-5` 已有移轉橫幅 |
| DOC-6 | `apps/api/.env.example:31`、`.env.demo.example:37` 註解指向「memory live-acceptance-recipe」（Agent memory，人類看不到、CLAUDE.md 明定非真實來源） | 應改指 `specs/004-.../research.md` R3 或 README |
| DOC-7 | README 環境變數表缺 `WORKER_CHAOS`／`WORKER_CHAOS_AT` | `README.md:674-698` vs `apps/worker/.env.example:79-88` |
| DOC-R1～R4 | 前輪報告數字自相矛盾：修復分支寫 17 commit 實為 16、升級分支寫 9 實為 17；§4 Zod 列 224.77 kB vs 表頭 224.32；§4 `pnpm outdated` 表仍是升級前快照未標時點 | `docs/20260927-research-review.md:7,9,145,149` |
| DOC-G1 | 直接 commit 到 `develop` 三次（`97dd0c5`、`1cfc8c0`、`eab5db4`）；008 有 9 個 phase commit 不合 CLAUDE.md 格式（`[Phase 7]` 缺名稱、`[Phase 3+4]`／`[Phase 5+6]` 合併兩個 phase）；`develop` 領先 `origin/develop` 36 個 commit | `git log --first-parent develop` |
| DOC-C1／C3 | CLAUDE.md:135「見最上層『執行動作』原則」是懸空引用；「跨 Feature 決策 MUST 回補」是治理層 MUST 卻只在 CLAUDE.md，且範圍只寫「SDD 流程任一階段」未涵蓋 fix／upgrade 這類非 SDD 分支（今天兩個分支正是跨 feature 決策最密集的來源）；沒有維護分支（`fix/*`、`upgrade/*`）的命名／scope／merge 訊息規則 | `CLAUDE.md:17-31,135` |
| DOC-S1 | 001–008 的 `spec.md` 仍 `Status: Draft`，只有 009 標完成；001–007 的 spec／data-model 沒有「已變更，現況見…」橫幅（如 003 data-model 仍有 `promptVersion` 在 payload、spec 仍寫 BullMQ limiter），README:456-468 把這些 spec 當 feature 說明連出去 | `specs/008-.../spec.md:7`、`specs/003-.../data-model.md:22` |
| DOC-D13 | constitution Principle III「控制訊息 MAY 直接以 TS 型別定義」已過時：12 則 message 全 Zod 化且漂移覆蓋率測試**依賴**此事，照 MAY 退回手寫 TS 會讓測試紅 | `.specify/memory/constitution.md:111-115` |

---

## 4. Low（彙整，供後續追蹤）

| 面向 | ID | 一句話 | 位置 |
| --- | --- | --- | --- |
| api | API-5 | `WS_HEARTBEAT_MS`／`MOCK_TELEMETRY_INTERVAL_MS` 只 `positive()` 無合理下限（設 1 等同災難） | `lib/env-schema.ts:43-44` |
| api | API-7 | 回應帶 `X-Powered-By: Express`；畸形 JSON 的 400 訊息回顯輸入前 10 字元（README:664「不回顯原始輸入」只對 Zod 路徑成立）；body 上限沿用 Express 100 kb | `main.ts` |
| api | API-9 | 啟動韌性不對稱：Mongo 不可達 bootstrap 失敗 exit 1，Redis 不通仍可啟動；`HistoryService.ping()` 的「啟動中」分支實務上走不到 | `history.service.ts:130,152-155` |
| api | AR-S6 | `getJobCounts` 不含 `delayed`，LLM 被限流時面板顯示佇列 0 | `metrics.service.ts` |
| api | AR-S7 | 前端靜默忽略 `system/unauthorized`，使用者只看到沒有資料 | web `ws-message.ts` |
| api | API-10 | `publishTelemetry`／`broadcastMetrics` 對每個 client 各做一次 `JSON.stringify`；`MetricsService` 每週期 `SCAN` 整個 keyspace（可改 `ZADD metrics:workers` + `ZRANGEBYSCORE`，順帶解 API-8） | `monitoring.gateway.ts`、`metrics.service.ts` |
| worker | WK-7 | `latestState` 查詢無時間界，time-series 的 `metadata.machineId` 子欄位用不到自動索引 → COLLSCAN 全部 bucket（**實測** 6M 點 6,000 bucket）；四個查詢串行 `await` | `context-builder.ts:51,81-86,89,102` |
| worker | WK-8 | 簽章缺 `windowMinutes`（目前寫死 5，潛在）；`topErrorCodes` 實際存的是 errorlog **state**（值域 warning／critical），同機台溫度 70→95 在 TTL 內仍命中同一份快取、`evidence` 引舊值；命名誤導 | `signature.ts:63-79`、`context-builder.ts:100` |
| worker | WK-9 | `PROMPT_VERSION` 手動升版，但 prompt 內嵌 `JSON.stringify(DIAGNOSIS_RESULT_JSON_SCHEMA)`，契約加 optional 欄位時 prompt 變、版本不變，舊快取服務到 TTL | `prompt.ts:133,173` |
| worker | WK-10 | `usage.outputTokens` 不含 `thoughtsTokenCount`（thinking 模型少算）；`recordLatency` 在 safety／max_tokens／parse 失敗判斷**之前**就記，與註解「只記成功」不符 | `gemini-provider.ts:72-77`、`processor.ts:233-235,261` |
| worker | WK-11 | prompt 直接插入 `e.message`、`m.summary` 無長度上限與資料邊界；`maintenanceRecords` 是未來最可能接外部輸入處 | `prompt.ts:149-157`、`context-builder.ts:95-117` |
| worker | TQ-L16 | `mapFinishReason` 把 `RECITATION` 等歸 `other` 照常 parse，失敗才以可重試 `schema_invalid` 重打兩次；switch 缺 exhaustive 檢查 | `gemini-provider.ts:105-119` |
| web | WEB-5／CT-7 | `@__PURE__` 只標 `events.ts`，bundle 仍留 `CreateDiagnosisBodySchema` 死碼；`events.ts:88` 註解「web 執行期只用 `SystemMetricsSchema`」不實（另用 `JobStatusSchema`／`AiStreamEventSchema`／`CreateDiagnosisResponseSchema`／`AiDoneSchema`）；註解內的 `@__PURE__` 字樣讓 build 多一則 Rollup 警告（升級分支帶入的小回歸）；體積影響 < 1 kB | `packages/contracts/src/*.ts` |
| web | WEB-6／CT-11 | 開發軌道不一致：api dev 跑 packages dist、worker dev 跑 src，改契約時兩個 process 錯開；`vite build`（NODE_ENV=production 不匹配 `development` condition）讀 dist，單獨 build web 會打包過期契約或直接失敗（**實測**） | `apps/api/package.json:8`、`vite.config.ts` |
| web | WEB-7 | dev 指標面板整塊 `role="status"`，展開時螢幕閱讀器每秒播報「Ns ago」 | `MetricsPanel.vue` |
| web | WEB-8 | Fleet Health 每一幀重算重繪，註解寫「每秒」 | |
| web | WEB-9 | 拖曳拉桿 `localStorage` 無 try/catch，瀏覽器封鎖站台資料時整個 App 白屏；不能鍵盤操作 | `useResizeDrag.ts` |
| web | WEB-12 | 預設節拍下背壓比值約等於機台數，rAF 合併貢獻約 1 倍，README 仍用「削峰」描述（前輪 §3.3 補強） | README |
| web | AR-A7／AR-模組 | 機台名冊實際有**五份**（web 內三份），前輪記三份；web `shared/` 反向匯入 `domains/` 有四處（`useDiagnoseTrigger`、`TopBar.vue`、`MetricsPanel.vue`、`AppLayout.vue`），前輪只列一處 | |
| contracts | CT-5 | 漂移測試 `normalize` 漏洞：date-time 兩種變體無法區分（Zod 端退回 Z-only 抓不到）；`multipleOf`／`uniqueItems`／`propertyNames`／`additionalItems` 等鍵不比對（建議白名單反轉成黑名單）；enum 被 `.map(String)`；`anyOf` 與 `oneOf` 並存只比第一個；不驗 channel 方向 | `asyncapi-drift.test.ts:36-57,76-79,118,129` |
| contracts | CT-9 | 註解宣稱「依 RFC 3339」但 `z.iso.datetime({offset:true})` 拒收小寫 `t`/`z` 與閏秒（**實測**）；生產端一律 `toISOString()` 無實害 | `datetime.test.ts:6-8`、`events.ts:35` |
| contracts | CT-10 | web lint 禁令的 `ImportExpression` 選擇器只涵蓋 `pino|socket.io`，動態 `import("@flow-gatekeeper/shared/logging")` 不會被擋；`pino-pretty` 未列 | `eslint.config.js:164` |
| contracts | CT-12 補充 | `SystemConnected.clientId` 是 `z.string()` 而 `CreateDiagnosisBody.socketId` 是 `z.uuid()`，Gateway 若改用非 UUID clientId，POST 回 400 而前端顯示「前端版本可能過舊」 | `events.ts:94`、`http.ts:22` |
| infra | INF-7 | `ignoredBuiltDependencies` 的 `@nestjs/core` 是 NestJS 10 遺留（11.2.6 已無 install script）；`lucide-vue-next@0.454.0` 已 deprecated（改 `@lucide/vue`）；`eslint@9.39.4` 已標「no longer supported」（9 線 EOL，前輪決定維持 9 的新證據）；`pnpm dedupe --check` 不通過（`@vue/compiler-dom`／`@vue/shared` 3.5.39 vs 3.5.43）；`postcss`／`nanoid` override 已是不起作用的下限；`ioredis` 兩份（5.11.1／bullmq 釘 5.10.1）無害 | `package.json:18,30-40` |
| infra | INF-8 | CI 無 `permissions:`、`timeout-minutes`、`concurrency`；actions 只釘 tag 未釘 SHA；`ci.yml:18` 註解「node:22-alpine」已過時（實為 `22.23.3@sha256`）；缺 `pnpm audit --prod --audit-level=high`、`docker compose config -q`、image smoke（恢復 CI 時一併補） | `.github/workflows/ci.yml` |
| infra | INF-10 | `scripts/dev-up.ps1:59,73` 同樣依賴 PATH 上的裸 `pnpm`（前輪 §1.4 只點名 root scripts） | |
| infra | INF-11 | base image digest 釘死但無更新機制（無 dependabot／renovate），security patch 不會進來 | `.github/` |
| infra | INF-12 | builder 為了 `@types/node` 選入 root，連帶裝 spectral／eslint 全套（只拖慢 link，不進 runtime） | `apps/*/Dockerfile:41-44` |
| infra | INF-13 | Node 版本來源分散：`.nvmrc` 22（浮動）、Dockerfile 22.23.3、`engines >=22.12`、`@types/node ~22`；本機實跑 Node 24.20 | |
| 品質 | TQ-L2 | 5 個套件 test script 都帶 `--passWithNoTests`：include 樣式改錯時 CI 以 0 測試綠燈 | `apps/*/package.json:12` |
| 品質 | TQ-L3／L4 | `tsconfig.build.json` 仍 exclude 不存在的 `*.check.ts`；4 份 `vitest.config.ts` 註解「tsc 會把測試編進 dist」已過時（build 皆已 exclude），dist exclude 現在只防舊產物（本機 `packages/shared/dist` 仍有 2 個舊 `.test.js`，build 不清 dist） | |
| 品質 | TQ-L5／L6 | 兩個 entry 註解宣稱「import 為 side-effect-free」但模組頂層就載入 `.env`；worker entry 用 cwd 相依 `import "dotenv/config"`，api 用明確路徑（前輪 §1.2 只點名 seed） | `apps/*/src/main.ts` |
| 品質 | TQ-L7 | 死碼：`health-probe.ts` 的 `isConnectedMessage` 無 production 使用者但有 4 支測試灌進測試數；`SHARED_PACKAGE` 佔位常數與「Feature 001 僅骨架」註解 | |
| 品質 | TQ-L8／L9 | `AiStreamRelayService` 在 `psubscribe` resolve 前就記「subscribed」；同類別混用 Nest `Logger` 字串插值與 pino 結構化；`(err as Error).message` 非 Error 值印 `undefined` | `ai-stream-relay.service.ts:27-54` |
| 品質 | TQ-L10／L11 | 「帶時限等待」有四份實作（`withDeadline`、`HealthService.probe`、`jobs.service.withTimeout`、processor `abortable`）；env helper 在 api／worker 逐字重複，`REDIS_COMMAND_TIMEOUT_MS` worker 可設而 api 寫死 5000；`AppConfigService` 對 `resolveMetricsInterval` 各呼叫兩次 | |
| 品質 | TQ-12 | api `isIndexConflict` 只認 85／86，worker 同名函式另認 11000；`mongoErrorCode` duck-type vs `mongoCode` 要求 `instanceof`；集中到共用套件時直接合併會悄悄改變一端行為 | `mongo-ttl.ts:16-24`、`diagnosis-repository.ts:19-39` |
| 品質 | TQ-L13～L15 | FR 編號撞號（同檔 `FR-004` 指兩件事）；帶時間語境的註解；strict lint 命中 8 處（`telemetry-coalesce.ts:48,58` 兩處 `!`、`chaos.ts:51` 的 `as` 掩蓋 undefined、`useModalSheet.ts` 的 `never` 逃逸等） | |
| 品質 | TQ-L17／L18 | api 測試未靜音 Nest Logger，CI log 夾雜彩色輸出；`diagnose-api` 回應 jobId 不一致分支沒測 | |
| 文件 | DOC-9～D15 | README:163「截圖為 006 時的畫面」實為 009 修復前；`.env.example` 仍寫「背壓比值 ≥10:1」而 README／ADR-001 已改不宣稱固定比值；`package.json` 版本皆 `0.1.0` 與 tag v1.0.0 無單一來源；demo 影片同時在 git（1.6 MB）與 Release 兩份 | |

---

## 5. 架構層結論

### 5.1 狀態所在地與隱性耦合

- **狀態分佈**：api 行程內有 10 處單實例假設的狀態（訂閱表、`jobRooms`、`delayedUntil`、`enqueuing`、`lastState`、telemetry buffer、errorlog 佇列、心跳表、metrics 快照合併、授權狀態缺席）；worker 行程內有 liveness 與 chaos；Redis 有 BullMQ 佇列、`ai-stream:*`、`ai-cache:*`／`ai-lock:*`、`ai-rpm:*`、`worker:heartbeat:*`／`metrics:worker:*`；Mongo 有 `telemetry`／`errorlogs`／`diagnoses`／`diagnosisTriggers`／`maintenanceRecords`。建議把這份清單補進 ADR-002 §6.1。
- **隱性耦合（前輪 §2.1 之外的新發現）**：逾時常數三端各一份（AR-A1）；`METRICS_INTERVAL_MS` 兩份 env 必須相同（AR-A2）；機台名冊五份（AR-A7）；錯誤碼無列舉、前端靠訊息關鍵字（AR-A9）；`jobRooms` 路由表由 `AiStreamRelayService` 持有卻由三個類別協作（owner 放錯）；`websocket` 與 `telemetry` 目錄沒有對應 NestJS module，provider 平攤在 AppModule；`main.ts` 靠 `app.get()` 手動接線繞過 DI。NestJS 層無循環依賴。

### 5.2 FMEA 重點（僅列有實害或未處理者）

| 情境 | 三端反應 | 狀態 |
| --- | --- | --- |
| 持鎖 worker 被 SIGKILL | 鎖等 TTL 45 s 過期；等待者無事件；前端 45 s 判逾時；worker 隨後完成送 `ai/done` 無人接收 | 未處理（§2.3） |
| LLM 成功後 Redis 瞬斷 | attempt 重來、重打 LLM、`diagnoses`=A／cache=B | 未處理（WK-4） |
| `ai/done` Pub/Sub 遺失（api 重啟瞬間） | 前端卡到 45 s 判逾時，`job/status completed` 不帶 result 無法收尾 | 未處理（AR-1） |
| 前端重連換 clientId | 綁定失效，只能 Retry；斷線期間仍可送出新診斷、結果送往舊 socket | 部分（前輪已記 012）；WEB-3／API-4 新增 |
| Mongo 斷線 | api bootstrap 失敗 exit 1（Redis 則可啟動）；worker 診斷因寫 `diagnoses` 失敗→重試→最終 `worker_failed`，前端顯示「AI 診斷逾時」 | 語意錯誤（AR-A9）；Mongo 是診斷硬相依需明確化 |
| Redis `noeviction` 滿 | 寫入失敗；`PUBLISH` 仍可執行（推理）；api 每筆 `POST` 都 503；亂數 machineId 攻擊可主動撞到此狀態 | 部分（API-3） |
| Gemini 429 | 目前消耗 attempts；建議改走 `moveToDelayed` | 可改善 |
| 慢讀者 WS client | `bufferedAmount` 無上限、心跳可被騙 | 未處理（API-2） |

### 5.3 模組邊界建議

- **Gateway 拆分**：`WsConnectionRegistry`（連線／授權／心跳／背壓）、`SubscriptionService`、`TelemetryPipeline`（配 `TelemetrySource` 介面，mock producer 成為第一個實作）、`JobRoutingRegistry`（`jobRooms` 的正確 owner，並負責 socketId 在線驗證）。純搬移約 0.5–1 人日，不改 wire format。
- **`packages/shared`**：門檻與 `deriveMachineState` 移進 contracts，shared 只留 logging（前輪 §1.6 未拆包的具體方案）。
- **web**：新增 `src/app/` 殼層放 `App.vue`／`AppLayout`／`TopBar`／`MetricsPanel`／`useDiagnoseTrigger` 這些跨 domain 組裝件，並加 eslint 規則禁止 `shared/` 匯入 `domains/`。

### 5.4 Roadmap 修訂：010-lite → 012-lite → 011

| # | 範圍 | 為何調整 |
| --- | --- | --- |
| **010-lite** 資料層單一來源 | contracts 加 `infra.ts` 集中 Redis key／channel／collection 常數與文件型別；`DiagnosisJobPayload` Zod 化；`system/connected` 下發名冊、`protocolVersion`、watchdog 門檻；`WorkerMetrics` 加 `windowMs`；抽 `JobRoutingRegistry` 並驗證 socketId；`AiErrorCode` enum | 前輪 010 的「`TelemetryPoint` 改 Zod」已在升級分支完成，其餘皆為本輪 P2 的共同根因 |
| **012-lite** 串流韌性 | processor 回傳結果 → BullMQ `returnvalue`（已保存 1 小時）→ `job/status.result`；`GET /diagnoses/:jobId`（第一來源 `returnvalue`，其次 Mongo；**cache 命中的 job 不寫 `diagnoses`，只讀 Mongo 會 404**）；重連以 jobId rebind；relay 監聽 `stalled`；等待者 keepalive | 比 Redis Streams 涵蓋面大（同時解 api 重啟、前端重連、`ai/done` 遺失、watchdog 誤判），成本低（只加一條 HTTP route）；Streams 只補得到重連期間的 token 缺口卻要處理 `XADD`／`MAXLEN`／`XREAD`／last-id |
| **011** 效能證據自動化 | 維持前輪範圍；補 WEB-12 的背壓指標重定義（badge 同時顯示每次 flush 的訊息數與每則訊息的點數） | 需先有 010-lite 的名冊下發與 012-lite 的完成語意，量測結果才穩定 |

ADR-002 §9 四條推翻條件均未逼近。

### 5.5 技術棧選型（升級後再檢視）

| 分類 | 項目 | 一句理由 |
| --- | --- | --- |
| 維持 | NestJS 11 + 原生 ws、BullMQ 5、Redis Pub/Sub（token）、Mongo time-series、Pinia 3、`@google/genai`、Zod 4 classic（後端） | 皆為各自 major 最新線；BullMQ 的 `returnvalue`／`stalled` 尚未用起來，先用完既有能力再談替換 |
| 不要動 | ioredis 5、Tailwind 3、TypeScript 5 | bullmq 釘 ioredis 5.10；Tailwind 4 視覺回歸風險高收益低；TS 7 等 vue-tsc／typescript-eslint |
| 下一個 feature 順手 | `zod/mini`（web）；統一 dotenv 載入方式；Gemini 429 改 `moveToDelayed`；Mongo 對診斷的硬相依明確化（降級或明確錯誤碼）；`lucide-vue-next` → `@lucide/vue`；eslint 9 → 10（9 線 EOL） | `zod/mini` 實測 gzip 29.7 → 9.4 kB，可讓 web bundle 少約 27%，只需改 `packages/contracts` 約 250 行、消費端 `.safeParse` 幾乎不動，但須確認 Gemini 用的 JSON Schema 逐鍵相同（既有測試可驗）；屬跨 feature 決策需走 ADR |
| 契約產生方向 | asyncapi 改由 Zod 產生（`z.toJSONSchema(io:"input")` + `.meta({description})`） | 漂移測試退化成快照比對，CT-4／CT-5 這類語意與結構漂移從根本消失 |

---

## 6. 建議處理順序

### Batch A：小修一批（獨立 `fix:` 分支，約 1 天）

1. CT-1 logger `redact` + 測試 + Redis 錯誤日誌節流。
2. WEB-1 色票改名 + 選取態 class 順序 + Playwright 截圖回歸。
3. CT-2 `METRICS_INTERVAL_MS` 驗證；API-5 heartbeat／tick 下限。
4. INF-2 `WEB_BIND` 預設 `127.0.0.1` + nginx `limit_req`；INF-4／INF-5 restart policy 與 `service_healthy`。
5. API-3／WK-5 名冊驗證 + 空脈絡短路；WK-3 `maxOutputTokens`。
6. INF-3 `files: ["dist"]` + `.dockerignore` 前綴；INF-1 chaos 劇本或開關。
7. TQ-1／TQ-3 斷言補齊；TQ-L2 移除 `--passWithNoTests`；TQ-10 worker bootstrap 改 `fatal`。
8. 前輪 §7 第 2 步的小修（healthcheck／seed env、TTL 與 `persist` 指標、root script、§3.1 b／e、§3.3 a／b／c）合併進來。

### Batch B：Gateway 出口閘門與 HTTP 入口收斂（約 1–2 天，可與 A 同分支或獨立）

API-2 背壓 + pong nonce、API-4 授權集合、API-6 違規計數、前輪 §1.1 連線數上限、WEB-2／WEB-3「連線真的活著」狀態；補慢讀者與未授權整合測試、TQ-2 Gateway harness。

### Batch C：文件與 release 準備（Batch A 之後、release 之前）

1. DOC-2 asyncapi 升 1.2.0 + changelog（含 HTTP 契約與 `invalid_format`）；README／指南同步。
2. DOC-3 指南 §15.6 補升級分支摘要並改名「v1.0.0 之後的現況摘要」；`engines` 修正。
3. DOC-8 ADR-002 §6 新增「已知未做」表（連線數上限、`/livez`、`protocolVersion`、Mongo auth、`deploy --legacy` 疑慮、FR-021 免授權後果、api 行程內 10 處單實例狀態）。
4. DOC-5 指南 §9 加「已完成、勿再執行」；DOC-6 memory 引用改 repo 路徑；DOC-7 README 補 `WORKER_CHAOS*`；INF-6 Dockerfile 註解與 README 可重現描述對齊實況。
5. DOC-R1～R4 前輪報告數字更正或凍結為歷史快照並標基準 commit；DOC-S1 001–008 spec Status 加一行「已完成（v1.0.0）；之後變更見指南 §15.6」。
6. DOC-C1／C3／D13：CLAUDE.md 刪懸空引用、新增「維護分支（fix／upgrade／docs）」小節、統一 `/speckit-*` 寫法；治理層 MUST（跨 feature 回補、契約升版）收進 constitution 1.5.0 並修 Principle III 過時描述。
7. 新增 `CHANGELOG.md`；決定 v1.1.0 版號與 `package.json` 版本策略；README demo 連結決策（重錄或註明「影片為 v1.0.0 畫面」並修 DOC-9）。
8. 加兩個便宜的自動檢查：vitest 斷言 README／指南的 `info.version` 字串等於 `asyncapi.yaml`；斷言 README env 表涵蓋兩份 `env-schema.ts` 全部 key。

### Batch D：測試基礎建設（可穿插，約 3–4 天）

依投報比：TQ-4／TQ-5 processor 全欄位與注入時間 → TQ-6 relay 事件驅動 → `@vitest/coverage-v8` + root `test.projects` + 不退步門檻（lines 60%／branches 50%）→ 真 Redis 整合測試（Lua、並發去重、鎖換手；解前輪 §1.7 與 TQ-13）→ 真 Mongo 整合測試（collMod、85／86／11000、`writeOnce`）→ **跨 process e2e**（compose 起四服務、worker 以 env 換 fake `AiProvider`、`ws` client 訂閱→POST→斷言 `job/status` 序列與 `ai/token` seq／attempt→`ai/done`，另加 worker kill 後 stalled 重派）→ 變異測試常態化（Stryker 只跑五個核心檔，nightly，門檻 70%）→ web 元件測試（happy-dom + `@vue/test-utils`，只挑 `CopilotDrawer`／`MetricsPanel`／`MachineNodeCard`）。不建議再增加純函式單測數量。

### Roadmap：010-lite → 012-lite → 011（見 §5.4），依 SDD 流程另開 feature。

---

## 7. 不必做的事

前輪 §6 全部維持。本輪新增：

- 不要為 INF-6 引入 SBOM 簽章或 registry 推送；驗證方式限於「乾淨 cache build 一次比對」。
- 不要為 API-2 引入 Socket.IO 或訊息佇列；高水位 + `terminate()` 已足（遙測本來就宣告有損）。
- 不要為 AR-A9 引入 i18n；錯誤碼 enum + 固定文案即可。
- 不要現在做 Redis Streams（012 原案）；先用 BullMQ `returnvalue`。
- 不要為 WK-7 換時序資料庫；加時間界與 `Promise.all` 即可。
- 不要一次把 39 個變異全補測試；只補 §2.4 與 TQ-4～TQ-6 對應的接線層。
- 不要為了 dependabot 恢復 CI 的 push／PR 觸發；dependabot 只開 PR，CI 恢復另議。

---

## 8. 通過驗證、無問題的項目

- **升級無回歸**：Zod 4 的 `z.uuid()`（RFC 9562）、`z.iso.datetime({offset:true})`（含秒、驗日期合法性、±hh:mm）、`z.number()` 拒 `Infinity`／`NaN`、`.nullable()`／`discriminatedUnion` 轉 JSON Schema、`.int()` 安全整數邊界皆實測與 asyncapi 一致；NestJS 11 `abortOnError:false` 走 fatal JSON、刻意不用 `enableShutdownHooks()` 由自訂 handler 防重入理由正確；Express 5 路由變更不影響兩個端點。
- **去重與快取**：簽章含 machineId／state／排序後 codes／`PROMPT_VERSION`／providerId／model；鎖值 uuid + Lua compare-and-del；INCR 與首次 EXPIRE 原子；`finally` 必釋放鎖；cache 寫入一定是 `parseResult` 驗證過的物件，讀回 `safeParse` 不合法即刪。
- **AI 串流**：SDK 無預設 retryOptions（不與 BullMQ 形成兩層重試）；`chunk.text` 排除 `thought` part；`abortable` 掛了 rejection handler 無浮空 rejection；structured output 的 `literal`／`max`／`record`／`default` 在載入時 throw（fail-fast 如設計）。
- **Pub/Sub 與重試**：所有事件帶 `attempt`，換輪 seq 從 0；worker `ai/error.attempt` 與 api `worker_failed` 的 `attemptsMade` 編號一致；relay `safeParse` 並比對 channel 與 payload jobId。
- **Mongo**：`diagnoses.jobId` unique 與退回／恢復；trigger TTL；窗口 aggregate 走索引（**實測** IXSCAN 91 docs）；所有查詢有 `maxTimeMS`。
- **祕密衛生（除 CT-1 外）**：日誌不記 prompt、金鑰、模型輸出全文；Gemini 金鑰經 header；env 錯誤訊息不回顯原值；Gateway 忽略訊息只記 issue 路徑；`docker history` 無帶祕密的 ARG／ENV；`.dockerignore` 的 `**/.env*` 有效；redis 探針用 `REDISCLI_AUTH` 不進行程參數。
- **nginx**：`server_tokens off`、gzip + `gzip_vary`、`/assets/` immutable 不加 `always`、`index.html` no-cache、四個安全 header 在三個 `add_header` 區塊皆重複列出（繼承規則正確）、CSP 與 vite 產物相符（無 inline）、`connect-src 'self'` 涵蓋同源 ws、變數 upstream + `resolver 127.0.0.11 valid=10s`、原樣轉發 Origin。
- **建置與相依**：`packageManager` 附 hash；`onlyBuiltDependencies` 只列真正需要的兩項；`pnpm audit` 0；BuildKit cache mount store 不進 layer；原生模組 `msgpackr-extract` 的 musl 版存在；CI 讀 `.nvmrc` + `--frozen-lockfile` + 最後 `pnpm build` 順序正確；`demo-reset.ps1` 的 `set -e`／`pipefail`／`${#VAR}` 寫法正確。
- **型別與 lint**：production 程式碼零逃逸；測試檔逃逸集中於 fake 組裝且 eslint 只在 `TEST_FILES` 放寬 5 條 `no-unsafe-*`；tsconfig `strict`／`noUncheckedIndexedAccess`／`noImplicitOverride`／`noImplicitReturns`／`noFallthroughCasesInSwitch`／`verbatimModuleSyntax` 全開；架構邊界 lint 規則齊全且無 inline 關閉。
- **強測試**：asyncapi 漂移測試自帶 mutation 自測；relay schema／jobId 比對、Gateway 輸入加固（含 raw TCP 未遮罩 frame、保留 opcode、`afterEach` 斷言無 `process.exit`）、processor 的 double-check／重試不送 `ai/error`／abort 閘門／限流邊界、`useHighFrequencyWs` 的 rAF 批次與溢位守恆、`copilot.store` 的「WS 事件早於 HTTP 回應」race：變異全殺。fake timers 皆有 `useRealTimers` 清理；無真實外部網路；flaky 風險低。
- **git 流程**：001–005、008、009、fix-review、upgrade 皆有 `--no-ff` merge commit；`main` 的 v1.0.0 release merge 與 annotated tag 格式合規，`main` 無需回併的直接修正。
- **文件一致的部分**：兩份 `env-schema.ts` 的每個變數與預設值皆與 README 表、`.env.example` 一致；`WS_ALLOWED_ORIGINS` 四處皆有；版本（pnpm 10.34.5、Node ≥22.12、NestJS 11、Vite 7、Zod 4、vitest 4）與 README／指南一致；asyncapi 12 則 message／3 schema／12 channel 與 README 一致；ADR-001／002 的「撰寫時 → 已落地」寫法符合不重寫歷史；design-spec canonical 位置三處指向一致。

---

## 附錄 A：審查方法與產物

- **分工**：8 個 Opus 5.5 agent 各自唯讀審查一個面向，要求「先驗證前輪已修復宣稱 → 找新問題 → 給優化方向」，每項 finding 附 `file:line`、標嚴重度與「新發現／前輪補強／回歸」；由 Fable 5.1 統籌者交叉比對（同一問題由多個 agent 獨立發現者提升信心，如 CT-1 三方實測、API-3／WK-5／INF-2／WEB-3 四方印證），對矛盾結論（INF-6）標記待查證，並抽查關鍵證據（Tailwind `inset` 色票、chaos 守衛、logger 無 redact、`files` 欄位、8080 綁定、asyncapi 版本）。
- **實測項目**：真實 NestJS 11 app HTTP 探測；真實 Gateway + ws client 慢讀者；假 Redis 回 `WRONGPASS` 重現密碼外洩（三次獨立）；拋棄式 Redis 7.4／Mongo 7.0.43 容器驗鎖與查詢計畫（1.5M／6M 點 explain）；`docker save` 解開 image 比對 lockfile；headless Chrome 讀卡片 computed style；Vite 打包 Zod classic vs mini 體積；漂移測試 `normalize` 變異探測；processor／gateway／relay／composable 共 39 個手工變異；`tsx` 印出 `DIAGNOSIS_RESULT_JSON_SCHEMA` 測 `toGeminiJsonSchema` 邊界。
- **未實測、屬推理**：BullMQ stalled 時序依官方預設值（worker 未覆寫）；Redis `noeviction` 下 `PUBLISH` 仍可執行依指令旗標推論；`pnpm deploy --legacy` 在乾淨 cache 下的解析行為（INF-6）。
- **產物位置**（未納入 repo）：統籌者 scratchpad `review02/` 下八份面向報告、檢查 log（`contract`／`typecheck`／`lint`／`test.log`）、strict lint 試跑 `eslint-strict.json`、變異測試 `mut/`（含 `mutate.mjs` 與 39 份 `m-*.json`）、HTTP／WS／Redis 探測腳本、`cards.html`、Zod 體積比較腳本、image 版本比對清單。
- **對環境的副作用**：repo 無任何檔案修改、無 git 寫入；重建了 gitignored 的 `packages/*/dist` 與 `apps/web/dist`；審查用拋棄式容器已刪除；本機 image 未重建。

## 附錄 B：與前輪報告的對照

| 前輪結論 | 本輪判定 |
| --- | --- |
| §8「祕密衛生：不回顯原值」 | **推翻**（CT-1）：只驗了 env 錯誤訊息路徑，執行期 error 物件路徑會外洩 |
| §8「AI 輸出渲染／design-spec 逐項一致」 | 成立，但 WEB-1 顯示「token 一致」不等於「畫面正確」 |
| §3.2 c「`deploy --legacy` 未來可能被移除」 | 補強為 INF-6：更近的風險是版本解析語意，待乾淨 cache 驗證 |
| §2.1「機台名冊三份」 | 更正為五份（AR-A7） |
| §3.3 c「`useDiagnoseTrigger` 反向依賴」 | 更正為四處（AR-模組） |
| §5.4 roadmap 010→011→012 | 修訂為 010-lite→012-lite→011，Streams 改 `returnvalue` |
| §2.2「測試基礎建設」只列缺測模組 | 補強：問題在斷言面（24/39 變異存活），非模組覆蓋 |
| 表頭「17 commit」「9 commit」「224.77 kB」 | 實為 16、17、224.32（DOC-R1～R3） |
