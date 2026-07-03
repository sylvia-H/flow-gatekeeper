# Phase 1 Data Model: Monitoring Console Fidelity

**全部為前端衍生／呈現型別**，存於 `apps/web` 記憶體（Pinia store 與純函式）。**不新增 `packages/contracts`**（FR-023）：契約型別（`MachineState`、`TelemetryPoint`、`JobStatus` 等）僅**消費**。下列型別皆定義在 `apps/web/src/domains/monitoring/lib/*` 或 `monitoring.store.ts`。

---

## 1. `DerivedEvent`（US3）— 前端衍生事件

檔案：`domains/monitoring/lib/events.ts`

```ts
export type Severity = "warning" | "critical"; // 只記門檻跨越/錯誤，不記回 healthy

export interface DerivedEvent {
  id: string;          // 唯一鍵（`${ts}-${machineId}`），供 v-for key
  ts: number;          // 產生時間（Date.now()，批次接收時刻）
  machineId: string;
  severity: Severity;  // = 轉入的 nextState
  message: string;     // 可讀短訊息，如 "Press 02 entered CRITICAL"
}
```

**產生規則**（`deriveTransitionEvent(prevState, nextState, machineId, ts) => DerivedEvent | null`）：

| prevState | nextState | 結果 |
| --- | --- | --- |
| `healthy` / `warning` / `undefined` | `warning` | 若 `nextState !== prevState` → 記 warning，否則 null |
| 任意 | `critical` | 若 `nextState !== prevState` → 記 critical，否則 null |
| 任意 | `healthy` | null（不記恢復事件） |
| `X` | `X` | null（同態抖動＝去重，FR-010） |

**保留規則**（`pushCapped(list, event, max=50)`）：新事件 unshift 到頂端，超過 50 筆時 pop 最舊；清單為顯示用、無持久化（FR-011、FR-012）。

---

## 2. `FleetHealthSummary`（US2）— 四類聚合

檔案：`domains/monitoring/lib/fleet-health.ts`

```ts
export interface FleetHealthSummary {
  healthy: number;
  warning: number;
  critical: number;
  stale: number;   // 含 never-reported 與 isStale(>10s)
  total: number;   // = roster.length（固定 5）
}
```

**聚合規則**（`fleetHealthOf(machines: Map<string, MachineLive>, now: number, roster: readonly string[]) => FleetHealthSummary`）：

- 逐一走 `roster`（不是走 `machines`），確保 `total` 穩定＝5。
- 每台：無快照 → `stale`；`isStale(snapshot.lastUpdated, now)` → `stale`；否則依 `snapshot.state`。
- 不變量：`healthy + warning + critical + stale === total`（SC-003）。
- 比例條由各類 / total 導出（呈現層計算，不入資料型別）。

**關係**：與 US1 卡片共用 `isStale`（design-spec §8.3，門檻 10s）；與契約 `MachineState`（healthy/warning/critical）對齊，stale 為前端衍生第四態（非契約 state）。

---

## 3. 卡片呈現衍生（US1）— 無新實體，純函式投影

檔案：`domains/monitoring/lib/telemetry-format.ts`（皆為 `MachineLive.telemetry` 的呈現投影，不改 store 型別）

```ts
export type MetricKey = "temperature" | "vibration" | "throughput" | "errorRate";

export function metricUnit(key: MetricKey): string;          // °C / mm/s / u/min / %
export function offendingMetrics(t: TelemetryPoint["telemetry"]): Record<MetricKey, "warn" | "crit" | null>;
export function relativeTimeLabel(lastUpdated: number, now: number): string; // "Ns ago"
```

**`offendingMetrics` 門檻**（鏡射 002 producer，R1）：

| metric | warn（染 amber） | crit（染 crit） |
| --- | --- | --- |
| temperature | `> 78` | `> 95` |
| vibration | `> 0.9` | `> 1.7` |
| errorRate | `> 0.04` | `> 0.12` |
| throughput | —（不參與） | — |

