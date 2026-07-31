# Quickstart：Observability Baseline 驗收演練

**Feature**: 009-Observability-Baseline | **Date**: 2026-07-20
**用途**: 逐項驗證 spec 的 SC-001 ~ SC-007。每個場景可獨立執行、可重播。

> 形狀細節不在此重複，見 [contracts/](./contracts/) 與 [data-model.md](./data-model.md)。
> 本檔只寫「怎麼跑、看到什麼算過」。

---

## 0. 前置

```powershell
# infra（Redis 7 + Mongo 7）
docker compose up -d redis mongo

# 相依（本 feature 新增 pino）
pnpm install

# 三端直跑（各開一個 PowerShell 視窗）
pnpm --filter @flow-gatekeeper/api    start:dev
pnpm --filter @flow-gatekeeper/worker start:dev
pnpm --filter @flow-gatekeeper/web    dev
```

**⚠️ 既知陷阱**：`apps/api/.env` 的 `WS_AUTH_SECRET` 若有值，未帶 token 的 ws 訂閱會被拒。
純觀測驗收（場景 1–5）不受影響；場景 6 需要前端實際訂閱，請確認該值為空或前端帶對 token。

---

## 場景 1 — 結構化日誌與 `LOG_LEVEL`（SC-001、SC-005 前半）

**驗 FR-001／FR-003／FR-004**

1. 啟動 api 與 worker，觀察兩者輸出。
2. 停掉，改以 production 模式看純 JSON：

```powershell
$env:NODE_ENV="production"; $env:LOG_LEVEL="info"
pnpm --filter @flow-gatekeeper/api start:dev
```

3. 再測等級過濾：

```powershell
$env:LOG_LEVEL="warn"
```

**通過判準**：
- [x] dev 模式為 pretty、production 模式每行皆為合法 JSON（可用 `ConvertFrom-Json` 逐行驗）。
- [x] 每筆皆含 `level`、`time`、`service`、`context`、`msg`（data-model E1）。
- [x] 兩端格式一致（同一組共通欄位），**無**兩套並存格式。
- [x] `LOG_LEVEL=warn` 後 info 級雜訊消失，warn／error 仍在。
- [x] 服務運行期無殘留純文字 `console.log`（`seed.ts`／`smoke-gemini.ts` 為 CLI 腳本，
      依 contracts/log-fields.md §8 刻意不納入）。

### 1.1 非法設定值的回退與警告（FR-003／FR-008）

```powershell
$env:LOG_LEVEL="loud"; $env:METRICS_INTERVAL_MS="1000"
pnpm --filter @flow-gatekeeper/api start:dev
```

- [x] 行程**照常啟動**（不因非法值中止）。
- [x] 啟動時輸出一則 `warn`，載明收到 `LOG_LEVEL=loud`、實際採用 `info`。
- [x] 另一則 `warn` 說明 `METRICS_INTERVAL_MS=1000` 低於下限 5000，已回退至預設 60000。

---

## 場景 2 — 用 jobId 串接跨行程事件序列（SC-002）

**驗 FR-002**

1. 三端就緒後，於前端對任一機台觸發 AI 診斷（或直接 `POST /diagnoses`）。
2. 從 api 日誌取得該次 `jobId`，在**兩端**日誌中以該值過濾：

```powershell
# 對 production JSON 輸出（假設已導向檔案）
Get-Content api.log, worker.log | ForEach-Object { $_ | ConvertFrom-Json } |
  Where-Object { $_.jobId -eq "<貼上 jobId>" } | Format-Table time, service, context, msg
```

**通過判準**：
- [x] 能串起「api 接收 → queue 派送 → worker 領取／處理 → 結果回傳」的完整序列。
- [x] `jobId` 是**獨立欄位**（可過濾），不是只出現在 `msg` 字串裡。
- [x] 相關事件另帶 `machineId`；ws 連線事件帶 `clientId`。
- [x] **無需**靠時間戳猜測對應關係。

---

