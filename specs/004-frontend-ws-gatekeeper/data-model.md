# Phase 1 Data Model — 前端高頻 WebSocket Gatekeeper 監控台

> ⚠️ **已變更（2026-09-27 盤點）**：下列原敘述已被 v1.0.0 之後的修復／升級改變；內文保留為歷史，現況以指南 §15.6「v1.0.0 之後的現況摘要」為準（`docs/Flow-Gatekeeper-SDD-完整實作指南.md`）。
>
> - §3：控制訊息「忽略 subscribed·unauthorized」→ `machine/subscribed` 用於歸零退避與判定連線就緒；`system/unauthorized` 以 TopBar chip 呈現。
> - §1：`batchRatio = receivedMessages / renderedBatches` → `droppedMessages` 一併計入比值；buffer 溢位改為合併。
> - §1：`machines: Map` 為一般 reactive state → 改 `shallowRef`。
> - §2：`nextBackoffDelay(attempt)` 的 attempt 歸零時機 → 在 `machine/subscribed` 才歸零。

前端無持久化；此處描述 **Pinia store 的記憶體狀態模型** 與相關純函式。型別以 `@flow-gatekeeper/contracts` 為單一來源（`TelemetryPoint`、`MachineState`、控制訊息聯集），本 feature 不新增契約。

## 1. Monitoring Store（`domains/monitoring/stores/monitoring.store.ts`）

### State

| 欄位 | 型別 | 說明 |
|------|------|------|
| `machines` | `Map<string, MachineLive>` | 每台機台最新一筆快照；key 為 machineId。只保留最新值（覆寫）。 |
| `selectedMachineId` | `string \| null` | 目前選取機台（至多一台）；供 selected 視覺與 005 診斷觸發。 |
| `connectionStatus` | `'connected' \| 'reconnecting' \| 'disconnected'` | 即時通道三態。初始 `'disconnected'`。 |
| `clientId` | `string \| null` | `system/connected` 派發的連線識別；保存供 005（POST /diagnoses 的 socketId）。 |
| `receivedMessages` | `number` | 累積收到的 telemetry 筆數（背壓分子）。 |
| `renderedBatches` | `number` | 累積 rAF 批次提交次數（背壓分母）。 |
| `now` | `number` | 低頻更新的當前時間戳，驅動 stale 重算（每秒一次）。 |

`MachineLive`（衍生自 `TelemetryPoint`，非契約新增，僅前端投影）：
```
machineId: string
state: MachineState                 // 'healthy' | 'warning' | 'critical'
telemetry: { temperature; vibration; throughput; errorRate }  // 來自 TelemetryPoint.telemetry
lastUpdated: number                 // 收到批次時的 Date.now()（或 payload timestamp 解析）
```
> 顯示名稱**不入** state，改由 `machineLabel(machineId)` 靜態對照（見 §3）。

### Getters

| Getter | 回傳 | 規則 |
|--------|------|------|
| `batchRatio` | `number` | `renderedBatches > 0 ? round(receivedMessages / renderedBatches) : 0`（design-spec §7.2.1、指南 §10.2）。 |
| `machineList` | `MachineLive[]` | 由 `machines` 值排序輸出（依 machineId 穩定排序）；**僅含已收到遙測者**。⚠️ 卡片渲染 MUST NOT 只依此 getter，否則冷啟動（Map 空）無法顯示 placeholder。渲染來源為固定名冊 `KNOWN_MACHINE_IDS`（見 §2），逐台向 `machines` 查快照、無則傳 `machine=null`。 |
| `selectedMachine` | `MachineLive \| null` | `selectedMachineId` 對應的快照，供 TopBar／005 使用。 |

### Actions

| Action | 簽章 | 行為 |
|--------|------|------|
| `applyTelemetryBatch` | `(batch: TelemetryPoint[]) => void` | 逐筆 `machines.set(point.machineId, project(point))` 並更新該台 `lastUpdated`；`receivedMessages += batch.length`；`renderedBatches += 1`。**每次呼叫 = 一個 rAF 幀 = 一次批次**（不論 batch 幾筆）。 |
| `selectMachine` | `(machineId: string) => void` | 設 `selectedMachineId`（同一時間至多一台）。 |
| `setConnectionStatus` | `(s) => void` | 更新三態。 |
| `setClientId` | `(id: string) => void` | 保存 `clientId`。 |
| `tickNow` | `() => void` | `now = Date.now()`，供 stale getter/卡片重算。 |

**測試要點（FR / 憲章測試門檻）**：呼叫 `applyTelemetryBatch` 三次、每次 N 筆 → `receivedMessages == 3N`、`renderedBatches == 3`、`batchRatio == round(N)`。此關係即「收 N 筆只批次渲染少數次」的核心斷言（`monitoring.store.test.ts`）。

## 2. 純函式 Helpers（`domains/monitoring/lib/`）

### `backoff.ts` — `nextBackoffDelay(attempt, maxMs = 30000)`
- 回傳 `min(1000 * 2^attempt, maxMs)` 為 base，加 `0..30%` 抖動（測試以固定或注入 rng 驗證上界與單調不減至 cap）。
- 對應 FR-013 指數退避＋抖動、SC-003。

### `stale.ts` — `isStale(lastUpdated, now, thresholdMs = 10000)`
- 回傳 `now - lastUpdated > thresholdMs`。對應 FR-017、SC-005、design-spec §8.3。

### `machine-labels.ts` — `KNOWN_MACHINE_IDS` + `machineLabel(machineId)`
- `KNOWN_MACHINE_IDS = ['mixer-01','press-02','pack-03','oven-04','sorter-05'] as const`——**5 台示範機台名冊的單一來源**，供「訂閱清單」「topology placeholder 渲染名冊」「label 對照」三處共用（避免名冊漂移）。
- 靜態表 `{ 'mixer-01':'Mixer 01', 'press-02':'Press 02', 'pack-03':'Pack 03', 'oven-04':'Oven 04', 'sorter-05':'Sorter 05' }`；缺項時回傳 `machineId` 本身（fallback）。對應 FR-006a、Clarify 決議。

## 3. 實體關係與生命週期

```
useHighFrequencyWs (composable)
  ├─ ws.onmessage
  │    ├─ Array<TelemetryPoint>  ─push→ buffer（非 reactive）
  │    └─ 控制訊息 ─分流→ onStatus / onConnected / (pong 清 timer) / 忽略 subscribed·unauthorized
  ├─ rAF pump（每幀）: buffer.splice(0) ─onBatch→ store.applyTelemetryBatch
  └─ heartbeat / reconnect(nextBackoffDelay) / onUnmounted 清理

store.machines(Map) ─machineList→ TopologyCanvas ─v-for→ MachineNodeCard
  MachineNodeCard: machineLabel(id) + state(StatusLight) + telemetry + isStale(lastUpdated, now)
store.{received,rendered} ─batchRatio→ BackpressureBadge
store.connectionStatus ─→ AppLayout / TopBar connection chip
store.selectedMachineId ─→ MachineNodeCard(selected 視覺)；保留供 005
```

**狀態轉移（連線）**：`disconnected` →(connect open)→ `connected` →(close/onerror,非 manual)→ `reconnecting` →(重試 open)→ `connected`；`manualClose`（unmount）→ 停止重連。

**狀態轉移（機台卡片）**：`placeholder`（尚無快照）→(首批到)→ `live`（healthy/warning/critical）→(>10s 無更新)→ `stale`（降透明＋badge，數值保留）→(新資料)→ `live`。
