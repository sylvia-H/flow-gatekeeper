---
description: "Task list for Feature 005 — AI Copilot Drawer"
---

# Tasks: AI Copilot Drawer

**Input**: Design documents from `/specs/005-ai-copilot-drawer/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md)

**Tests**: 本 feature **包含**純函式／store 單元測試——非 TDD 要求，而是憲章「測試門檻」規定每個 feature MUST 至少提供純函式單元測試作為驗收佐證（見 research R9）。UI 行為驗收走 [quickstart.md](./quickstart.md) 的 AC1–AC12。

**Organization**: 依 user story（US1/US2/US3）分階段，各階段可獨立實作與驗收。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 可平行（不同檔案、無未完成相依）
- **[Story]**: US1/US2/US3；Setup／Foundational／Polish 無 story 標籤
- 每個任務含明確檔案路徑

## Path Conventions

- 主要改動 `apps/web/`（Vue 3 + Pinia，沿用 004 domain 佈局）；附帶小改 `apps/worker/`；`packages/contracts` 不改（僅消費）。

---

## Phase 1: Setup（共用基礎）

**Purpose**: 專案初始化與骨架

- [X] T001 [P] 於 apps/web/vite.config.ts 的 dev `server.proxy` 新增 `"/diagnoses"` → `http://localhost:3000`（changeOrigin），與既有 `/ws` proxy 同理（contracts/diagnose-rest、research R2）
- [X] T002 [P] 建立 ai-copilot domain 目錄骨架 apps/web/src/domains/ai-copilot/{components,stores,lib}/（design-spec §9 File Mapping）

---

## Phase 2: Foundational（阻斷性前置——所有 US 之前必須完成）

**Purpose**: 三個 user story 共用的狀態機、store、事件入口、共用視覺與版面

**⚠️ CRITICAL**: 本階段未完成前，任一 user story 不得開工

- [X] T003 [P] 建立 copilot 呈現型別與 reducer 純函式於 apps/web/src/domains/ai-copilot/lib/copilot-reducer.ts：`CopilotJobState` discriminated union、`copilotReducer(state,event)`、`isStaleJobEvent(state,event)`、`progressLabel(progress)`（依 data-model 轉移表；型別 `import` 自 `@flow-gatekeeper/contracts`）
- [X] T004 [P] reducer 單元測試於 apps/web/src/domains/ai-copilot/lib/copilot-reducer.test.ts（憲章測試門檻）：涵蓋 waiting→active→completed（含 `cached:true`）、`ai/token` 依 `seq` 保序 append、`ai/error`→failed、`job/status:failed`→failed、過期 `jobId` 片段被忽略、`progressLabel(null)`→indeterminate（FR-004/006/007/009/011）
- [X] T005 [P] diagnose REST helper 於 apps/web/src/domains/ai-copilot/lib/diagnose-api.ts：`fetch` `POST /diagnoses` 帶 `{ machineId, socketId, requestedBy? }`（`socketId`=clientId），回傳 `jobId`；無 clientId 時不送出（contracts/diagnose-rest、FR-003）
- [X] T006 建立 copilot.store 於 apps/web/src/domains/ai-copilot/stores/copilot.store.ts：`Map<machineId,CopilotJobState>`；getters `stateFor`/`canDiagnose`；actions `diagnose`/`retry`/`applyEvent`/`onReconnect`（委派 T003 reducer 與 T005 api）（依賴 T003、T005；contracts/copilot-store）
- [X] T007 [P] copilot.store 單元測試於 apps/web/src/domains/ai-copilot/stores/copilot.store.test.ts：`canDiagnose` 去重（active 期間 false）、`diagnose` 建 active、`applyEvent` 委派 reducer、`onReconnect` 使 active 台轉 failed（FR-008/010/012）
- [X] T008 擴充 004 WS 事件入口 apps/web/src/domains/monitoring/composables/useHighFrequencyWs.ts：新增選用 `onDiagnosisEvent` 回呼，於 `handleMessage` default 分支對 `job/status`／`ai/token`／`ai/done`／`ai/error` 分流呼叫（MUST NOT 進遙測 buffer；research R1、憲章 IV、FR-017）
- [X] T009 [P] 建立共用 SeverityBadge 於 apps/web/src/shared/components/SeverityBadge.vue（`ok`/`warning`/`critical` 具名 token，design-spec §7.6）
- [X] T010 [P] 建立共用 ProgressBar 於 apps/web/src/shared/components/ProgressBar.vue：支援數值與 indeterminate，含 `aria-valuenow`／indeterminate 描述（FR-004、design-spec §10）
- [X] T011 AppLayout 響應式 drawer 於 apps/web/src/shared/components/AppLayout.vue：`md+` 常駐右欄、mobile 改 bottom-sheet（可 Escape 關閉、不遮頂欄）（FR-002/015、research R8）