## 場景 3 — 健康端點反映依賴狀態（SC-003）

**驗 FR-005／FR-006／FR-007**

```powershell
# 3.1 全正常
curl.exe -i http://127.0.0.1:3000/healthz

# 3.2 停掉 Redis
docker compose stop redis
Start-Sleep -Seconds 3
curl.exe -i http://127.0.0.1:3000/healthz

# 3.3 恢復
docker compose start redis
Start-Sleep -Seconds 5
curl.exe -i http://127.0.0.1:3000/healthz

# 3.4 對 Mongo 重複 3.2–3.3
docker compose stop mongo   # …再 start
```

**通過判準**：
- [x] 3.1 回 **HTTP 200**，body `status: "healthy"`，兩個依賴皆 `up` 且有 `latencyMs`。
- [x] 3.2 於**數秒內**回 **HTTP 503**，`status: "unhealthy"`，`dependencies.redis.status = "down"`
      且 `error` 有值；**`mongo` 仍為 `up`**（二態整體不健康，但 body 仍指出是哪一個出問題）。
- [x] 3.3 回復 200。
- [x] 3.4 對 Mongo 行為對稱。
- [x] **回應不阻塞**：3.2 的請求在 ~2 秒內返回（`HEALTH_PROBE_TIMEOUT_MS`），非長時間掛住。

### 3.5 容器 healthcheck 已改走 `/healthz`（R4a）

```powershell
docker compose up -d --build
docker compose ps            # api 應轉 healthy
docker compose stop redis
# ⚠️ compose 的 api healthcheck 為 interval 30s / retries 3 ——需「連續 3 次」失敗才翻牌，
#    最壞約 90s+。等 60s 會看到仍是 healthy 而誤判為失敗，故取 120s 留餘裕。
Start-Sleep -Seconds 120
docker compose ps            # api 應轉 unhealthy
docker compose start redis
Start-Sleep -Seconds 60      # 恢復只需單次成功探測（interval 30s）
docker compose ps            # api 應轉回 healthy
```

- [x] 停 Redis 後 api 容器最終轉 `unhealthy`（008 的 `/ws` 握手探活**做不到**這件事——
      這正是本 feature 補上的深度）。**判準是「最終翻牌」而非「多久翻牌」**——翻牌延遲由
      compose 的 `interval`／`retries` 決定，不是端點的反應速度；端點本身的 5 秒內反應
      已由場景 3.2 驗過（SC-003）。
- [x] 恢復 Redis 後 api 容器轉回 `healthy`。

```powershell
docker compose logs api --tail 20
docker compose logs worker --tail 20
```

- [x] 容器內 api／worker 的日誌**每行皆為合法 JSON**——這同時證明 `pino` 已隨
      `packages/shared` 正確進入 production image（而 `pino-pretty` 未進，故無 pretty 輸出）。

---

## 場景 4 — 指標週期摘要入日誌（SC-004）

**驗 FR-008／FR-009**

1. 讓系統承載遙測至少 2 分鐘，期間觸發**至少兩次**同一機台的診斷
   （第二次應命中快取，使命中率非 0）。
2. 觀察 api 日誌中 `context: "metrics"` 的紀錄。

**通過判準**：
- [x] 每 `METRICS_INTERVAL_MS`（預設 60000）出現**一則** api 摘要。
- [x] 四項齊全：`queue.{waiting,active,failed}`、`wsConnections`、
      `worker.llmLatency.*`、`worker.cache.hitRate`。
- [x] worker 日誌另有**自身那半**的摘要（可獨立判讀）。
- [x] `cache.hitRate` 反映實際命中（兩次同機台診斷後應 > 0）。
- [x] **FR-009**：高頻遙測**未**逐筆入日誌——一分鐘內約 1200 次 telemetry tick，
      但日誌不應因此暴增（正常路徑零日誌）。

### 4.1 worker 缺席時的降級

```powershell
# 停掉 worker，等待超過 3 個週期（預設 180s）
```

