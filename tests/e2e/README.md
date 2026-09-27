# @flow-gatekeeper/e2e — 跨 process e2e

真的起 compose 全棧（redis／mongo／seed／api／worker／web），以原生 `ws` client 走和瀏覽器相同的入口
（nginx `127.0.0.1:18080` 的 `/ws` 與 `/diagnoses`），驗證「訂閱 → POST → `job/status` 序列 → `ai/token` → `ai/done`」
與 worker 崩潰後的 stalled 重派。來源：`docs/20260927-research-review02.md` §6 Batch D。

## 怎麼跑

```powershell
corepack pnpm test:e2e        # 等同 corepack pnpm --filter @flow-gatekeeper/e2e test:e2e
```

前置：Docker Engine 25+、Compose 2.24.4+（override 用到 `!reset`／`!override` 與 healthcheck `start_interval`）。
**不需要** `GEMINI_API_KEY`，也**不需要**先建立 `apps/worker/.env`、`apps/api/.env.demo`。

流程（`src/harness/global-setup.ts`）：

1. 若專案 `flow-gatekeeper-e2e` 有殘留容器 → `down -v`（避免上一輪的 cache／job 污染本輪）。
2. `docker compose -p flow-gatekeeper-e2e -f docker-compose.yml -f docker-compose.e2e.yml --profile demo build`。
3. `up -d --wait`（等所有 healthcheck 轉 healthy）。
4. 循序跑 `src/*.e2e.test.ts`。
5. `down -v`（映像保留，下次 build 走快取）。

`E2E_KEEP=1 corepack pnpm test:e2e` 會保留容器，事後用
`docker compose -p flow-gatekeeper-e2e logs worker api` 排查，清理：`docker compose -p flow-gatekeeper-e2e --profile demo down -v`。

gating：只有 `vitest run --mode e2e`（即 `test:e2e`）才會設 `E2E=1`；`pnpm test`／`test:coverage` 不涵蓋本套件，
在本目錄直接 `vitest run` 時測試全部 skip、也不起容器。

## 隔離（為什麼可以和 demo／dev infra 同時存在）

`docker-compose.e2e.yml` 只給本套件用：

| 項目 | e2e | demo |
| --- | --- | --- |
| compose 專案名 | `flow-gatekeeper-e2e`（容器／網路／volume 都帶此前綴） | `flow-gatekeeper` |
| 對外埠 | 只有 web `127.0.0.1:18080` | web 8080、redis 6379、mongo 27017 |
| env 檔 | 已提交的 `apps/worker/.env.example`、`apps/api/.env.demo.example` | 開發者自己的 `.env`／`.env.demo` |
| AI provider | `AI_PROVIDER=fake`（20 段 × 500ms） | gemini |
| 映像 tag | `:e2e` | `:local` |
| Redis 密碼 | 強制關閉 | 依 root `.env` |

`down -v` 只清 `flow-gatekeeper-e2e_*` volume，不會動到 demo 或 `docker compose up -d` 起的 dev infra。

## fake AiProvider（測試替身）

`apps/worker/src/ai/fake-provider.ts`：實作 `AiProvider` interface（CLAUDE.md 硬規則 4），把一份固定的
假診斷 JSON 切段、以固定延遲逐段 `onToken`。processor 的取鎖、限流、`parseResult`／`DiagnosisResultSchema`
驗證（硬規則 6）、快取、Pub/Sub 串流全部是真的，只把「打 Gemini」換掉。`id`／`model`（`fake`／`fake-diagnosis-v1`）
進 cache signature，不會和 gemini 的快取互相命中。

| 變數 | 預設 | 說明 |
| --- | --- | --- |
| `AI_PROVIDER` | `gemini` | `fake` 啟用測試替身；production 下仍允許但啟動時 warn。**僅供測試／演練** |
| `FAKE_AI_TOKENS` | `20` | 切成幾段送出（1–1000；超過假診斷 JSON 字元數時以字元數為上限） |
| `FAKE_AI_TOKEN_DELAY_MS` | `500` | 相鄰兩段的延遲（0–60000 ms） |

e2e 另把 `AI_TIMEOUT_MS=15000`、`AI_DEDUPE_LOCK_SECONDS=20`（縮短 kill 場景等待死鎖過期的時間）。

