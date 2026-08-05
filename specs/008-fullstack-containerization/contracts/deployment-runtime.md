# Contract: Deployment Runtime（Phase 1）

**`packages/contracts` 零變更。** 本檔記錄的是**部署／運維層契約**——profile 名、入口位址、退出碼、健康判定、啟動條件、設定注入。這些不是跨端通訊 payload，不屬憲章 III 的 Zod／`z.infer` 範圍，故以文件形式定義（與 007 的 [supervision-runtime.md](../007-worker-process-supervision/contracts/supervision-runtime.md) 同一處置）。

契約的消費者是**展示者、運維者與編排器**，不是程式碼。任何一項變更都會改變 README 的操作說明或驗收判準。

## 1. 模式分組契約（profile）

| 分組 | 值 | 涵蓋服務 | 語意 |
|---|---|---|---|
| （不帶分組） | — | `redis`、`mongo` | 開發模式：只起資料層，app 在 host 熱重載 |
| demo | `demo` | ＋`seed`、`api`、`worker`、`web` | 全棧受監督容器形態 |

**MUST**：

- 全棧模式以**單一**分組旗標啟動：`docker compose --profile demo up -d --build`。
- `supervised` 分組**已退場**——MUST NOT 出現在 compose、README 或指南的現況描述中（FR-008／FR-016）。
- 單獨啟動某一端以**指名服務**達成（`docker compose --profile demo up -d worker`），MUST NOT 為此新增分組。

**破壞性變更警示**：007 交付時的 `--profile supervised` 指令在本 feature 後**失效**。`README.md`、`apps/worker/Dockerfile` 檔頭註解與指南 §14／§16 須回補；歷史敘述（ADR、指南「由來」段、§13 的 007 決策背景）保留原文，僅標註現況（FR-016）。

> **修訂註（analyze 修正）**：原文寫「README 與指南 §13 須回補」——經全域搜尋確認指南全檔 0 處 `supervised`，§13 無標的可更名（詳見 spec FR-016 註與 research D8）。

## 2. 入口契約（Entry Point）

| 項目 | 值 | 來源 |
|---|---|---|
| demo 入口 | `http://localhost:8080` | compose `web.ports: ["8080:80"]` |
| 即時通道 | `ws://localhost:8080/ws`（同源相對路徑） | nginx 反向代理 → `api:3000`（變數式 `proxy_pass`，見下） |
| 診斷觸發 | `POST http://localhost:8080/diagnoses`（同源相對路徑） | nginx 反向代理 → `api:3000`（變數式 `proxy_pass`，見下） |
| api 對外埠 | **無** | compose `api` **不宣告 `ports`** |

**實作期的暫時例外（僅 Phase 3）**：US1 交付時 web 容器尚不存在，其一致性比對須以 host 端 dev 前端連上容器化 Gateway，而 vite dev proxy 的 target 寫死 `http://localhost:3000`。故 Phase 3 期間 api 暫時宣告 `ports: ["3000:3000"]`（tasks T008），並於 web 容器交付時移除（tasks T012）。**此例外只存在於 Phase 3－Phase 4 之間的實作區間，不是本契約的終態**——本表定義的「api 對外埠＝無」是 feature 收尾時 MUST 成立的狀態（release-gate CHK054）。Phase 3 尚無「單一入口」可言，故該暫時發佈不構成 FR-006 違反；殘留至收尾則構成違反。

**MUST**：

- 瀏覽器 MUST 只需知道一個位址；前端 MUST NOT 要求使用者指定後端位址（FR-006）。
- 前端產物 MUST NOT 內嵌後端絕對位址——同一份產物在不同入口埠／主機下皆可用（FR-009）。
- nginx 的 `/ws` location MUST 帶 WebSocket 升級標頭：

  ```nginx
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  ```

  漏掉任一項，握手會退化為一般 HTTP 請求而失敗。**這是入口拓樸的單點故障處。**

- nginx 對 api 的 upstream MUST **延後解析**——`resolver 127.0.0.11 valid=10s ipv6=off;` + `set $api_upstream api:3000;` + `proxy_pass http://$api_upstream;`。字面 hostname 的 `proxy_pass http://api:3000;` 會被 nginx 在**啟動時解析一次並永久快取**，api 崩潰重啟後若換 IP 即持續轉發至失效位址，使 SC-003 失敗且症狀與「重啟上限耗盡」同形（research D1「upstream 解析」）。`proxy_pass` 後 MUST NOT 接 URI 路徑，以保留原始請求 URI。

