# Feature Specification: AI Copilot Drawer

**Feature Branch**: `005-ai-copilot-drawer`

**Created**: 2026-07-02

**Status**: 已完成（v1.0.0；2026-07-03 以 `db3902b` 併入 develop）；之後變更見指南 §15.6「v1.0.0 之後的現況摘要」

> ⚠️ **已變更（2026-09-27 盤點）**：下列原敘述已被 v1.0.0 之後的修復／升級改變；內文保留為歷史，現況以指南 §15.6「v1.0.0 之後的現況摘要」為準（`docs/Flow-Gatekeeper-SDD-完整實作指南.md`）。
>
> - FR-003／FR-008 帶 `socketId` 觸發、active 期間禁用重送 → Diagnose 只在連線就緒時可按（`system/connected` 且已 `machine/subscribed`、未斷線、未收到 `system/unauthorized`），卡片 icon 等所有入口共用同一閘門；`jobId` 前端產生、送出前先建 pending；in-flight 去重；fetch 15 秒逾時。
> - FR-005／FR-006 串流文字 append → `ai/*` 帶 `attempt`，重試換輪時清空串流文字；`ai/done` 另有二次 schema 防線。
> - FR-007 錯誤呈現 → `409`（WebSocket 連線不存在或未授權）顯示可讀訊息；非最終嘗試不會收到 `ai/error`，最終失敗由 api 補送 `worker_failed`。
> - FR-016 無障礙 → StreamingPanel 不再逐 token 朗讀；行動版改 dialog＋focus trap。

**Input**: User description: "在 apps/web 實作 AI Copilot drawer。範圍：使用 design-spec token 與 refs/copilot-drawer.png 視覺；顯示 selected machine 的 diagnosis job 狀態；job/status 事件更新 progress（waiting/active/completed/failed）；ai/token 事件 append streaming text；ai/done 顯示 severity、summary、likely causes、evidence、suggestedActions；ai/error 顯示錯誤與 retry；同一 machine active job 期間 disable duplicate submit；Cache hit 顯示 cached badge。成功條件：點 Diagnose 後 drawer 立刻進入 active；token 逐段顯示，不等 done；done 後 structured result 正確渲染；failed 可 retry；desktop/mobile 不溢出。"

## Clarifications

### Session 2026-07-02

- Q: drawer 底層要維護「每台各自的任務狀態」還是「單一目前任務」？ → A: 以 `machineId` 為 key 的每機台任務狀態（Map）：切換選取即還原該台的 active/completed/failed 呈現，多台可並存進行；drawer 同一時間仍只呈現目前選取（或指定）機台的那一份。
- Q: completed 後先前逐段串流的推理文字要保留、收合還是移除？ → A: 保留但預設收合（可展開回看）；completed 主視覺為結構化結果，串流文字收進可展開區塊，避免版面被長文字撐開。
- Q: 進行中任務被判定「中斷」的觸發訊號為何（供 FR-012 可測收尾）？ → A: 以即時通道重連為觸發——active 任務期間收到新的 `system/connected`/新 `clientId` 即把該任務標中斷/失敗並提供 Retry；不採逾時偵測（後端錯誤已由 `ai/error`/`job/status: failed` 顯式回報，見 FR-007）。
- Q: 進度條數值以何為準？後端只給 5/20/100 是否夠？ → A: 前端純事件驅動——progress 完全以 `job/status` 攜帶之值為準，不在前端合成/映射；事件未帶 progress（waiting 或首個裸 active）時以 indeterminate 呈現。另附帶一項小幅 worker（003）調整：把 progress 綁到 worker **真實處理階段**回報 0/20/40/60/80/100（0=job active、20=context 組好、40=取鎖即將呼叫 LLM、60=串流首個 token、80=串流結束且 schema 解析成功、100=寫庫/快取並發 `ai/done`）——每格對應確實發生的事件，非 token 數估計。契約不變（沿用 `job/status` 既有 optional `progress`）。
- Q: 桌機上 drawer 平時是常駐面板還是預設收合、按 Diagnose 才開？ → A: 桌機為**常駐面板**（idle 也顯示，選取機台即在 drawer 內見摘要與 Run diagnosis）；FR-002 的「立即開啟」在桌機退化為「立即進入 active 呈現」（無開合位移）。手機維持 bottom-sheet 按需開合。
- Q: Retry 是否可能命中快取（重試診斷的 cache 行為）？（原 CHK038） → A: 可以——Retry 等同對同機台重新呼叫 `POST /diagnoses`，簽章相同時後端 cache-aside 自然回 `cached:true`，drawer 照常顯示 Cached badge；前端不特別繞過快取（尊重 003 去重/快取設計）。
- Q: 跨機台並發診斷是否設上限？（原 CHK039） → A: 前端不設額外並發上限——並發實質受限於 5 台固定示範機台，且每台仍受同機台去重（FR-008）約束；呼叫速率由後端 `AI_RPM` limiter（003）控制，前端不重複實作節流。

