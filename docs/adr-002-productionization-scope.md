# ADR-002：生產化範圍邊界——監督者選型、整棧容器化路線與運維層取捨

| 項目 | 內容 |
| --- | --- |
| 狀態 | Accepted |
| 日期 | 2026-07-06 |
| 範圍 | 部署與執行模型（worker/api/web）、process 監督、可觀測性，以及「明確不補」的運維層差距 |
| 相關 | Feature 007/008/009（實作指南 §13–§15）、`apps/worker/src/main.ts` process handlers、`docker-compose.yml`、`scripts/dev-up.ps1`、ADR-001、2026-09-27 審查報告（`docs/20260927-research-review.md`）與其修復分支 `fix/20260927-research-review`、第二輪審查報告（`docs/20260927-research-review02.md`）與其修復分支 `fix/20260927-research-review02`；v1.0.0 之後的現況總覽見實作指南 §15.6「v1.0.0 之後的現況摘要」 |

---

## 1. 背景（Context）

flow-gatekeeper 是作品集 side project，核心賣點是三件事：前端 rAF gatekeeper 背壓、BullMQ 分散式削峰、AI 雙通道 streaming。Feature 001–006 完成後，對照「實務上真正上線的專案」做了一次全面盤點，結論是：

> **差距最大的不是「選了什麼技術」，而是「執行與運維層整個缺席」。**

功能層的選型（pnpm monorepo + Zod 契約單一來源、BullMQ limiter/attempts/backoff、`AiProvider` 介面隔離、cache signature 含 `promptVersion`/`model`）都站得住腳（撰寫時的評估；2026-09 審查修復已把 limiter 換成取鎖後的 Redis 固定窗、signature 另含 provider id，見 README），可以直接帶進生產。真正的落差集中在運維層（完整清單見 §3）。

直接導火線是 `fix/worker-stream-resilience` hotfix 留下的「另一半」：worker 的 `uncaughtException`/`unhandledRejection` 目前是「log + 續跑」，因為專案沒有任何 process 監督者——`api`/`worker`/`web` 都在 host 上各開一個 PowerShell 視窗用 `tsx watch` 跑，`docker-compose.yml` 只起 Redis + Mongo。**「翻轉為 `exit(1)`」與「建立監督者」是同一件事的兩半，只做一半是退步**，所以整包留給正式 feature。

本 ADR 要回答的問題是：**哪些差距值得補、哪些只需要承認並寫下升級路徑、哪些應該明確拒絕**——以及補的部分用什麼技術路線、怎麼分期。

---

## 2. 決策（Decision）

1. **監督者採容器化路線**：worker 以 Docker 容器執行，由 docker compose 的 restart policy 擔任監督者。**捨棄 pm2 與 systemd**（理由見 §4）。
2. **生產化分三個 feature 漸進**（理由見 §5）：
   - **Feature 007**：worker 容器化 + 監督 + process handler 翻轉為「let it crash」。
   - **Feature 008**：api/web 也容器化，`docker compose up` 一鍵起全棧 demo。
   - **Feature 009**：可觀測性基線（結構化日誌、healthz、關鍵指標）。
3. **四項差距「只文件化、不實作」**：Gateway 水平擴展、Redis Pub/Sub 的 at-most-once 語意、認證升級、有損寫入語意（升級路徑見 §6）。
4. **五類路線明確拒絕**：Kubernetes、Kafka/MQTT ingestion、專用時序資料庫、OIDC/完整 IAM、Redis HA（理由見 §7）。

---

## 3. 與生產的差距全景（誠實盤點）

> 「現況」欄為本 ADR 撰寫時（2026-07-06，006 完成後）的盤點；各列後段的「→ 已落地／已變更」標註為之後的現況（最近一次回補：2026-09-27 審查修復）。差距敘述本身保留，作為決策由來。

