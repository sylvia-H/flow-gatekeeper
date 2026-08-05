# Quickstart 驗收指南: 即時 Gateway、遙測產生器與 MongoDB 歷史層

目的：在本機端到端證明本 feature 達標（對應 spec 的 SC-001~SC-008）。前端 rAF 整合留待 004，
此處用命令列 WebSocket 客戶端與資料庫查詢驗收。

## 前置

```powershell
docker compose up -d                 # Redis + MongoDB（本 feature 只用 Mongo）
Copy-Item .env.example apps/api/.env  # 若尚未建立；demo 可把 TELEMETRY_TTL_SECONDS 設小（如 3600）
pnpm install                          # 安裝（含本 feature 新增的 mongodb / platform-express / tsx / dotenv）
```

`wscat`（可選）：`npm i -g wscat`。若無，可改用最小 Node ws 腳本或 004 前端。

## 啟動

```powershell
pnpm --filter @flow-gatekeeper/api seed       # 種入 maintenanceRecords（SC-004）
pnpm --filter @flow-gatekeeper/api start:dev   # 啟動 API + ws Gateway（ws://localhost:3000/ws）
```

## 場景 1 — 依訂閱接收遙測、互不串流（US1 / SC-001、SC-002）

開兩個 `wscat` 連線，分別訂閱不相交機台：

```text
# 連線 A
wscat -c ws://localhost:3000/ws
> {"type":"machine/subscribe","token":"replace_me_dev_only","machineIds":["press-02"]}

# 連線 B（另一個終端）
wscat -c ws://localhost:3000/ws
> {"type":"machine/subscribe","token":"replace_me_dev_only","machineIds":["oven-04"]}
```

**預期**：
- 兩者連上即收到 `system/connected`（含各自 clientId），訂閱後收到 `machine/subscribed`。
- A 只持續收到 `press-02` 的 `TelemetryPoint[]`、B 只收到 `oven-04`，**互不串流**（SC-001）。
- 觀察 **≥ 60 秒**，會看到 `state` 出現 healthy↔warning↔critical 變化（SC-002）。

## 場景 2 — 心跳與授權（US3 / SC-006）

```text
> {"type":"ping"}                       # 預期回 {"type":"pong","ts":...}
> {"type":"machine/subscribe","token":"WRONG","machineIds":["press-02"]}
                                        # 預期回 {"type":"system/unauthorized"}，且不推送 press-02
> （直接關掉終端模擬斷線）              # server 應清理該連線訂閱
```

**半死連線（SC-005）**：拔網路/強制中斷而非正常關閉，等待至多 `WS_HEARTBEAT_MS`，server
應透過心跳探活判定失效並清理（可在 server log 觀察）。

## 場景 3 — 歷史落地與 errorlog 去重（US2 / SC-003、SC-004）

執行 **≥ 60 秒**後（停止產生再查，避免落地與觀察的時間差），用 `mongosh` 查：

```javascript
db = db.getSiblingDB('flow-gatekeeper')   // DB 名含連字號，依 MONGO_DB；不可用 `use flow-gatekeeper`
db.telemetry.countDocuments()                 // > 0，且涵蓋未被任何連線訂閱的機台（FR-009 全量）
db.telemetry.find({ "metadata.machineId": "sorter-05" }).sort({ timestamp: -1 }).limit(3)
db.errorlogs.find().sort({ timestamp: -1 }).limit(10)  // 僅「轉入 warning/critical」各一筆
db.maintenanceRecords.find()                  // ≥ 1（SC-004）
```

**預期**：
- `telemetry` 持續增長，且包含「沒人訂閱」的機台（證明落地與訂閱解耦，FR-009）。
- `errorlogs` 筆數 ≈ 機台進入 warning/critical 的**轉換次數**，連續同狀態不重複（SC-003）。

## 單元測試（FR-016 / SC-007）

```powershell
pnpm --filter @flow-gatekeeper/api test
```

**預期**：至少一支實際測試通過，覆蓋
`filterPointsForSubscription`（依訂閱過濾）與/或 `detectErrorTransitions`（errorlog 去重）。

## 契約檢查

```powershell
pnpm contract:lint    # 擴充後的 asyncapi.yaml 仍 0 違規
pnpm typecheck        # 全 workspace strict TS 通過（含 contracts 新型別）
```

## 對應驗收

| 場景/指令 | 對應 SC |
|-----------|---------|
| 場景 1 互不串流、狀態變化 | SC-001、SC-002 |
| 場景 3 telemetry/errorlog 查詢 | SC-003 |
| `seed` + maintenanceRecords 查詢 | SC-004 |
| 場景 2 斷線/半死清理 | SC-005 |
| 場景 2 無效授權被拒 | SC-006 |
| `pnpm --filter api test` | SC-007 |
| 量測串流期間推送間隔 p95 ≤ cadence × 2 | SC-008 |
