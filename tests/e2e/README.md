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
worker 用 fake provider，且 e2e 把首 token 延後 2 秒（`FAKE_AI_FIRST_TOKEN_DELAY_MS=2000`，場景 3b 的 kill 窗口，見「fake AiProvider」段）。

流程（`src/harness/global-setup.ts`）：

1. 無條件 `down -v` 專案 `flow-gatekeeper-e2e`（不先查殘留容器：容器已移除、volume 仍在時，上一輪的 cache／job 一樣會污染本輪）。
2. `docker compose -p flow-gatekeeper-e2e -f docker-compose.yml -f docker-compose.e2e.yml --profile demo build`。
3. `up -d --wait`（等所有 healthcheck 轉 healthy）。
4. 循序跑 `src/*.e2e.test.ts`。
5. `down -v`（映像保留，下次 build 走快取）。

`E2E_KEEP=1 corepack pnpm test:e2e` 會保留容器，事後用
`docker compose -p flow-gatekeeper-e2e logs worker api` 排查，清理：`docker compose -p flow-gatekeeper-e2e --profile demo down -v`。

gating：只有 `vitest run --mode e2e`（即 `test:e2e`）才會設 `E2E=1`、收 `src/*.e2e.test.ts` 並起容器；`test:coverage` 不涵蓋本套件。
其他方式（本目錄 `vitest run`、`pnpm test` 經 `pnpm -r` 帶到本套件）只收 `src/harness/**/*.test.ts`、不掛 globalSetup，不起容器（shell 殘留 `E2E=1` 也一樣）。

harness 單元測試：`pnpm --filter @flow-gatekeeper/e2e test`（日誌解析、窗界加總、`maxGap` 等純函式，不需 Docker）。

harness 讀後端證據的兩處做法（`src/harness/infra.ts`，與 012 tasks T022 原文不同、已採納）：
- worker 日誌時間取 pino 每行自帶的 `time`（epoch ms），不加 `compose logs --timestamps`：兩者同為容器側時鐘，`time` 免解析奈秒前綴。
- Pub/Sub 斷線迴圈的 Redis 密碼以 `REDISCLI_AUTH` 傳給 `redis-cli`，不用 `-a`：`-a` 會讓密碼出現在容器行程參數，與 compose healthcheck 同法。

## 隔離（為什麼可以和 demo／dev infra 同時存在）

`docker-compose.e2e.yml` 只給本套件用：

| 項目 | e2e | demo |
| --- | --- | --- |
| compose 專案名 | `flow-gatekeeper-e2e`（容器／網路／volume 都帶此前綴） | `flow-gatekeeper` |
| 對外埠 | 只有 web `127.0.0.1:18080` | web 8080、redis 6379、mongo 27017 |
| env 檔 | 已提交的 `apps/worker/.env.example`、`apps/api/.env.demo.example` | 開發者自己的 `.env`／`.env.demo` |
| AI provider | `AI_PROVIDER=fake`（首 token 前 2s、20 段 × 500ms） | gemini |
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
| `FAKE_AI_FIRST_TOKEN_DELAY_MS` | `0` | 只延遲第一段；e2e 設 `2000`（見下） |

e2e 另把 `AI_TIMEOUT_MS=15000`、`AI_DEDUPE_LOCK_SECONDS=20`（縮短 kill 場景等待死鎖過期的時間），
`FAKE_AI_FIRST_TOKEN_DELAY_MS=2000`：場景 3b 要在 context 已建好、首 token 之前 kill worker（research P24），但 fake 原本
一呼叫就送出首 token，progress 20 → 首 token 只差幾十 ms，從 Windows host 下 `docker compose kill`（數百 ms）打不進這個窗口；
P24「首 token 約在 progress 40 後 500ms」的前提與實作不符，2026-10-21 以這個延遲修正。整段串流因此約 11.5s（仍 < `AI_TIMEOUT_MS`）。

## 場景