- [x] api 摘要**仍照常輸出**，`worker` 欄位為 `null`，api 那兩項指標正常。

---

## 場景 5 — 指標摘要不被 `LOG_LEVEL` 濾掉（SC-005 後半）

```powershell
$env:LOG_LEVEL="warn"    # 一般 info 雜訊應消失
# METRICS_LOG_LEVEL 保持預設 info
```

**通過判準**：
- [x] 一般 info 級日誌消失（**api 與 worker 兩端皆須確認**）。
- [x] **api 側** `context: "metrics"` 的週期摘要仍持續輸出。
- [x] **worker 側** `context: "metrics"` 的自身摘要**亦仍持續輸出**——worker 的摘要同樣走專屬
      metrics child logger（contracts/log-fields.md §3／§5），若此處消失即代表 worker 側誤用了
      一般 logger，SC-005 不成立。

---

## 場景 6 — web dev 指標面板（SC-004 後半、FR-008a）

**前置**：
1. `apps/api/.env` 的 `WS_AUTH_SECRET` 須為空，或前端帶對 token（見 §0 既知陷阱）——
   本場景需要前端實際連上 ws，未授權會讓面板永遠收不到快照。
2. 旗標放 **`apps/web/.env`**（Vite 的 env 根目錄是 `apps/web/`，根目錄 `.env` 的 `VITE_` 變數
   讀不到）：

```powershell
# apps/web/.env（可從 apps/web/.env.example 複製）
# VITE_METRICS_PANEL=true
pnpm --filter @flow-gatekeeper/web dev
```

**通過判準**：
- [x] TopBar 出現指標面板入口，**預設收合**；展開後顯示四項指標。
- [x] 面板數值與同一時刻的 api 日誌摘要**一致**（ws payload 與日誌行同源、逐欄位比對已於
      自動化演練驗證；面板即渲染該 payload，畫面數值 `queue 0/0/0`／`wsConnections 1` 相符）。
- [x] 面板為**唯讀**——無任何可觸發後端動作的控制項。
- [x] `VITE_METRICS_PANEL` 未設或為 `false` 時（production build 預設），面板**不渲染**，
      首屏與改動前逐項一致（以 `pnpm --filter @flow-gatekeeper/web exec vite preview` 驗證；
      判別關鍵：Mock Hz 與背壓 badge **仍在**、只有 Metrics 入口消失，證明是旗標關閉而非
      TopBar 容器查詢隱藏次要項）。
- [x] **憲章 IV 邊界**：`system/metrics` 未進 rAF buffer——面板依 `windowMs` 自成節奏更新，
      且 `BackpressureBadge` 的背壓比值全程維持 11–13:1、與改動前同量級（未被污染）。

### 6.2 面板四態：`empty` / `live` / `stale` / `disconnected`（FR-008a）

面板狀態機見 contracts/metrics-summary.md §2.1。**`stale`（後端停更）與 `disconnected`（前端沒連上）
必須分開驗**——停掉 api 會同時斷 ws，只驗那一步無法證實過期樣態成立。

**(a) `empty`**：面板開啟後、收到第一則快照之前（最長一個週期）

- [x] 呈現「尚無資料」，**不是**過期樣態（此時無 `collectedAt`／`windowMs` 可算門檻）。

**(b) `live` → `stale`**：ws 保持連線，只讓後端停止廣播

```powershell
# 面板已看到一次快照後，於 api 端停掉指標廣播但保持 ws 連線：
# 最省事的做法是把 METRICS_INTERVAL_MS 調大後重啟 api，
# 再等超過「舊 windowMs × 2」（例如原 60s → 面板應在 ~120s 後轉 stale）
```

- [x] 超過 **2 × 最近一則 payload 的 `windowMs`** 未收到新快照後，面板轉為 **`stale`**
      （以 `docker compose stop redis` 停止後端結算、ws 全程不斷線；`14s ago · 5s window`）。
