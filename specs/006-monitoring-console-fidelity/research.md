# Phase 0 Research: Monitoring Console Fidelity

本檔彙整 006 的技術決策。所有項目皆**前端-only**，不動 `packages/contracts`／`apps/api`／`apps/worker`（FR-023）。Technical Context 無 `NEEDS CLARIFICATION`（spec 的 clarify 已決 4 項；其餘低影響項於下方定案）。

---

## R1 · US1「越界數值染 amber」的門檻來源

- **Decision**：在前端新增靜態門檻常數（`telemetry-format.ts` 的 `offendingMetrics`），**鏡射 002 mock producer 推導 `state` 的門檻**：
  - warning：`temperature > 78` 或 `vibration > 0.9` 或 `errorRate > 0.04`
  - critical：`temperature > 95` 或 `vibration > 1.7` 或 `errorRate > 0.12`
  - `throughput` 不是 state 觸發指標（下降型），不參與 amber。
  越界者於卡片把**該數值**染 warn/crit 色（token），非染整卡；卡片邊框維持 subtle。
- **Rationale**：契約 `TelemetryPoint` 帶 `state`（整體）但不帶「哪個 metric 越界」。要精準只染越界值，前端需自行判定；用與後端相同的門檻常數可保一致。純呈現，不需契約新增欄位。
- **Alternatives considered**：
  - 後端在 payload 標註 per-metric offending flag → **需改契約**，違反 FR-023，否決。
  - warning 時把**所有**數值染 amber → 簡單但不符 FR-002「越界的數值」語意，且會誤導，否決。
- **風險/備註**：門檻是「複製常數」，若未來後端調門檻需同步。以純函式 + 單測固定行為，並在 `telemetry-format.ts` 註記來源檔（`apps/api/.../mock-telemetry.service.ts`）。門檻僅供**呈現**，機台整體 state 仍以契約 `state` 為準（徽章/StatusLight 讀 `state`，不自行重算）。

## R2 · US1 遙測單位

- **Decision**：`temperature`→`°C`、`vibration`→`mm/s`、`throughput`→`u/min`、`errorRate`→`%`（errorRate 既有已 ×100 顯示 `%`）。單位為靜態字串常數（`metricUnit(key)`）。
- **Rationale**：spec FR-003 明列；design-spec §7.3 未規定單位字串、無衝突。
- **Alternatives considered**：從契約帶單位 → 無此欄位且非必要，否決。

## R3 · US1 相對時間戳「Ns ago」

- **Decision**：以純函式 `relativeTimeLabel(lastUpdated, now)` 產生（`<5s`→`just now`、`<60s`→`Ns ago`、`<60m`→`Nm ago`…），讀既有 `store.now`（App.vue:78 已每秒 `tickNow()`），不另開計時器。保留卡片既有 `Stale` badge 呈現不變。
- **Rationale**：sec 級精度足夠，沿用既有 tick 符合憲章「低頻更新用低頻 tick」；純函式可單測邊界。
- **絕對時間 tooltip**：**保留**——hover／點擊時間戳時以 tooltip 顯示絕對時間（如 `toLocaleTimeString()`）作輔助（clarify Session 2026-07-03 第二輪定案）。以原生 `title` 或既有 tooltip 呈現，屬純呈現、不新增資料流。

## R4 · US2 Fleet Health 聚合與 total（含 stale 第四類）

- **Decision**：純函式 `fleetHealthOf(machines, now, roster=KNOWN_MACHINE_IDS)` 回 `{ healthy, warning, critical, stale, total }`。逐一走 `roster`（固定 5 台）：
  - 該台**無快照**（never-reported，冷啟動）→ 計入 `stale`。
  - 有快照且 `isStale(lastUpdated, now)`（>10s）→ 計入 `stale`。
  - 否則依快照 `state` 計入 healthy/warning/critical。
  - `total = roster.length`；四類之和恆等於 total（含 stale）。
- **Rationale**：以固定名冊為分母使 total 穩定＝5（SC-003），never-reported 併入 stale 語意一致（都是「沒有新鮮資料」）。stale 沿用既有 `isStale`，與 US1 卡片 Stale 共用同一判斷（clarify 決議）。
- **Alternatives considered**：以 `machines.size` 為分母 → 冷啟動時 total 會從 0 長到 5、和不穩定，否決。stale 併回最後已知 state → 已被 clarify 否決（改獨立第四類）。
- **Reactivity**：getter 依賴 `machines` 與 `now`（reactive），每秒 tick 觸發重算，於 rAF 批次外但為低頻（每秒），不違反憲章 IV。