呈現：卡片對每個數值套 `offendingMetrics` 回傳的色 token；warning 態卡片邊框維持 `border-subtle` + `warn-bg` subtle inset（design-spec §7.3），**不加 warn 邊框**。狀態文字徽章由契約 `state` 決定（HEALTHY/WARNING/CRITICAL），與 `StatusLight` 一致。

---

## 4. `MachineGroup`（US6）— 靜態分組對照

檔案：`domains/monitoring/lib/machine-groups.ts`

```ts
export type MachineGroupName = "Prep" | "Forming & Baking" | "Fulfilment" | "Ungrouped";

export const MACHINE_GROUPS: { name: MachineGroupName; machineIds: string[] }[]; // 有序
export function machineGroup(machineId: string): MachineGroupName;               // 缺項 → "Ungrouped"
```

| Group | machineIds |
| --- | --- |
| Prep | `mixer-01` |
| Forming & Baking | `press-02`, `oven-04` |
| Fulfilment | `pack-03`, `sorter-05` |
| Ungrouped（fallback） | 對照缺項者 |

**關係**：比照 `machine-labels.ts` 靜態對照；sidebar 依 `MACHINE_GROUPS` 順序渲染，群組成員經 US4 search 過濾後為空則該群組標題可略。

---

## 5. `JobStep`（US7）— Drawer active 步驟（進度衍生）

檔案：`domains/ai-copilot/lib/`（就地擴充，衍生自既有 `CopilotJobState.progress`，不新增契約）

```ts
export type StepStatus = "done" | "active" | "todo";
export interface JobStep { milestone: 0|20|40|60|80|100; label: string; status: StepStatus; }

export function jobSteps(progress: number | undefined): JobStep[];
```

**規則**：里程碑標籤沿用 005 FR-018（0=job active、20=context、40=取鎖、60=首 token、80=解析成功、100=寫庫/發 ai/done）。依當前 `progress`：`milestone < progress` → done；涵蓋當前的里程碑 → active；其餘 → todo。`progress` 為 undefined（indeterminate）→ 首步 active、其餘 todo。**meta 全為靜態常數**（見 research R11）——契約 `JobStatus`／`CopilotJobState` 不帶 attempt/queue/concurrency，故不動態化：queue=`DIAGNOSIS_QUEUE`（import 契約常數值 `"diagnosis"`）、concurrency=`2`、attempts=`3`（忠實對映 003 worker/api 設定），**不呈現動態 attempt 計數**。

---

## 6. Store 新增狀態（`monitoring.store.ts`）

| 名稱 | 型別 | 種類 | 用途 / 規則 |
| --- | --- | --- | --- |
| `events` | `DerivedEvent[]` | state | US3 事件清單，上限 50；於 `applyTelemetryBatch` 衍生更新 |
| `latencyMs` | `number \| null` | state | US4 ping/pong RTT；`setLatency` 由 composable `onLatency` 餵；null＝尚無量測 |
| `paused` | `boolean` | state | US4 pause 開關；`togglePause` 切換；composable `isPaused()` 讀它決定是否 flush |
| `fleetHealth` | `FleetHealthSummary` | getter | US2 四類聚合，依賴 `machines` + `now`（每秒 tick 重算） |

**既有沿用**：`machines`（快照 Map）、`now`（每秒 tick）、`selectedMachineId`、`connectionStatus`、`machineList`。`applyTelemetryBatch` 內在覆寫每台快照**前**讀 prevState，呼叫 `deriveTransitionEvent` 累積事件（保持單一批次點，憲章 IV）。

---

**不變量總覽**（供測試與驗收）：

- FleetHealth 四類和 == `KNOWN_MACHINE_IDS.length`（=5）。
- `events.length <= 50`，且僅含 state 轉入 warning/critical 的筆數（同態抖動不產生）。
- 卡片 `state` 徽章 ∈ {HEALTHY,WARNING,CRITICAL}，與 `StatusLight` 同源（契約 `state`），amber 只作用於越界數值、不改盒模型。
- 全程無 `packages/contracts`／`apps/api`／`apps/worker` 型別新增或改動。