**Checkpoint**: 狀態機／store／事件入口／共用視覺／版面就緒——可開始 US 實作

---

## Phase 3: User Story 1 — 觸發診斷並看到串流推理與結構化結果 (Priority: P1) 🎯 MVP

**Goal**: 選台按 Diagnose → drawer 立即 active → token 逐段串流 → done 渲染五區塊結構化結果

**Independent Test**: 啟動前後端＋worker，選一台按 Diagnose，確認 drawer <1s active、進度經 20/40/60/80、串流可見、done 後五區塊正確（quickstart AC1–AC5）

### Implementation for User Story 1

- [X] T012 [P] [US1] 建立 StreamingPanel.vue 於 apps/web/src/domains/ai-copilot/components/StreamingPanel.vue：token 文字＋`animate-stream-caret`；未手動捲動貼底跟隨、手動上捲不強拉（FR-005/013、design-spec §7.7）
- [X] T013 [P] [US1] 建立 SuggestedActionList.vue 於 apps/web/src/domains/ai-copilot/components/SuggestedActionList.vue：每項 `label`＋`priority`（high 用 warn/crit 但不整排紅底），可多行（FR-006、design-spec §7.7）
- [X] T014 [P] [US1] 建立 DiagnosisResultView.vue 於 apps/web/src/domains/ai-copilot/components/DiagnosisResultView.vue：`summary`／`severity`(SeverityBadge)／`likelyCauses`／`evidence`(telemetry/errorlog/maintenance)／`suggestedActions`(SuggestedActionList) 五區塊；**空陣列（如無 evidence／suggestedActions）以空狀態呈現，不崩潰、不殘留佔位**（依賴 T009、T013；FR-006、spec Edge Cases、CHK022）
- [X] T015 [US1] 建立 CopilotDrawer.vue 於 apps/web/src/domains/ai-copilot/components/CopilotDrawer.vue：header（machineId／jobId short）／status（ProgressBar）／StreamingPanel／DiagnosisResultView；idle 顯示 selected machine 摘要與 Run diagnosis；completed 保留串流文字但預設收合（依賴 T010、T012、T014；FR-002/006/014、Clarifications Q2）
- [X] T016 [US1] TopBar diagnose action 於 apps/web/src/shared/components/TopBar.vue：作用於 `selectedMachineId`，無選取時 disabled（FR-002/014、design-spec §7.2）
- [X] T017 [P] [US1] MachineNodeCard diagnose icon 於 apps/web/src/domains/monitoring/components/MachineNodeCard.vue：卡片 diagnose icon 觸發診斷（作用於該台，含 `aria-label`）（FR-002、design-spec §7.4）
- [X] T018 [US1] App.vue 接線於 apps/web/src/App.vue：掛 copilot.store、`onDiagnosisEvent: copilot.applyEvent`、drawer slot 呈現 `stateFor(selectedMachineId)`、diagnose 觸發帶 `monitoring.clientId`；桌機 `drawerOpen` 常駐（依賴 T006、T008、T011、T015、T016）
- [X] T019 [US1] worker 進度里程碑（FR-018）於 apps/worker/src/main.ts：`updateProgress` 改綁真實階段 `0/20/40/60/80/100`（`20`=context 返回、`40`=取鎖前、`60`=首個 token(seq===0)、`80`=parseResult 成功後、`100`=寫庫/快取；cached 直接 100）（research R5、SC-008）