## 3. 退出碼契約（Exit Code）

退出碼是監督語意的**唯一**依據——`restart: on-failure:N` 只重啟非零退出。

| 行程 | 退出碼 | 觸發 | 監督者行為 |
|---|---|---|---|
| `api` | `0` | SIGTERM／SIGINT → `app.close()` 完成 | **不重啟**（終態） |
| `api` | `≠0` | 未捕捉例外、非預期錯誤 | 重啟（Docker 內建指數退避），連續 5 次後停止 |
| `seed` | `0` | 資料備妥完成 | 不重啟（`restart: "no"`）；**解除 api 的啟動條件** |
| `seed` | `≠0` | 資料層不可用等 | 不重啟；**api 不啟動**，compose 以明確錯誤呈現 |
| `worker` | `0`／`≠0` | 同 007，不動 | 同 007，不動 |

**MUST**：api 的優雅關閉 MUST 以 `0` 退出。收尾過程出錯時 MUST 記 log 後**仍以 `0` 退出**——收尾失敗不是崩潰，若以非零退出會被監督者誤判為崩潰而重啟一個正要停止的服務。

## 4. 監督參數契約

| 服務 | `restart` | `stop_grace_period` | `init` |
|---|---|---|---|
| `api` | `on-failure:5` | **`15s`** | `true` |
| `worker` | `on-failure:5`（不動） | **`45s`**（不動） | `true`（不動） |
| `web` | `on-failure:5` | 預設 | — |
| `seed` | `"no"` | 預設 | — |

**兩個寬限期為何不同**（FR-004）：`45s` 是為涵蓋 worker 的 `AI_TIMEOUT_MS`（30s）LLM 收尾預算而算；api 不呼叫 LLM，收尾僅為關閉連線、量級為秒內，故 `15s`。**MUST NOT 互相照抄**。

**上限耗盡後**：容器停在 `exited`，不再重啟。判讀依 `docker compose ps` 的狀態欄與 `docker inspect` 的 `RestartCount`／`State.Status`（research D10）。編排器 MUST NOT 因此發出額外通知——觀測能力屬 Feature 009。

## 5. 健康判定契約

| 服務 | 判定依據 | 探測方式 | 參數 |
|---|---|---|---|
| `api` | `/ws` 握手收到 `system/connected` | `node dist/healthcheck.js`（映像第二進入點） | `interval 30s`／`timeout 5s`／`retries 3`／`start_period 30s` |
| `worker` | Redis heartbeat key 未過期 | `node dist/healthcheck.js`（007 已交付，**不動**） | 同上（不動） |
| `web` | 入口位址有回應 | HTTP 探測（`wget --spider`，待實測確認工具存在） | 同上 |
| `seed` | 不適用 | 以退出碼為準 | — |

**MUST**：

- 健康判定 MUST 以**既有對外介面**為依據，MUST NOT 新增任何端點（FR-011）。`/healthz` 屬 Feature 009。
- api MUST NOT 以「HTTP 埠有回應」充數——api 無任何 GET 路由，探 HTTP 必得 404，等於把 404 當健康；`/ws` 握手證明的才是 demo 所需的真實能力（Gateway 已 attach）。
- 「全部就緒」MUST 為**複合訊號**：seed 完成 → api healthy → web 有回應 → worker healthy。

**已知限制（明文接受）**：不涵蓋 Mongo／Redis 連通性——api 可能握手成功但資料層斷線而仍 healthy。屬 009 範圍。

**探針無需授權的依據**：`handleConnection` 在連線當下無條件送出 `system/connected`，`WS_AUTH_SECRET` 只在 `machine/subscribe` 時檢查，故探針不需持有 token。

## 6. 啟動條件契約（depends_on）

| 服務 | 相依 | 條件 |
|---|---|---|
| `seed` | `mongo` | 預設（`service_started`） |
| `api` | `seed` | **`service_completed_successfully`** |
| `api` | `redis`、`mongo` | 預設 |
| `web` | `api` | 預設 |
| `worker` | `redis`、`mongo` | 預設（不動） |

**MUST**：