## R5 · US3 Event Stream 前端衍生、去重與上限

- **Decision**：事件在 `monitoring.store.applyTelemetryBatch` 內衍生——對 batch 中每台，於覆寫快照**前**讀既有快照的 `state`（prevState），用純函式 `deriveTransitionEvent(prevState, nextState, machineId, ts)`：僅當 `nextState !== prevState` 且 `nextState ∈ {warning, critical}` 時回一筆 `DerivedEvent`，否則 `null`。產生的事件以 `pushCapped(events, event, 50)` 存入 store `events`（unshift 最新、裁到 50）。
  - prevState 為 `undefined`（該台首次出現）且 nextState 為 warning/critical → 視為轉入，記一筆。
  - 短訊息由 `nextState` 與 machineLabel 組（如 `Press 02 entered CRITICAL`）。
- **Rationale**：完全沿用 004 既有批次點，事件與 Fleet Health 都在批次後才更新（憲章 IV：不逐筆 reactive）。「僅狀態轉換」＝天然去重，連續抖動不灌爆（FR-010）。50 筆上限防無限成長（FR-011）。與 002 `HistoryService.lastState` 同思路、搬到前端，不動後端/契約。
- **Alternatives considered**：後端推事件（002 `errorlogs` 可回放）→ **需改契約 + 三端**，違反護欄，spec 已判為獨立 feature，否決。用計時器輪詢 diff → 多餘，批次點已是自然 diff 時機，否決。
- **備註**：跨重整不留存（spec 已知取捨）。同批多台同時轉換→各自 `deriveTransitionEvent` 各記一筆（Edge case）。

## R6 · US4 pause/resume 機制（續收 buffer、resume 跳最新）

- **Decision**：`monitoring.store` 加 `paused` state 與 `togglePause()`；`useHighFrequencyWs` 加 `isPaused?: () => boolean` option，`pump()` 於 `isPaused()` 為真時**跳過 `buffer.splice/onBatch`（不 flush）**但**保留 rAF 迴圈與 buffer 累積**（buffer 仍受既有 `maxBufferSize` 保護、丟最舊保最新）。resume 後下一幀 flush 整個 buffer，`applyTelemetryBatch` 逐台覆寫成**最新**快照＝畫面直接跳最新，不補放中間畫格（FR-013／clarify）。
- **Rationale**：pause 語意＝停止「畫面更新」而非停止「收訊息」，正好對應 pump flush 開關；buffer 續存確保 resume 有最新資料。實作最小、不碰通道與心跳。
- **Alternatives considered**：`applyTelemetryBatch` 內判 paused 直接 return → composable 端 buffer 已 splice，資料會遺失、resume 後不是「最新」，否決。斷開 WS → 破壞連線語意與心跳，否決。
- **副作用**：pause 期間 FleetHealth/EventStrip/卡片同步凍結（皆讀 store.machines），一致；`now` 每秒 tick 仍走，長時間 pause 後卡片可能顯示 stale——可接受（確實久未更新）。

## R7 · US4 connection chip 延遲 ms（ping/pong RTT）

- **Decision**：`useHighFrequencyWs` 於送 `{type:"ping"}` 時記 `lastPingAt = Date.now()`；收到 `pong`（`handleControlMessage`）時算 `Date.now() - lastPingAt` 交新 option `onLatency(ms)` → `store.setLatency(ms)`。TopBar chip 顯示 `store.latencyMs`（連線中且有值時）。
- **Rationale**：既有心跳每 15s 一次 ping、pong 已被處理（clearPongTimer），只需在該點補量測，零新訊息、零契約變更。
- **Alternatives considered**：新增專用測量訊息 → 需契約，否決。用 `performance.now()`→ 與 `Date.now()` 皆可，統一用 `Date.now()` 對齊既有程式。
- **備註**：更新頻率為心跳週期（~15s），非高頻，直接寫 reactive 無背壓疑慮。首個 pong 前 chip 不顯示 ms（或顯示 `—`）。

## R8 · US4 search 範圍與比對鍵

