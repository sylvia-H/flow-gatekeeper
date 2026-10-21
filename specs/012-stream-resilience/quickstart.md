# Quickstart：012-lite 串流韌性驗收劇本

**Feature**：`012-stream-resilience` | **Plan**：[plan.md](./plan.md)

本檔只寫「怎麼跑、看什麼」；行為定義見 [contracts/](./contracts/)，狀態與鍵見 [data-model.md](./data-model.md)。指令以 PowerShell
為準（Windows），pnpm 在本機以 `corepack pnpm` 呼叫。

## 0. 前置

- Node 22、pnpm 10（`corepack enable`）；`corepack pnpm install`。
- Docker Desktop 已啟動（整合測試、e2e、手動演練需要；純單元測試不需要）。
- 手動演練建議用 fake provider 省 Gemini 額度：`apps/worker/.env` 設 `AI_PROVIDER=fake`（20 段 × 500 ms；production 下啟動會記一則 warn，
  屬預期），演練完改回 `gemini`。

## 1. 單元測試（不需 Docker）

機器記憶體吃緊時逐套件或逐檔跑，不要一次 `pnpm test`：

```powershell
corepack pnpm --filter @flow-gatekeeper/contracts test          # 傳輸型別、GET schema、asyncapi 漂移、文件版本字串（SC-010）
corepack pnpm --filter @flow-gatekeeper/worker exec vitest run src/processor.test.ts src/lib/keepalive.test.ts
corepack pnpm --filter @flow-gatekeeper/api exec vitest run src/modules/websocket src/modules/jobs
corepack pnpm --filter @flow-gatekeeper/web exec vitest run src/domains/ai-copilot
```

收尾前一次：`corepack pnpm check`（contract lint＋typecheck＋lint＋test，SC-010／SC-011），`corepack pnpm test:coverage`
（全域與十個核心檔逐檔門檻，FR-044）。

| 判準 | 由哪些單元測試承接 |
| --- | --- |
| SC-005（GET 七種回應） | api `diagnosis-lookup.service.test.ts`、`jobs.controller.test.ts`、`job-routing-registry.test.ts` |
| SC-006（四種完成順序收斂） | web `copilot-reducer.test.ts`、`copilot.store.test.ts` |
| SC-007（同簽章失敗 ≤ 4 次 LLM） | worker `processor.test.ts`（fake store／timer／provider） |
| SC-008（persist_failed、failed 寬限） | worker `processor.test.ts`、api `job-status-relay.service.test.ts` |
| SC-009（keepalive 每 10 s ± 1 s） | worker `keepalive.test.ts`、`processor.test.ts`（fake timer）、api relay progress 拆解 |

## 2. 整合測試（需本機 Redis＋Mongo）

```powershell
docker compose up -d                                              # Redis 7 + MongoDB 7
corepack pnpm --filter @flow-gatekeeper/worker test:integration   # triggers unique＋upsert、findDiagnosisResult、setIfAbsent、真 BullMQ returnvalue／progress
corepack pnpm --filter @flow-gatekeeper/api test:integration      # HistoryService.findDiagnosisResult 讀真 Mongo
```

預期：全綠；`bullmq-lifecycle.int.test.ts` 的 QueueEvents `completed` 讀回 `{ result, cached }`、`progress` 讀回 `{ value, attempt, execution }`。

## 3. e2e（需 Docker；約 10～15 分鐘）

```powershell
corepack pnpm test:e2e                 # build → up --wait → 循序跑全部場景 → down -v
$env:E2E_KEEP = "1"; corepack pnpm test:e2e   # 保留容器排查；事後 docker compose -p flow-gatekeeper-e2e --profile demo down -v
```

| 場景 | 判準 | 看什麼 |
| --- | --- | --- |
| 1／2／4a／4b（既有） | SC-011 | 照過；場景 1 的 `completed` 現在帶 `result` 與 `cached:false` |
| 3a 串流中 SIGKILL、3b 首 token 前 SIGKILL | SC-001 | 場景輸出印 `maxGap`（< 45 s）、`W`（worker 冷啟動）；`waiting`＋`reason:"stalled"`、`execution` 遞增、最終 `completed`、無 `ai/error` |
| 5 Pub/Sub 每 50 ms 斷線 | SC-002 | 以帶 `result` 的 `job/status: completed` 收尾，`result` 通過 schema；`ai/done` 可有可無 |
| 6a api 重啟（job 期間完成） | SC-003 | 新連線 GET → 200 completed＋result；api healthy 後 60 s 內 |
| 6b api 重啟（job 仍在佇列） | SC-003 | 停 worker → POST → restart api → GET 200 waiting `rebound:true` → 啟動 worker → 新連線收到 `completed` |
| 7 Redis 停頓 50 s | SC-004 | `diagnosisTriggers` 該 jobId 恰 1 筆、worker 日誌 `LLM call` 恰 1 則、hit／miss 合計 1、`completed.cached === false` |
| 8 GET 回應形狀 | SC-005 | 隨機 jobId → 404；他人 socketId 查進行中 → 409 `job_bound_elsewhere`；同情境帶 `previousSocketId`＝原 socketId → 200 `rebound:true`；不在線 socketId → 409 `socket_unauthorized`；非 UUID socketId → 400；已完成任務以他人 socketId 查 → 200 completed |