| # | 層面 | 現況 | 生產基線 | 本 ADR 的處置 |
| --- | --- | --- | --- | --- |
| 1 | 執行模型 | 撰寫時：`tsx watch` 開在 PowerShell 視窗，無 Dockerfile、無 restart 策略——**沒有可部署的形態**。→ **已落地（007／008）**：三端多階段 Dockerfile、compose `demo` profile、`restart: on-failure:5`、api `/healthz`／worker heartbeat／web 入口三種 healthcheck；開發模式仍保留 host 直跑（§4.4）。**2026-09 運維加固**：redis／mongo 補 healthcheck、api／worker／seed 改 `depends_on: service_healthy`；各服務 `deploy.resources.limits` 與 json-file log 輪替（10MB × 3）；base image tag＋digest 雙釘、BuildKit cache mount；web 改非 root 的 `nginx-unprivileged`（容器內 8080）並加安全 header。**2026-09 第二輪審查修復**：app 服務維持 `restart: on-failure:5`，redis／mongo 改 `restart: unless-stopped`（資料層不設重試上限）；web `depends_on: api: service_healthy`；web 入口改 `${WEB_BIND:-127.0.0.1}:8080:8080`（預設只綁本機）。現況見 README「執行模式」與「部署與監督拓撲」 | 三端容器映像 + 編排器帶 restart 與健康檢查 | **實作**：007（worker）、008（api/web） |
| 2 | 崩潰語意 | 撰寫時：worker `uncaughtException` log + 續跑（行程狀態未定義，Node 官方明言 not safe to resume）。→ **已落地（007，api 於 2026-09 修復補齊）**：worker 與 api 的 `uncaughtException`／`unhandledRejection` 皆以 `writeSync` 同步寫出致命訊息（worker 為純文字 stderr、api 為與 pino 同形的 JSON）後 `exit(1)`，交監督者重啟。現況見 README「let it crash + process 監督」 | let it crash：`exit(1)` + 監督者重啟乾淨行程 | **實作**：007 |
| 3 | 可觀測性 | 撰寫時：只有 console log；無結構化日誌、metrics、tracing、告警。→ **已落地基線（009）**：pino 結構化 JSON、`GET /healthz`、queue／WS／LLM latency／cache 命中率週期入 log 並廣播 `system/metrics`；tracing、告警、exporter 仍依 §7 不做。現況見 README「可觀測性基線」 | 結構化 JSON log + metrics + 告警是上線入場券 | **實作基線**：009（僅日誌 + healthz + 指標入 log） |
| 4 | Gateway 擴展 | 單實例有狀態：訂閱表與 jobId 路由在行程內 `Map`，`psubscribe ai-stream:*`。→ **Gateway 仍成立**；2026-09 審查另指出更早的斷點：`POST /diagnoses` 的 `socketId` 把 HTTP 請求綁在收到 WS 連線的那個實例（見 §6.1）。**worker 端的多實例限制已解除**：heartbeat／metrics key 改為 `worker:heartbeat:<instanceId>`／`metrics:worker:<instanceId>`，api 以 SCAN 合併 | 連線狀態外置或 sticky session + 跨實例路由 | **文件化**：§6.1 |
| 5 | Streaming 可靠性 | Redis Pub/Sub at-most-once，Gateway 重啟或前端重連期間 token 永久丟失。→ 仍成立；另更正：最終結果雖落庫，但目前**沒有讀取端點**（見 §6.2） | Redis Streams 可回放，或 token 落地 + offset 續傳 | **文件化**：§6.2 |
| 6 | 認證與安全 | 撰寫時：`WS_AUTH_SECRET` 靜態共享字串放在訊息 payload；`ws://` 明文；HTTP 端點無驗證與 rate limit。→ **部分已變更（2026-09 修復）**：基本加固已落地——WS 控制訊息 Zod `safeParse`、`maxPayload` 16 KiB、可選 Origin 白名單 `WS_ALLOWED_ORIGINS`、`POST /diagnoses` Zod 驗證＋只收 JSON＋jobId 冪等、api 讀 `REDIS_PASSWORD`、Redis／Mongo 只綁 127.0.0.1。**2026-09 第二輪審查修復再補**：WS 每連線授權狀態（`ai/*`／`job/status`／`system/metrics` 只送已授權連線）、`POST /diagnoses` 綁定前驗 `socketId` 在線且已授權（409）、WS 出口背壓、`MAX_WS_CONNECTIONS`、nginx 對 `/diagnoses` `limit_req`（10 r/m）與 `/ws` `limit_conn`、web 預設只綁 127.0.0.1。身分驗證、`wss://`、per-user 配額仍未做（§6.3、§6.5） | 升級握手驗 JWT/OIDC、`wss://`、per-user 授權與配額 | **文件化**：§6.3 |
| 7 | 資料寫入語意 | 撰寫時：telemetry 持久化 fire-and-forget；errorlog 去重靠行程內 `lastState` Map。→ **已變更（2026-09 修復）**：telemetry 改為有上限 buffer（5000 點）＋每秒批次＋單一 in-flight＋丟棄計數；errorlog 佇列區分可重試／終局失敗；`lastState` 仍在行程內（§6.4） | 明確宣告的丟失預算，或帶重試的寫入佇列 | **文件化 + 明文註解**：§6.4、009 |
| 8 | 資料層 HA | Redis/Mongo 各單節點。撰寫時寫「Redis 身兼 queue/cache/Pub/Sub/lock 四職」——**已更正**：實際職責為 BullMQ 佇列、Pub/Sub（`ai-stream:*`）、cache／dedupe lock（`ai-cache:*`／`ai-lock:*`）、worker heartbeat（`worker:heartbeat:<instanceId>`）、worker 指標快照（`metrics:worker:<instanceId>`）、LLM 限流窗（`ai-rpm:*`）。仍為單節點，但已補基本護欄：`maxmemory 256mb`＋`noeviction`（BullMQ 要求）、可選 `requirepass`（見 §7 補充） | 託管服務或 Sentinel/replica set，職責分實例 | **拒絕**：§7 |
| 9 | CI/CD | CI 刻意暫停（私有 repo 省 Actions 分鐘數），無 image 發布管線。→ 仍暫停（僅 `workflow_dispatch`）；workflow 已改讀 `.nvmrc`（Node 22）並補 `pnpm build` | CI 產 image → registry → 自動部署 | **不綁在 007–009**：CI 恢復另議 |

---

## 4. 監督者選型：為什麼是容器化，不是 pm2 或 systemd

Feature 007 原藍圖列了三條候選路線（容器化 / pm2 / systemd），本 ADR 定案為**容器化**。逐一交代：

### 4.1 systemd——淘汰