## User Scenarios & Testing *(mandatory)*

本 feature 的「使用者」是**監控台操作者兼技術評審**：在 004 監控台上盯著高頻機台狀態、看到某台轉為 warning／critical 後，想「就地」對這台機台觸發一次 AI 診斷，並在同一畫面上**逐段看到 AI 推理過程**與最終結構化結論（嚴重度、可能原因、佐證、建議動作），而不用切頁或等整段生成完。其價值是：在 002 即時 Gateway／遙測、003 BullMQ + AI streaming 後端、004 前端監控台之上，讓系統第一次擁有**可操作的 AI 診斷入口**——把後端已經跑通的「建立 job → token 串流 → 結構化結果 → 快取去重」在前端 drawer 中完整、即時、可重複地呈現出來，作為整個 demo 的收尾亮點。

診斷任務的建立與串流承載於既有後端：前端按下 Diagnose 時，帶著目前即時通道的連線識別（`socketId` 即 WS `clientId`）呼叫建立診斷的 HTTP 入口（`POST /diagnoses`）；後端把該 job 綁定到此連線，之後的 `job/status`、`ai/token`、`ai/done`、`ai/error` 事件皆經由同一條即時通道回送到本連線（契約見 `packages/contracts`）。

### User Story 1 - 對選取機台觸發診斷並在 drawer 內看到串流推理與結構化結果 (Priority: P1)

操作者在 004 監控台選取一台機台（`selectedMachineId`）後按下 Diagnose，Copilot drawer 立即開啟並進入 active：先顯示任務狀態（waiting → active）與進度，接著 AI 的推理文字**逐段串流出現**（不等生成結束），最後在 done 時原地渲染出結構化結果——嚴重度徽章、摘要、可能原因、佐證片段與建議動作。

**Why this priority**: 「就地觸發診斷並即時看到串流 + 結構化結果」是本 feature 的核心能力與最小可行產物——只要這一條成立，系統就有一個會動、可展示、可獨立驗收的 AI 診斷入口，構成 demo 的高潮段落。

**Independent Test**: 啟動前後端與 worker，於監控台選取一台機台按 Diagnose，確認 drawer 立即進入 active、進度條走動、推理文字逐段出現、done 後正確渲染 severity／summary／likely causes／evidence／suggested actions 五個區塊——即可獨立驗收。

**Acceptance Scenarios**:

1. **Given** 監控台已選取一台機台且即時通道已連線，**When** 操作者按下 Diagnose，**Then** Copilot drawer 立即開啟並進入 active 狀態，顯示該機台識別與任務進度，且不需等待任何 AI 文字先出現。
2. **Given** 任務進入 active，**When** 後端開始推送 AI 推理 token，**Then** drawer 的串流面板逐段 append 文字並顯示串流游標，過程中不需等到整段生成完成即可看見內容。
3. **Given** 任務完成，**When** 最終結果抵達，**Then** drawer 原地渲染結構化結果：嚴重度徽章（ok／warning／critical）、摘要、可能原因清單、佐證片段（telemetry／errorlog／maintenance）與建議動作（含優先級），且與串流文字不重複打架、版面不溢出。
4. **Given** 任務進行中，**When** 後端依真實處理階段推送進度里程碑（0/20/40/60/80/100，見 FR-018），**Then** drawer 的進度呈現隨之推進、經過中間里程碑，狀態文字與進度值一致且具無障礙描述（未帶值時為 indeterminate，不只靠顏色或動畫）。
5. **Given** drawer 顯示某 job 的內容，**When** 該 job 對應的機台與目前 `selectedMachineId` 不同（操作者已切換選取），**Then** drawer 仍明確標示「目前結果／進行中任務對應的是哪一台機台」，不會把兩台的資料混淆。

---

