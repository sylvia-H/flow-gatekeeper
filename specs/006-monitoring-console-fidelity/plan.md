# Implementation Plan: Monitoring Console Fidelity（監控台前端保真補完）

**Branch**: `006-monitoring-console-fidelity` | **Date**: 2026-07-03 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/006-monitoring-console-fidelity/spec.md`

## Summary

在 004（前端高頻 WebSocket 監控台）與 005（AI Copilot Drawer）之上，把 `apps/web/design/design-spec.md`／`refs/*.png` 已定義、但 004／005 漏做或沒對齊的**前端項目**補齊，**全部前端-only**：只消費 004 `monitoring.store` 既有 telemetry 與 005 既有診斷事件，**不新增 `packages/contracts` event/payload、不改 `apps/api`／`apps/worker`**（憲章 II/III、FR-023）。

七個 User Story 皆落在既有結構的**就地擴充**或**store 衍生**：

- **US1 卡片保真**（`MachineNodeCard.vue`）：加狀態文字徽章（HEALTHY/WARNING/CRITICAL）；warning 態改為 design-spec §7.3 的「邊框 subtle + warn-bg subtle inset」並把**越界的遙測數值**染 amber（門檻鏡射 002 mock producer 的 state 推導：temp>78/95、vib>0.9/1.7、err>0.04/0.12——純前端呈現，不動契約）；補單位（°C / mm/s / u/min / %）；時間戳由 `toLocaleTimeString()` 絕對時間改相對「Ns ago」，讀既有 `store.now`（每秒 tick，App.vue:78 已有）。全程不動卡片尺寸與 2×2 grid（FR-005）。
- **US2 Fleet Health** + **US3 Event Stream**：以 `monitoring.store` 的**衍生**達成，不新增資料流。`fleetHealth` getter 對固定名冊 `KNOWN_MACHINE_IDS`（5 台）聚合四類（healthy/warning/critical/stale），stale 沿用既有 `isStale(lastUpdated, now)`（>10s）；四類和恆等於 5（total）。事件在 `applyTelemetryBatch` 批次提交時，就地比對**每台前一個 state**，僅於「轉入 warning/critical」時 push 一筆並裁切到**最近 50 筆**（憲章 IV：仍在批次後更新、不逐筆 reactive）。新增兩個純呈現元件 `FleetHealth.vue`（sidebar 左下）、`EventStrip.vue`（main 底部，design-spec §7.8）。
- **US4 TopBar 保真**（`TopBar.vue` + 小改 store/composable）：pause/resume 控制 `useHighFrequencyWs` 的 rAF flush（暫停時**仍收訊息進 buffer、停止 flush**，resume 直接反映最新——FR-013/clarify）；connection chip 顯示 ping→pong RTT 毫秒（composable 量測 → `store.latencyMs`）；search 以 computed filter 既有名冊（過濾 sidebar 清單與卡片）。
- **US5 主區標題列**：main 頂加「Fleet monitor · N machines」標題列（N=名冊數），純呈現、**不含 Graph 視圖**。
- **US6 機台分組**：sidebar 依前端**靜態** group map 三組分區——Prep(`mixer-01`)／Forming & Baking(`press-02`,`oven-04`)／Fulfilment(`pack-03`,`sorter-05`)，比照 `machine-labels.ts` 靜態對照做法，含 fallback 群組。
- **US7 Drawer active 保真**（`CopilotDrawer.vue` active 區塊）：顯示 job 的 meta 與對應 005 進度里程碑（0/20/40/60/80/100）的步驟清單（已完成/進行中/待辦）。**meta 一律靜態標示、忠實對映 003 設定**（queue=`DIAGNOSIS_QUEUE`＝`"diagnosis"`，前端 import 契約常數值；concurrency=2；attempts=最多 3 次重試）——**契約 `JobStatus`／`CopilotJobState` 不帶 attempt/queue/concurrency，故不呈現動態 attempt 計數**（見 research R11）。步驟清單由既有 `job/status` 進度衍生，不新增事件。

護欄：所有視覺一律 design-spec 具名 token（憲章 II、FR-020）；新元件不逐筆 reactive、沿用 004 rAF 批次（憲章 IV、FR-021）；四 viewport 不溢出/重疊/layout shift、手機依 §6.2 退化（FR-022）；驗收 `git diff` 不含 `packages/contracts`、`apps/api`、`apps/worker`（FR-023）。

## Technical Context

**Language/Version**: TypeScript 5.6（strict，`noUncheckedIndexedAccess`），Vue 3.5 SFC，ESM。純前端變更。

**Primary Dependencies**:
- 既有（消費）：`vue@^3.5`、`pinia@^2.2`、`@flow-gatekeeper/contracts`（`MachineState`、`TelemetryPoint`、`JobStatus` 等型別，**僅消費、不改**）、`lucide-vue-next`（icon）、004 `monitoring.store`／`useHighFrequencyWs`／`isStale`／`machine-labels`、005 `copilot.store`／`copilot-reducer`。
- 新增套件：**無**。
- 測試（既有 devDeps）：`vitest`（node env）；純函式優先，元件測試才掛 `@vue/test-utils` + `jsdom`。

**Storage**: 前端無持久化。所有新狀態（events、latency、paused）存 Pinia `monitoring.store`（記憶體）。事件為前端衍生、跨重整不留存（spec 已知取捨）。

**Testing**: Vitest。純函式/衍生優先，不需 DOM：
- `fleetHealthOf(machines, now, roster)` 四類聚合（含 stale、never-reported 併入 stale、和=roster 長度）。
- `deriveTransitionEvent(prevState, nextState, machineId, ts)` 僅於轉入 warning/critical 回事件、否則 null（去重＝僅狀態轉換）。
- `pushCapped(list, event, 50)` 上限裁切（保最新 50、淘汰最舊）。
- `offendingMetrics(telemetry)` / `metricUnit(key)`（US1 amber 與單位判定）。
- `relativeTimeLabel(lastUpdated, now)`（「Ns ago」邊界）。
- `machineGroup(machineId)` 三組對照與 fallback。
- `filterMachineIds(roster, query)`（US4 search）。
- pause/RTT 屬 composable 副作用，於 quickstart live 驗收（AC）覆蓋。

**Target Platform**: 現代瀏覽器（原生 WebSocket / rAF）；本機 Windows / PowerShell，`vite dev` :5173、Gateway/API :3000、worker 獨立 process、infra `docker compose`（Redis 7 + Mongo 7）。僅需前端與既有後端跑著即可驗收。

**Project Type**: pnpm monorepo。**唯一改動 `apps/web`**。`packages/contracts`、`apps/api`、`apps/worker` 一律不動（FR-023 為硬護欄，驗收以 `git diff` 佐證）。

**Performance Goals**（對應 Success Criteria）:
- 高頻遙測下無新的 long task（SC-009）：FleetHealth/EventStrip/卡片皆讀 store reactive 值，於 rAF 批次後才變（憲章 IV、FR-021）；事件衍生在 `applyTelemetryBatch` 內 O(batch) 完成，不另開高頻迴圈。
- 卡片狀態切換 layout shift = 0（SC-002）：徽章/單位為固定寬度靜態字串，warning 只換色不改盒模型。

**Constraints**（多為憲章／design-spec 既定，非本 plan 自由裁量）:
- **前端-only 硬護欄**：MUST NOT 動 `packages/contracts`/`apps/api`/`apps/worker`（FR-023、憲章 III）。事件來源為**前端衍生**（不新增 event/payload）。
- 高頻遙測 buffer + rAF 批次 MUST NOT 被破壞（憲章 IV、FR-021）：新增衍生一律在批次點（`applyTelemetryBatch`）或 reactive getter 內，禁止逐筆 telemetry 觸發重繪。
- 視覺一律 design-spec 具名 token，MUST NOT 散落 hex（憲章 II、FR-020、§9「禁止」）。
- stale 判定沿用既有 `isStale`（design-spec §8.3：`now - lastUpdated > 10_000`），US1 卡片與 US2 Fleet Health 共用同一判斷。
- strict TS、無 `any` 擴散（憲章 III）。

**Scale/Scope**: 5 台固定示範機台（沿用 004 `KNOWN_MACHINE_IDS`）。改動集中於 `apps/web`：`monitoring.store`（新增 getter/state/actions）、`useHighFrequencyWs`（pause flush 開關 + RTT 量測）、`MachineNodeCard`（US1 就地）、`TopBar`（US4）、`App.vue`（sidebar 分組 + FleetHealth/標題列/EventStrip 掛載、search 接線）、`CopilotDrawer`（US7 active 區塊）、新增 `FleetHealth.vue`／`EventStrip.vue` 與數個純函式 lib。

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| 原則 | 與本 feature 的關係 | 狀態 |
|------|--------------------|------|
| I. 規格驅動開發 | 於 `006-monitoring-console-fidelity` branch 走完整流程 specify→clarify→plan→…；不手貼 code 又跑 implement；merge 回 develop 用 `--no-ff` | ✅ PASS |
| II. 單一真實來源 | 視覺一律取 design-spec §7.2/§7.3/§7.6/§7.8 具名 token（warning inset、SeverityBadge、EventStrip、StatusLight）；型別取 `packages/contracts`，不另立平行定義；不新增 hex | ✅ PASS |
| III. 契約優先與全棧型別安全 | **不新增/不改**契約——事件為前端衍生、聚合為 store getter；strict TS、無 `any`；US1 amber 門檻為前端呈現常數（鏡射 002 producer），不進契約 | ✅ PASS |
| IV. 即時通道架構紀律 | 不新增通道；所有衍生（fleetHealth getter、事件 push）在 004 rAF 批次點或 reactive getter 內，MUST NOT 逐筆 telemetry 重繪；pause 只切 flush、不改通道 | ✅ PASS |
| V. AI 診斷紀律 | US7 只呈現既有 job/status 進度里程碑與 meta，不觸 provider/cache/schema 路徑（皆屬 003/005 後端），前端不繞過 | ✅ PASS |
| VI. 祕密與設定衛生 | 純前端呈現，不引入祕密、不新增設定檔 | ✅ N/A |
| VII. 資料可追溯性 | 前端不持久化；事件為前端衍生 UI 呈現、非歷史來源（歷史回放另案，spec 已界定），不違反「歷史 MUST 落 Mongo」（本 feature 不產生需持久化的歷史資料） | ✅ PASS |

**結論**：Constitution Check ✅ PASS（Phase 0 前）。無違反、無跨邊界例外、無 Complexity Tracking 項目。相較 005，本 feature 連 005 的「worker 進度細化」跨邊界例外都沒有——是純 `apps/web` 變更。

## Project Structure

### Documentation (this feature)

```text
specs/006-monitoring-console-fidelity/
├── plan.md              # 本檔
├── research.md          # Phase 0 輸出（決策彙整）
├── data-model.md        # Phase 1 輸出（前端衍生實體）
├── quickstart.md        # Phase 1 輸出（live 驗收指引，逐 US）
├── contracts/
│   └── ui-surface.md    # Phase 1 輸出（store 新增 surface + 元件 props；明示「不動 packages/contracts」）
├── checklists/
│   └── requirements.md  # 已存在（specify/clarify 產出）
└── tasks.md             # Phase 2（/speckit-tasks 產出，非本命令）
```

### Source Code (repository root)

```text
apps/web/src/
├── domains/monitoring/
│   ├── stores/
│   │   ├── monitoring.store.ts            # 改：新增 fleetHealth getter、events state+衍生、latencyMs、paused + actions
│   │   └── monitoring.store.test.ts       # 改：補 fleetHealth/事件衍生/上限 的 store 測試
│   ├── composables/
│   │   └── useHighFrequencyWs.ts          # 改：pump 加 isPaused flush 開關；ping/pong RTT → onLatency
│   ├── components/
│   │   ├── MachineNodeCard.vue            # 改（US1）：狀態文字徽章、warning inset+amber 數值、單位、相對時間
│   │   ├── FleetHealth.vue                # 新增（US2）：四類計數＋比例條（design-spec §6 sidebar）
│   │   └── EventStrip.vue                 # 新增（US3）：最近事件列（design-spec §7.8）
│   └── lib/
│       ├── fleet-health.ts               # 新增：fleetHealthOf(machines, now, roster) 純函式
│       ├── fleet-health.test.ts
│       ├── events.ts                     # 新增：deriveTransitionEvent / pushCapped / DerivedEvent 型別
│       ├── events.test.ts
│       ├── telemetry-format.ts           # 新增：metricUnit / offendingMetrics / relativeTimeLabel
│       ├── telemetry-format.test.ts
│       ├── machine-groups.ts             # 新增：machineGroup(machineId) 三組對照 + fallback
│       ├── machine-groups.test.ts
│       ├── machine-search.ts             # 新增：filterMachineIds(roster, query)（US4）
│       └── machine-search.test.ts
├── shared/components/
│   └── TopBar.vue                        # 改（US4）：pause/resume 按鈕、chip 顯示 latencyMs、search 綁定
├── domains/ai-copilot/
│   ├── components/
│   │   └── CopilotDrawer.vue             # 改（US7）：active 區塊加 job meta（靜態標示）+ 步驟清單（衍生自既有進度）
│   └── lib/
│       ├── job-steps.ts                  # 新增（US7）：jobSteps(progress) 里程碑步驟純函式
│       └── job-steps.test.ts
└── App.vue                              # 改：sidebar 分組渲染 + FleetHealth 掛載、main 標題列 + EventStrip 掛載、search 狀態接線、pause 接線
```

**Structure Decision**: 沿用 004/005 已建立的 monorepo／domain 佈局與 design-spec §9 File Mapping 精神。US2/US3 的新元件落 `domains/monitoring/components`（資料源在 monitoring domain）；純函式一律拆進 `domains/monitoring/lib` 以利單測（呼應憲章「至少純函式單元測試」門檻）。**不新增 shared 元件**（FleetHealth/EventStrip 屬 monitoring 語意，非跨 domain 共用）。單一 WebSocket 連線與 store 資料流沿用 004，本 feature 只加**衍生**與**呈現**，不新增資料通道。

## Complexity Tracking

> 無 Constitution 違反，無需記錄。本 feature 為純 `apps/web` 前端呈現/衍生補齊，無跨邊界例外。