| 檔案 | 場景 | 主要斷言 |
| --- | --- | --- |
| `diagnosis.e2e.test.ts` | 1 happy path（`mixer-01`） | `system/connected` → `machine/subscribed` → POST 201；`job/status` 首則 `waiting`、之後 `active`、進度恰為 `0/20/40/60/80/100`、最後一則 `completed`；`ai/token` `seq` 0–19 連號、`attempt` 皆 1、串接全文＝結果；`ai/done` `cached:false`、通過 `AiDoneSchema`／`DiagnosisResultSchema`；最後一個 token 早於 `ai/done` |
| 同上 | 2 cache 命中 | 同機台同簽章再 POST → `ai/done cached:true`、結果與場景 1 相同、零 `ai/token`、進度 `0/20/100` |
| 同上 | 4a 不在線 socketId | 隨機 uuid → 409，body `statusCode: 409`、`error: "Conflict"` |
| 同上 | 4b 名冊外機台 | `ghost-99` → 404，body `statusCode: 404`、`error: "Not Found"` |
| `pubsub-loss.e2e.test.ts` | 5 Pub/Sub 每 50 ms 斷線 20 s（`pack-03`，SC-002） | POST 後 redis 容器內迴圈 `CLIENT KILL TYPE pubsub`；以帶 `result` 的 `job/status: completed` 收尾、`result` 通過 `DiagnosisResultSchema`、`cached:false`、無 `ai/error`、迴圈 `killed > 0`；`ai/token`／`ai/done` 可有可無（只印出收到幾個） |
| `api-restart.e2e.test.ts` | 6a 串流中重啟 api（`press-02`，SC-003） | 第一個 token 後 `restart api`＋等 healthy → 重連 → 新 socketId（帶 `previousSocketId`）GET → 200 `completed`＋`result`（通過 schema、`cached:false`），api healthy 後 60 s 內 |
| 同上 | 6b job 仍在佇列時重啟 api（P18） | 停 worker → POST → `restart api` → 重連 GET → 200 `waiting`、`rebound:true` → 啟動 worker → 新連線收到帶 `result` 的 `completed`，api healthy 後 60 s 內 |
| `redis-pause.e2e.test.ts` | 7 Redis 停頓 50 s（`oven-04`，SC-004；執行點在 US3 checkpoint） | 第 3 個 token 後 `pause redis` 50 s → `unpause`；`diagnosisTriggers` 該 jobId 1 筆、worker 日誌 `LLM call` 1 則、POST 前與完成後兩個 `worker metrics summary` 窗界之間 `cache.hits + cache.misses` 合計 1、`completed.cached === false`；收到 `reason:"stalled"` 或 `execution ≥ 2`（否則印「未重現 AR-4」並失敗）；印出重派那次 `idempotent short-circuit` 的 `source` |
| `diagnosis-lookup.e2e.test.ts` | 8 GET 回應形狀（`press-02`，SC-005） | 隨機 jobId → 404；`socketId=abc` → 400（帶 `issues`、不回顯）；不在線 socketId → 409 `socket_unauthorized`；停 worker 製造進行中 job（綁 A）：B 查 → 409 `job_bound_elsewhere`、B 帶 `previousSocketId`＝A → 200 `waiting` `rebound:true`、之後 `completed` 只送 B；完成後 A 查 → 200 `completed`＋`result` |
| `worker-kill.e2e.test.ts` | 3a 串流中 SIGKILL（第 3 個 token 後）、3b 首 token 前 SIGKILL（收到 progress 20 即 kill，P24；靠 e2e 的 `FAKE_AI_FIRST_TOKEN_DELAY_MS=2000` 留出窗口）（`sorter-05`，SC-001） | 每題 POST 前清 `ai-cache:*`；`docker compose kill -s SIGKILL worker` → `start worker` → 收到 `completed`（帶通過 schema 的 `result`、`cached:false`）、無 `failed`／`ai/error`；`waiting`＋`reason:"stalled"` 或 `execution ≥ 2`；整個 job 的 `maxGap < 45 s`；印出 `W`（kill 後第一則 `worker ready` − 容器 `State.FinishedAt`），W > 25 s 印「上界失效」並失敗。3a 另斷言第二輪 `seq` 0–19 重播、`attempt` 皆 1、串接全文＝`completed.result`；3b 斷言 kill 前零 token、只有重派那一輪 |

每則 WS 訊息都以契約 schema `safeParse`（遙測批次以 `isTelemetryBatch`），不符者記入 `violations`，各場景結尾斷言為空。

機台選擇：mock telemetry 只對 `press-02`、`oven-04` 注入尖峰；`mixer-01`、`sorter-05`、`pack-03` 的 state 恆為 healthy、
不產生 errorlog，診斷簽章在測試期間穩定（cache 命中可重現）。各檔機台：場景 1／2 `mixer-01`、3 `sorter-05`、5 `pack-03`、
6 與 8 `press-02`、7 `oven-04`。必須走 LLM 路徑、又與別檔共用機台或可能被先跑的檔留下快取的場景（6、7）在 beforeAll
以 `clearDiagnosisCache()` 清空 `ai-cache:*`。這些機台都沒有 seed 維修紀錄，脈絡來自 api 持續寫入的遙測，
所以每個檔案在 POST 前會先等到該機台的 `machine/data`，再等 3 秒（api 每秒 flush 一次），避免走 `no_context`。