- [x] `stale` 時數值**不再看起來像即時值**——黃色樣態 + 「已連線，但逾兩個週期未收到新摘要
      ——後端指標可能停止廣播」，且 TopBar 仍是綠色 Connected，兩者對比一眼可辨。
- [x] 收到下一則廣播後自動轉回 `live`。

**(c) `disconnected`**：停掉 api（ws 直接斷線），瀏覽器不重整

- [x] 面板轉為 **`disconnected`**，且**文案／視覺與 `stale` 明顯不同**——紅色 `Offline` +
      「即時通道未連線——顯示的是最後已知數值，與後端是否仍在產指標無關」，TopBar 同步轉為
      Reconnecting 並顯示橫幅；與上一節的黃色 `Stale`（TopBar 仍綠）不會混淆。
- [x] api 重啟、ws 重連並收到下一則廣播後，面板轉回 `live`。

### 6.1 pino 未進入瀏覽器 bundle（research R10）

```powershell
pnpm --filter @flow-gatekeeper/web build
Select-String -Path apps/web/dist/assets/*.js -Pattern "pino" -SimpleMatch
```

- [x] **無**任何命中。

---

## 場景 7 — 有損寫入語意明文化（SC-006）

**驗 FR-011**

對照三處，確認敘述一致且與程式行為相符：

1. `apps/api/src/modules/history/history.service.ts` 的 `persistBatch` 註解
2. `apps/api/src/lib/errorlog-transition.ts`／`lastState` 的去重註解
3. `README.md` 的「已宣告的取捨」小節

**通過判準**：
- [x] 三處皆載明「telemetry 為 fire-and-forget，API 崩潰時可丟失最後數秒」。
- [x] 三處皆載明「errorlog 去重靠行程內 Map，**重啟後首筆會重複**」。
- [x] 皆引用 `ADR-002 §6.4`，且升級路徑（寫入前先進佇列再批次落庫）一致。
- [x] 與程式實際行為相符——`persistBatch` 確為 `void` 呼叫、未 await（gateway.ts:138）。
- [x] US4 **未改動任何程式行為**（`git diff` 僅見註解與文件）。

---

## 場景 8 — 三端零行為回歸（SC-007）⭐ 最關鍵

**驗 FR-012**。逐項與改動前對照，任一項不一致即為失敗。

| # | 項目 | 判準 |
| --- | --- | --- |
| 8.1 | 遙測推送 | 卡片更新流暢，cadence 與改動前一致（預設 50ms tick） |
| 8.2 | 背壓比值 | `BackpressureBadge` 的收訊/渲染比值與改動前同量級 |
| 8.3 | AI 診斷 streaming | token 逐字浮現，`job/status` 進度里程碑 0→20→40→60→80→100 完整 |
| 8.4 | 快取命中 | 同機台第二次診斷回 `cached: true`，**不**再打 LLM |
| 8.5 | 訂閱與授權 | `machine/subscribe` 取代式語意、未授權回 `system/unauthorized` 不變 |
| 8.6 | 優雅關閉 | api／worker 收 SIGTERM 皆以 exit 0 收尾，未被監督者誤判為崩潰 |
| 8.7 | worker 致命語意 | `WORKER_CHAOS` 演練：致命訊息仍以**純文字同步**寫出、exit 1、監督者重啟（007 契約未被 pino 破壞） |
| 8.8 | 持久化 | Mongo 各 collection 的文件形狀與寫入時機與改動前一致 |
| 8.9 | 007 heartbeat 共存 | `redis-cli TTL worker:heartbeat` 仍為 007 的 30s 語意、值與消費者未變；009 只新增 `metrics:worker`（TTL 180s），**兩者未互相取代或覆寫**（FR-010／data-model E4） |

**通過判準**：
- [x] 8.3–8.9 全部與改動前逐項一致（2026-07-31 實跑：8.3 里程碑 0→20→40→60→80→100 完整；
      8.4 第二次診斷 `cached: true` 且無 LLM 呼叫；8.5 空 token 訂閱成立；8.6 容器 `stop`
      後 api／worker 皆 exit 0 且**關閉後無殘窗摘要**；8.7 見下；8.8 診斷／觸發文件照常寫入；
      8.9 `worker:heartbeat` TTL 仍為 30s 語意、`metrics:worker` 為獨立 key，互不覆寫）。