### User Story 2 - 對同一機台的重複診斷被去重，命中快取時明確標示 (Priority: P2)

操作者對同一台機台、同一類問題再次按下 Diagnose 時，系統不會重複觸發：在該機台已有進行中任務時，Diagnose 動作被禁用（避免重複送出）；若後端因快取命中而回傳既有結果，drawer 會顯示 Cached 標記，讓操作者知道這是重用而非重新推理的結果。

**Why this priority**: 去重與快取標示是 003「Cache before API／dedupe lock」設計在前端的可視化證據，能在 demo 中直接展示「第二次同樣診斷秒回且標為 cached」的賣點；但它依賴 US1 的診斷流程先跑通，故列 P2。

**Independent Test**: 對某機台完成一次診斷後，於同機台仍有 active job 時確認 Diagnose 被禁用；待完成後再次對同機台觸發同類診斷，確認結果標示 Cached（客觀判準＝`ai/done.cached===true`、快取路徑進度直接 100 不重跑 LLM；「明顯快」為其可觀察結果，非獨立門檻）——即可獨立驗收。

**Acceptance Scenarios**:

1. **Given** 某機台已有進行中（active）的診斷任務，**When** 操作者嘗試對「同一台機台」再次送出 Diagnose，**Then** 該送出動作被禁用或忽略，不會建立第二個重複任務。
2. **Given** 後端因快取命中回傳結果，**When** drawer 渲染完成狀態，**Then** 顯示 Cached 標記；未命中快取時不顯示。
3. **Given** 某機台有 active job，**When** 操作者切換選取到「另一台」機台，**Then** 對另一台的 Diagnose 不受前一台 active job 影響（去重僅限同一機台）。

---

### User Story 3 - 診斷失敗時清楚顯示錯誤並可重試 (Priority: P3)

當診斷因 AI 供應商錯誤、worker 問題或任務失敗而無法完成時，drawer 進入 failed 狀態，顯示可讀的錯誤訊息與一個 Retry 動作；操作者按 Retry 可對同一機台重新發起診斷，回到 active 流程。

**Why this priority**: 失敗與重試讓 demo 在非理想路徑（例如暫停 worker、AI 429）下仍可控、可解說，展現系統的健壯性；屬於完整性收尾，故列 P3。

**Independent Test**: 於 worker 暫停或注入錯誤的情境對某機台觸發診斷，確認 drawer 進入 failed 並顯示錯誤訊息與 Retry；恢復後按 Retry 確認可重新進入 active 並最終完成——即可獨立驗收。

**Acceptance Scenarios**:

1. **Given** 已觸發診斷，**When** 後端回報任務失敗或 AI 錯誤，**Then** drawer 進入 failed 狀態，顯示可讀的錯誤訊息（非原始堆疊）與一個 Retry 動作。
2. **Given** drawer 處於 failed，**When** 操作者按 Retry，**Then** 對同一機台重新發起診斷並回到 active 流程（進度重置、可再次串流）。
3. **Given** drawer 處於 failed 或 completed，**When** 操作者關閉 drawer 或切換到別台再回來，**Then** 不殘留上一次的錯誤／串流殘影造成誤導（狀態呈現與目前選取或進行中任務一致）。

---

### Edge Cases