- dev 環境是 **Windows/PowerShell**，systemd 不存在；demo 受眾也未必有 Linux 主機。
- 採用它會讓監督設定變成平台特定資產：dev 上完全無法演練，驗收只能在另一台機器做，違反「本機一鍵可重現」的 demo 定位。

### 4.2 pm2——淘汰

- 只為了 restart 語意引入一整套新工具鏈（daemon、ecosystem config、自己的 log 管理），卻**不提供環境隔離與可攜性**——node 版本、環境變數、工作目錄仍依附 host。
- 專案已經有 docker-compose 在跑 Redis/Mongo，再加 pm2 等於維護**兩套執行模型**（infra 在容器、app 在 pm2），啟動文件與心智模型都變複雜。
- 履歷訊號較弱：「會用 pm2」與「能把 pnpm monorepo 做成多階段容器映像」的市場價值不對等。

### 4.3 容器化——勝出

- **與既有 stack 一致**：Redis/Mongo 已在 compose 裡，worker 加入後整個系統收斂成單一 `docker-compose.yml` 描述。
- **監督能力即取即用**：Docker 內建 restart 指數退避（100ms 起、每次翻倍、有上限），`restart: on-failure` 可帶最大重試次數——crash-loop 防護不用自己寫。
- **跨平台**：dev 在 Windows 用 Docker Desktop 即可演練與驗收，不需要另一台 Linux。
- **為 008 鋪路**：worker 的 Dockerfile 把 pnpm monorepo 多階段建置的坑趟完後，api/web 的容器化幾乎是複製貼上，一鍵 demo 水到渠成。
- **履歷訊號**：多階段建置、workspace 依賴裁剪（`pnpm deploy` / filtered install）是真實工程問題，demo 時可以直接講。

### 4.4 附帶決策：dev 迴圈不強制容器化

dev 期間 worker 保留 `tsx watch`（熱重載價值 > 監督價值，且人在場看 log 即可）；容器 + 監督用於 demo/prod-ish 情境。兩種模式如何用 compose profiles 或 scripts 切換，留給 Feature 007/008 的 `/speckit.clarify` 定細節。

> **已落地（007／008 clarify 定案）**：同一份 `docker-compose.yml` 以 profile 分組——不帶 profile 只起 Redis／Mongo（開發模式，app 由 `scripts/dev-up.ps1` 在 host 直跑：worker `tsx watch`、api `nest start --watch`、web `vite`），`demo` profile 起 seed／api／worker／web 全棧受監督容器；兩模式刻意不同時啟動（共用資料層）。現況見 README「執行模式：開發模式與一鍵 demo」與實作指南 §16。

---

## 5. 為什麼從「只 worker」擴成「整棧」，又為什麼拆成三個 feature

### 5.1 擴大範圍的理由

原 007 藍圖只容器化 worker，api/web 標註「如需，另案」。重新檢視後認定「另案」必須升格為明確排程（Feature 008），理由：

- **api（Gateway）崩潰的後果其實更嚴重**：所有 WebSocket 連線、訂閱表、jobId 路由同時蒸發。只監督 worker 是保護了錯誤後果較輕的那個行程。
- **「沒有部署形態」是整棧的問題**，不是 worker 的問題。三端都容器化之後，README 的第一印象從「開四個終端機」變成「`docker compose up` 一鍵起全棧」，對 demo 體驗與「我懂容器化」的訊號都是大回報。

### 5.2 但不合併成一個大 feature 的理由

- **007 是行為翻轉，008 是純打包**。007 把崩潰語意從「log + 續跑」翻成「exit(1) + 重啟」，有風險、要驗證 BullMQ stalled 重派與 graceful shutdown 交互；008 不改任何行為，只改執行形態。混在一起會讓驗收混濁——打包問題與語意問題互相遮蔽。
- **技術風險前置**：pnpm monorepo 的容器化坑（lockfile、workspace 依賴、多階段裁剪）由 007 先趟，008 收割。
- **符合專案一貫的 SDD 節奏**：每個 feature 範圍小、驗收獨立、一條 branch 走完 specify → implement → merge。

### 5.3 009（可觀測性基線）獨立成案的理由

- 觀測是**橫切三端**的關注點，不從屬於任何單端的容器化。
- 與 007 有自然銜接：007 只做 worker 的存活探針（監督者需要），009 把結構化日誌（pino）、api `/healthz`、關鍵指標（queue 深度、WS 連線數、LLM latency、cache 命中率）補成基線。
- demo 敘事上有一個好講的點：**這個專案本身是監控台，但它自己目前不可被監控**——009 就是把這句話收掉。
- 範圍刻意壓在「基線」：只做結構化日誌 + healthz + 指標入 log，不做 Prometheus/Grafana/OTel（見 §7）。

---

## 6. 只文件化、不實作的差距（含升級路徑)

以下四項（§6.1–§6.4）是真實的生產差距，但**補齊它們不會讓三個核心賣點更亮**，且各自都有明確的升級路徑可以在面試中講清楚。對作品集而言，「能說出哪裡是簡化、生產要怎麼改」的價值不低於真的做出來。§6.5 另列 2026-09 兩輪審查盤點出的較小延後項（含已落地者的指向），依 CLAUDE.md「跨 Feature 決策 MUST 回補真實來源」記錄於此。

### 6.1 Gateway 單實例與水平擴展