**Checkpoint**: MVP 可獨立展示——選台→Diagnose→active→串流→結構化結果，進度真實推進

---

## Phase 4: User Story 2 — 去重、Cached 標示與多台切換 (Priority: P2)

**Goal**: 同機台 active 禁重複送出；快取命中顯示 Cached；多台狀態獨立、切換還原

**Independent Test**: 同台 active 期間 Diagnose 被禁用；第二次同類診斷顯示 Cached；A 台 active 時切 B 台再切回 A 還原呈現（quickstart AC6–AC8）

### Implementation for User Story 2

- [ ] T020 [US2] 送出去重 UI：在 apps/web/src/shared/components/TopBar.vue 與 apps/web/src/domains/ai-copilot/components/CopilotDrawer.vue 依 `copilot.canDiagnose(machineId, hasClient)` 於該台 active 期間禁用 Diagnose（依賴 T016、T015；FR-008）
- [ ] T021 [US2] Cached badge：於 apps/web/src/domains/ai-copilot/components/CopilotDrawer.vue（或 DiagnosisResultView.vue）在 `completed && cached` 顯示 Cached 標記（依賴 T015；FR-009）
- [ ] T022 [US2] 多台切換還原接線於 apps/web/src/App.vue：drawer 恆依 `selectedMachineId` 取 `stateFor` 呈現，確認切換還原各台既有 active/completed/failed（依賴 T018；FR-010、US2-3）

**Checkpoint**: US1＋US2 皆獨立可用——去重、Cached、多台互不干擾

---

## Phase 5: User Story 3 — 失敗顯示、Retry 與重連中斷收尾 (Priority: P3)

**Goal**: 失敗顯示可讀錯誤＋Retry；重連（新 clientId）使進行中任務標中斷＋可 Retry

**Independent Test**: 暫停 worker 觸發診斷 → failed＋Retry，恢復後 Retry 完成；active 期間手動斷線重連 → 該台標中斷不卡 active（quickstart AC9–AC10）

### Implementation for User Story 3

- [ ] T023 [US3] Failed 呈現於 apps/web/src/domains/ai-copilot/components/CopilotDrawer.vue：failed 狀態顯示可讀錯誤訊息（非原始堆疊）＋Retry 按鈕（依賴 T015；FR-007）
- [ ] T024 [US3] Retry 接線：Retry 呼叫 `copilot.retry(machineId, clientId)`（新 jobId、重置 progress/streamText）於 CopilotDrawer.vue／App.vue；Retry 若命中後端快取 MUST 照常顯示 Cached 結果、不繞過快取（依賴 T006、T023；FR-007/FR-009、Clarifications CHK038）
- [ ] T025 [US3] 重連中斷收尾接線於 apps/web/src/App.vue：`onConnected` 內呼叫 `copilot.onReconnect(clientId)`，使 active 台在新 clientId 時轉 failed（中斷）（依賴 T006、T018；FR-012、research R7）

**Checkpoint**: 三個 user story 皆獨立可用

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: 跨 story 的無障礙、響應式、品質門檻與驗收回寫