- **首次開啟、尚無任何診斷**：drawer 於 idle 狀態顯示目前 selected machine 摘要與「Run diagnosis」提示；若尚未選取任何機台，Diagnose 入口為 disabled 並提示需先選取機台。
- **done 前重複觸發**：同機台 active 期間的 Diagnose 送出必須被抑制（見 US2），避免建立重複任務或造成串流交錯。
- **連線中斷／重連導致綁定失效**：即時通道重連時後端派發新的 `clientId`，先前 job 的連線綁定失效（004 已記為已知限制，不做跨重連 rebind）。此時進行中任務的後續串流不會再回到本連線，drawer MUST 以可理解的方式收尾（標示為中斷／失敗並提供 Retry），MUST NOT 永久卡在 active 假象。
- **亂序或遲到的串流片段**：token 片段帶有序號；drawer 對於明顯過期（屬於已被取代之任務）的事件應忽略，不覆蓋目前任務的內容。
- **最終結果不完整或欄位缺失**：後端保證最終結果已通過 schema 驗證（003）；若某些陣列為空（如無建議動作），對應區塊以空狀態呈現而非崩潰或殘留佔位。
- **長串流內容**：串流面板超過高度上限時內部捲動；使用者未手動捲動時保持貼底跟隨，一旦手動往上捲則不強制跳回底部。
- **桌機與手機版面**：桌機為右側**常駐** drawer（版面固定區域，不需開合）、手機為底部 bottom-sheet（按需開合、可關閉）；兩者內容皆不溢出、不遮住頂部狀態列。

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: 系統 MUST 提供一個 AI Copilot 呈現面（桌機為右側 drawer、手機為 bottom-sheet），承載單一機台的診斷任務生命週期呈現，視覺一律依 `apps/web/design/design-spec.md` 與 `refs/copilot-drawer.png` 的具名 token（顏色、圓角、陰影、間距不在元件內散落 hex）。
- **FR-002**: 操作者 MUST 能對目前選取的機台（沿用 004 的 `selectedMachineId`）觸發一次診斷（Diagnose）；觸發時 drawer MUST 立即進入 active 呈現，不需等待任何 AI 內容先抵達。桌機採**常駐面板**（drawer 為版面固定區域，觸發即就地由 idle 轉 active、無開合位移）；手機為 bottom-sheet，觸發時滑開並進入 active。
- **FR-003**: 觸發診斷時，系統 MUST 帶上目前即時通道的連線識別（`socketId` 即 WS `clientId`）呼叫建立診斷的既有 HTTP 入口，使後端能把該任務的串流回送到本連線；連線識別 MUST 取自 004 對外提供的「最新 `clientId`」。
- **FR-004**: drawer MUST 依 `job/status` 事件呈現任務進度：`waiting` 建立初始 active 呈現、`active` 更新進度、`completed`／`failed` 進入對應終態。進度值 MUST **純以事件攜帶的 `progress` 為準（前端不合成、不映射假值）**；事件未攜帶 `progress` 時（如 `waiting` 或首個裸 `active`）MUST 以 indeterminate（不確定態）呈現，待第一個數值 progress 抵達再顯示具體百分比。進度呈現 MUST 具無障礙描述（`aria-valuenow` 或 indeterminate 描述），不只靠顏色或動畫。
- **FR-018**（附帶之 worker/003 小幅調整）: 為讓進度反映真實處理進展，worker MUST 於單次診斷執行期間將 `progress` 綁定到**真實處理階段里程碑**回報，各里程碑對應一個確實發生的事件：`0`=job 進入 active（尚未處理）、`20`=讀取 Mongo 組完 diagnosis context、`40`=取得去重鎖且即將呼叫 LLM、`60`=LLM 串流開始（收到首個 token）、`80`=串流結束且 `DiagnosisResultSchema` 解析成功、`100`=寫入 Mongo/快取並發出 `ai/done`。里程碑值 MUST NOT 以 token 數估算或時間推移偽造；快取命中路徑 MAY 直接跳至 `100`。此為 005 附帶、跨 003 邊界的例外調整，通訊契約不變（沿用 `job/status` 既有 optional `progress` 欄位，前端政策仍為 FR-004 的純事件驅動）。
- **FR-005**: drawer MUST 依 `ai/token` 事件逐段 append 串流文字並顯示串流游標，過程中 MUST NOT 等到最終結果才顯示內容（token 逐段可見）。
- **FR-006**: drawer MUST 依 `ai/done` 事件渲染結構化結果，且欄位對齊 `DiagnosisResultSchema`：`summary`、`severity`（ok／warning／critical）、`likelyCauses`、`evidence`（source 為 telemetry／errorlog／maintenance 之片段）、`suggestedActions`（含 `label` 與 `priority`）。嚴重度以 `SeverityBadge` 的具名樣式呈現。completed 後先前逐段串流的推理文字 MUST 保留但預設收合（提供可展開回看），主視覺聚焦結構化結果、不被長串流文字撐開版面。
- **FR-007**: drawer MUST 依 `ai/error` 事件（或 `job/status: failed`）進入 failed 狀態，顯示可讀的錯誤訊息（非原始堆疊）並提供 Retry 動作；Retry MUST 能對同一機台重新發起診斷並回到 active 流程。Retry 為對同機台重新呼叫既有診斷入口，若後端簽章相同而命中快取，MUST 照常顯示 Cached 結果（FR-009），前端 MUST NOT 特別繞過快取。
- **FR-008**: 系統 MUST 在「同一機台已有進行中（active）任務」期間禁用該機台的重複送出（disable duplicate submit），避免建立重複任務；此去重 MUST 僅限同一機台，不影響其他機台的觸發。
- **FR-009**: 當結果來自後端快取（`ai/done` 的 `cached: true`）時，drawer MUST 顯示 Cached 標記；非快取結果 MUST NOT 顯示該標記。
- **FR-010**: drawer MUST 以 `machineId` 為 key 維護每台各自的任務狀態（idle／active／completed／failed），多台任務 MAY 並存進行且互不干擾；drawer 同一時間只呈現目前選取（或指定）機台的那一份，並明確標示對應哪一台。當操作者切換 `selectedMachineId` 時，drawer MUST 還原該台既有的 active/completed/failed 呈現（若有），MUST NOT 把不同機台的串流或結果混淆。前端 MUST NOT 對「跨機台同時進行的診斷數」設額外上限（實質受限於固定示範機台數，速率由後端 `AI_RPM` 控制）；每台仍受 FR-008 同機台去重約束。
- **FR-011**: 對於明顯過期或屬於已被取代之任務的串流事件（例如重試後仍抵達的舊 job 片段、或亂序遲到片段），drawer MUST 忽略之，不得覆蓋目前任務的呈現內容。
- **FR-012**: 當即時通道中斷／重連導致先前任務綁定失效時，drawer MUST 以可理解方式收尾進行中任務（標示中斷／失敗並提供 Retry），MUST NOT 永久停留在 active 假象。收尾觸發訊號 MUST 為「即時通道重連」——即某台 active 任務期間收到新的 `system/connected`／新 `clientId` 時，該台 active 任務即標為中斷；MUST NOT 依賴前端逾時偵測（純後端錯誤由 `ai/error`／`job/status: failed` 顯式回報，見 FR-007）。
- **FR-013**: 串流面板 MUST 在超過高度上限時內部捲動；未手動捲動時保持貼底跟隨，使用者手動往上捲後 MUST NOT 強制跳回底部。
- **FR-014**: drawer 於 idle（尚無診斷）MUST 顯示目前 selected machine 摘要與可觸發診斷的提示；桌機常駐面板下，選取機台即在 drawer 內顯示該台 idle 摘要與 Run diagnosis；若尚未選取任何機台，Diagnose 入口 MUST 為 disabled 並提示需先選取機台（桌機面板顯示空狀態提示，不隱藏面板）。
- **FR-015**: 手機 bottom-sheet MUST 可關閉（含鍵盤 Escape），且 MUST NOT 遮住頂部狀態列；桌機常駐面板不需關閉但同樣 MUST NOT 遮住頂部狀態列。關閉後重新開啟或切換機台再回來時，呈現 MUST 與目前選取或進行中任務一致，不殘留誤導性殘影。
- **FR-016**: drawer 及其內部元件 MUST 通過無障礙基本要求：icon-only 按鈕具 `aria-label`，狀態不只靠顏色（有文字或 aria 標籤），critical 相關動畫克制不過快（脈動週期 MUST ≥ 1.2s，見 design-spec §10 與 tailwind `criticalPulse` keyframe），keyboard focus ring 保留且用 `accent`。
- **FR-017**: 系統 MUST NOT 讓高頻遙測（004 的 telemetry 串流）與診斷串流互相干擾——診斷 token 串流的處理 MUST NOT 破壞既有遙測的批次渲染背壓策略（憲章：高頻事件先進 buffer、以每幀批次提交）。診斷 `ai/token` 為相對低頻（人可讀速率），MAY 直接 append 而不套用遙測的 rAF 批次；但 MUST NOT 混入遙測 buffer、MUST NOT 與遙測共用同一批次管線（分流即達成互不干擾，見 research R6）。token 節流非本 feature 目標。