- **現況**：訂閱表（`clientId -> Set<machineId>`）與 `jobId -> clientId` 路由都在 Gateway 行程內的 `Map`；AI relay 用 `psubscribe ai-stream:*`。開第二個 API 實例就壞：兩台 Gateway 各自收到所有 token，會重複轉發或找不到 client；API 重啟則所有訂閱歸零。**補充（2026-09 審查）**：第一個斷點其實更早——`POST /diagnoses` 帶 `socketId`，把 HTTP 請求綁在收到該 WS 連線的實例上，LB 把 HTTP 與 WS 分到不同實例時綁定查不到對象；errorlog 的 `lastState` 也在行程內。
- **api 行程內單實例狀態清單（2026-09 第二輪審查 §5.1 盤點）**：水平擴展前必須逐項外置或改為可重建的狀態——
  1. 訂閱表與每連線狀態（`MonitoringGateway` 的 `clients` Map：clientId → socket、訂閱集合）；
  2. **授權狀態**（同上 `ClientState`：`authorized`、授權期限起算的 `connectedAt`、違規計數、背壓超標 tick、close 等待）；
  3. **心跳表**（同上：協定層 ping nonce 與存活旗標）；
  4. `jobRooms`（`AiStreamRelayService`：jobId → 接收者綁定）；
  5. `delayedUntil`（`JobStatusRelayService`：`delayed` 狀態的到期時間）；
  6. `enqueuing`（`JobsService`：同 jobId 並發入列的 in-flight 去重）；
  7. `lastState`（`HistoryService`：errorlog 轉態判斷）；
  8. telemetry buffer（`HistoryService` 的 `BoundedBuffer`：上限 5000 點待寫批次）；
  9. errorlog 佇列（`HistoryService`：上限 1000 筆待寫）；
  10. metrics 快照合併（`MetricsService`：api 端視窗統計＋SCAN 讀回的 worker 快照合併結果）。
  其餘狀態的分佈：worker 行程內只有 liveness（處理槽進度）與 chaos 武裝狀態；**Redis** 持有 BullMQ 佇列、`ai-stream:*` Pub/Sub、`ai-cache:*`／`ai-lock:*`、`ai-rpm:*`、`worker:heartbeat:*`／`metrics:worker:*`；**Mongo** 持有 `telemetry`／`errorlogs`／`diagnoses`／`diagnosisTriggers`／`maintenanceRecords`。
- **為何不做**：demo 負載單實例綽綽有餘；ADR-001 本來就把「需要多實例」列為推翻條件之一；動這裡等於重寫 Gateway 核心，卻不新增任何可展示的能力。
- **worker 端已解除（2026-09）**：原本 `worker:heartbeat`／`metrics:worker` 是單一 key，多副本時任一副本活著就替已死的副本續命、指標互相覆寫。現改為每實例一把（`instanceId` = `WORKER_INSTANCE_ID` ?? `os.hostname()`，容器內即 container id；限 `[A-Za-z0-9._-]` ≤ 128；demo 容器內 `WORKER_INSTANCE_ID` 由 compose `environment` 釘為空字串，一律使用 hostname（container id），`apps/worker/.env` 裡的值只對 host 直跑生效。）：healthcheck 只看自己的 key；api 每個結算週期以 `SCAN MATCH metrics:worker:* COUNT 100` 分頁＋`MGET` 讀取、逐筆 `WorkerMetricsSchema` 驗證、排除 `collectedAt - snapshotAt > 2.5 × windowMs`（容忍 worker 漏寫一次） 的舊快照後合併（`count`／`hits`／`misses` 加總、`avgMs` 以 count 加權、`p95Ms` 取最大作近似上界、`maxMs` 取最大、`hitRate` 重算、`snapshotAt` 取最新；零筆 → `worker: null`），`WorkerMetrics` 契約形狀不變；worker 優雅關閉時 `DEL` 自身兩把 key，崩潰則靠 TTL＋讀取端過濾。**Gateway 單實例的限制不變。**
- **生產路徑**：訂閱表外置 Redis；用精準 channel subscribe（`subscribe ai-stream:<jobId>`，只訂自己路由的 job）取代 `psubscribe *`；LB 開 sticky session，或把連線層抽成獨立 tier。屆時也應重新評估 Socket.IO + Redis adapter（見 ADR-001 §6）。

### 6.2 Redis Pub/Sub 的 at-most-once 語意