- [x] **8.7**——`WORKER_CHAOS=uncaught` 演練：致命訊息仍為
      `[worker] uncaughtException（致命，…）：…` 純文字同步寫出、exit code 1
      （contracts/log-fields.md §7：`fatal.ts` 是 FR-004 的唯一例外，未被 pino 破壞）。
- [x] 8.1／8.2 的**協定層**：遙測 cadence 與改動前一致（40 秒約 5100 筆＝50ms tick），
      `system/metrics` 為獨立訊息、**未混入遙測陣列**（故不進 rAF buffer、不污染比值分子）。
- [x] 8.1／8.2 的**畫面層**：五台卡片全程 `updated just now`、Fleet Health 正常聚合；
      `BackpressureBadge` 在 empty／live／stale／disconnected 各階段皆維持 11–13:1，
      與改動前同量級。

---

## 場景 9 — 自動化檢查

```powershell
pnpm -r typecheck
pnpm -r lint
pnpm -r test
```

**通過判準**：
- [x] 三項全綠。
- [x] 新增 **6** 個純函式測試皆存在且通過：`resolveLogLevel`、`resolveMetricsInterval`、
      `aggregateHealth`、`mergeMetrics`、`summarizeLatency`、`hitRate`（research R9）。

---

## 驗收總表

**演練日期**：2026-07-31（`/speckit-implement` 收尾）。**全部場景皆已實跑通過**——
後端與傳輸層以自動化演練驗證，瀏覽器畫面判準以實機逐項確認並截圖存證。

| SC | 場景 | 狀態 |
| --- | --- | --- |
| SC-001 | 1、1.1、3.5 | ☑ |
| SC-002 | 2 | ☑ |
| SC-003 | 3、3.5 | ☑ |
| SC-004 | 4、4.1、6、6.2 | ☑ |
| SC-005 | 1、5 | ☑ |
| SC-006 | 7 | ☑ |
| SC-007 | 8（8.1–8.9） | ☑ |

**演練中修出的四項缺失**（皆已各自 commit，非 spec 變更）：

1. `LOG_LEVEL` 回退警告缺 `context` 欄位（違反 data-model E1）。
2. 依賴中斷恢復時指標結算堆疊，出現同毫秒重複摘要——加重入防護。
3. 面板展開層被 AppLayout 的 `h-14 + overflow-hidden` header 裁掉、點了像沒反應——改
   `Teleport` 到 body（`position: fixed` 無效，因 `.tb-bar` 的 `container-type` 會成為
   fixed 子孫的 containing block）。
4. `empty` 狀態提示寫死「預設 60 秒」，非預設間隔下與實際不符——移除該數字。

**實機演練的兩個實務要點**（後續 feature 若要重跑本檔，先看這裡）：

- 把 `METRICS_INTERVAL_MS` 設為下限 `5000` 可把等待從 2 分鐘壓到 10 秒，且走的是同一條
  程式路徑（面板門檻由 payload 的 `windowMs` 推導）。**api 與 worker 兩邊都要設**，
  否則 worker 要滿一個預設週期才寫出第一份快照，面板會先顯示 `worker: null`。
- 驗 `stale` 用 `docker compose stop redis`（api 的 queue 讀取掛住 → 結算跳過），**ws 全程
  不斷線**；比「調大間隔後重啟 api」乾淨，後者會順帶斷 ws 而混淆兩態。
- 驗「旗標關閉不渲染」時 **TopBar 必須夠寬**：窄於 820px 時 Mock Hz／背壓 badge／Metrics
  會一起被容器查詢隱藏，會把「被隱藏」誤判為「旗標關閉」。判準是**前兩者仍在、只有
  Metrics 消失**。