### 場景 3 反映的現況語意

（012-lite 改寫，2026-10-21；設計見 `docs/adr-003-completion-semantics.md` D4、D7。）

- **relay 監聽 `stalled`**：重派時 api 送 `job/status { status: "waiting", reason: "stalled" }`，接著第二次 `active`；
  `job/status` 另帶 `attempt`（＝`attemptsMade + 1`，stalled 重派不遞增，維持 1）與 `execution`（＝`attemptsStarted`，重派後為 2），
  場景以「`reason: "stalled"` 或 `execution ≥ 2`」判定重派確實發生。
- **最長無事件間隔斷言 < 45 s**：client 為每則訊息記收到時間，`maxGap` 取整個 job 期間相鄰兩則訊息的最大間隔。BullMQ lock 15 s、
  stalled 檢查每 5 s、worker keepalive 10 s，設計上界 `K + L + 2S` ＝ 35 s（`W ≤ L` 時；`W > L` 時為 `K + W + 2S`，`W` 須 < 25 s）。
  `W`＝kill 後第一則 `worker ready` − 容器 `State.FinishedAt`，`W > 25 s` 時場景印「上界失效」並失敗（不放寬判準）。
- **重播**：3a 的第二輪 `ai/token` 仍帶 `attempt: 1`、`seq` 從 0 重播（同一 attempt 內 `seq <= 上一個 seq` 即新一次執行，契約 1.3.0 起；
  `execution` 遞增同樣會清空串流）；3b 在首 token 前 kill，kill 前零 token，只有重派那一輪。
- **實測（012-lite）**：3a `maxGap` **（第 3 輪實測後填）**、3b `maxGap` **（第 3 輪實測後填）**、`W` **（第 3 輪實測後填）**、
  kill → `reason: "stalled"` **（第 3 輪實測後填）**、kill → `completed` **（第 3 輪實測後填）**、本檔耗時 **（第 3 輪實測後填）**。

以下為 012-lite 之前（2.1.0）的語意與實測，保留作對照：

- BullMQ stalled 重派**不遞增** `attemptsMade`，所以重跑的 `ai/token` 仍帶 `attempt: 1`，靠「同一 attempt 內再見 `seq: 0`」
  判定換輪（契約 `packages/contracts/src/ai-stream.ts` 已寫明）。契約 1.3.0 起規則為同一 attempt 內 `seq <= 上一個 seq`
  即視為新一次執行，`seq: 0` 是其特例；本場景斷言的 `seq: 0` 重播在新規則下照樣成立。
- （當時）api 的 job-status relay 沒有監聽 `stalled`（審查報告 AR-3）；前端看到的是 BullMQ `moveJobToWait` 附帶的 `waiting`，
  接著第二次 `active`。
- （當時）實測 kill → 重派的 `waiting`／第二次 `active` 約 **92 秒**、→ `completed` 約 101 秒（兩輪一致）：BullMQ job lock（30s）
  過期後，還要經過 stalled 檢查（每 30s，先標記、下一輪才搬回 wait）才認定 stalled。這段期間前端**收不到任何事件**，
  已超過前端 45 秒的無進展 watchdog（審查報告 AR-1／AR-3 的實測佐證）。各段等待上限：第 3 個 token 30s、
  重派 `waiting` 150s、第二次 `active` 60s、完成 60s；場景 timeout 360s（大於各段總和，逾時時先看到具名的 waitFor 訊息）。

## 注意

- nginx 對 `/diagnoses` 設 `limit_req rate=10r/m burst=5 nodelay`：瞬間上限 1＋5＝6 次，之後每 6 秒回補 1 次，
  **被 api 回 409／404 的請求也計數**（限流在 nginx，早於 api 判斷）。全套約 10 次 POST，但分散在各檔、每檔耗時數十秒，
  期間持續回補，不會同時超過瞬間上限 6。`GET /diagnoses/:jobId` 走獨立的 `diag_read` 桶（60 r/m、burst 10），不吃 POST 的額度。
  每輪都是新容器，限流狀態不會跨輪累積。
- 檔案執行順序**不保證**（vitest 依上次耗時排序，實測 `worker-kill` 常先跑）。各檔機台與快取處理見上方「機台選擇」；
  同一檔內的場景依賴順序（檔內循序，例如場景 1 → 2、6a → 6b）。會停 worker、暫停 redis 的檔在 afterAll 一律還原。
- 冷啟動會 build 三個映像（worker／api／web），第一次約數分鐘；之後走 Docker layer 快取。
