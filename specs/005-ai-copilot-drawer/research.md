# Phase 0 Research — AI Copilot Drawer

所有 spec 的 `[NEEDS CLARIFICATION]` 已於兩輪 `/speckit-clarify` 消解（見 spec §Clarifications）。本檔記錄實作前的關鍵技術決策與理由，供 Phase 1 設計與 tasks 依循。

## R1 — 診斷事件如何進前端：復用單一 WebSocket，加分流回呼

- **Decision**: 不新增連線。於 004 `useHighFrequencyWs` 的 `handleMessage` default 分支（現忽略 `ai/*`／`job/status`，[useHighFrequencyWs.ts:153-155](../../apps/web/src/domains/monitoring/composables/useHighFrequencyWs.ts#L153)）新增一個可選 `onDiagnosisEvent(event)` 回呼，把 `job/status`／`ai/token`／`ai/done`／`ai/error` 交給 `copilot.store`。診斷事件 MUST NOT 進遙測 buffer。
- **Rationale**: 憲章 IV「即時通道用單一原生 ws」；診斷事件與遙測經同一條 Gateway 連線回送（003 relay 以 `send(clientId, payload)`）。用回呼分流可保持 004 的 buffer/rAF 遙測路徑不受影響（FR-017／SC-007）。
- **Alternatives considered**：(a) 005 自開第二條 WebSocket —— 違反單一連線、且 clientId 會不一致，被否決；(b) 把診斷事件也塞進遙測 buffer 走 rAF —— 破壞分流語意、且診斷事件需即時反映（token/done），被否決。

## R2 — 觸發診斷：原生 fetch `POST /diagnoses` + dev proxy

- **Decision**: `diagnose-api.ts` 用瀏覽器 `fetch` 打 `POST /diagnoses`，body `{ machineId, socketId, requestedBy? }`，`socketId` = 004 對外的最新 `clientId`。dev 於 `vite.config` 新增 proxy 把 `/diagnoses` 轉發到 `http://localhost:3000`（與既有 `/ws` proxy 同理）。
- **Rationale**: 003 已定義 `POST /diagnoses` 且 dev 開放不需授權；`socketId` 即 WS `clientId`（[jobs.controller.ts](../../apps/api/src/modules/jobs/jobs.controller.ts) 缺欄位回 400）。同源 proxy 免 CORS、不把後端位址硬編進 bundle（呼應 004 R2、憲章 VI）。
- **Alternatives considered**：直接打 `http://localhost:3000/diagnoses` 絕對網址 —— 需 CORS 且把位址寫進 bundle，與 004 的 proxy 慣例不一致，被否決。

## R3 — 任務狀態容器：`Map<machineId, CopilotJobState>`（每台一份）

- **Decision**: `copilot.store` 以 machineId 為 key 維護每台狀態機（idle／active／completed／failed）。drawer 依 `selectedMachineId` 取當前那一份呈現。多台可並存 active。
- **Rationale**: spec Clarification Q1／FR-010／US2-3——切換選取須還原該台既有呈現、多台互不干擾。對齊 004 已以 `selectedMachineId` 驅動選取的模式。
- **Alternatives considered**：單一全域「目前任務」—— 切台會遺失前台結果、無法滿足 US2-3，被否決。

## R4 — 過期／亂序事件過濾：以「該台目前 activeJobId」為準

- **Decision**: 每台狀態保存 `activeJobId`。收到某 `job/status`／`ai/*` 時，若其 `jobId` 不等於該台目前 `activeJobId`（例如 Retry 後舊 job 的遲到片段），純函式 `isStaleJobEvent` 判定為過期並忽略（FR-011）。`ai/token` 另以 `seq` 保序 append。
- **Rationale**: Retry 會產生新 jobId；舊 job 的殘餘 token 不得覆蓋新任務內容。以 activeJobId 比對是決定性、可單元測試的判準。
- **Alternatives considered**：以時間戳判定 —— 事件無穩定單調時間欄位且較脆弱，被否決。

## R5 — 進度：前端純事件驅動 + worker 綁真實階段（FR-018）

- **Decision（前端）**: `ProgressBar` 只反映 `job/status.progress`；未帶時 indeterminate（`aria` 用 indeterminate 描述），待首個數值 progress 再顯示百分比。前端不合成、不映射假值。
- **Decision（worker/003）**: 把 `main.ts` 的 `updateProgress` 由現行 `5/20/100` 改為綁真實階段的 `0/20/40/60/80/100`：`0`=job active、`20`=`buildDiagnosisContext` 返回、`40`=取得去重鎖即將呼叫 LLM（現 `updateProgress(20)` 位置）、`60`=`streamDiagnosis` 首個 token（`seq===0` 觸發一次）、`80`=`parseResult` 成功後、`100`=寫庫/快取後；cache-hit 路徑直接 `100`。
- **Rationale**: spec Clarification Q4（改綁真實階段，非 token 數估計）；每格對應確實發生的事件，可於 quickstart live 驗收。契約不變（`job/status` 既有 optional `progress`）。
- **落點對應**：`20`→[main.ts:69](../../apps/worker/src/main.ts#L69) 之後、`40`→取代 [main.ts:101](../../apps/worker/src/main.ts#L101)、`60`→[main.ts:104-107](../../apps/worker/src/main.ts#L104) token callback `seq===0`、`80`→[main.ts:111](../../apps/worker/src/main.ts#L111) 之後、`100`→維持 [main.ts:124](../../apps/worker/src/main.ts#L124)／[main.ts:87](../../apps/worker/src/main.ts#L87)（cached）。
- **Alternatives considered**：token-count 估計 40/60/80 —— demo 可行但值為估算，與「反映真實狀況」訴求不符，已於 clarify 改掉。

## R6 — 串流 token append：直接提交，不套遙測 rAF；但不破壞遙測背壓

- **Decision**: `ai/token` 到達即 append 至該台 `streamText`（相對低頻，人眼可讀速率）。不進 004 遙測 buffer、不共用遙測 rAF pump。`StreamingPanel` 未手動捲動時貼底跟隨、手動上捲則不強拉（FR-013）。
- **Rationale**: 診斷 token 頻率遠低於 10–50ms 遙測；直接 append 不會造成背壓問題，且需即時可見（SC-002）。憲章 IV 的 rAF 批次針對「高頻遙測」，token 不屬此類。FR-017／SC-007 要求兩者互不干擾——分流即達成。
- **Alternatives considered**：token 也走 rAF 批次 —— 徒增延遲與複雜度、無收益，被否決。若日後 token 異常高頻，可再引入節流，non-goal for now。

## R7 — 中斷收尾：重連（新 clientId）觸發，不用逾時

- **Decision**: `copilot.store` 訂閱 004 既有的 `onConnected`（每次 system/connected 觸發、帶新 clientId）。若某台當下為 active，且偵測到 clientId 變更（重連），把該台標為 failed（中斷）＋可 Retry。無逾時計時器。
- **Rationale**: spec Clarification Q3／FR-012——重連派新 clientId 使舊綁定失效是確定性事實；後端錯誤另由 `ai/error`／`job/status:failed` 顯式回報（FR-007）。避免逾時門檻的誤殺與可測性問題。
- **Alternatives considered**：逾時偵測、A+B 併用 —— 門檻難定、複雜度高、demo 極少走到，被否決。

## R8 — 桌機常駐面板 vs 手機 bottom-sheet：AppLayout 響應式

- **Decision**: `AppLayout` 右側 drawer 於 `md+` 常駐（版面固定欄，`drawerOpen` 對桌機恆真、idle 也顯示）；於 mobile 改為 bottom-sheet（覆蓋層、可 Escape 關閉、高度 70–85vh，design-spec §5.3）。`CopilotDrawer` 內容單一，外層容器負責響應式形態。
- **Rationale**: spec Clarification Q5／FR-002/FR-014/FR-015；design-spec §5「右側 drawer 為版面一部分」「Copilot 手機為 bottom sheet」。桌機常駐讓 idle 摘要即時可見、Diagnose 就地轉 active 無位移。
- **Alternatives considered**：桌機也預設收合按需開 —— 與 design-spec 版面與 idle 摘要語意不合，被否決。

## R9 — 測試策略：reducer 純函式優先

- **Decision**: 核心狀態轉移抽成純函式 `copilotReducer(state, event)` 與 `isStaleJobEvent`／`progressLabel`，以 Vitest 覆蓋：waiting→active→completed（含 cached）、ai/token append 保序、ai/error→failed、job/status:failed→failed、過期 jobId 片段被忽略、indeterminate progress label。store 只做副作用（fetch、訂閱回呼）薄殼。worker 進度里程碑於 quickstart AC 驗收。
- **Rationale**: 憲章測試門檻要求純函式單元測試；把決定性邏輯抽離 Vue／WebSocket 讓測試不需 DOM／網路、快速可靠（對齊 004 的 backoff/stale/label 測試風格）。
- **Alternatives considered**：只做元件 e2e —— 慢且脆，覆蓋狀態機邊界不足，被否決。