- **現況**：AI token 走 `ai-stream:<jobId>` 是 fire-and-forget。Gateway 若在串流中重啟、或前端斷線重連，中間的 token 永久丟失。
- **為何可接受**：最終診斷結果會落 MongoDB `diagnoses` 並進 Redis cache，丟失的只是「打字機動畫的過場」，不是資料；重連後可拿完整結果（此句已更正，見下一條）。
- **更正（2026-09 審查）**：上一條「重連後可拿完整結果」撰寫時即無程式支撐——HTTP 只有 `POST /diagnoses` 與 `GET /healthz`，**目前沒有任何結果讀取端點**；重連後拿到新 `clientId`、綁定失效，前端只能顯示「中斷 + Retry」（Retry 若簽章相同且快取未過期會秒回 Cached，這是目前唯一的取回路徑）。資料確實落庫，但使用者取不回。補上 `GET /diagnoses/:jobId` 與重連 rebind 列為 roadmap 012（串流韌性）。**roadmap 已修訂（2026-09 第二輪審查）**：順序改為 010-lite → 012-lite → 011（見 `docs/20260927-research-review02.md` §5.4）；012-lite 範圍為 processor 回傳結果存 BullMQ `returnvalue`→`job/status.result`、`GET /diagnoses/:jobId`（第一來源 `returnvalue`、其次 Mongo；cache 命中的 job 不寫 `diagnoses`）、重連以 jobId rebind、relay 監聽 `stalled`、等待者 keepalive（見 §6.5）。
- **生產路徑**：改用 Redis Streams（`XADD`/`XREAD` + consumer group），client 帶 last-id 續傳即可回放斷線期間的 token；或 token 落地 + offset 續傳。
  > **已變更（2026-09 第二輪審查）**：優先路徑改為先用完 BullMQ 既有能力——結果存 `returnvalue`（已保存 1 小時）＋`GET /diagnoses/:jobId`＋`stalled` 監聽（roadmap 012-lite），可同時涵蓋 api 重啟、前端重連、`ai/done` 遺失與 watchdog 誤判；Redis Streams 降為**備選**（只補得到重連期間的 token 缺口，卻要處理 `XADD`／`MAXLEN`／`XREAD`／last-id）。上一段保留為原決策敘述。

### 6.3 認證：`WS_AUTH_SECRET` 是佔位符

- **現況**：一個靜態共享字串，放在 `machine/subscribe` 訊息 payload 裡比對。沒有使用者身分、沒有到期、`ws://` 明文、`POST /diagnoses` 無身分驗證與 rate limit。（撰寫時敘述；rate limit 已由 nginx `limit_req` 部分補上、WS 授權狀態與連線上限已落地，見下兩條。身分驗證與 `wss://` 仍未做。）
- **已落地的基本加固（2026-09 修復，成本近零、不與 OIDC 綁在一起延後）**：客戶端控制訊息以 `ClientControlMessageSchema` `safeParse`（token ≤ 512、`machineIds` ≤ 50 且每個 ≤ 64）、`maxPayload` 16 KiB、每條連線掛 `error` listener、`machineIds` 與名冊取交集、可選 Origin 白名單 `WS_ALLOWED_ORIGINS`（防 Cross-Site WebSocket Hijacking）；`POST /diagnoses` 以 Zod 驗證、只收 `application/json`（跨站請求必過 preflight）、jobId 冪等且不改綁；api 讀 `REDIS_PASSWORD`；compose 的 Redis／Mongo 只綁 127.0.0.1。
- **已知限制：FR-021 免授權 REST 入口會讓 WS 授權形同虛設**：任何連線一建立就收到 `system/connected{clientId}`，而 `POST /diagnoses` 本身不驗身分；若照單全收 body 的 `socketId`，未通過 token 檢查的連線（或已斷線的 clientId）照樣能發起診斷並收到 AI 串流，`WS_AUTH_SECRET` 等於只擋住遙測。收斂方式（2026-09 第二輪審查 Batch B，**已落地**，merge `898ccfc`）：Gateway 維護每連線的「已授權」狀態（未設密鑰時連上即授權，有設時須通過 `machine/subscribe` token 檢查），`ai/*`／`job/status`／`system/metrics` 只送已授權連線；`POST /diagnoses` 在**綁定前**驗 `socketId` 在線且已授權，否則回 409。這仍不是身分驗證——HTTP 端點本身依然免授權，只是不能再借用未授權的 WS 連線收結果；真正的解法見下方「生產路徑」。同批另補 WS 出口背壓（`WS_SEND_HIGH_WATER_BYTES`）、心跳 ping nonce、每連線違規上限（1008）、token 常數時間比較與全域連線數上限（`MAX_WS_CONNECTIONS`，預設 500，達上限 upgrade 回 HTTP 503；有 `WS_AUTH_SECRET` 時未授權連線另有子上限 `max(10, floor(20% × MAX_WS_CONNECTIONS))`）。接受的代價：(1) 全域上限讓連線名額本身可被耗盡——連上但不訂閱、會自動回 pong 的 client 心跳回收不了；以授權期限（有密鑰時 `WS_AUTH_GRACE_MS` 內未通過 token 即 1008）與 nginx `/ws` 每 IP `limit_conn` 緩解，未設密鑰的 demo 只剩 nginx 那道（且 Docker Desktop 下全體同一個桶）。(2) 授權失敗、畸形訊息等 warn 改為 30 秒抽樣（全域 key、附被壓掉的則數），比 FR-017 的逐則記錄弱，換取日誌不被暴力猜 token 放大。
- **為何不做**：專案沒有多使用者需求，demo 情境反而常要把它清空；引入 OIDC/JWT 生命週期管理會吃掉大量開發時間卻展示不了核心賣點。
- **生產路徑**：驗證移到 HTTP upgrade 握手階段（帶短效 JWT，通過才建連線；**不要放 query string**——會進 nginx access log，改用 `Sec-WebSocket-Protocol` 或 cookie）；全面 `wss://`；job 建立端點加身分驗證與配額。

### 6.4 有損寫入語意