### Key Entities *(include if feature involves data)*

- **Copilot 任務狀態（前端）**：以 `machineId` 為 key 的每機台診斷任務呈現狀態機集合，各台狀態為 idle／active／completed／failed；每筆 attributes 概念上含 `jobId`、`machineId`、progress、串流文字、`cached`、最終結構化結果或錯誤訊息。drawer 依目前選取（或指定）機台呈現對應的那一份。此為前端呈現狀態，非後端持久化實體。
- **診斷結果（DiagnosisResult）**：後端已 schema 驗證之最終結果，含 `summary`、`severity`、`likelyCauses`、`suggestedActions`（`label`/`priority`/`command?`）、`evidence`（`source`/`id?`/`excerpt`）。單一真實來源為 `packages/contracts` 的 `DiagnosisResultSchema`，前端不得手寫平行型別。
- **診斷串流事件**：即時通道上與診斷相關的事件族——`job/status`、`ai/token`、`ai/done`、`ai/error`，契約定義於 `packages/contracts`（`events.ts`）；前端依 `type` 分派更新任務狀態。

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 操作者對選取機台按下 Diagnose 後，drawer 於 1 秒內開啟並進入 active 呈現（顯示任務狀態與進度），不需等待任何 AI 文字先出現。
- **SC-002**: AI 推理文字為**逐段串流**出現：在最終結果抵達之前，操作者即可看到部分推理內容（可見的中間 token），而非等到整段生成完成才一次顯示。
- **SC-003**: 最終結果抵達後，drawer 正確渲染五個結構化區塊（severity、summary、likely causes、evidence、suggested actions），欄位與後端結果一致、無缺漏或錯位。
- **SC-004**: 同一機台在有 active 任務期間，重複的 Diagnose 送出 100% 被抑制（不產生第二個重複任務）；對第二次同類診斷，若後端命中快取，drawer 100% 顯示 Cached 標記。
- **SC-005**: 失敗情境（如 worker 暫停或 AI 錯誤）下，drawer 100% 進入 failed 並顯示可讀錯誤與 Retry；按 Retry 後可重新進入 active 流程。
- **SC-006**: 於四個基準 viewport（桌機寬螢幕、桌機一般、平板、手機 390×844）drawer／bottom-sheet 內容皆不溢出、不遮住頂部狀態列、可關閉；手機版以 bottom-sheet 呈現。
- **SC-007**: 診斷串流啟用期間，004 的高頻遙測 UI 仍維持流暢、不因診斷串流而出現明顯卡頓（背壓批次策略不被破壞）。
- **SC-008**: 單次診斷（非快取命中）執行期間，進度條至少推進經過 20／40／60／80 等中間里程碑（非只有 0→100 或 0→20→100 兩三點），且每個里程碑對應一個確實發生的處理階段事件；進度數值全數來自後端事件（前端未編造、後端未以 token 數或時間偽造）。

