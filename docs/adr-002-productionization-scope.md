# ADR-002：生產化範圍邊界——監督者選型、整棧容器化路線與運維層取捨

| 項目 | 內容 |
| --- | --- |
| 狀態 | Accepted |
| 日期 | 2026-07-06 |
| 範圍 | 部署與執行模型（worker/api/web）、process 監督、可觀測性，以及「明確不補」的運維層差距 |
| 相關 | Feature 007/008/009（實作指南 §13–§15）、`apps/worker/src/main.ts` process handlers、`docker-compose.yml`、`scripts/dev-up.ps1`、ADR-001 |

---

## 1. 背景（Context）

flow-gatekeeper 是作品集 side project，核心賣點是三件事：前端 rAF gatekeeper 背壓、BullMQ 分散式削峰、AI 雙通道 streaming。Feature 001–006 完成後，對照「實務上真正上線的專案」做了一次全面盤點，結論是：

> **差距最大的不是「選了什麼技術」，而是「執行與運維層整個缺席」。**

功能層的選型（pnpm monorepo + Zod 契約單一來源、BullMQ limiter/attempts/backoff、`AiProvider` 介面隔離、cache signature 含 `promptVersion`/`model`）都站得住腳，可以直接帶進生產。真正的落差集中在運維層（完整清單見 §3）。

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

| # | 層面 | 現況 | 生產基線 | 本 ADR 的處置 |
| --- | --- | --- | --- | --- |
| 1 | 執行模型 | `tsx watch` 開在 PowerShell 視窗，無 Dockerfile、無 restart 策略——**沒有可部署的形態** | 三端容器映像 + 編排器帶 restart 與健康檢查 | **實作**：007（worker）、008（api/web） |
| 2 | 崩潰語意 | worker `uncaughtException` log + 續跑（行程狀態未定義，Node 官方明言 not safe to resume） | let it crash：`exit(1)` + 監督者重啟乾淨行程 | **實作**：007 |
| 3 | 可觀測性 | 只有 console log；無結構化日誌、metrics、tracing、告警 | 結構化 JSON log + metrics + 告警是上線入場券 | **實作基線**：009（僅日誌 + healthz + 指標入 log） |
| 4 | Gateway 擴展 | 單實例有狀態：訂閱表與 jobId 路由在行程內 `Map`，`psubscribe ai-stream:*` | 連線狀態外置或 sticky session + 跨實例路由 | **文件化**：§6.1 |
| 5 | Streaming 可靠性 | Redis Pub/Sub at-most-once，Gateway 重啟或前端重連期間 token 永久丟失 | Redis Streams 可回放，或 token 落地 + offset 續傳 | **文件化**：§6.2 |
| 6 | 認證與安全 | `WS_AUTH_SECRET` 靜態共享字串放在訊息 payload；`ws://` 明文；HTTP 端點無驗證與 rate limit | 升級握手驗 JWT/OIDC、`wss://`、per-user 授權與配額 | **文件化**：§6.3 |
| 7 | 資料寫入語意 | telemetry 持久化 fire-and-forget；errorlog 去重靠行程內 `lastState` Map | 明確宣告的丟失預算，或帶重試的寫入佇列 | **文件化 + 明文註解**：§6.4、009 |
| 8 | 資料層 HA | Redis/Mongo 各單節點，Redis 身兼 queue/cache/Pub/Sub/lock 四職 | 託管服務或 Sentinel/replica set，職責分實例 | **拒絕**：§7 |
| 9 | CI/CD | CI 刻意暫停（私有 repo 省 Actions 分鐘數），無 image 發布管線 | CI 產 image → registry → 自動部署 | **不綁在 007–009**：CI 恢復另議 |

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

以下四項是真實的生產差距，但**補齊它們不會讓三個核心賣點更亮**，且各自都有明確的升級路徑可以在面試中講清楚。對作品集而言，「能說出哪裡是簡化、生產要怎麼改」的價值不低於真的做出來。

### 6.1 Gateway 單實例與水平擴展

