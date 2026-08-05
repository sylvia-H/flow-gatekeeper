# Data Model: Full-Stack Containerization & One-Command Demo（Phase 1）

本 feature **不新增任何持久化資料結構**——Mongo collections、Redis key、`packages/contracts` 的通訊 payload 一律不動（FR-014）。本檔描述的是**部署層的實體與狀態**：服務拓樸、啟動相依、狀態轉移。

決策依據見 [research.md](./research.md)；契約形式見 [contracts/deployment-runtime.md](./contracts/deployment-runtime.md)。

## 實體：執行模式（Execution Mode）

系統可被啟動的兩種形態，由**同一份** `docker-compose.yml` 描述、以 compose profile 切分（FR-008）。

| 模式 | 啟動指令 | 涵蓋服務 | app 執行位置 |
|---|---|---|---|
| **開發模式** | `docker compose up -d` | `redis`、`mongo` | host 直跑（`dev-up.ps1` → `nest start --watch` / `tsx watch` / `vite`） |
| **全棧 demo 模式** | `docker compose --profile demo up -d --build` | `redis`、`mongo`、`seed`、`api`、`worker`、`web` | 容器內跑建置產物 |

**不變量**：

- 未帶 `--profile` 時，掛 `profiles: ["demo"]` 的服務 MUST NOT 被拉起（compose 機制保證，非紀律保證）——SC-004 的機制基礎。
- 兩模式共用 `redis`／`mongo`（不掛 profile），故 MUST NOT 同時啟動兩模式（Edge case：資源衝突可預期、可辨識）。
- `supervised` 分組已退場，MUST NOT 與 `demo` 並存（FR-008、research D8）。

## 實體：服務（Service）

編排中的可執行單元。屬性與各服務取值：

| 服務 | profile | 對外埠 | 重啟策略 | 停止寬限 | 健康判定 | 啟動相依 |
|---|---|---|---|---|---|---|
| `redis` | —（共用） | `6379:6379` | 預設 | 預設 | — | — |
| `mongo` | —（共用） | `27017:27017` | 預設 | 預設 | — | — |
| `seed` | `demo` | 無 | `"no"`（一次性） | 預設 | —（以退出碼為準） | `mongo` |
| `api` | `demo` | **無**（僅容器網路 `api:3000`） | `on-failure:5` | **15s** | `/ws` 握手收到 `system/connected` | `seed`（`service_completed_successfully`）、`redis`、`mongo` |
| `worker` | `demo` | 無 | `on-failure:5`（不動） | **45s**（不動） | Redis heartbeat 探針（不動） | `redis`、`mongo` |
| `web` | `demo` | **`8080:80`**（唯一對外入口） | `on-failure:5` | 預設 | 入口位址有回應 | `api` |

**關鍵不變量**：

- **`api` MUST NOT 宣告 `ports`**（FR-006）。瀏覽器只面對 `web` 的 8080；`/ws` 與 `/diagnoses` 由 nginx 同源轉發至 `api:3000`（upstream 以 `resolver` + 變數式 `proxy_pass` 延後解析，research D1）。
  **實作期例外（僅 Phase 3）**：US1 交付時 `web` 尚不存在，其一致性比對須以 host dev 前端連上（vite proxy target 寫死 `localhost:3000`），故 `api` 暫時宣告 `ports: ["3000:3000"]`（tasks T008）並於 `web` 交付時移除（tasks T012）。**本不變量描述的是 feature 收尾時的終態**，release-gate CHK054 把關其確實回到終態。
- **`worker` 的兩個監督參數不動**——`45s` 是為涵蓋 `AI_TIMEOUT_MS` 30s 的 LLM 收尾而算，api 的 `15s` 依其自身收尾成本（僅關閉連線）另定，兩者 MUST NOT 互相照抄（FR-004）。
- **`seed` 與 `api` 共用同一映像**（`flow-gatekeeper-api:local`），兩者皆須宣告 `build:`（research D7）。
- 服務間定址一律用服務名（`redis`／`mongo`／`api`），MUST NOT 用 host 迴路位址（FR-009）。

## 實體：映像產物（Image）

| 映像 | 來源 | runtime 基底 | 進入點 |
|---|---|---|---|
| `flow-gatekeeper-api:local` | `apps/api/Dockerfile` | `node:22-alpine` | `dist/main.js`（api）／`dist/scripts/seed.js`（seed）／`dist/healthcheck.js`（探針） |
| `flow-gatekeeper-worker:local` | `apps/worker/Dockerfile`（不動） | `node:22-alpine` | `dist/main.js`／`dist/healthcheck.js` |
| `flow-gatekeeper-web:local` | `apps/web/Dockerfile` | `nginx:alpine` | nginx（靜態產物 + 反向代理） |

**不變量**：任何映像 MUST NOT 含祕密（憲章 VI、SC-006）。機制：`.dockerignore` 排除 `**/.env`、放行 `!**/.env.example`——此兩行在本 feature 一字不動（research D4）。

**一個映像三個進入點**：api 映像的三個入口全部由同一次 `tsc` 建置產出（`tsconfig.build.json` 只排除 `*.test.ts`／`*.check.ts`），不需額外映像——沿用 007 的 healthcheck 模式。