## 4. 手動演練（一鍵 demo）

```powershell
docker compose --profile demo up -d --build      # http://localhost:8080
```

共通：開瀏覽器 DevTools（Network 取 POST `/diagnoses` 回應的 `jobId`；WS frames 取 `system/connected` 的 `clientId`）。
Redis 有設密碼時，下方 `redis-cli` 加 `--no-auth-warning -a <REDIS_PASSWORD>`。

### 演練 1：worker 崩潰（US3、SC-001）

1. 選「分揀機 05」按診斷，看到串流開始。
2. `docker compose kill -s SIGKILL worker`，隨即 `docker compose --profile demo start worker`。
3. 預期：面板維持「進行中」，出現「後端處理程序中斷，任務已重新排入佇列（第 2 次執行）」；串流清空後重新開始；不出現
   「超過 45 秒沒有收到進度…」；最終完成。
4. 記錄 `W`：`docker compose logs --timestamps worker | Select-String "worker ready"` 最後一則的時間減去步驟 2 的時間，寫進驗收紀錄
   （`W ≤ 15 s` 時 35 s 上界成立，見 plan 風險 1）。

### 演練 2：Pub/Sub 斷線（US1、SC-002）

1. 按診斷後立刻執行（20 秒內每 50 ms 斷一次 Pub/Sub 訂閱）：

   ```powershell
   docker compose exec -T redis sh -c 'end=$(( $(date +%s) + 20 )); while [ $(date +%s) -lt $end ]; do redis-cli CLIENT KILL TYPE pubsub >/dev/null; sleep 0.05; done'
   ```

2. 預期：面板轉「已完成」、顯示嚴重度與建議動作；**不**出現「結果未送達」；原始串流標題為「原始串流（不完整）」。

### 演練 3：api 重啟續接（US2、SC-003）

1. 按診斷，串流開始後 `docker compose restart api`。
2. 預期：頂列連線狀態短暫轉斷線後恢復；面板顯示「已重新連線，正在取回診斷狀態…」，接著轉「已完成」，完成 meta 有「重新連線後取回」，
   標題「原始串流（不完整）」。若 job 在 api 重啟期間尚未完成，則面板維持進行中、之後照常收到結果。
3. 補充（GET 直接驗）：`curl.exe -i "http://localhost:8080/diagnoses/<jobId>?socketId=<clientId>"` → 200 completed；換一個隨機 jobId → 404；
   `socketId` 換成隨機 UUID → 409 `socket_unauthorized`；`socketId=abc` → 400。

### 演練 4：Redis 停頓（US4、SC-004）

1. 按診斷，串流開始後 `docker compose pause redis`；等 50 秒；`docker compose unpause redis`。
2. 預期畫面：凍結期間沒有任何事件，約 45 秒時面板可能顯示「超過 45 秒沒有收到進度，結果未知，請重試」——這是 D11「結果未知」的語意
   （research R13）；恢復後按重試應秒回（命中快取）。
3. 預期後端（取步驟 1 的 jobId）：

   ```powershell
   # PowerShell 5.1 傳給原生程式時會吃掉內嵌的雙引號，JS 字串改用單引號（在 PS 單引號字串內寫成兩個單引號）
   docker compose exec -T mongo mongosh --quiet flow-gatekeeper --eval 'db.diagnosisTriggers.countDocuments({ jobId: ''<jobId>'' })'   # 1
   docker compose logs worker | Select-String '"msg":"LLM call"' | Select-String '<jobId>'                                            # 恰 1 行
   docker compose logs worker | Select-String 'idempotent short-circuit|cache hit' | Select-String '<jobId>'                         # 重派那次走的路徑
   ```

### 演練收尾

`docker compose --profile demo up -d`（拉回所有服務）；`docker compose ps -a` 四項就緒；`apps/worker/.env` 的 `AI_PROVIDER` 改回 `gemini`
後 `docker compose --profile demo up -d worker`。