## 場景

| 檔案 | 場景 | 主要斷言 |
| --- | --- | --- |
| `diagnosis.e2e.test.ts` | 1 happy path（`mixer-01`） | `system/connected` → `machine/subscribed` → POST 201；`job/status` 首則 `waiting`、之後 `active`、進度恰為 `0/20/40/60/80/100`、最後一則 `completed`；`ai/token` `seq` 0–19 連號、`attempt` 皆 1、串接全文＝結果；`ai/done` `cached:false`、通過 `AiDoneSchema`／`DiagnosisResultSchema`；最後一個 token 早於 `ai/done` |
| 同上 | 2 cache 命中 | 同機台同簽章再 POST → `ai/done cached:true`、結果與場景 1 相同、零 `ai/token`、進度 `0/20/100` |
| 同上 | 4a 不在線 socketId | 隨機 uuid → 409，body `statusCode: 409`、`error: "Conflict"` |
| 同上 | 4b 名冊外機台 | `ghost-99` → 404，body `statusCode: 404`、`error: "Not Found"` |
| `worker-kill.e2e.test.ts` | 3 worker SIGKILL → stalled 重派（`sorter-05`） | 第 3 個 token 後 `docker compose kill -s SIGKILL worker` → `start worker`；token 分兩輪，第二輪 `seq` 從 0 重播 0–19、**`attempt` 仍為 1**；重派後出現 `waiting` 再第二次 `active`、進度重走 `0…100`、`completed`；無 `ai/error` |

每則 WS 訊息都以契約 schema `safeParse`（遙測批次以 `isTelemetryBatch`），不符者記入 `violations`，各場景結尾斷言為空。

機台選擇：mock telemetry 只對 `press-02`、`oven-04` 注入尖峰；`mixer-01`、`sorter-05` 的 state 恆為 healthy、
不產生 errorlog，診斷簽章在測試期間穩定（cache 命中可重現）。兩台都沒有 seed 維修紀錄，脈絡來自 api 持續寫入的遙測，
所以每個檔案在 POST 前會先等到該機台的 `machine/data`，再等 3 秒（api 每秒 flush 一次），避免走 `no_context`。

### 場景 3 反映的現況語意

- BullMQ stalled 重派**不遞增** `attemptsMade`，所以重跑的 `ai/token` 仍帶 `attempt: 1`，靠「同一 attempt 內再見 `seq: 0`」
  判定換輪（契約 `packages/contracts/src/ai-stream.ts` 已寫明）。
- api 的 job-status relay 沒有監聽 `stalled`（審查報告 AR-3）；前端看到的是 BullMQ `moveJobToWait` 附帶的 `waiting`，
  接著第二次 `active`。
- 實測 kill → 重派的 `waiting`／第二次 `active` 約 **92 秒**、→ `completed` 約 101 秒（兩輪一致）：BullMQ job lock（30s）
  過期後，還要經過 stalled 檢查（每 30s，先標記、下一輪才搬回 wait）才認定 stalled。這段期間前端**收不到任何事件**，
  已超過前端 45 秒的無進展 watchdog（審查報告 AR-1／AR-3 的實測佐證）。各段等待上限：第 3 個 token 30s、
  重派 `waiting` 150s、第二次 `active` 60s、完成 60s；場景 timeout 360s（大於各段總和，逾時時先看到具名的 waitFor 訊息）。

## 注意

- nginx 對 `/diagnoses` 設 `limit_req rate=10r/m burst=5 nodelay`：瞬間上限 1＋5＝6 次，之後每 6 秒回補 1 次，
  **被 api 回 409／404 的請求也計數**（限流在 nginx，早於 api 判斷）。全套 5 次 POST，在瞬間上限內；新增會 POST 的場景
  若讓總數超過 6、又集中在數秒內，超出者會拿到 429。每輪都是新容器，限流狀態不會跨輪累積。
- 檔案執行順序**不保證**（vitest 依上次耗時排序，實測 `worker-kill` 常先跑）。兩個檔用不同機台（`mixer-01`／`sorter-05`）、
  簽章不同，彼此獨立；同一檔內的場景 1 → 2 依賴順序（檔內循序）。
- 冷啟動會 build 三個映像（worker／api／web），第一次約數分鐘；之後走 Docker layer 快取。