- **現況**：訂閱表（`clientId -> Set<machineId>`）與 `jobId -> clientId` 路由都在 Gateway 行程內的 `Map`；AI relay 用 `psubscribe ai-stream:*`。開第二個 API 實例就壞：兩台 Gateway 各自收到所有 token，會重複轉發或找不到 client；API 重啟則所有訂閱歸零。
- **為何不做**：demo 負載單實例綽綽有餘；ADR-001 本來就把「需要多實例」列為推翻條件之一；動這裡等於重寫 Gateway 核心，卻不新增任何可展示的能力。
- **生產路徑**：訂閱表外置 Redis；用精準 channel subscribe（`subscribe ai-stream:<jobId>`，只訂自己路由的 job）取代 `psubscribe *`；LB 開 sticky session，或把連線層抽成獨立 tier。屆時也應重新評估 Socket.IO + Redis adapter（見 ADR-001 §6）。

### 6.2 Redis Pub/Sub 的 at-most-once 語意

- **現況**：AI token 走 `ai-stream:<jobId>` 是 fire-and-forget。Gateway 若在串流中重啟、或前端斷線重連，中間的 token 永久丟失。
- **為何可接受**：最終診斷結果會落 MongoDB `diagnoses` 並進 Redis cache，丟失的只是「打字機動畫的過場」，不是資料；重連後可拿完整結果。
- **生產路徑**：改用 Redis Streams（`XADD`/`XREAD` + consumer group），client 帶 last-id 續傳即可回放斷線期間的 token；或 token 落地 + offset 續傳。

### 6.3 認證：`WS_AUTH_SECRET` 是佔位符

- **現況**：一個靜態共享字串，放在 `machine/subscribe` 訊息 payload 裡比對。沒有使用者身分、沒有到期、`ws://` 明文、`POST /diagnoses` 無驗證與 rate limit。
- **為何不做**：專案沒有多使用者需求，demo 情境反而常要把它清空；引入 OIDC/JWT 生命週期管理會吃掉大量開發時間卻展示不了核心賣點。
- **生產路徑**：驗證移到 HTTP upgrade 握手階段（header/query 帶短效 JWT），通過才建連線；全面 `wss://`；job 建立端點加身分驗證與配額。

### 6.4 有損寫入語意

- **現況**：telemetry 持久化是 fire-and-forget（`void persistBatch(...)`，刻意不 await 以免卡住推送 cadence）；API 崩潰時 in-flight batch 直接丟。errorlog 去重靠行程內 `lastState` Map，重啟後會重寫一筆、多實例下判斷會錯。
- **決策**：**明文接受**「可丟失最後數秒 telemetry、errorlog 在重啟邊界可能重複」。有損是可以的，未宣告的有損才是問題。
- **落地（✅ 已完成，Feature 009）**：語意已明文於三處且指向同一份事實——`persistBatch` 與 `detectErrorTransitions` 的程式註解、README 的「已宣告的取捨」小節，兩者皆引用本節。若未來轉為不可丟失，路徑是寫入前先進佇列（BullMQ 或 Redis Stream）再批次落庫；該路徑仍**不在範圍內**。

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

另外：**CI/CD 發布管線（image registry、自動部署）不綁進 007–009**。CI 目前因私有 repo 節省 Actions 分鐘數而刻意暫停，恢復時機是獨立決策；007/008 的 Dockerfile 寫好後，接上 CI 產 image 是機械工作，不需要現在做。

---

## 8. 接受的代價（Trade-offs）

| 代價 | 如何承擔 |
| --- | --- |
| dev 與 demo 變成雙執行模型（`tsx watch` vs 容器） | 用 compose profiles / scripts 收斂成兩條明確指令；文件寫清楚哪個情境用哪條 |
| Docker Desktop 成為 demo 的硬需求 | 本來就是（Redis/Mongo 已在 compose）；只是從「起 infra」升級為「起全棧」 |
| `restart: on-failure` 只偵測行程死亡，偵測不到「活著但卡住」 | 007 的健康探針（heartbeat key + compose healthcheck）補位 |
| 四項差距只文件化，系統本身仍有這些弱點 | 每項都有 §6 的升級路徑小節，面試被追問時直接引用；風險自覺本身就是可展示的判斷力 |
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
