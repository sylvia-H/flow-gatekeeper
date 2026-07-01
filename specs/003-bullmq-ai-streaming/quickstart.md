# Quickstart / 驗收指南: 診斷任務佇列、AI 串流診斷與 Redis 快取

可重播的端到端驗收腳本。實作細節見 [plan.md](./plan.md)、[data-model.md](./data-model.md)、
[contracts/](./contracts/)；本檔只列「怎麼跑、看到什麼算過」。環境為 Windows / PowerShell。

## 前置

1. `.env`（由 `.env.example` 複製）填入可用的 `GEMINI_API_KEY`；其餘 `AI_RPM`／`AI_CACHE_TTL_SECONDS`／
   `AI_DEDUPE_LOCK_SECONDS`／`AI_TIMEOUT_MS`／`REDIS_*`／`MONGO_*` 用預設即可。
2. 本機 infra：

   ```powershell
   docker compose up -d   # Redis 7 + MongoDB 7
   ```

3. 先讓 002 的遙測落地一段時間（`api start:dev` 跑 ≥ 60 秒），使 Mongo 有 telemetry/errorlogs 可組
   context；或執行 `pnpm --filter api seed` 補維修紀錄。

## Step 0：LLM 連通性 smoke（FR-017，接 queue 前先做）

```powershell
pnpm --filter worker smoke:gemini
```

**預期**：印出一句模型回覆（如 "flow-gatekeeper ready."）。失敗先修 API key／模型名／額度，**不要**
急著接 BullMQ。

## Step 1：啟動三方

```powershell
pnpm --filter api start:dev
pnpm --filter worker start:dev
```

**預期**：worker log 顯示已連 Redis／Mongo、Worker 就緒；api log 顯示 QueueEvents 與
`ai-stream:*` 訂閱已建立。

## Step 2：觸發一次診斷（US1 / SC-001）

純後端 smoke 時 `socketId` 可填任意字串（無 client 收 streaming，但 job 仍跑完、寫 Mongo、進 cache）。

```powershell
Invoke-RestMethod -Method Post -Uri http://localhost:3000/diagnoses `
  -ContentType "application/json" `
  -Body '{"machineId":"press-02","requestedBy":"demo","socketId":"manual-test"}'
```

**預期（通過條件）**：
- API 回 `{ jobId, machineId:"press-02", status:"waiting" }`。
- worker log 顯示 job `active`；Redis `ai-stream:<jobId>` 有 `ai/token` 陸續發布、最後 `ai/done`。
- 首個 `ai/token` 在 **≤ 5 秒**出現；單次診斷（cache miss）在 **AI 逾時 + 開銷（≤ 35 秒）** 內完成（SC-001）。
- 若接了真前端（004）或 `wscat` 訂閱：發起連線依序收到 `ai/token`（`seq` 遞增）→ `ai/done`
  （含通過 schema 的 `result`），並收到 `job/status` 由 waiting→active→completed。

驗證串流可用 `wscat`（連線後從 `system/connected` 取 `clientId`，用該 `clientId` 當 `socketId`）：

```powershell
wscat -c ws://localhost:3000/ws
# 收到 {"type":"system/connected","clientId":"..."} 後，用該 clientId 發 POST /diagnoses
```

## Step 3：Cache hit（US2 / SC-002）

在同一機台**同一狀態**下再次 POST `/diagnoses`（緊接 Step 2，於 `AI_CACHE_TTL_SECONDS` 內）。

**預期**：
- 第二次的 `ai/done` 帶 `cached:true`，且 worker log **無新的 LLM 呼叫**。
- MongoDB `diagnoses` **不因命中新增結果**；`diagnosisTriggers` 兩次觸發皆有稽核（一筆 `cached:false`、
  一筆 `cached:true`）。

## Step 4：速率限制與並發去重（US2 / SC-003、SC-004）

一分鐘內連續發 20 個 request（可用迴圈）：

```powershell
1..20 | ForEach-Object {
  Invoke-RestMethod -Method Post -Uri http://localhost:3000/diagnoses `
    -ContentType "application/json" `
    -Body '{"machineId":"press-02","requestedBy":"load","socketId":"manual-test"}'
}
```

**預期**：一分鐘內實際 LLM 呼叫次數 ≤ `AI_RPM`（SC-003）；相同簽章同時湧入時，只有 1 次真正打 LLM，
其餘吃 cache（SC-004，觀察 worker log 的「取鎖／輪詢命中」）。

## Step 5：Worker 韌性（US3 / SC-005、SC-006）

1. **worker 未運行時觸發**：停掉 worker，POST `/diagnoses` → API 仍回 `jobId`、api 不崩潰、job 進
   waiting；重啟 worker → 積壓 job 被消化（SC-005）。
2. **處理中途關 worker**：診斷進行中 `Ctrl-C` worker → api 與 ws 連線存活、不崩潰（SC-006）；job 依
   `attempts` 由後續 worker 重試。

## Step 6：驗證失敗路徑（SC-007）

以會產生非法結構的情境（如暫時把 prompt 改壞或模型回非 JSON）觸發一次。

**預期**：發起連線收到 `ai/error`（`code:'schema_invalid'`）；`diagnoses` **無**該次未驗證結果。

## Step 7：可追溯性（SC-008）

```powershell
# 於 mongosh 檢查
# db.diagnoses.find({machineId:"press-02"}).sort({createdAt:-1})       -> 只有實際產生的結果
# db.diagnosisTriggers.find({machineId:"press-02"}).sort({createdAt:-1}) -> 每次觸發（含 cached:true）
```

**預期**：`diagnoses` 只含 cache miss 實際產生的結果；每次觸發（含命中）皆可在 `diagnosisTriggers`
追溯，且正確標示 `cached`。

## Step 8：單元測試（FR-018 / SC-009）

```powershell
pnpm --filter worker test
```

**預期**：`cache/signature.test.ts`（相同輸入決定性、不同 state/錯誤類型簽章改變）與
`lib/parse-result.test.ts`（壞 JSON 丟錯）通過。

## 品質門檻

```powershell
pnpm contract:lint    # asyncapi 未新增 WS 訊息，維持通過
pnpm -r typecheck
pnpm -r lint
pnpm -r test
```