- **撰寫時的現況**：telemetry 持久化是 fire-and-forget（`void persistBatch(...)`，刻意不 await 以免卡住推送 cadence）；API 崩潰時 in-flight batch 直接丟。errorlog 去重靠行程內 `lastState` Map，重啟後會重寫一筆、多實例下判斷會錯。
- **現況（已變更，2026-09 審查修復）**：fire-and-forget 暴露的是「故障時無上限」——Mongo 卡住時每 50ms 疊一個帶資料的 `insertMany` promise。現改為**有上限 buffer＋單一 in-flight＋丟棄計數**：Gateway 每 tick 同步 `enqueue()` 進記憶體 buffer（上限 5000 點，滿即丟最舊、計入 `droppedPoints`），`HistoryService` 每秒 flush 一次、同時只允許一個寫入；寫入失敗的那批 telemetry 不重試（計入 `failedPoints`），錯誤 log 30 秒節流並附累計數。errorlog 進獨立佇列（上限 1000）：網路／選址類失敗放回重試、server 明確拒絕的毒批次丟棄並計數。正常關閉走 stopProducer → flush（上限 5 秒）→ `app.close()`，所以有損只剩「崩潰（至多約 1 秒＋進行中一批）」與「關閉 flush 逾時」兩種情形。`lastState` 仍在行程內，重啟邊界可能重複一筆 errorlog 的宣告不變。
- **決策**：**明文接受**「可丟失最後數秒 telemetry、errorlog 在重啟邊界可能重複」。有損是可以的，未宣告的有損才是問題。
- **落地（✅ 已完成，Feature 009；2026-09 更新）**：語意已明文於三處且指向同一份事實——009 當時為 `persistBatch` 與 `detectErrorTransitions` 的程式註解，現為 `HistoryService`（`apps/api/src/modules/history/history.service.ts`）類別註解；README 的「已宣告的取捨」小節同步更新，兩者皆引用本節。若未來轉為不可丟失，路徑是寫入前先進佇列（BullMQ 或 Redis Stream）再批次落庫；該路徑仍**不在範圍內**（2026-09 審查亦認為對每秒一批的量級過重，現行有上限 buffer 已足）。

### 6.5 已知未做與延後項（2026-09-27 盤點）

兩輪審查（`docs/20260927-research-review.md` §7 第 3 步、`docs/20260927-research-review02.md` DOC-8）指出下列延後決策在 ADR／README／指南查無紀錄；依 CLAUDE.md，未寫進真實來源的延後決策視為「未落地」，故集中於此。已落地者保留一列並指向現況，避免重複敘述。