- [ ] T026 [P] 無障礙加固：drawer 全控制項（Diagnose／Retry／close／收合）具 `aria-label`，狀態不只靠顏色，focus ring 用 `accent`，手機 sheet 可 Escape 關閉，ProgressBar aria 正確（FR-015/016、design-spec §10）
- [ ] T027 [P] 四 viewport 響應式檢查（寬桌機／桌機／平板／手機 390×844）：桌機常駐右欄、手機 bottom-sheet；不溢出、不遮頂欄、不重疊（SC-006）
- [ ] T028 品質門檻：`pnpm --filter web typecheck`、`pnpm --filter web lint`、`pnpm --filter web test` 全綠；若動 apps/worker/src/main.ts 一併 `pnpm --filter worker typecheck`（憲章 III）
- [ ] T029 執行 [quickstart.md](./quickstart.md) live 驗收 AC1–AC12（含 AC12 遙測背壓不受干擾＝FR-017/SC-007），回寫結果
- [ ] T030 [P] 勾選 tasks.md／checklists；CHK038（Retry 可命中快取、不繞過）與 CHK039（不設前端並發上限）已於 spec Clarifications 拍板並落入 FR-007/FR-010，於此確認實作與決策一致

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: 無相依，可立即開始
- **Foundational (Phase 2)**: 依賴 Setup——**阻斷所有 US**
- **User Stories (Phase 3–5)**: 皆依賴 Foundational 完成後才可開工
  - US1 為 MVP；US2/US3 可在 Foundational 後與 US1 平行（不同檔案為主），但因 US2/US3 皆再編 CopilotDrawer.vue，實務上建議依 P1→P2→P3 順序以避免同檔衝突
- **Polish (Phase 6)**: 依賴所有目標 US 完成

### User Story Dependencies

- **US1 (P1)**: Foundational 後即可——無其他 story 相依
- **US2 (P2)**: Foundational 後可——建立於 store 既有 getter（`canDiagnose`）與 US1 的 CopilotDrawer 之上
- **US3 (P3)**: Foundational 後可——建立於 store 既有 `retry`/`onReconnect` 與 US1 的 CopilotDrawer 之上

### Within Each User Story

- 純函式／store 測試（T004、T007）已在 Foundational 先行；UI 元件由子件（StreamingPanel/ResultView）→ 容器（CopilotDrawer）→ 接線（App.vue）
- 同檔任務不得平行（CopilotDrawer.vue 於 T015→T020/T021/T023 為序列編修）

### Parallel Opportunities

- Setup T001、T002 可平行
- Foundational 中 T003、T004、T005、T007、T009、T010 可平行（不同檔案）；T006 依 T003/T005；T008、T011 各自獨立
- US1 中 T012、T013、T017 可平行；T014 依 T013/T009；T015 依 T010/T012/T014
- Polish T026、T027、T030 可平行

---

## Parallel Example: Foundational

```bash
# 可同時進行（不同檔案、無相依）：
Task: "copilot-reducer.ts 純函式與型別"          # T003
Task: "copilot-reducer.test.ts 單元測試"          # T004
Task: "diagnose-api.ts REST helper"               # T005
Task: "SeverityBadge.vue 共用徽章"                 # T009
Task: "ProgressBar.vue 共用進度條"                 # T010
```

## Parallel Example: User Story 1

```bash
# 可同時進行：
Task: "StreamingPanel.vue"                         # T012
Task: "SuggestedActionList.vue"                    # T013
Task: "MachineNodeCard diagnose icon"              # T017
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. 完成 Phase 1 Setup
2. 完成 Phase 2 Foundational（阻斷所有 story）
3. 完成 Phase 3 US1
4. **STOP & VALIDATE**：獨立驗收 US1（AC1–AC5）
5. 可展示 MVP

### Incremental Delivery

1. Setup + Foundational → 基礎就緒
2. US1 → 獨立驗收 → demo（MVP）
3. US2 → 獨立驗收 → demo（去重／Cached／多台）
4. US3 → 獨立驗收 → demo（失敗／Retry／重連中斷）
5. Polish → 無障礙／響應式／品質門檻／quickstart 回寫

---

## Notes

- 每個 phase 完成後依 CLAUDE.md 規則以 `[Phase N: …]` 標記 commit（`/speckit.implement` 期間逐 phase 自動 commit）
- `[P]` = 不同檔案、無相依；同檔任務序列化
- 診斷事件與遙測共用 004 單一 WebSocket；診斷事件 MUST NOT 進遙測 buffer（憲章 IV、FR-017）
- 不新增通訊契約；worker 僅改 progress **值**（FR-018），型別不變
- 絕不提交祕密（`.env`／token）；dev proxy 用同源路徑（憲章 VI）
