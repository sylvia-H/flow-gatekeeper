# Quickstart — 前端高頻 WebSocket Gatekeeper 監控台（驗收指南）

可重播的端到端驗收腳本。實作細節見 `plan.md` / `data-model.md` / `contracts/`；本檔只列「如何跑起來、看什麼、預期結果」。環境為 Windows / PowerShell。

## 前置

1. 相依已安裝：`pnpm install`（含新增的 `lucide-vue-next`、`vue-tsc`、`eslint-plugin-vue` 等）。
2. 本機 infra（供 002 Gateway/Mongo）：`docker compose up -d`（Redis 7 + MongoDB 7）。
3. `.env` 由 `.env.example` 複製：`Copy-Item .env.example .env`。dev 可**不設** `WS_AUTH_SECRET`（或留 `replace_me_dev_only`；前端送空 token，若伺服器設了祕密則訂閱會被拒——驗收前端「開放訂閱」時保持未設或改前端測試策略）。

## 啟動

```powershell
# 終端 1：API（含 WebSocket Gateway + mock telemetry producer）
pnpm --filter @flow-gatekeeper/api start:dev

# 終端 2：Web（Vite dev，:5173，/ws 由 proxy 轉發到 :3000）
pnpm --filter @flow-gatekeeper/web dev
```

開瀏覽器到 `http://localhost:5173`。

## 驗收情境

### AC1 — 第一屏是可操作監控台且即時更新（US1 / SC-001, SC-006）
- **預期**：進站即見監控台（node grid + 5 張卡片），非 landing page。冷啟動先看到 placeholder（數值 `—`）＋連線橫幅，連上後卡片開始跳動：溫/振/吞/錯即時更新、狀態燈變色、lastUpdated 走動。
- **重播特徵**（002 決定性 producer）：`press-02` 會週期性進入 critical（pulse）、`oven-04` 週期性 warning。
- 只呈現訂閱的 5 台，無其他機台串流。

### AC2 — 背壓比值可見（US2 / SC-002）
- **預期**：TopBar 的 `BackpressureBadge` 顯示類似 `... msgs · ... frames · N:1`，且 `msgs` 明顯 > `frames`（不需開 DevTools 即可看到）。比值隨頻率變化：因每則訊息含 5 台各一筆，下限約 5:1——`MOCK_TELEMETRY_INTERVAL_MS=50` 時約 5:1、`=10` 時約 8:1、**`≤8`（如 5）時 ≥ 10:1**。
- 驗收 **≥ 10:1** 時把 `MOCK_TELEMETRY_INTERVAL_MS` 設為 **5**（改 `apps/api/.env` 重啟 api）；把值調小可見比值**上升**。

### AC3 — 高頻不卡頓（SC-001）
- 於 `MOCK_TELEMETRY_INTERVAL_MS=10` 下開 DevTools Performance 錄 30 秒：**無明顯 long task**；捲動與點選卡片即時回應（<100ms 體感）。
- 佐證背壓：reactive 提交次數（`renderedBatches`）遠少於訊息數（`receivedMessages`）。

### AC4 — 斷線自動重連（US3 / SC-003）
- 關掉 API（終端 1 Ctrl+C）。**預期**：非使用者主動的斷線會立即進入重連，故 connection chip 轉 **`Reconnecting`（黃）**＋橫幅「顯示最後已知資料」；資料保留、逾 10s 標 stale，畫面**不清空**。（`Disconnected`（紅）保留給冷啟動尚未連上與主動關閉／卸載；非預期斷線直接走 reconnecting，見 data-model §3、FR-015。）
- 重開 API。**預期**：chip 於 ~30s 內回到 `Connected`（綠），前端**自動重新訂閱**、卡片恢復更新。

### AC5 — 選取與 stale（US1 / US3 / SC-005）
- 點某張卡片：該卡呈現 selected（accent 邊框），`selectedMachineId` 設定（供 005）。
- 讓某台 >10s 無更新（或斷線後觀察）：該卡 opacity 降、顯示 `Stale` badge，但**數值仍在**（不清零）。

### AC6 — 響應式無溢出（SC-004）
- 在 1366×768、1440×900、390×844、768×1024 檢視：卡片文字不溢出、不重疊；hover/selected/critical pulse **不造成 layout shift**。

## 品質門檻（合併前）

```powershell
pnpm --filter @flow-gatekeeper/web typecheck   # vue-tsc：含 .vue，strict 無 any
pnpm --filter @flow-gatekeeper/web lint         # eslint（含 eslint-plugin-vue）
pnpm --filter @flow-gatekeeper/web test         # vitest：批次關係/backoff/stale/label 純函式與 store 單測
pnpm --filter @flow-gatekeeper/web build        # vite build 成功
```

- **測試門檻（憲章）**：`monitoring.store.test.ts` 斷言「收 N×3 筆 → renderedBatches=3 → batchRatio=round(N)」；`backoff.test.ts` 上界/單調；`stale.test.ts` 門檻；`machine-labels.test.ts` fallback。
- **可重播驗收**：沿用 002 決定性 mock producer，AC1/AC2 可重現。
