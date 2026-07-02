# Implementation Plan: AI Copilot Drawer

**Branch**: `005-ai-copilot-drawer` | **Date**: 2026-07-02 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/005-ai-copilot-drawer/spec.md`

## Summary

在 002（即時 Gateway＋遙測）、003（BullMQ 診斷 job＋AI streaming＋cache-aside＋`send(clientId,payload)` relay）、004（前端監控台＋原生 `WebSocket`＋`selectedMachineId`＋對外保存最新 `clientId`）之上，於 `apps/web` 交付**可操作的 AI 診斷入口**：新增 `ai-copilot` domain——`copilot.store` 以 `Map<machineId, CopilotJobState>` 維護**每台各自**的診斷任務狀態機（idle／active／completed／failed，多台可並存），`CopilotDrawer`（桌機常駐右側面板、手機 bottom-sheet）依目前選取機台呈現對應那一份。按 Diagnose 時帶 004 對外提供的最新 `clientId`（即 `socketId`）呼叫既有 `POST /diagnoses`；後端把 job 綁定此連線，之後 `job/status`／`ai/token`／`ai/done`／`ai/error` 皆經**同一條 004 WebSocket** 回送。004 的 `useHighFrequencyWs` 目前在 `handleMessage` 對 `ai/*`／`job/status` 走 default 忽略（[useHighFrequencyWs.ts:153-155](../../apps/web/src/domains/monitoring/composables/useHighFrequencyWs.ts#L153)）——005 於此加一個 `onDiagnosisEvent` 分流回呼，把診斷事件交給 `copilot.store`，維持「單一 WebSocket 連線」不新增第二條通道（憲章 IV）。

前端政策：progress **純事件驅動**（未帶 `progress` 時 indeterminate，不合成假值）；`ai/token` 逐段 append＋caret，`completed` 保留串流文字但預設收合、主視覺為結構化結果（欄位對齊 `DiagnosisResultSchema`）；同機台 active 期間禁重複送出（去重僅限同機台）；`cached:true` 顯示 Cached badge；重連（新 `clientId`）即把該台進行中任務標中斷＋Retry（不用逾時）。

本 feature **原則上只動 `apps/web`**（消費既有契約，不新增 event/payload）。唯一跨邊界例外：一項小幅 **worker（003）進度細化**（FR-018）——把 `updateProgress` 由現行 `5/20/100` 改綁**真實處理階段**回報 `0/20/40/60/80/100`，通訊契約不變（沿用 `job/status` 既有 optional `progress`）。另需一項 dev-only 的 `vite.config` proxy（把 `POST /diagnoses` 轉發到 :3000，與既有 `/ws` proxy 同理，避免 CORS 與硬編後端位址）。

## Technical Context

**Language/Version**: TypeScript 5.6（strict，`noUncheckedIndexedAccess`），Vue 3.5 SFC，ESM。Worker 端為 Node ESM（既有）。

**Primary Dependencies**:
- 既有（消費）：`vue@^3.5`、`pinia@^2.2`、`@flow-gatekeeper/contracts`（`JobStatus`、`AiToken`、`AiDone`、`AiError`、`DiagnosisResult`／`DiagnosisResultSchema` 的單一來源）、`lucide-vue-next`（icon）、004 的 `useHighFrequencyWs`／`monitoring.store`（`selectedMachineId`、`clientId`）。
- 新增套件：**無**。診斷觸發用瀏覽器原生 `fetch`（`POST /diagnoses`），串流走既有 WebSocket，皆不需新依賴。
- 測試（既有 devDeps）：`vitest`、`@vue/test-utils` + `jsdom`（僅掛載元件測試時）。

**Storage**: 前端無持久化。任務狀態存 Pinia store（記憶體，`Map<machineId, CopilotJobState>`）。診斷結果／trigger 的持久化屬 003（Mongo），不在本 feature。

**Testing**: Vitest（node environment）。純函式／reducer 優先（不需 DOM）：`copilotReducer(state, event)` 對 `job/status`／`ai/token`／`ai/done`／`ai/error` 的狀態轉移（含 append token、cached、failed、忽略過期 job 片段）、`isStaleJobEvent(current, incoming)` 過期片段判定、`progressLabel`（含 indeterminate）。worker 端：進度里程碑為副作用，於 quickstart live 驗收（AC）覆蓋。

**Target Platform**: 現代瀏覽器（原生 WebSocket／fetch／rAF）；本機 Windows / PowerShell，`vite dev` :5173、Gateway/API :3000、worker 獨立 process、infra `docker compose`（Redis 7 + Mongo 7）。

**Project Type**: pnpm monorepo。主要改動 `apps/web`（新增 `ai-copilot` domain、共用 `SeverityBadge`/`ProgressBar`、AppLayout 響應式 drawer、`vite.config` dev proxy）；附帶小改 `apps/worker`（FR-018 進度里程碑）；`packages/contracts` 不改（僅消費）；`apps/api` 不改。

**Performance Goals**（對應 Success Criteria）:
- 按 Diagnose 後 drawer <1s 進入 active（SC-001）；達成手段＝送出即本地建立該台 active 狀態，不等任何事件先回。
- token 逐段可見、不等 done（SC-002）；`ai/token` 到達即 append（低頻，不需 rAF 背壓，但 MUST NOT 破壞 004 遙測的 rAF 批次——SC-007／FR-017）。
- 進度至少經過 20/40/60/80 中間里程碑且對應真實階段（SC-008／FR-018）。

**Constraints**（多為憲章／design-spec／既定約束，非本 plan 自由決定）:
- 即時通道 MUST 用**同一條**原生 WebSocket（憲章 IV）；診斷事件經 004 composable 分流，MUST NOT 另開第二條連線或引入 Socket.IO。
- 高頻遙測的 buffer + rAF 批次策略 MUST NOT 被診斷串流破壞（憲章 IV、FR-017）；`ai/token` 為相對低頻，直接 append 可接受但不得混入遙測 buffer。
- AI 結果 MUST 以 `DiagnosisResultSchema` 對齊呈現；前端消費後端**已驗證**結果，不自行放寬（憲章 III/V）。
- 視覺一律 design-spec 具名 token（`SeverityBadge`/`ProgressBar`/`CopilotDrawer` 見 §7.6/§7.7），MUST NOT 散落 hex（憲章 II）。
- Secrets：診斷 REST 於 dev 開放、不需 token（003 Clarifications）；MUST NOT 把祕密打包進 bundle（憲章 VI）。
- strict TS、無 `any` 擴散（憲章 III）。

**Scale/Scope**: 5 台固定示範機台（沿用 004）。新增：`ai-copilot` domain（`CopilotDrawer.vue` + 子區塊、`copilot.store.ts`、`copilotReducer` 純函式與測試、`diagnoseApi` fetch helper）、共用 `SeverityBadge.vue`/`ProgressBar.vue`、`useHighFrequencyWs` 加 `onDiagnosisEvent` 分流、`AppLayout` 響應式 drawer、App.vue 接線、`vite.config` proxy、worker 進度里程碑。

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| 原則 | 與本 feature 的關係 | 狀態 |
|------|--------------------|------|
| I. 規格驅動開發 | 於 `005-ai-copilot-drawer` branch 走完整流程 specify→clarify→plan→…；不手貼 code 又跑 implement；merge 回 develop 用 `--no-ff` | ✅ PASS |
| II. 單一真實來源 | 視覺取自 design-spec §7.6/§7.7 具名 token（SeverityBadge/CopilotDrawer/ProgressBar）；診斷事件與結果型別取自 `packages/contracts`，不另立平行定義 | ✅ PASS |
| III. 契約優先與全棧型別安全 | **消費** `JobStatus`/`AiToken`/`AiDone`/`AiError`/`DiagnosisResult`，不新增契約（worker 只改 progress **值**、不改型別）；`DiagnosisResultSchema` 為結果呈現的欄位依據；strict TS、無 `any` | ✅ PASS |
| IV. 即時通道架構紀律 | 診斷事件走**既有同一條**原生 WebSocket，經 004 composable 分流交 store（非第二條連線、非 Socket.IO）；`ai/token` 不混入遙測 buffer，遙測 rAF 批次不被破壞（FR-017） | ✅ PASS |
| V. AI 診斷紀律 | 前端只呈現後端**已 `DiagnosisResultSchema.parse()`** 的結果；cache/dedupe 屬 003，前端呈現 `cached` badge 與同機台去重（UI 層），不繞過後端 | ✅ PASS |
| VI. 祕密與設定衛生 | 診斷 REST dev 開放、送出不帶祕密；`vite.config` proxy 用同源路徑，不硬編後端位址、不打包祕密 | ✅ PASS |
| VII. 資料可追溯性 | 前端不持久化；診斷結果/trigger 落 Mongo 屬 003，本 feature 只呈現，無「只存 Redis」情形 | ✅ N/A |

**跨邊界例外（FR-018 worker 進度細化）**：屬 003/worker 的**行為**微調（`updateProgress` 里程碑），不新增契約、不改 API process 職責、不讓 worker emit WebSocket（進度仍走 BullMQ QueueEvents→ Gateway relay）。與憲章 IV「雙通道分流」一致（job lifecycle 走 QueueEvents），不構成違反，無需 Complexity Tracking 記錄。

**結論**：Constitution Check ✅ PASS（Phase 0 前）。無違反、無 Complexity Tracking 項目。

## Project Structure

### Documentation (this feature)

```text
specs/005-ai-copilot-drawer/
├── plan.md              # 本檔
├── research.md          # Phase 0 輸出
├── data-model.md        # Phase 1 輸出（前端狀態機／實體）
├── quickstart.md        # Phase 1 輸出（live 驗收指引）
├── contracts/           # Phase 1 輸出（消費之事件契約參照＋前端 store/REST 介面契約）
│   ├── consumed-events.md
│   ├── diagnose-rest.md
│   └── copilot-store.md
├── checklists/
│   └── requirements.md  # 已存在（specify/clarify 產出）
└── tasks.md             # Phase 2（/speckit-tasks 產出，非本命令）
```

### Source Code (repository root)

```text
apps/web/src/
├── domains/
│   ├── monitoring/                         # 004 既有；本 feature 小改
│   │   └── composables/
│   │       └── useHighFrequencyWs.ts       # 改：新增 onDiagnosisEvent 分流回呼（default 分支）
│   └── ai-copilot/                         # 新增 domain（design-spec §9 File Mapping）
│       ├── components/
│       │   ├── CopilotDrawer.vue           # 主面板：header/status/streaming/result（桌機常駐、手機 bottom-sheet）
│       │   ├── StreamingPanel.vue          # 串流文字 + caret + 自動貼底跟隨（FR-013）
│       │   ├── DiagnosisResultView.vue     # summary/severity/likelyCauses/evidence/suggestedActions
│       │   └── SuggestedActionList.vue     # 建議動作（含 priority）
│       ├── stores/
│       │   ├── copilot.store.ts            # Map<machineId, CopilotJobState>；actions：diagnose/retry/applyEvent/onReconnect
│       │   └── copilot.store.test.ts
│       └── lib/
│           ├── copilot-reducer.ts          # 純函式：reducer(state,event)、isStaleJobEvent、progressLabel
│           ├── copilot-reducer.test.ts
│           └── diagnose-api.ts             # fetch POST /diagnoses（帶 socketId=clientId）
├── shared/components/
│   ├── AppLayout.vue                       # 改：drawer 響應式（桌機常駐右欄；手機 bottom-sheet）
│   ├── SeverityBadge.vue                   # 新增（design-spec §7.6）
│   ├── ProgressBar.vue                     # 新增（design-spec §7.x；aria-valuenow / indeterminate）
│   └── TopBar.vue                          # 改：diagnose action 作用於 selectedMachineId（design-spec §7.2）
├── domains/monitoring/components/
│   └── MachineNodeCard.vue                 # 改（可選）：卡片 diagnose icon 觸發（design-spec §7.4）
├── App.vue                                 # 改：接 copilot.store、onDiagnosisEvent、drawer 呈現、diagnose 觸發
└── vite.config.ts                          # 改：dev proxy 增加 POST /diagnoses → :3000

apps/worker/src/
└── main.ts                                 # 改：FR-018 進度里程碑 0/20/40/60/80/100（綁真實階段）
```

**Structure Decision**: 沿用 004 已建立的 monorepo／domain 佈局與 design-spec §9 File Mapping。新增獨立 `ai-copilot` domain 與其 store／reducer／components；共用視覺元件（`SeverityBadge`/`ProgressBar`）落 `shared/components`。單一 WebSocket 連線由 004 `useHighFrequencyWs` 持有，005 以回呼消費診斷事件（不新增連線）。worker 僅動 `main.ts` 進度里程碑。

## Complexity Tracking

> 無 Constitution 違反，無需記錄。（FR-018 跨邊界例外已於 Constitution Check 說明為合規的行為微調。）
