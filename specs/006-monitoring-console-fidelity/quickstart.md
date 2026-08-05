# Quickstart / Live 驗收: Monitoring Console Fidelity

逐 User Story 的可重播 live 驗收指引。實作細節見 [plan.md](./plan.md)／[data-model.md](./data-model.md)／[contracts/ui-surface.md](./contracts/ui-surface.md)；本檔只列「怎麼跑、看到什麼算過」。

## 前置

1. **Infra**：`docker compose up -d`（Redis 7 + Mongo 7）。
2. **WS_AUTH_SECRET 陷阱**：`apps/api/.env` 的 `WS_AUTH_SECRET` MUST 清空（否則前端 dev 送空 token 會被拒、收不到遙測）。
3. 三端啟動（各自終端）：
   ```powershell
   pnpm --filter api start:dev      # Gateway/API :3000
   pnpm --filter worker start:dev   # worker（US7 需要）
   pnpm --filter web dev            # Vite :5173
   ```
4. 開瀏覽器 `http://localhost:5173`，等 connection chip 轉 **Connected**、卡片開始跳動。
5. mock producer 為決定性節拍（`press-02` 週期 critical、`oven-04` 週期 warning），故以下情境可重播。

## 單元測試（純函式，先跑）

```powershell
pnpm --filter web test
```

預期涵蓋（見 plan「Testing」）：`fleet-health`（四類和=5、含 stale）、`events`（僅轉入 warning/critical 記一筆、50 上限）、`telemetry-format`（單位、offendingMetrics 門檻、relativeTimeLabel）、`machine-groups`（三組 + fallback）、`machine-search`（過濾），以及 `monitoring.store` 的 fleetHealth/事件整合。全綠才進 live。

---

## US1 · 卡片保真（P1）

**做**：觀察任一卡片；等 `oven-04` 進 warning、`press-02` 進 critical。
**通過條件**：
- 每張卡片有狀態文字徽章 **HEALTHY/WARNING/CRITICAL**，與 StatusLight 顏色一致。
- warning 卡片：越界的數值（temp/vibration/error）**染 amber**，卡片**邊框仍 subtle**（無 warn 邊框），可見 warn-bg subtle inset。
- 數值帶單位：溫度 `°C`、振動 `mm/s`、吞吐 `u/min`、錯誤率 `%`。
- 時間戳為相對 **「Ns ago」** 且每秒遞增（非絕對時鐘時間）。
- hover / 選取 / critical pulse 切換時**卡片不位移**（對照 `refs/node-states.png` 六態；可用 DevTools 量測無 layout shift）。

## US2 · Fleet Health（P1）

**做**：看 sidebar 左下 Fleet Health 面板；斷開其中一台（或等其 >10s 未更新）使其 stale。
**通過條件**：
- 顯示 healthy/warning/critical/**stale** 四類計數與比例條。
- 四類計數之和 == 訂閱機台數（**5**），且與當下卡片狀態一致。
- 某台變 stale 時計入 stale 類、且仍計入 total（和仍為 5）。

## US3 · Event Stream（P2）

**做**：等 `press-02` 尖峰進 critical；持續觀察其在 critical 內抖動。
**通過條件**：
- main 底部 Event Stream 於該台**轉入** critical 的批次內新增一筆（timestamp mono / machineId / severity / 短訊息）。
- 該台維持 critical 期間的持續抖動**不重複新增**（僅狀態轉換記一筆）。
- 讓事件累積超過 50 筆 → 最舊者被淘汰、清單維持 ≤50。
- 重整頁面 → 舊事件不留存、由當下重新累積（已知取捨）。

## US4 · TopBar（P2）

**做**：按 pause / resume；觀察 connection chip；在 search 輸入 `press`。
**通過條件**：
- **pause** 後畫面停更（卡片/FleetHealth/EventStrip 凍結）；**resume** 後直接跳到最新（不逐格補放）。
- connection chip 於 Connected 時顯示合理 **延遲 ms**（隨心跳更新；首個 pong 前可為 `—`）。
- search `press` → sidebar 清單與主區卡片**同時**只留 `press-02`；清空恢復全部；查無相符顯示空狀態。

## US5 · 主區標題列（P3）

**通過條件**：main 頂顯示 **「Fleet monitor · 5 machines」**，N 與實際機台數一致；無 Graph 視圖。

## US6 · 機台分組（P3）

**通過條件**：sidebar 依三組標題分區——**Prep**(Mixer 01)／**Forming & Baking**(Press 02, Oven 04)／**Fulfilment**(Pack 03, Sorter 05)；每台恰屬一組。

## US7 · Drawer active 保真（P3）

**做**：選 `press-02` 按 Diagnose 進 active。
**通過條件**：drawer active 顯示 job **meta**（靜態標示：queue=`diagnosis`、concurrency=2、attempts=3，對映 003 設定；**無動態 attempt 計數**）與**步驟清單**；隨進度里程碑 0→20→40→60→80→100 推進，步驟由待辦→進行中→已完成。

---

## 全域護欄驗收

- **四 viewport**（1366×768 / 1440×900 / 390×844 / 768×1024）：無溢出/重疊/layout shift；手機版依 §6.2 退化（sidebar 收 sheet、Event strip 收合）。
- **高頻無 long task**：DevTools Performance 錄一段高頻遙測，無新增 long task（衍生皆在 rAF 批次點/reactive getter）。
- **護欄**：`git diff --name-only` 只含 `apps/web/**`（與本 specs 目錄）；**不得**出現 `packages/contracts`、`apps/api`、`apps/worker`（FR-023）。
- **視覺**：`git grep -nE "#[0-9a-fA-F]{3,6}" apps/web/src`（新增/改動檔）不得出現散落 hex（憲章 II／§9）。