| 項目 | 現況 | 為何延後 | 升級路徑 | 追蹤位置 |
| --- | --- | --- | --- | --- |
| WS 連線數上限 | **已落地**（2026-09 第二輪 Batch B）：`MAX_WS_CONNECTIONS`（預設 500，1–100000），達上限 upgrade 回 HTTP 503；有 `WS_AUTH_SECRET` 時未授權連線子上限 `max(10, floor(20% × MAX_WS_CONNECTIONS))`；nginx `/ws` 每來源 `limit_conn` 20。細節與接受的代價見 §6.3 | —（原為第一輪審查 §1.1 的未記錄延後項） | 多實例時改為 LB 層配額或外置計數（隨 §6.1） | §6.3；README 環境變數表 |
| `/livez`／`/readyz` 拆分 | 只有 `GET /healthz`：聚合 Redis／Mongo 連通性，任一依賴失敗即 503；compose 的 api healthcheck 與 web `depends_on: service_healthy` 皆用它 | compose 不因 unhealthy 重啟容器，依賴故障時 503 只影響啟動順序與觀測，目前無害；拆分不讓核心賣點更亮 | 改走 k8s 或任何「unhealthy 即重啟」的編排器前 MUST 拆：`/livez` 只看行程存活（事件迴圈可回應），`/readyz` 才看依賴，避免依賴故障連鎖重啟 api | 第一輪報告 §1.5；本表 |
| `protocolVersion` | `system/connected` 只帶 `clientId`；前後端協定版本不協商，靠同一 repo 同步部署保證一致 | 單一 repo、單一部署單位，目前不會出現新舊版混跑 | `system/connected` 下發 `protocolVersion`（連同機台名冊、watchdog 門檻），前端不相容時提示重新整理 | roadmap **010-lite**（第二輪報告 §5.4） |
| Mongo 認證 | compose 的 mongo 無認證，只綁 `127.0.0.1:27017`；Redis 則已有可選 `requirepass` | 單機 demo，資料只有 mock 遙測與診斷結果；加認證需改三端連線字串與 seed 流程，收益低 | compose 以 `MONGO_INITDB_ROOT_USERNAME`／`PASSWORD` 起、`MONGO_URL` 帶帳密並建最小權限 app user；生產改託管服務（§7） | §7 補充；README「Redis／Mongo 只綁 `127.0.0.1`」 |
| `pnpm deploy --legacy` 是否依 lockfile 解析（INF-6） | **已驗證無漂移（2026-09-27 乾淨 cache 實測）**：以全新 cache mount＋`--no-cache` 建置 api image，`.pnpm` 內全部 production 套件版本與 `pnpm-lock.yaml` 逐一相同（計數方法與數字見 README「技術棧」部署列），範圍內較新的 `ws` 8.22.0／`bullmq` 5.81.5 未被選入；legacy deploy 仍會跑一次解析、需要 registry metadata（`--offline` 會 `ERR_PNPM_NO_OFFLINE_META`），故保留 `--prefer-offline`。屬單次觀察，升 pnpm 大版時需重驗（只實測 api image，worker 沿用同一 Dockerfile 模式） | pnpm 10 對非 injected workspace 的 `deploy` 須加 `--legacy`；改走非 legacy 需調整 workspace 設定並重驗三個 image | 若確認分岔，擇一：builder stage 設 `inject-workspace-packages=true` 走非 legacy deploy；或 deploy 後以 `pnpm list --prod --json` 比對 lockfile、不符即中止；或 runtime 直接相依改精確版號 | 第二輪報告 INF-6、§7；`apps/api/Dockerfile`、`apps/worker/Dockerfile` 註解 |
| FR-021 免授權 REST 入口的殘餘後果 | Batch B 後 `POST /diagnoses` 不能再借用未授權或已斷線的 WS 連線收結果，但 **HTTP 端點本身仍免身分驗證**，只靠 nginx `limit_req`（10 r/m）與名冊驗證擋濫用 | 無多使用者需求；身分驗證與 OIDC 一起延後（§6.3「為何不做」） | 見 §6.3「生產路徑」：握手驗短效 JWT、`wss://`、job 建立端點加身分驗證與配額 | §6.3 |
| api 行程內單實例狀態 | 10 處狀態在 api 行程內（清單見 §6.1） | 同 §6.1：demo 單實例足夠 | 同 §6.1；`jobRooms` 的 owner 先移到獨立 `JobRoutingRegistry`（第二輪報告 §5.3）再談外置 | §6.1；roadmap 010-lite |
| 結果讀取與完成語意（`GET /diagnoses/:jobId`＋`job/status.result`＋`stalled` 監聽） | 無結果讀取端點；「完成」只靠 `ai/done` 單一 Pub/Sub 訊號；relay 未監聽 BullMQ `stalled` | 需一併改 relay、HTTP 契約與前端重連流程，屬串流行為變更，須走 SDD | 見 §6.2 已變更註記：BullMQ `returnvalue` 優先、Redis Streams 備選 | §6.2；roadmap **012-lite** |
| 日誌節流器三份 | api `LogThrottle`（`lib/telemetry-buffer.ts`）與 `ConnectionErrorThrottle`（`lib/connection-error-throttle.ts`）、worker `lib/log-throttle.ts` 各自實作 | 行為已各自有測試，合併不改對外行為，排在功能修復之後 | 收進 `packages/shared` 的 logging 模組，三端共用 | 後續（第二輪修復留下） |
| `droppedSendCount` 未進 `system/metrics` | Gateway 背壓略過推送的累計數（`MonitoringGateway.droppedSendCount`）只寫 warn log，未進指標廣播 | 需改 `SystemMetrics` 契約與 asyncapi（升版），不在 Batch B 範圍 | `system/metrics` 加 optional 欄位（比照 `persist`），web dev 面板顯示 | 後續（第二輪修復留下；可併入 011 背壓指標重定義） |
| web 無供給 WS token 的途徑 | 設定 `WS_AUTH_SECRET` 後，前端沒有 UI 也沒有 env 可帶 token 進 `machine/subscribe`，內建 web 會被判未授權；因此 demo 與內建前端實際只能讓 `WS_AUTH_SECRET` 留空 | `WS_AUTH_SECRET` 本身是佔位符（§6.3），token 放進前端 bundle 或 env 也不構成真正的身分驗證 | 隨 §6.3 生產路徑一起做：握手階段帶短效 JWT（由登入流程取得），不走靜態共享字串 | 後續（第二輪修復 code-review 未指派項）；§6.3 |
| nginx 每 IP 限流在 Docker Desktop 下退化為全域一桶 | `/diagnoses` `limit_req` 與 `/ws` `limit_conn` 以 `$binary_remote_addr` 為 key，Docker Desktop 下來源皆為 gateway IP，實際成為全體共用一桶 | demo 情境只有本機使用者，全域一桶反而是可接受的總量上限 | 部署在前置 LB／反向代理後時，改用 `real_ip` 模組信任上游並以真實來源 IP 為 key；多使用者時改 per-user 配額（§6.3） | §6.3 已知限制（1）；後續（第二輪修復 code-review 未指派項） |
| api healthcheck 每次載入整份 env zod schema | `apps/api/src/healthcheck.ts` 經 `resolveHealthcheckPort` 呼叫 `parseApiEnv`，每次探針執行都載入並驗證整份 env schema（含 zod） | 屬微優化：探針間隔以秒計，額外開銷不影響判定正確性 | 改為輕量探針：只讀 `API_PORT` 並做最小驗證，不引入 zod | 後續（第二輪修復 code-review 未指派項） |
| WEB-4 行動版關 sheet 後點同卡片不重開 | 行動版 Copilot sheet 只在「選取機台改變」時開啟；關閉後再點同一張卡片沒有反應 | 桌面版不受影響，且有換卡片的繞路 | 點擊已選取卡片也觸發開啟 | 後續（第二輪報告 WEB-4） |

---

## 7. 明確拒絕的路線（over-engineering 邊界）

判準只有一條：**做了會不會讓三個核心賣點（rAF gatekeeper、BullMQ 削峰、雙通道 streaming）更亮？** 不會的話，只是稀釋敘事、拖垮維護、增加 demo 摩擦。

