# Implementation Plan: 前端高頻 WebSocket Gatekeeper 監控台

**Branch**: `004-frontend-ws-gatekeeper` | **Date**: 2026-07-02 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/004-frontend-ws-gatekeeper/spec.md`

## Summary

在 002（即時 Gateway＋高頻遙測＋Mongo 歷史）與 003（AI 診斷後端＋`send(clientId,payload)` relay）之上，於 `apps/web` 交付**第一個可操作的監控台**：Vue 3＋Pinia 建立 monitoring domain，`useHighFrequencyWs` composable 以原生 `WebSocket` 連上 Gateway（`/ws`），**onmessage 只 push buffer、不逐筆寫 reactive state**，再用 `requestAnimationFrame` 每幀把 buffer 批次提交到 store（憲章 IV 核心）。UI 以 design-spec token 呈現 `AppLayout` / `TopBar` / `MachineNodeCard` / `StatusLight`：訂閱 5 台固定示範機台、顯示最新 telemetry／state／lastUpdated，冷啟動先渲染 placeholder 卡片＋連線橫幅，點選卡片設定 `selectedMachineId`（selected 視覺）。TopBar 的 `BackpressureBadge` 直接把 `receivedMessages`／`renderedBatches`／`batchRatio` 秀在畫面上，作為「背壓有做到」的可視化佐證。連線韌性：ping/pong 心跳、指數退避＋抖動重連、manual close 清理、connected/reconnecting/disconnected 三態、`>10s` 未更新標 stale 且不清空數值。

技術取捨並非本 plan 自由決定：即時通道用**原生 ws**、高頻**先 buffer 再 rAF 批次**、視覺一律**具名 token（不散落 hex）**，皆為憲章（Principle II/IV）與 design-spec、指南 §10 既定約束。本 feature 只**消費**既有契約（`TelemetryPoint`、控制訊息聯集），不新增後端 event/payload；AI 診斷觸發與 `CopilotDrawer` 明確劃歸 Feature 005，本 feature 僅保存 `clientId` 作為銜接點。

## Technical Context

**Language/Version**: TypeScript 5.6（strict，`noUncheckedIndexedAccess`），Vue 3.5 SFC，ESM（`"type": "module"`）

**Primary Dependencies**:
- 既有：`vue@^3.5`、`pinia@^2.2`、`@flow-gatekeeper/contracts`（`TelemetryPoint`、`MachineState`、控制訊息型別的單一來源）、`@flow-gatekeeper/shared`。
- 新增（前端）：`lucide-vue-next`（design-spec 指定 icon set）。
- 新增（devDependencies）：`vue-tsc`（.vue SFC typecheck）、`eslint-plugin-vue` + `vue-eslint-parser`（lint .vue）、`@vue/test-utils` + `jsdom`（僅在需要掛載元件測試時；純函式／store 測試不需 DOM）。
- 不新增即時通訊套件：即時通道用瀏覽器原生 `WebSocket`（憲章 IV，MUST NOT Socket.IO）。

**Storage**: 前端無持久化。狀態存在 Pinia store（記憶體）；每台機台只保留最新一筆快照（`Map<machineId, MachineLive>`）。歷史持久化屬 002（Mongo），不在本 feature。

**Testing**: Vitest（node environment，`--passWithNoTests` 底線）。至少一支實際純函式／store 單元測試（憲章測試門檻＋FR）：`applyTelemetryBatch` 的「N 筆訊息 → 1 次批次、`receivedMessages` 累加、`batchRatio` 關係」、`nextBackoffDelay(attempt)` 決定性上界、`isStale(lastUpdated, now)` 門檻、label map fallback。皆不需 WebSocket／DOM。

**Target Platform**: 現代瀏覽器（Chromium/Firefox/WebKit 皆支援原生 WebSocket 與 rAF）；開發者本機 Windows / PowerShell，`vite dev` 於 `:5173`，Gateway 於 `:3000`。

**Project Type**: pnpm monorepo — 本 feature 只動 `apps/web`（新增 monitoring／shared components domain）；`packages/contracts` 不改（僅消費）；`apps/api`、`apps/worker` 不在範圍。

**Performance Goals**（對應 Success Criteria）:
- 高頻（每台每 10ms）下互動回應 <100ms、30s 無明顯 long task（SC-001）；達成手段＝buffer + rAF 每幀批次，reactive 提交次數（`renderedBatches`）遠少於訊息數（`receivedMessages`）。
- `batchRatio ≥ 10:1` 且即時顯示於畫面（SC-002）。
- 斷線後 ≤30s 自動重連並恢復（SC-003）；指數退避 base `min(1000·2^attempt, maxReconnectMs=30000)` + 30% 抖動。
- 四個 viewport 無溢出／重疊／layout shift（SC-004）；`>10s` 標 stale 保留數值（SC-005）；只呈現訂閱機台（SC-006）。

**Constraints**（皆憲章／design-spec／指南既定，非本 plan 決定）:
- 即時通道 MUST 用原生 `WebSocket`（憲章 IV，見 `docs/adr-001-native-websocket.md`）。
- 高頻遙測 MUST 先進 buffer、再 rAF 每幀批次提交，MUST NOT 逐筆寫 reactive state（憲章 IV）。
- buffer MUST 設上限（背景分頁 rAF 暫停時丟最舊保最新，避免記憶體無限成長）。
- 顏色／圓角／陰影／狀態樣式一律用 design-spec 具名 token（Tailwind `theme.extend`），MUST NOT 在元件內散落 hex（憲章 II、design-spec §1/§9）。
- 第一屏 MUST 是可操作監控台，非 landing page（design-spec §1）。
- Secrets：dev 前端 subscribe 送空 token，MUST NOT 把 `WS_AUTH_SECRET` 打包進 bundle（憲章 VI、spec Clarifications）。
- strict TS、無 `any` 擴散（憲章 III、root eslint `no-explicit-any: error`）。

**Scale/Scope**: 5 台固定示範機台（`mixer-01`/`press-02`/`pack-03`/`oven-04`/`sorter-05`，沿用 002）。新增元件：shared（`AppLayout`、`TopBar`、`StatusLight`、`BackpressureBadge`）、monitoring domain（`MachineNodeCard`、`TopologyCanvas`、`monitoring.store`、`useHighFrequencyWs`、`machineLabels`、純函式 helpers）。`ProgressBar`/`SeverityBadge`/`CopilotDrawer`/`EventStrip` 屬 005 或後續，本 feature 不建。

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| 原則 | 與本 feature 的關係 | 狀態 |
|------|--------------------|------|
| I. 規格驅動開發 | 走完整 Spec Kit 流程，於 `004-frontend-ws-gatekeeper` branch；specify→clarify→plan→…；不手貼 code 又跑 implement；merge 回 develop 用 `--no-ff` | ✅ PASS |
| II. 單一真實來源 | 視覺一律取自 `apps/web/design/design-spec.md` §4/§5 具名 token（Tailwind `theme.extend` v0.4 已落地），元件內不散落 hex；訊息型別取自 `packages/contracts`，不另立平行定義 | ✅ PASS |
| III. 契約優先與全棧型別安全 | **消費** `TelemetryPoint`／控制訊息聯集，不新增契約；strict TS、無 `any`；新增 `.vue` 以 `vue-tsc` 納入 typecheck、`eslint-plugin-vue` 納入 lint | ✅ PASS |
| IV. 即時通道架構紀律 | **本 feature 的核心**：前端原生 `WebSocket`（非 Socket.IO）；高頻遙測 onmessage 只 push buffer → `requestAnimationFrame` 每幀批次提交；控制訊息與遙測分流不混入 buffer；buffer 設上限 | ✅ PASS |
| V. AI 診斷紀律 | 不在本 feature 範圍（診斷觸發／串流呈現屬 005）；本 feature 僅保存 `clientId` 作為 005 銜接點 | ✅ N/A |
| VI. 祕密與設定衛生 | dev 前端 subscribe 送空 token，不把 `WS_AUTH_SECRET` 打包進 bundle；不新增任何提交的祕密（`.env.example` 既有 `WEB_PORT` 已足夠） | ✅ PASS |
| VII. 資料可追溯性 | 前端不持久化；歷史落地屬 002（Mongo），本 feature 只呈現最新快照，無「只存 Redis」情形 | ✅ N/A |
| 測試門檻 | 至少一支實際純函式／store 單測（batching 關係、backoff 決定性、stale 門檻、label fallback），不需 DOM；其餘維持 `--passWithNoTests` | ✅ PASS |
| 可重播驗收 | 沿用 002 決定性 mock producer（`press-02` critical、`oven-04` warning 週期出現）→ 監控台可重播展示；第一屏為可操作監控台（design-spec） | ✅ PASS |
| Phase 化遞交 | implement 以 tasks.md 的 phase 為遞交單位，逐 phase 勾選並 commit | ✅ PASS（流程約束） |

**Gate 結論**：無違規，無需 Complexity Tracking。本 feature 是憲章 IV 前端側（buffer+rAF、原生 ws）的實際兌現，視覺完全依 design-spec token；未引入任何繞過原則的複雜度。唯一「取捨」是 dev 階段訂閱不帶 token（實質開放），已於 spec Clarifications／Assumptions 明列，屬 side-project demo 既定範圍，非繞過 Principle VI（反而避免把祕密打包進 bundle）。

## Project Structure

### Documentation (this feature)

```text
specs/004-frontend-ws-gatekeeper/
├── plan.md              # This file
├── research.md          # Phase 0 output（前端技術決策：typecheck/lint/測試環境/WS 連線/字型）
├── data-model.md        # Phase 1 output（store state/getters/actions、label map、stale/backoff 純函式）
├── quickstart.md        # Phase 1 output（可重播驗收腳本：起服務、看比值、殺 api 重連、stale）
├── contracts/           # Phase 1 output
│   ├── ws-client.contract.md   # 前端↔Gateway 訊息協定（消費 packages/contracts；subscribe 空 token/分流/批次）
│   └── ui-surface.contract.md  # 元件 props/states（引用 design-spec 為 SoT，不重述 token）
├── checklists/
│   └── requirements.md  # /speckit-specify 既有產物
└── tasks.md             # /speckit-tasks 產物（非本指令建立）
```

### Source Code (repository root)

```text
apps/web/
├── package.json                 # ★ +lucide-vue-next；dev: +vue-tsc/eslint-plugin-vue/vue-eslint-parser（測試需要時 +@vue/test-utils/jsdom）
├── tsconfig.json                # ★ include 加入 "src/**/*.vue"；typecheck script 改走 vue-tsc
├── vite.config.ts               # ★ server.proxy '/ws' → http://localhost:3000（ws:true），前端連同源 /ws
├── index.html                   # ★（可選）掛 Inter / JetBrains Mono 字型連結
├── tailwind.config.ts           # 沿用（v0.4 token，不改）
└── src/
    ├── main.ts                  # ★ 改寫：createApp(App) + use(createPinia()).mount('#app')（取代 001 骨架）
    ├── App.vue                  # ★ 組裝 AppLayout + 啟動 useHighFrequencyWs + 訂閱 5 台
    ├── shared/components/
    │   ├── AppLayout.vue        # ★ sidebar/top bar/main/drawer slot；connectionStatus、drawerOpen
    │   ├── TopBar.vue           # ★ search（外觀）、connection chip、BackpressureBadge、diagnose 佔位（→005 啟用）
    │   ├── StatusLight.vue      # ★ healthy/warning/critical + pulse + aria-label
    │   └── BackpressureBadge.vue# ★ receivedMessages/renderedBatches/ratio（中性色、mono、千分位、tooltip）
    └── domains/monitoring/
        ├── components/
        │   ├── MachineNodeCard.vue   # ★ id(mono)+名稱+state+溫/振/吞/錯+lastUpdated+selected/stale/hover；placeholder 佔位
        │   └── TopologyCanvas.vue    # ★ node grid（topology-bg）容納卡片，responsive 不溢出
        ├── stores/
        │   ├── monitoring.store.ts   # ★ machines Map/selectedMachineId/connectionStatus/received/rendered + getters/actions
        │   └── monitoring.store.test.ts # ★ applyTelemetryBatch 批次關係 / batchRatio 單測
        ├── composables/
        │   └── useHighFrequencyWs.ts # ★ 原生 ws + buffer + rAF pump + heartbeat + backoff + manualClose（指南 §10.3）
        └── lib/
            ├── machine-labels.ts     # ★ 純：machineId→顯示名稱靜態表 + fallback
            ├── machine-labels.test.ts# ★ fallback 測試
            ├── backoff.ts            # ★ 純：nextBackoffDelay(attempt, maxMs)
            ├── backoff.test.ts       # ★ 上界/單調 測試
            └── stale.ts              # ★ 純：isStale(lastUpdated, now, thresholdMs)
```

**Structure Decision**: 沿用 monorepo，前端採 **domain 導向**佈局（`shared/components` 放跨 domain 的外殼元件；`domains/monitoring` 放本 feature 專屬 store／composable／卡片），與 design-spec §9 File Mapping 對齊。**關鍵責任切分**：`useHighFrequencyWs` 只負責「連線＋buffer＋每幀 flush」並透過 `onBatch` 回呼把批次交給 store 的 `applyTelemetryBatch`——把「高頻不逐筆重繪」的憲章 IV 紀律**封裝在單一 composable**，元件與 store 拿到的都是「已批次」的資料。**把 backoff／stale／label／batchRatio 抽成純函式或 store getter**，讓憲章測試門檻的單測不需啟動 WebSocket 或 DOM。WS 連線走 **Vite `/ws` proxy**（同源），避免 CORS 與把祕密塞進前端。`ProgressBar`/`SeverityBadge`/`CopilotDrawer`/`EventStrip` 留給 005，本 feature 不建，維持 004 scope 收斂。

## Complexity Tracking

> 無 Constitution Check 違規，本節不適用。