- 示範資料 MUST 於 api 開始服務前備妥（FR-012、US2 場景 4）。
- api 的崩潰自動重啟 MUST NOT 重跑 seed（FR-012、US2 場景 5）——機制上自然成立：`depends_on` 只在**啟動編排**時求值，`restart` 觸發的重啟不重新求值相依。
- 資料層尚未就緒即被連線時，api／worker MUST NOT 永久卡死（US1 場景 5）——`depends_on` 的預設條件只保證「容器已啟動」而非「服務可用」，故最終一致性由既有的驅動程式重連機制承擔，本 feature MUST NOT 為此改寫連線邏輯（FR-014）。

## 7. 設定與祕密注入契約

| 服務 | `env_file` | `environment` 覆蓋 |
|---|---|---|
| `api` | `apps/api/.env` | `REDIS_HOST: redis`、`MONGO_URL: mongodb://mongo:27017/flow-gatekeeper` |
| `seed` | `apps/api/.env` | `MONGO_URL: mongodb://mongo:27017/flow-gatekeeper` |
| `worker` | `apps/worker/.env`（不動） | `REDIS_HOST: redis`、`MONGO_URL: ...`（不動） |
| `web` | **無**（不持有任何祕密） | — |

**MUST**：

- 祕密 MUST 僅於執行時注入，MUST NOT 烘入映像（憲章 VI、FR-010、SC-006）。
- MUST NOT 引入根目錄 `.env`——compose 插值不讀 `env_file`，強行採用須搬動祕密佈局，並使根目錄 `.env.example` 的既有敘述失效、產生兩層語意不同的 `.env`（research D12）。
- 服務間定址 MUST 用服務名，MUST NOT 用 host 迴路位址（FR-009）。

**前置需求（FR-005／SC-001）**：展示者需複製兩份範本——`apps/api/.env`（可全用預設值）、`apps/worker/.env`（填 `GEMINI_API_KEY`）。`env_file` 指向的檔案不存在時，compose 以明確錯誤中止並指名缺哪個檔。

## 8. 祕密缺漏的行為契約（FR-017）

**適用情境**：`.env` 檔存在、但 `GEMINI_API_KEY` 留空（比「忘了複製範本」更隱蔽——後者 compose 會直接指名報錯）。

| 面向 | 契約 |
|---|---|
| 啟動 | 全棧 MUST 照常啟動；MUST NOT 因缺金鑰擋下任何服務 |
| 遙測、背壓比值 | MUST 正常運作（4 賣點中的 2 個仍可見） |
| AI 診斷、快取命中 | 失效；MUST 走既有 `ai/error` 路徑 |
| 畫面訊息 | MUST 指名金鑰為病因，MUST NOT 只顯示通用失敗語 |
| 檢查機制 | MUST NOT 新增（編排、app 啟動路徑、獨立服務皆不可） |

**為何不擋啟動**：擋下會讓沒有 LLM 帳號的評估者一個賣點都看不到，直接違反 US2「拿到 repo 想在最短時間內看到系統跑起來」的價值主張（Clarifications 完整理由）。

**驗收 MUST 實測**：空金鑰與無效金鑰的供應商回應未必相同，MUST NOT 以無效金鑰的結果推斷。若落入通用文案，MUST 補齊既有映射——此屬覆蓋缺口的缺陷修復，非 FR-014 例外（research D11）。

## 9. 停止與重設契約

| 動作 | 指令 | 結果 |
|---|---|---|
| 乾淨停止 | `docker compose --profile demo down` | 各服務依自身寬限期收尾；0 個殘留行程佔埠 |
| 停止單一服務（優雅） | `docker compose --profile demo stop api` | SIGTERM → 15s 寬限；不觸發重啟 |
| 連同資料清除的重設 | `docker compose --profile demo down -v` | 移除 `redis-data`／`mongo-data` volume；重起後 seed 重跑，回到初始狀態 |
| 只清 AI 快取／鎖 | `./scripts/demo-reset.ps1`（**不動**） | 只清 `ai-cache:*`／`ai-lock:*`；保留遙測歷史——與 `down -v` 為**不同粒度**，兩者並存 |

**MUST**：`down -v` 後重起 MUST 使同一份 demo 劇本可重跑並得到同等結果（SC-005、FR-013）。
