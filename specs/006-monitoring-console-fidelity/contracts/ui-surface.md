# UI Surface Contract: Monitoring Console Fidelity

本 feature **不新增/不改 `packages/contracts`**（FR-023、憲章 III）。此檔記錄的是 `apps/web` 內部的**前端介面表面**（store surface 與元件 props/emits），供 tasks 與實作對齊，非通訊契約。

> 通訊契約（消費，不變）：`MachineState`、`TelemetryPoint`、`JobStatus`／`CopilotJobState`（005）等一律取自 `@flow-gatekeeper/contracts` 與 004/005 既有型別，本 feature 只讀不改。

---

## A. `monitoring.store` 新增 surface

### Getters

| 名稱 | 回傳 | 說明 |
| --- | --- | --- |
| `fleetHealth` | `FleetHealthSummary` | 四類（healthy/warning/critical/stale）+ total；依 `machines`+`now` 重算（US2） |

### State（新增）

| 名稱 | 型別 | 初值 |
| --- | --- | --- |
| `events` | `DerivedEvent[]` | `[]`（US3，上限 50） |
| `latencyMs` | `number \| null` | `null`（US4） |
| `paused` | `boolean` | `false`（US4） |

### Actions（新增）

| 名稱 | 簽章 | 說明 |
| --- | --- | --- |
| `setLatency` | `(ms: number) => void` | 由 composable `onLatency` 呼叫（US4/R7） |
| `togglePause` | `() => void` | 切換 `paused`（US4/R6） |

### 既有 action 行為擴充

- `applyTelemetryBatch(batch)`：在覆寫每台快照**前**讀 prevState，對每台呼叫 `deriveTransitionEvent`，命中則 `pushCapped(events, e, 50)`。**維持單一批次點、批次後才更新 reactive**（憲章 IV／FR-021）。不改其簽章與既有背壓計數行為。

---

## B. `useHighFrequencyWs` option 擴充

新增兩個 optional option（既有 `onBatch`/`onStatus`/`onConnected`/`onDiagnosisEvent` 不變）：

```ts
interface UseHighFrequencyWsOptions {
  // ...既有...
  onLatency?: (ms: number) => void;   // pong 到達時回報 RTT（R7）
  isPaused?: () => boolean;           // pump 讀它：true 則跳過 flush、續存 buffer（R6）
}
```

- `pump()`：`if (options.isPaused?.()) { rafId = requestAnimationFrame(pump); return; }` 再進行 `buffer.splice/onBatch`。buffer 仍受 `maxBufferSize` 保護。
- ping 送出記 `lastPingAt`；`handleControlMessage` 的 `pong` 分支計 `Date.now()-lastPingAt` → `onLatency?.(ms)`。
- **不改**通道、心跳週期、重連、分流語意（憲章 IV）。

---

## C. 元件 props/emits

### `FleetHealth.vue`（新增，US2）

```ts
defineProps<{ summary: FleetHealthSummary }>();
```
呈現四類計數 + 比例條（design-spec 具名 token；sidebar 左下）。無 emit。

### `EventStrip.vue`（新增，US3）

```ts
defineProps<{ events: DerivedEvent[] }>();
```
列出最近事件（timestamp mono / machineId / severity / message；design-spec §7.8：高度 120–160px、row 32–40px）。無 emit。

### `MachineNodeCard.vue`（改，US1）

props/emits **不變**（`machine`/`machineId`/`selected`/`stale`；emit `select`/`diagnose`）。僅呈現層改：狀態文字徽章、warning inset+amber 數值、單位、相對時間。**不改尺寸**（min-h 148、2×2 grid），維持 FR-005。

### `TopBar.vue`（改，US4）

- 新增 pause/resume icon button → `store.togglePause()`；圖示依 `store.paused` 切換（play/pause）。
- connection chip 於 `store.connectionStatus==='connected'` 且 `store.latencyMs!=null` 時附 `{latencyMs}ms`。
- search input 綁 `v-model` → 上拋/共享 query（見 D）。

### `CopilotDrawer.vue`（改，US7）

active 呈現新增 job meta 區與步驟清單（衍生自既有 `state.progress`／`CopilotJobState`）。既有 props 不變。

---

## D. `App.vue` 接線

- **search query**：於 App 持有 `query` ref（或 monitoring store 亦可，擇一），`filterMachineIds(KNOWN_MACHINE_IDS, query)` 得 `visibleIds`；sidebar 群組渲染與 main 卡片渲染皆用 `visibleIds`（US4 同時過濾）。TopBar search 與此 query 綁定。
- **sidebar 分組**：以 `MACHINE_GROUPS` 為外層迴圈、群組內成員經 `visibleIds` 過濾渲染；群組底部掛 `FleetHealth :summary="store.fleetHealth"`。
- **main**：頂部標題列「Fleet monitor · {N} machines」（N=名冊長度）；底部掛 `EventStrip :events="store.events"`（design-spec §6.2 手機收合為 collapsible）。
- **pause 接線**：`useHighFrequencyWs({ ..., isPaused: () => store.paused, onLatency: store.setLatency })`。

---

**護欄驗證點**：完成後 `git diff --name-only` MUST 僅列 `apps/web/**`（與本 specs 目錄）；出現任何 `packages/contracts`／`apps/api`／`apps/worker` 檔案即違反 FR-023。