- **Decision**：純函式 `filterMachineIds(roster, query)`：query 去頭尾空白、小寫，對每台**同時比對** `machineId` 與 `machineLabel(id)`（顯示名稱），任一 `includes` 即命中；空 query 回全部。**同時過濾** sidebar 機台清單與 main 卡片（兩處讀同一 computed 結果）。
- **Rationale**：5 台小名冊，同時比對 id 與 label 最符合直覺（打 "press" 或 "press-02" 都中）；同時過濾兩處避免 sidebar 與主區不一致。已於此定案，非 NEEDS CLARIFICATION。
- **Alternatives considered**：只過濾卡片 → sidebar 仍全列，體驗割裂，否決。只比對 id → 打顯示名稱無效，否決。
- **Edge case**：查無相符時主區顯示「無結果」空狀態（FR/Edge），sidebar 群組標題可隱藏空群組。

## R9 · US5 主區標題列

- **Decision**：main 頂部加固定標題列「Fleet monitor · N machines」，N＝`KNOWN_MACHINE_IDS.length`（固定 5；若日後名冊動態則讀名冊長度）。**僅標題列**，不含 Grid/Graph 切換或拓樸視圖（spec 明確不做）。
- **Rationale**：純呈現，對齊 layout.png 主區；N 由名冊導出，穩定可測。

## R10 · US6 機台分組（三組靜態對照）

- **Decision**：新增 `machine-groups.ts`——靜態 `Record<groupName, machineId[]>` 與 `machineGroup(machineId)`：
  - **Prep**：`mixer-01`
  - **Forming & Baking**：`press-02`、`oven-04`
  - **Fulfilment**：`pack-03`、`sorter-05`
  - 對照缺項 → fallback 群組 `Ungrouped`。
  sidebar 依「群組順序 → 群組內機台」渲染，每群組一標題。
- **Rationale**：clarify 決議；比照 `machine-labels.ts` 靜態對照做法（同一目錄、同風格），純前端資料。截圖的 Stamping/Fluids 為示意、與實際 5 台 roster 不符，故以此三組落地。
- **Alternatives considered**：從契約帶 group → 無此欄位且非必要，否決。

## R11 · US7 Drawer active meta 與步驟清單

- **Decision**：在 `CopilotDrawer.vue` 的 **active** 呈現加兩塊：
  - **meta（全靜態）**：**契約核對更正**——經查證，契約 `JobStatus`（`packages/contracts/src/events.ts`，僅 `type/jobId/machineId/status/progress?/result?/error?`）與前端 `CopilotJobState`（`status/machineId/jobId/progress/streamText`）**皆不帶 attempt/queue/concurrency**，前端無法動態取得 attempt。故三者**一律靜態標示、忠實對映 003 設定**：queue=`DIAGNOSIS_QUEUE`（`packages/contracts/src/jobs.ts`＝`"diagnosis"`，前端 **import 契約常數值**即可，屬消費、非改契約）、concurrency=`2`（worker `main.ts` `new Worker(..., { concurrency: 2 })`）、attempts=`3`（`apps/api/.../jobs.service.ts` `attempts: 3` 重試政策）。**不呈現動態 attempt 計數**。
  - **步驟清單**：對應 005 進度里程碑 `0/20/40/60/80/100` 的固定步驟標籤，依當前 `progress` 值把每步標為已完成（<current）/進行中（=current 區間）/待辦（>current）。
- **Rationale**：步驟由既有 `progress` 衍生為呈現，meta 為忠實靜態常數，全程不新增事件/契約（憲章 III/V、FR-023）。里程碑語意沿用 005 FR-018。
- **Alternatives considered**：把 attempt/queue/concurrency 加進 `JobStatus` 契約由 worker 動態回報 → **需改契約 + worker**，違反 FR-023／憲章 III，否決（這正是要避免的「用破護欄去解」）。
- **備註**：僅 active 套用；idle/completed/failed 維持 005 既有行為（Edge case）。

## R12 · 測試策略（呼應憲章「至少純函式單元測試」門檻）

- **Decision**：US1–US6 的核心邏輯一律抽成 `domains/monitoring/lib/*` 純函式並各附 `*.test.ts`（見 plan「Testing」）；store 端補 `monitoring.store.test.ts` 對 fleetHealth getter、事件衍生與 50 上限的整合。pause/RTT/DOM 呈現屬副作用，於 `quickstart.md` 的 live AC 覆蓋。
- **Rationale**：決定性純函式最好測、最穩；符合專案既有 `stale.test.ts`／005 reducer 測試風格。

---

**Phase 0 結論**：所有決策定案，無 `NEEDS CLARIFICATION` 殘留；無違反憲章、無跨邊界。可進入 Phase 1 設計。