| 路線 | 誘因 | 拒絕理由 |
| --- | --- | --- |
| Kubernetes | 「生產都用 k8s」 | compose 的 restart policy 已滿足監督需求；k8s 帶來的 manifest/網路/儲存複雜度對單機 demo 是純負擔，且「會寫 YAML」不是本專案要證明的能力 |
| Kafka / MQTT ingestion | 真實系統的 telemetry 攝取層長這樣 | telemetry 是 mock producer，攝取層沒有真實流量可以證明什麼；BullMQ 已經扮演「佇列削峰」的敘事主角，再加一套 broker 是重複賣點 |
| 專用時序資料庫（Timescale/Influx/ClickHouse） | 高頻時序的「正規」選擇 | Mongo time-series + TTL 在 demo 資料量下綽綽有餘；換庫是大遷移卻換不到畫面上任何可見差異 |
| OIDC / 完整 IAM | 生產必備 | 無多使用者需求（見 §6.3）；升級路徑已文件化 |
| Redis Sentinel/Cluster、Mongo replica set | 資料層 HA | 單機 demo 沒有「另一台機器」可以故障轉移；HA 的正解是託管服務，那是部署環境的選擇而非程式碼的選擇 |

> **補充（2026-09 審查）**：「拒絕 HA」不等於「單節點可以不設防」。現況已補上成本近零的基本護欄——Redis／Mongo 只綁 127.0.0.1、redis `maxmemory 256mb`＋`noeviction`、可選的 Redis 認證（repo 根 `.env` 或 shell 設 `REDIS_PASSWORD` 即由 compose 加 `--requirepass`，且 `apps/api/.env(.demo)`、`apps/worker/.env` 必須同值）、各服務資源上限與 log 輪替。Mongo 仍無認證（只綁 localhost），屬已知簡化（延後項與升級路徑見 §6.5）。

另外：**CI/CD 發布管線（image registry、自動部署）不綁進 007–009**。CI 目前因私有 repo 節省 Actions 分鐘數而刻意暫停，恢復時機是獨立決策；007/008 的 Dockerfile 寫好後，接上 CI 產 image 是機械工作，不需要現在做。

---

## 8. 接受的代價（Trade-offs）

| 代價 | 如何承擔 |
| --- | --- |
| dev 與 demo 變成雙執行模型（`tsx watch` vs 容器） | 用 compose profiles / scripts 收斂成兩條明確指令；文件寫清楚哪個情境用哪條 |
| Docker Desktop 成為 demo 的硬需求 | 本來就是（Redis/Mongo 已在 compose）；只是從「起 infra」升級為「起全棧」 |
| `restart: on-failure` 只偵測行程死亡，偵測不到「活著但卡住」 | 007 的健康探針（heartbeat key + compose healthcheck）補位 |
| 四項差距只文件化，系統本身仍有這些弱點 | 每項都有 §6 的升級路徑小節，面試被追問時直接引用；風險自覺本身就是可展示的判斷力（§6.3 的基本加固與 §6.4 的有界寫入已於 2026-09 落地，見各節現況） |
| 三個 feature 比一個大 feature 多兩輪 SDD 流程開銷 | 換來獨立驗收與乾淨的 git 歷史，符合專案一貫節奏 |

---

## 9. 什麼情況下這個決策會被推翻

- 專案從作品集轉為**長期維護的正式產品 / 真實多使用者**：§6.3 認證與 §7 資料層 HA 從「文件化」升級為必做。
- **需要第二個 Gateway 實例**（真實流量或高可用要求）：§6.1 的擴展路徑升格為 feature，並重新評估 ADR-001。
- telemetry 從 mock 換成**真實資料來源**：攝取層（Kafka/MQTT）與時序庫選型重新評估。
- demo 環境**拿不到 Docker**（例如受限的企業筆電）：pm2 是備援路線，§4.2 的淘汰理由在該前提下不成立。

---

## 10. demo 時可直接講的取捨說明（60–90 秒）

> 這個專案做完核心功能後，我對照生產環境做了一次差距盤點，寫成 ADR。結論是功能層的選型——BullMQ、契約單一來源、LLM provider 隔離——都站得住，真正缺的是運維層：沒有部署形態、worker 崩潰是 log 完繼續跑、沒有結構化日誌。
>
> 我的處置是分層：值得做的，排成三個 feature——先把 worker 容器化、崩潰語意翻成 let it crash 交給 restart policy；再把整棧容器化做成一鍵 demo；最後補觀測基線，因為這個專案本身是監控台，它自己也該可被監控。
>
> 監督者我選容器化而不是 pm2 或 systemd：dev 在 Windows、systemd 直接出局；pm2 只給 restart 卻不給隔離跟可攜性，而我 compose 裡本來就有 Redis 和 Mongo，worker 加進去整個系統就收斂成一份 compose 檔，Docker 又內建重啟退避，crash-loop 防護不用自己寫。
>
> 至於 Gateway 水平擴展、Pub/Sub 的 at-most-once、認證升級這些真實差距，我選擇不做，但每一項都在 ADR 裡寫了現況、為什麼 demo 可以接受、以及生產要怎麼改。對 side project 來說，知道哪裡是簡化、說得出升級路徑，比把每一層都做重要。
