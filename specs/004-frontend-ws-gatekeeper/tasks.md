---
description: "Task list for 004 前端高頻 WebSocket Gatekeeper 監控台"
---

# Tasks: 前端高頻 WebSocket Gatekeeper 監控台

**Input**: Design documents from `/specs/004-frontend-ws-gatekeeper/`

**Prerequisites**: plan.md、spec.md（必需）；research.md、data-model.md、contracts/、quickstart.md

**Tests**: 依憲章測試門檻，納入純函式／store 單元測試（batching 關係、backoff、stale、label fallback）——不需 DOM。元件視覺/效能走 quickstart 人工＋截圖驗收，不硬做脆弱的 DOM 斷言。

**Organization**: 依 User Story 分階段，各階段為可獨立驗收的增量。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 不同檔、無未完成相依，可平行
- **[Story]**: US1/US2/US3；Setup/Foundational/Polish 無 story 標籤
- 每個任務標明確切檔案路徑

## Path Conventions

- 前端 monorepo 套件：`apps/web/`（Vue 3 + Pinia + Tailwind）；domain 佈局見 plan.md「Source Code」
- 視覺 SoT：`apps/web/design/design-spec.md`；訊息型別 SoT：`packages/contracts`（本 feature 只消費、不新增契約）

---

## Phase 1: Setup（共用基礎設定）

**Purpose**: 讓 `.vue` 進入型別檢查與 lint、WS 走同源 proxy、相依就緒

- [X] T001 [P] `apps/web/package.json`：新增 dependency `lucide-vue-next`；devDependencies `vue-tsc`、`eslint-plugin-vue`、`vue-eslint-parser`；`scripts.typecheck` 改為 `vue-tsc --noEmit -p tsconfig.json`。**暫不加** `@vue/test-utils`/`jsdom`——本 feature 測試皆純函式/store（node 環境），待日後真的寫元件掛載測試時再加（research R5）
- [X] T002 [P] `apps/web/tsconfig.json`：`include` 加入 `"src/**/*.vue"`，使 SFC 納入 strict typecheck（憲章 III、research R4）
- [X] T003 [P] `apps/web/vite.config.ts`：`server.proxy` 新增 `'/ws': { target: 'http://localhost:3000', ws: true, changeOrigin: true }`，前端連同源 `/ws`（research R2）
- [X] T004 [P] 根 `eslint.config.js`：加入 `eslint-plugin-vue` 扁平設定與 `vue-eslint-parser`，對 `**/*.vue` 套用（保留既有 TS 規則與 `no-explicit-any: error`）（research R4）
- [X] T005 [P] `apps/web/index.html`：掛 Inter / JetBrains Mono 字型連結（Google Fonts 或 fontsource），未載到時退回系統字型（design-spec §4.2、research R6）
- [X] T006 於 repo 根執行 `pnpm install` 更新 `pnpm-lock.yaml`（依賴 T001 同檔，須先完成）

---

## Phase 2: Foundational（阻擋所有 user story 的前置）

**Purpose**: 建立所有故事共用的 store、機台名冊、app bootstrap 與 token 化外殼基元

**⚠️ CRITICAL**: 本階段完成前，任何 user story 都不能開始