## Assumptions

- **後端已就緒**：003 的 `POST /diagnoses`、BullMQ 任務、worker AI streaming、Redis cache-aside 與 Pub/Sub relay 皆已運作；本 feature **原則上只做前端 drawer 與其狀態機**，唯一例外是本次澄清新增的「worker 進度回報級距細化」（見 FR-018）屬小幅 worker 調整、不動通訊契約；其餘不改後端（若需新增 event/payload 才回頭改 `packages/contracts`）。
- **連線識別來源**：診斷送出所需的 `socketId` 取自 004 對外提供的「最新 `clientId`」；本 feature 不自行管理 WebSocket 連線生命週期，僅消費 004 的即時通道與 `selectedMachineId`。
- **REST 入口開放**：依 003，開發階段 `POST /diagnoses` 不要求授權；本 feature 不處理 REST 認證（正式環境認證不在範圍）。
- **重連不 rebind（已知限制）**：重連派發新 `clientId` 會使進行中任務的連線綁定失效，後端不做跨重連 rebind（與 003 記憶體 Map、004 記錄之取捨一致）；本 feature 僅負責在前端把此情形收尾為中斷／失敗 + Retry，不負責讓串流跨重連自動接續。
- **診斷觸發來源**：Diagnose 以 004 的 `selectedMachineId`（點卡片選取，同一時間至多一台）為對象；同時保留 design-spec 中卡片 diagnose icon 與 top bar diagnose action 兩個觸發位置的視覺，實際皆作用於目前選取機台。
- **切換選取不取消任務**：操作者可在任務進行中切換 selected machine；進行中任務綁定其自身 `machineId`，drawer 明確標示對應機台，切換不隱式取消或搬移該任務。
- **結果保留策略**：completed 結果保留於 drawer，直到使用者對該機台重新診斷或切換情境；不自動清空以避免版面跳動與資訊丟失。
- **落地位置**：依 design-spec File Mapping，元件落在 `apps/web/src/domains/ai-copilot/`（`components/CopilotDrawer.vue`、`stores/copilot.store.ts`）與共用 `SeverityBadge`／`ProgressBar` 等，沿用 004 已建立的 layout 與 store 慣例。