## 狀態轉移：全棧啟動序列

```text
docker compose --profile demo up -d --build
   │
   ├─ redis ─┐
   ├─ mongo ─┤
   │         ▼
   │      seed（一次性）
   │         ├─ exit 0 ──────────────► api 可啟動
   │         └─ exit ≠0 ─────────────► api 不啟動；compose 以明確錯誤呈現
   │                                    （Edge case：示範資料備妥失敗）
   │                                         │
   │                                         ▼
   │                                   api（listen :3000 → Gateway attach）
   │                                         │ start_period 30s 後開始探針
   │                                         ▼
   │                                   healthy（/ws 握手收到 system/connected）
   │                                         │
   ├─ worker ──► heartbeat ──► healthy      │
   │                                         ▼
   └────────────────────────────────────► web（nginx）
                                             │
                                             ▼
                                  「全部就緒」＝複合訊號
                          （seed 完成 → api healthy → web 有回應 → worker healthy）
```

**「全部就緒」為複合訊號**（FR-011）——單一服務健康不代表可 demo。判讀方式見 [quickstart.md](./quickstart.md)。

**已知限制（spec 明文接受）**：健康判定不涵蓋 Mongo／Redis 連通性——api 可能握手成功但資料層斷線而仍顯示 healthy。屬 Feature 009 的觀測基線範圍，008 明確不做。

## 狀態轉移：api 行程生命週期

退出碼是監督語意的唯一依據——`on-failure` 只重啟非零退出（與 007 worker 同構）。

```text
                    ┌──────────────────────────────────┐
                    │            running               │
                    └──────────────────────────────────┘
                        │                          │
          SIGTERM/SIGINT│                          │未捕捉例外／非預期錯誤
                        ▼                          ▼
          app.close()（觸發四個既有             exit ≠0
          onModuleDestroy——本 feature              │
          讓它們第一次真的被執行）                  │
                        │                          ▼
                        ▼                    ┌───────────┐
                    exit 0                   │ 監督者重啟 │◄─┐
                        │                    │（Docker 內 │  │ 連續失敗 < 5
                        ▼                    │ 建指數退避）│──┘
                  ┌──────────┐               └───────────┘
                  │ 不重啟    │                     │ 連續失敗 = 5
                  │（終態）   │                     ▼
                  └──────────┘               ┌──────────────┐
                                             │ exited（終態）│
                                             │ 停止重啟      │
                                             └──────────────┘
```

**寬限期 15s 的語意**：SIGTERM 後 15s 內未退出即 SIGKILL。SC-005 要求**實測收尾 ≤ 3s**（上限的 1/5）——api 的收尾僅為關閉連線（Gateway、Mongo、Redis／佇列事件），量級為秒內；**實測超過 3s 即屬缺陷**，代表收尾路徑有非預期的阻塞，正解是排除阻塞，而非調大寬限期或門檻。

**上限耗盡後的辨識（research D10）**：容器停在 `exited`，以 `docker compose ps` 的狀態欄與 `docker inspect` 的 `RestartCount`／`State.Status` 判讀。展示者實際看到的症狀是「web 入口正常載入、但即時通道永遠連不上」——quickstart **場景 1e** MUST 附判讀指令（`1c` 是崩潰自動重啟，兩者不同節）。

## 狀態轉移：示範資料（Maintenance Records）

| 觸發 | seed 是否執行 | 資料結果 |
|---|---|---|
| `--profile demo up`（首次） | ✅ 執行一次 | 重置後重建（決定性） |
| `--profile demo up`（重複啟動） | ✅ 再執行一次 | 冪等——`deleteMany` → `insertMany` 不堆積（US2 場景 4） |
| **api 崩潰自動重啟** | ❌ **不執行** | **維持原狀**（US2 場景 5、FR-012） |
| `down` → `up` | ✅ 執行一次 | 重置後重建 |
| `down -v` → `up` | ✅ 執行一次 | volume 已清空，回到初始狀態（SC-005 可重播） |

**「崩潰重啟不重跑 seed」的機制**：`depends_on` 只在**啟動編排**時求值；容器因 `restart: on-failure` 重啟不會重新觸發相依服務。這正是 Clarifications 排除「把 seed 綁進 api 啟動路徑」的理由——該做法會讓 FR-003 的每次重啟都重置示範資料，與 US1 場景 3 的復原演練直接衝突。

## 實體：入口位址（Entry Point）

| 屬性 | 值 |
|---|---|
| demo 入口 | `http://localhost:8080` |
| 前端定址方式 | 同源相對路徑（`/ws`、`/diagnoses`）——**產物不內嵌後端絕對位址** |
| 可攜性 | 同一份產物在不同入口埠／主機下皆可用，無需重新建置（FR-009） |

**8080 的理由**（research D2）：避開 `5173`（vite dev）與 `3000`（api dev）兩個既有佔用，使「同時啟動兩模式」退化為一眼可辨的埠衝突，而非「連上了但不知道連到哪一個」。

**非預設埠的驗收**（Edge case）：改 compose 的 `ports` 一行為非 8080 後重起，前端仍須能連上——同源相對路徑使其自然成立，但 MUST 實測一次。