- [X] T007 `apps/web/src/domains/monitoring/stores/monitoring.store.ts`：定義 state（`machines: Map<string,MachineLive>`、`selectedMachineId`、`connectionStatus`、`clientId`、`receivedMessages`、`renderedBatches`、`now`）、getters（`batchRatio`、`machineList` 依 machineId 穩定排序、`selectedMachine`）、actions（`applyTelemetryBatch`、`selectMachine`、`setConnectionStatus`、`setClientId`、`tickNow`）（data-model §1）
- [X] T008 [P] `apps/web/src/domains/monitoring/stores/monitoring.store.test.ts`（Vitest + `setActivePinia(createPinia())`）：`applyTelemetryBatch` 呼叫 3 次、每次 N 筆 → `receivedMessages===3N`、`renderedBatches===3`、`batchRatio===round(N)`；`renderedBatches===0` 時 `batchRatio===0`（憲章測試門檻、FR-010、SC-002）
- [X] T009 [P] `apps/web/src/domains/monitoring/lib/machine-labels.ts` 與 `machine-labels.test.ts`：export **`KNOWN_MACHINE_IDS`**（5 台名冊常數，`['mixer-01','press-02','pack-03','oven-04','sorter-05'] as const`，供訂閱/topology 名冊/label 三處共用的單一來源）與 `machineLabel(machineId)`（靜態對照，缺項 fallback 回 machineId）；測試涵蓋 fallback（FR-006a、data-model §2）
- [X] T010 [P] `apps/web/src/shared/components/StatusLight.vue`：props `{ state:'healthy'|'warning'|'critical'; pulse?:boolean }`；直徑 8–10px、critical 用 `animate-critical-pulse`、必附 `aria-label`、wrapper 尺寸固定不造 layout shift（FR-008、FR-020、design-spec §7.4/§10）
- [X] T011 `apps/web/src/main.ts` 改寫：`createApp(App).use(createPinia()).mount('#app')`，保留「僅瀏覽器環境掛載」guard，移除 001 placeholder `createGatekeeperApp` render（research R8）
- [X] T012 更新 `apps/web/src/main.test.ts`（接 T011 破壞性變更）：原斷言 `createGatekeeperApp` 已不存在——改為斷言 entry 能於 node 環境乾淨 import（不觸發掛載），例如 `await import('./main.js')` 不丟錯，或改測 `App` 元件可 import；使 T026 的 `pnpm --filter web test` 不因舊斷言紅燈
- [X] T013 `apps/web/src/App.vue` 與 `apps/web/src/shared/components/AppLayout.vue`：`AppLayout` props `{ connectionStatus; drawerOpen }` 提供 sidebar／top bar／main／drawer slot（drawer slot 先留空，屬 005）；`connectionStatus` prop 僅供版面用途，**連線狀態單一資料來源為 `store.connectionStatus`**（避免雙軌）；`App.vue` 組裝 `AppLayout`，確保第一屏即監控台外殼（非 landing page）（FR-001、design-spec §6/§7.1）

**Checkpoint**: 地基就緒——store、名冊、app 掛載與外殼可用，user story 可開始

---

## Phase 3: User Story 1 - 在監控台第一屏即時看到訂閱機台的高頻狀態 (Priority: P1) 🎯 MVP

**Goal**: 連上即時通道、訂閱 5 台示範機台，以 buffer + rAF 每幀批次把高頻遙測批次提交到 store，並以 design-spec token 渲染會即時更新的機台卡片；冷啟動先 placeholder、點選卡片設定 selected。

**Independent Test**: 起 `api` 與 `web`，開監控台第一屏 → 先見 5 張 placeholder 卡片＋連線橫幅 → 連上後卡片持續更新溫/振/吞/錯與 lastUpdated；只呈現訂閱的 5 台；把 `MOCK_TELEMETRY_INTERVAL_MS=10` 下捲動/點選仍流暢；點卡片呈現 selected。

