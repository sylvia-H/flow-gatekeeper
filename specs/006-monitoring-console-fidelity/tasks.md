---
description: "Task list for Feature 006 — Monitoring Console Fidelity"
---

# Tasks: Monitoring Console Fidelity（監控台前端保真補完）

**Input**: Design documents from `/specs/006-monitoring-console-fidelity/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/ui-surface.md), [quickstart.md](./quickstart.md)

**Tests**: 本 feature **包含**純函式／store 單元測試——非 TDD 要求，而是憲章「測試門檻」規定每個 feature MUST 至少提供純函式單元測試作為驗收佐證（見 research R12）。所有分析核心（單位/門檻/聚合/事件衍生/分組/搜尋）抽成 `domains/monitoring/lib/*` 純函式並附測試；UI 呈現行為走 [quickstart.md](./quickstart.md) 的 US1–US7 live AC。

**Organization**: 依 user story（US1–US7）分階段，各階段可獨立實作與驗收。US 優先級：US1/US2 = P1、US3/US4 = P2、US5/US6/US7 = P3。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 可平行（不同檔案、無未完成相依）
- **[Story]**: US1–US7；Setup／Foundational／Polish 無 story 標籤
- 每個任務含明確檔案路徑

## Path Conventions

- **唯一改動 `apps/web/`**（Vue 3 + Pinia，沿用 004/005 domain 佈局）。`packages/contracts`、`apps/api`、`apps/worker` **一律不動**（FR-023 硬護欄，驗收以 `git diff` 佐證）。
- **共享編輯點提醒**：`apps/web/src/domains/monitoring/stores/monitoring.store.ts` 由 US2/US3/US4 各自新增區塊；`apps/web/src/App.vue` 由 US2/US3/US4/US5/US6 各自掛載/接線。這些檔案的任務**不得互相 [P]**（同檔），依 phase 順序串行套用；跨 US 的 lib 與新元件則可 [P]。

---

## Phase 1: Setup（共用基礎）

**Purpose**: 確立護欄基線；本 feature 無新相依、無新目錄（沿用既有 `domains/monitoring/{lib,components,stores}`）。

- [X] T001 確認無需新增任何相依，並確立 FR-023 護欄基線：記下當前 `git diff --name-only` 起點，實作全程 MUST 僅動 `apps/web/**`（出現 `packages/contracts`／`apps/api`／`apps/worker` 即違規）；於 apps/web 內不新增第三方套件

---

## Phase 2: Foundational（阻斷性前置——US 之前必須完成）

**Purpose**: 建立所有 US 元件所消費的**純函式分析層**（leaf 工具，彼此無相依、可全平行、可先行測試，滿足憲章測試門檻）。此階段完成即備妥單位/門檻/聚合/事件/分組/搜尋的決定性邏輯。

**⚠️ CRITICAL**: 本階段未完成前，US 的元件/接線任務不得開工（各元件依賴對應純函式）。

- [X] T002 [P] 建立 telemetry 呈現純函式於 apps/web/src/domains/monitoring/lib/telemetry-format.ts 與 telemetry-format.test.ts：`metricUnit(key)`（°C/mm/s/u/min/%）、`offendingMetrics(telemetry)`（門檻鏡射 002 mock-telemetry.service：temp>78/95、vib>0.9/1.7、err>0.04/0.12，throughput 不參與，回傳每 metric `"warn"|"crit"|null`）、`relativeTimeLabel(lastUpdated, now)`（「Ns ago」邊界）（data-model §3、research R1/R2/R3）
- [X] T003 [P] 建立 Fleet Health 聚合純函式於 apps/web/src/domains/monitoring/lib/fleet-health.ts 與 fleet-health.test.ts：`fleetHealthOf(machines, now, roster)` 回 `{healthy,warning,critical,stale,total}`，走 roster（固定 5 台）逐台判定（無快照或 `isStale`→stale，否則依 state），測試斷言**四類和 == roster.length**、never-reported 併入 stale（data-model §2、research R4）
- [X] T004 [P] 建立衍生事件純函式於 apps/web/src/domains/monitoring/lib/events.ts 與 events.test.ts：`DerivedEvent` 型別、`deriveTransitionEvent(prevState,nextState,machineId,ts)`（僅轉入 warning/critical 且 `next!==prev` 回一筆、否則 null）、`pushCapped(list,event,50)`（unshift 最新、裁到 50），測試涵蓋同態抖動去重與上限（data-model §1、research R5、FR-010/011）
- [X] T005 [P] 建立機台分組純函式於 apps/web/src/domains/monitoring/lib/machine-groups.ts 與 machine-groups.test.ts：有序 `MACHINE_GROUPS`（Prep=[mixer-01]、Forming & Baking=[press-02,oven-04]、Fulfilment=[pack-03,sorter-05]）與 `machineGroup(id)`（缺項→"Ungrouped"），測試斷言每台恰屬一組、缺項落 fallback（data-model §4、research R10、FR-017）
- [X] T006 [P] 建立機台搜尋純函式於 apps/web/src/domains/monitoring/lib/machine-search.ts 與 machine-search.test.ts：`filterMachineIds(roster, query)`——query 去空白小寫，對每台比對 `machineId` 與 `machineLabel(id)`，任一 `includes` 命中；空 query 回全部（research R8、FR-015）

**Checkpoint**: 分析層就緒且測試綠——各 US 可開始元件/接線

---

## Phase 3: User Story 1 — 機台卡片保真對齊 node-states (Priority: P1) 🎯 MVP

**Goal**: 卡片顯示狀態文字徽章、warning 態邊框 subtle + 越界數值染 amber、遙測帶單位、時間戳改相對「Ns ago」+ 絕對時間 tooltip，全程不造成 layout shift。

**Independent Test**: 讓 `oven-04` 進 warning、`press-02` 進 critical，對照 `refs/node-states.png` 檢查徽章/amber 數值/subtle 邊框/單位/相對時間+tooltip，切換 hover/selected/pulse 無位移（quickstart US1）。

### Implementation for User Story 1

- [X] T007 [US1] 就地擴充 apps/web/src/domains/monitoring/components/MachineNodeCard.vue：(a) 加狀態文字徽章 HEALTHY/WARNING/CRITICAL（讀契約 `machine.state`，與 `StatusLight` 同源、固定寬度）；(b) `stateClass` 的 warning 由 `border-warn-border` 改為 **`border-subtle` + warn-bg subtle inset**（design-spec §7.3），越界數值以 `offendingMetrics` 回傳色 token 染 amber/crit；(c) 各遙測值串接 `metricUnit`（°C/mm/s/u/min/%）；(d) `lastUpdated` 由 `toLocaleTimeString()` 改 `relativeTimeLabel(machine.lastUpdated, store.now)`，並在該元素加 `title`/tooltip 顯示絕對時間；全程維持 min-h 148 與 2×2 grid、不改盒模型（依賴 T002；FR-001/002/003/004/005）

**Checkpoint**: 卡片保真完成，可對照 node-states.png 六態獨立驗收（不動 store/App）。

---

## Phase 4: User Story 2 — Fleet Health 聚合面板 (Priority: P1)

**Goal**: sidebar 左下顯示 healthy/warning/critical/stale 四類計數與比例條，即時更新、四類和 == 5。

**Independent Test**: 讓機台落在不同狀態並斷開一台使其 stale，確認四類計數與比例條、和 == 訂閱數（5）、與卡片一致（quickstart US2）。

### Implementation for User Story 2

- [X] T008 [US2] 於 apps/web/src/domains/monitoring/stores/monitoring.store.ts 新增 `fleetHealth` getter，委派 `fleetHealthOf(machines, now, KNOWN_MACHINE_IDS)`（依賴 T003；contracts/ui-surface A、FR-006/007/008）
- [X] T009 [P] [US2] 建立 apps/web/src/domains/monitoring/components/FleetHealth.vue：`defineProps<{ summary: FleetHealthSummary }>()`，呈現四類計數 + 比例條（design-spec 具名 token；sidebar 左下版位）（依賴 T003 型別；FR-006/007）
- [X] T010 [US2] 於 apps/web/src/domains/monitoring/stores/monitoring.store.test.ts 補 `fleetHealth` getter 測試：四類和 == 5、stale（含 never-reported）計入、與 machines 狀態一致（依賴 T008）
- [X] T011 [US2] 於 apps/web/src/App.vue sidebar 底部掛 `<FleetHealth :summary="store.fleetHealth" />`（design-spec §6 左欄下方）（依賴 T008、T009）

**Checkpoint**: US1 + US2（皆 P1）完成 = 首個可展示增量。

---

## Phase 5: User Story 3 — Event Stream 事件列 (Priority: P2)

**Goal**: main 底部列出最近門檻跨越/錯誤事件（時間/機台/severity/短訊息），僅狀態轉換記一筆、上限 50。

**Independent Test**: 觸發 `press-02` 進 critical → 出現一筆；critical 內抖動不重複；累積超過 50 淘汰最舊；重整不留存（quickstart US3）。

### Implementation for User Story 3

- [X] T012 [US3] 於 apps/web/src/domains/monitoring/stores/monitoring.store.ts 新增 `events` state，並在 `applyTelemetryBatch` **覆寫每台快照前**讀 prevState，對每台呼叫 `deriveTransitionEvent`，命中則 `pushCapped(events, e, 50)`；**維持單一批次點、不逐筆 reactive**（依賴 T004；憲章 IV、FR-009/010/011/012）
- [X] T013 [P] [US3] 建立 apps/web/src/domains/monitoring/components/EventStrip.vue：`defineProps<{ events: DerivedEvent[] }>()`，列出 timestamp(mono)/machineId/severity/message（design-spec §7.8：高度 120–160px、row 32–40px）（依賴 T004 型別；FR-009）
- [X] T014 [US3] 於 apps/web/src/domains/monitoring/stores/monitoring.store.test.ts 補事件衍生測試：僅轉入 warning/critical 記一筆、同態抖動不重複、50 上限淘汰最舊（依賴 T012）
- [X] T015 [US3] 於 apps/web/src/App.vue main 底部掛 `<EventStrip :events="store.events" />`（手機依 §6.2 收合為 collapsible）（依賴 T012、T013）

**Checkpoint**: US1–US3 可獨立驗收。

---

## Phase 6: User Story 4 — TopBar 保真（pause/resume、延遲、search）(Priority: P2)

**Goal**: pause/resume 凍結/恢復畫面（續存 buffer、resume 跳最新）、connection chip 顯示 RTT ms、search 同時過濾 sidebar+卡片。

**Independent Test**: pause 後停更、resume 跳最新；chip 顯示合理 ms；search `press` 兩處同時只留 press-02、清空恢復（quickstart US4）。

### Implementation for User Story 4

- [X] T016 [US4] 於 apps/web/src/domains/monitoring/stores/monitoring.store.ts 新增 `paused`、`latencyMs` state 與 `togglePause`、`setLatency` actions（contracts/ui-surface A；FR-013/014）
- [X] T017 [US4] 於 apps/web/src/domains/monitoring/composables/useHighFrequencyWs.ts：`pump()` 在 `options.isPaused?.()` 為真時**跳過 flush、續存 buffer**（保留 rAF 迴圈與 maxBufferSize 保護）；送 ping 記 `lastPingAt`，`pong` 分支算 `Date.now()-lastPingAt` 呼叫 `onLatency?.(ms)`；不改通道/心跳/重連語意（憲章 IV；research R6/R7；FR-013/014）
- [X] T018 [US4] 於 apps/web/src/shared/components/TopBar.vue：加 pause/resume icon button（`store.togglePause()`，圖示依 `store.paused` 切換）；connection chip 於 connected 且 `latencyMs!=null` 時附 `{latencyMs}ms`（首個 pong 前顯 `—`）；search input 綁 `v-model` 上拋/共享 query（design-spec §7.2；FR-013/014/015）
- [X] T019 [US4] 於 apps/web/src/App.vue：`useHighFrequencyWs({ ..., isPaused: () => store.paused, onLatency: store.setLatency })`；持有 search `query`，以 `filterMachineIds(KNOWN_MACHINE_IDS, query)` 得 `visibleIds`，sidebar 清單與 main 卡片渲染皆改用 `visibleIds`（同時過濾）；查無相符時主區顯示空狀態（依賴 T006、T016、T017、T018；FR-015、SC-006、Edge Cases）

**Checkpoint**: US1–US4 可獨立驗收。

---

## Phase 7: User Story 5 — 主區標題列 (Priority: P3)

**Goal**: main 頂顯示「Fleet monitor · N machines」，N=名冊數，不含 Graph 視圖。

**Independent Test**: 進監控台，main 頂顯示「Fleet monitor · 5 machines」（quickstart US5）。

### Implementation for User Story 5

- [ ] T020 [US5] 於 apps/web/src/App.vue main 頂部（banner 之下、TopologyCanvas 之上）加標題列「Fleet monitor · {N} machines」，N=`KNOWN_MACHINE_IDS.length`；純呈現、不加 Grid/Graph 切換（FR-016）

**Checkpoint**: 標題列到位。

---

## Phase 8: User Story 6 — 機台分組（sidebar 分區）(Priority: P3)

**Goal**: sidebar 依三組（Prep/Forming & Baking/Fulfilment）標題分區，每台恰屬一組、缺項落 fallback。

**Independent Test**: sidebar 見三組標題與正確成員（quickstart US6）。

### Implementation for User Story 6

- [ ] T021 [US6] 於 apps/web/src/App.vue 改 sidebar 機台清單：外層以 `MACHINE_GROUPS` 迭代群組標題、內層列出該群組機台（經 US4 `visibleIds` 過濾後為空的群組可略標題）；沿用既有選取/樣式（依賴 T005；FR-017）

**Checkpoint**: sidebar 分組完成。

---

## Phase 9: User Story 7 — Drawer active 保真（任務 meta 與步驟）(Priority: P3)

**Goal**: drawer active 顯示 job meta（全靜態標示：queue=`diagnosis`、concurrency=2、attempts=3，對映 003；無動態 attempt 計數）與對應里程碑 0/20/40/60/80/100 的步驟清單（已完成/進行中/待辦）。

**Independent Test**: 選 `press-02` 按 Diagnose 進 active，見 meta 與步驟隨進度里程碑推進（quickstart US7）。

### Implementation for User Story 7

- [ ] T022 [P] [US7] 建立步驟純函式於 apps/web/src/domains/ai-copilot/lib/job-steps.ts 與 job-steps.test.ts：`JobStep`/`StepStatus` 型別、`jobSteps(progress)`——里程碑標籤沿用 005 FR-018（0/20/40/60/80/100），依 `progress` 標 done/active/todo，`undefined`→首步 active 其餘 todo（data-model §5、research R11）
- [ ] T023 [US7] 就地擴充 apps/web/src/domains/ai-copilot/components/CopilotDrawer.vue 的 **active** 呈現：加 job meta 區（**全靜態標示、忠實對映 003 設定**：queue=`DIAGNOSIS_QUEUE`（自 `@flow-gatekeeper/contracts` import 常數值 `"diagnosis"`）、concurrency=`2`、attempts=`3`；**不呈現動態 attempt 計數**——契約/`CopilotJobState` 不帶這些欄位，動態化須改契約違反 FR-023，見 research R11）與步驟清單（`jobSteps(state.progress)`）；idle/completed/failed 維持 005 既有行為（依賴 T022；FR-018/019、Clarifications Q6、Edge Cases）

**Checkpoint**: 全部 US（US1–US7）可獨立驗收。

---

## Phase 10: Polish & Cross-Cutting Concerns

**Purpose**: 跨 US 的護欄驗收與收尾（對照 spec 全域 SC 與憲章）。

- [ ] T024 執行 [quickstart.md](./quickstart.md) 的 US1–US7 live AC 與全域護欄段（四 viewport、手機 §6.2 退化）並記錄結果
- [ ] T025 [P] 護欄：`git grep -nE "#[0-9a-fA-F]{3,6}" apps/web/src`（本 feature 新增/改動檔）不得出現散落 hex——一律 design-spec 具名 token（憲章 II、FR-020、§9）
- [ ] T026 護欄：`git diff --name-only` 僅列 `apps/web/**` 與本 specs 目錄；**不得**含 `packages/contracts`／`apps/api`／`apps/worker`（FR-023、SC-010）；DevTools Performance 高頻錄製無新 long task（FR-021、SC-009）
- [ ] T027 執行 `pnpm --filter web typecheck` 與 `pnpm --filter web test`（strict TS 無 `any` 擴散、全部單元測試綠——憲章 III/測試門檻）並修正
- [ ] T028 於本 tasks.md 勾選各 phase 完成狀態，對齊 git 歷史（依 CLAUDE.md phase-by-phase commit 規則）

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup（Phase 1）**：無相依，先跑（確立護欄基線）。
- **Foundational（Phase 2）**：依賴 Setup；**阻斷所有 US**（各 US 元件依賴對應純函式）。T002–T006 彼此 [P]。
- **User Stories（Phase 3–9）**：皆依賴 Foundational 完成。US1（純卡片）與其餘 US 無相互相依；US2–US6 共用 `monitoring.store.ts`／`App.vue`（同檔串行，見下）。
- **Polish（Phase 10）**：依賴所有欲交付的 US 完成。

### User Story Dependencies

- **US1（P1）**：只動 `MachineNodeCard.vue`（+ T002）——完全獨立、最快見效、MVP。
- **US2（P1）**：store getter + `FleetHealth.vue` + App 掛載（+ T003）。
- **US3（P2）**：store events + `EventStrip.vue` + App 掛載（+ T004）。
- **US4（P2）**：store state/actions + composable + TopBar + App 接線（+ T006）。
- **US5（P3）**：App 標題列（無 lib 相依）。
- **US6（P3）**：App sidebar 分組（+ T005）。
- **US7（P3）**：`job-steps.ts` + `CopilotDrawer.vue` active（ai-copilot domain，與 monitoring 無耦合）。

### 同檔串行（不可 [P]）

- `monitoring.store.ts`：T008（US2）→ T012（US3）→ T016（US4）依 phase 順序套用（同檔）。
- `App.vue`：T011（US2）→ T015（US3）→ T019（US4）→ T020（US5）→ T021（US6）依 phase 順序套用（同檔）。
- 對應的新元件（T009 FleetHealth、T013 EventStrip）與 lib（Foundational、T022）皆為獨立檔，可 [P]。

### Parallel Opportunities

- Foundational **T002–T006 全部 [P]**（不同 lib 檔、無相依）。
- 各 US 的**新元件**與其 store/App 接線分屬不同檔：T009、T013、T022 可與同 US 的 store 任務 [P]。
- Polish 的 T025 可與 T024 併行（唯讀檢查）。

---

## Parallel Example: Foundational（Phase 2）

```bash
# 五個 leaf 純函式 + 測試可同時開工（不同檔、無相依）：
Task T002: telemetry-format.ts (+test)
Task T003: fleet-health.ts (+test)
Task T004: events.ts (+test)
Task T005: machine-groups.ts (+test)
Task T006: machine-search.ts (+test)
```

---

## Implementation Strategy

### MVP First（User Story 1）

1. Phase 1 Setup → Phase 2 Foundational（至少 T002）。
2. Phase 3 US1（T007）。
3. **STOP & VALIDATE**：對照 node-states.png 獨立驗收卡片保真。

### Incremental Delivery（建議展示節奏）

1. Setup + Foundational → 分析層 ready。
2. US1 + US2（皆 P1）→ 卡片保真 + Fleet Health = 首個可展示增量。
3. US3（Event Stream）→ US4（TopBar 互動）→ 各自獨立驗收。
4. US5 → US6 → US7（P3 收尾）。
5. Polish 護欄驗收。

### Phase-by-Phase Commit（CLAUDE.md 規則）

- 每完成一個 phase：先勾選該 phase 任務，再就成果建立**標記該 phase** 的 commit。
- type 擇一：US1 卡片對齊屬 `fix`；US2–US7 能力增量屬 `feat`；Foundational 純函式屬 `feat`（分析能力）或 `chore`（視性質）；Polish 屬 `test`/`docs`/`chore`。
- 範例：
  - `fix(006): [Phase 3: US1] 對齊 node-states 修正機台卡片狀態呈現`
  - `feat(006): [Phase 4: US2] 加入 Fleet Health 四類聚合面板`
  - `feat(006): [Phase 5: US3] 加入前端衍生 Event Stream 事件列`
- 驗收通過後 `git merge --no-ff` 併回 `develop`（MUST NOT fast-forward）。

---

## Notes

- [P] = 不同檔、無未完成相依；同檔（store/App）任務**不得** [P]，依 phase 串行。
- [Story] 標籤對映 spec 的 US1–US7，供追溯。
- **護欄硬約束**：全程不動 `packages/contracts`／`apps/api`／`apps/worker`（FR-023）；視覺一律具名 token（FR-020）；新衍生一律在 rAF 批次點/reactive getter、不逐筆重繪（FR-021）。
- 每個 US 應可獨立完成並驗收（quickstart 對應段）。