- [X] T014 [US1] `apps/web/src/domains/monitoring/composables/useHighFrequencyWs.ts`（**US1 版：connect + buffer + rAF pump + onmessage 分流 + onUnmounted 清理；尚無 heartbeat/reconnect**）：`onmessage` 陣列→逐筆 push 進非 reactive buffer、`system/connected`→`onConnected(clientId)`、`pong`/`machine/subscribed`/`system/unauthorized` 分流忽略、其餘 ai/*·job/status 暫忽略；`pump` 每幀 `buffer.splice(0)`→`onBatch`；buffer 超過 `maxBufferSize`（預設 2000）丟最舊；回傳 `{ clientId, send, close }`；`onUnmounted` 取消 rAF 與 close（FR-004/005/018/019、contracts/ws-client、指南 §10.3）
- [X] T015 [US1] `apps/web/src/domains/monitoring/components/MachineNodeCard.vue`：props `{ machine: MachineLive|null; machineId; selected; stale }`、emit `select`；呈現 machineId(mono)＋`machineLabel(machineId)`＋`StatusLight(state)`＋溫/振/吞/錯（mono、`text-number`、固定 grid 不跳動）＋lastUpdated；states healthy/warning/critical/selected/hover（stale 視覺於 US3 補）；`machine===null`→placeholder（值以 `—`、狀態中性、不報錯）；點選 `emit('select', machineId)`（FR-006/006a/007/023/024、design-spec §7.3）
- [X] T016 [US1] `apps/web/src/domains/monitoring/components/TopologyCanvas.vue`：`topology-bg` grid 容器，**以 `KNOWN_MACHINE_IDS` 名冊為渲染來源**（`v-for` 名冊，逐台 `store.machines.get(id)` 取快照，無則傳 `machine=null`），確保冷啟動即顯示 5 張 placeholder（FR-024）；桌面 grid（mobile 單欄於 Polish 補）；把 `store.selectedMachineId` 傳入卡片 selected（FR-020 桌面、FR-024、design-spec §6.3/§7.3）
- [X] T017 [US1] 在 `apps/web/src/App.vue` 接線：呼叫 `useHighFrequencyWs({ url: 同源 /ws, onBatch: store.applyTelemetryBatch, onStatus: store.setConnectionStatus, onConnected: (id)=>{ store.setClientId(id); send({type:'machine/subscribe', token:'', machineIds:[...KNOWN_MACHINE_IDS]}) } })`（訂閱清單用 `KNOWN_MACHINE_IDS` 單一來源）；掛入 `TopologyCanvas`；卡片 `select`→`store.selectMachine`（FR-002/003/022 保存 clientId/024/025 初次訂閱、SC-006、contracts/ws-client）

**Checkpoint**: US1 可獨立展示——會動的監控台 MVP

---

## Phase 4: User Story 2 - 在畫面上直接看到被量化的背壓比值 (Priority: P2)

**Goal**: 於 TopBar 呈現背壓計量（收到訊息數／渲染批次數／比值），把「高頻不逐筆重繪」量化在畫面上。

**Independent Test**: 高頻遙測下觀察 TopBar 的比值明顯 ≥ 10:1 且即時；把 `MOCK_TELEMETRY_INTERVAL_MS` 調小，比值上升。

- [X] T018 [P] [US2] `apps/web/src/shared/components/BackpressureBadge.vue`：props `{ receivedMessages; renderedBatches }`；顯示 `12,840 msgs · 312 frames · 41:1`（`font-mono`、千分位、中性色）；ratio = `renderedBatches>0 ? round(received/rendered) : 0`；比值以 `text-primary`/`accent` 強調；tooltip 說明背壓意義（FR-009/010/011、design-spec §7.2.1）
- [X] T019 [US2] `apps/web/src/shared/components/TopBar.vue`：放 search input（外觀）、connection status chip（**讀 `store.connectionStatus`**，先中性、US3 上色）、`BackpressureBadge`（綁 `store.receivedMessages`/`store.renderedBatches`）、diagnose 按鈕（disabled 佔位→005）、mock-frequency 控制（**disabled placeholder**，FR-027）；掛進 `AppLayout` top bar slot（FR-009、design-spec §7.2）

**Checkpoint**: US2 可獨立驗收——背壓比值即時可見

---

## Phase 5: User Story 3 - 斷線自動恢復並清楚呈現連線與資料新鮮度 (Priority: P3)

**Goal**: 心跳探活、指數退避重連、每次（重）連線重新訂閱、連線三態呈現、stale 標示且不清空資料。

**Independent Test**: 運行中殺 `api` → chip 轉 disconnected、資料標 stale 不清空 → 重開 `api` → 經 reconnecting 於 ~30s 回 connected 並**重新訂閱**、恢復更新。

- [X] T020 [P] [US3] `apps/web/src/domains/monitoring/lib/stale.ts` 與 `stale.test.ts`：`isStale(lastUpdated, now, thresholdMs=10000) = now-lastUpdated > thresholdMs`（FR-017、SC-005、design-spec §8.3）
- [X] T021 [P] [US3] `apps/web/src/domains/monitoring/lib/backoff.ts` 與 `backoff.test.ts`：`nextBackoffDelay(attempt, maxMs=30000)`＝`min(1000*2^attempt, maxMs)` 為 base、加 ≤30% 抖動（測試以注入 rng 驗上界與到 cap 前單調不減）（FR-013）
- [X] T022 [US3] 擴充 `apps/web/src/domains/monitoring/composables/useHighFrequencyWs.ts`（接 T014 同檔）：加 `startHeartbeat`（週期 `ping`，`pongTimer` 逾時 `ws.close()`）、`reconnect`（用 `nextBackoffDelay(attempt)`、`onStatus('reconnecting')`）、`onclose` 非 `manualClose`→`reconnect`、`onerror`→close、`manualClose` 於 `close()`/`onUnmounted` 設定並清 heartbeat/pong/reconnect timer；確保**每次** `system/connected`（初次與重連）皆觸發 `onConnected`，使 App 的訂閱邏輯（T017）在重連後自動重送 `machine/subscribe`（FR-012/013/014/015/025，依賴 T021）
- [X] T023 [US3] 連線韌性 UI：`MachineNodeCard.vue` 加 stale 視覺（`isStale(machine.lastUpdated, store.now)`→opacity 0.55＋`Stale` badge，數值不清空）；`TopBar.vue` connection chip 依 **`store.connectionStatus`**（單一來源）上色（connected→ok／reconnecting→warn／disconnected→crit）＋label；`AppLayout.vue`/`App.vue` 加冷啟動/斷線橫幅；`App.vue` 起每秒 `store.tickNow()` 驅動 stale 重算（FR-015/016/017/024、design-spec §8.2/§8.3）

**Checkpoint**: 三個 user story 皆可獨立驗收

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: 響應式、無障礙、品質門檻與可重播 live 驗收

- [X] T024 [P] 響應式：`TopologyCanvas.vue` 與 `MachineNodeCard.vue` 在手機（390×844）退化為單欄清單、四個 viewport（1366×768/1440×900/390×844/768×1024）文字不溢出、卡片不重疊、hover/selected/critical pulse 不造 layout shift（FR-020/026、SC-004、design-spec §6.2/§11）
- [X] T025 [P] 無障礙複查：icon-only 控制項具 `aria-label`/tooltip、狀態非僅靠顏色（狀態燈/badge/連線 chip 皆附文字或 aria）、keyboard focus ring 用 accent 且不移除、critical pulse 不過快（FR-008/021、design-spec §10）
- [X] T026 [P] 品質門檻：`pnpm --filter @flow-gatekeeper/web typecheck`（vue-tsc）、`lint`（含 eslint-plugin-vue）、`test`（store/backoff/stale/label 純函式綠、entry smoke 綠）、`build`（vite build 成功）全通過、無 `any` 洩漏
  - **結果（2026-07-02）**：typecheck ✅ 0；lint ✅ 0（`no-explicit-any: error` 綠即無 any 洩漏）；test ✅ 18 passed（5 檔：store 批次關係、backoff 上界/cap/單調/抖動、stale 門檻、label fallback、entry smoke）；build ✅ vite 成功（1585 modules，js 84.53 kB / css 13.27 kB gzip 32.85/3.38 kB）。
- [ ] T027 本機 live 驗收（依 quickstart.md AC1–AC6，`docker compose up -d` + `api start:dev` + `web dev`）：記錄①第一屏 placeholder→live、②背壓比值 ≥10:1 且頻率調高上升、③高頻 30s 無明顯 long task、④殺 api→disconnected/stale→重開→reconnecting→connected+重新訂閱、⑤selected 與 stale 保值、⑥四 viewport 無溢出——結果回寫本任務
  - **狀態（2026-07-02）：待使用者本機執行（未完成）**。本 session 無法執行：Docker daemon 未啟動（Docker Desktop 未開），無法起 Redis/Mongo → api Gateway 無法啟動；且 AC1–AC6 為瀏覽器/DevTools 目視互動驗收，需人工觀察。
  - **執行步驟（PowerShell）**：`docker compose up -d`（Redis 7 + MongoDB 7）→ 終端1 `pnpm --filter @flow-gatekeeper/api start:dev` → 終端2 `pnpm --filter @flow-gatekeeper/web dev` → 開 `http://localhost:5173`，依 quickstart AC1–AC6 逐項核對並回寫本任務與 `checklists/release-gate.md`。

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: 無相依，立即可開始
- **Foundational (Phase 2)**: 依賴 Setup——**阻擋所有 user story**
- **User Stories (Phase 3–5)**: 皆依賴 Foundational；`useHighFrequencyWs.ts` 為 US1↔US3 共用檔，建議依優先序 P1 → P2 → P3
- **Polish (Phase 6)**: 依賴所有目標 user story 完成

### User Story Dependencies

- **US1 (P1)**: Foundational 後即可開始；MVP——連線＋buffer＋rAF 批次＋卡片渲染（名冊驅動 placeholder）＋初次訂閱＋選取
- **US2 (P2)**: 在 US1 的 store（received/rendered）上加 `BackpressureBadge`＋`TopBar`；驗收（比值可見）獨立可測
- **US3 (P3)**: 在 US1 的 composable 上加 heartbeat/backoff/reconnect/重新訂閱＋stale＋連線三態 UI；驗收（斷線恢復）獨立可測

### Within Each User Story

- 純函式/store 測試與其對應模組一起完成（T007↔T008、T009、T020↔stale、T021↔backoff）
- US1：composable（T014）先於 App 接線（T017）；卡片（T015）與 topology（T016）先於接線
- US3：`backoff.ts`（T021）先於 composable 擴充（T022）；composable 擴充先於韌性 UI（T023）

### Parallel Opportunities

- Setup：T001–T005 不同檔可平行（T006 install 依賴 T001）
- Foundational：T008（store 測試）需 T007；T009/T010 與 store 不同檔可平行；T011→T012（main 與其測試）依序；T013 為 app 掛載，於基元後
- US2：T018（badge）與 US1 收尾不同檔可平行；T019 需 T018
- US3：T020（stale）/T021（backoff）不同檔可平行；T022 需 T021
- Polish：T024/T025/T026 可平行；T027 最後 live 驗收

### 同檔不可平行

- `useHighFrequencyWs.ts`：T014 → T022 **必須依序**（同檔）
- `MachineNodeCard.vue`：T015 → T023 依序；`TopBar.vue`：T019 → T023 依序；`App.vue`：T013 → T017 → T023 依序
- `main.ts`/`main.test.ts`：T011 → T012 依序

---

## Parallel Example: Setup

```bash
# 同時進行（不同檔）：
Task: "apps/web/package.json 加相依與 typecheck script"   # T001
Task: "apps/web/tsconfig.json include .vue"                # T002
Task: "apps/web/vite.config.ts 加 /ws proxy"              # T003
Task: "根 eslint.config.js 加 vue 解析"                    # T004
Task: "apps/web/index.html 掛字型"                         # T005
```

## Parallel Example: Foundational 純模組

```bash
# 彼此獨立檔案，可平行：
Task: "monitoring.store.test.ts 批次關係測試"        # T008（需 T007）
Task: "machine-labels.ts + KNOWN_MACHINE_IDS + test" # T009
Task: "StatusLight.vue"                               # T010
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. 完成 Phase 1 Setup（.vue typecheck/lint、/ws proxy、相依）
2. 完成 Phase 2 Foundational（store + 名冊 + app 掛載 + main 測試修正 + StatusLight/AppLayout 外殼）
3. 完成 Phase 3 US1（連線＋buffer＋rAF＋卡片＋名冊 placeholder＋訂閱＋選取）
4. **STOP & VALIDATE**：用 quickstart AC1（第一屏 5 張 placeholder→即時更新、只 5 台、點選）獨立驗收
5. 即為可展示的會動監控台 MVP

### Incremental Delivery

1. Setup + Foundational → 地基就緒
2. + US1 → 會動的監控台（MVP）
3. + US2 → 背壓比值可視化（賣點佐證）
4. + US3 → 斷線自我恢復＋資料新鮮度
5. + Polish → 響應式/無障礙/品質門檻/live 驗收
