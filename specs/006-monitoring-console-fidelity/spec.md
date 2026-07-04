# Feature Specification: Monitoring Console Fidelity（監控台前端保真補完）

**Feature Branch**: `006-monitoring-console-fidelity`

**Created**: 2026-07-03

**Status**: Draft

**Input**: User description: "在 apps/web 把 design-spec（layout.png / node-states.png / copilot-drawer.png）已定義、但 004/005 漏做或沒對齊的前端項目補齊。全部前端-only，只消費現有 telemetry 與診斷資料，不動 packages/contracts 與後端。範圍（依 User Story）：US1 卡片保真（狀態文字徽章、warning 數值染 amber 而邊框維持 subtle、遙測單位、相對時間戳）；US2 Fleet Health（機台 state 聚合計數＋比例條）；US3 Event Stream（最近門檻跨越／錯誤事件列，去重不灌爆）；US4 TopBar（pause/resume、connection chip 延遲 ms、search 實際過濾）；US5 主區標題列（Fleet monitor · N machines）；US6 機台分組（sidebar 依前端靜態對照分區）；US7 Drawer active 保真（BullMQ 任務 meta 與處理步驟清單）。不在範圍：Graph 拓樸圖視圖、Alerts/History 整頁、Copilot follow-up 對話、Recent jobs 清單、likely-cause 信心分數、mock frequency 真正作用（皆需後端／契約，另案）。共同成功條件：全部使用 design-spec 具名 token 不散落 hex；高頻 telemetry 下不逐筆重繪；四個 viewport 不溢出／重疊／layout shift；不新增 packages/contracts event/payload、不改後端。"

## Clarifications

### Session 2026-07-03

- Q: US6 機台分組——實際 roster 只有 5 台（截圖的 Stamping/Fluids 群組僅為示意），靜態群組如何定義？ → A: **三組**：**Prep**（`mixer-01`）／**Forming & Baking**（`press-02`、`oven-04`）／**Fulfilment**（`pack-03`、`sorter-05`）；對照缺項的機台落入 fallback 群組。
- Q: US3 Event Stream 的保留策略與上限？ → A: 保留**最近 50 筆**（固定筆數上限），超過時淘汰最舊者。
- Q: US2 Fleet Health 如何處理 stale／未連線機台？ → A: stale **獨立成第四類**（healthy／warning／critical／stale），且**仍計入 total**；stale 判定沿用 004 既有 `isStale`（`now - lastUpdated` 超過門檻，預設 10s），與 US1 卡片 Stale 呈現共用同一判斷。
- Q: US4 pause 期間到達的遙測如何處理？ → A: **續收進 buffer、暫停期間不更新畫面**；resume 後直接跳到最新狀態，**不補放**暫停期間的中間畫格。
- Q: US4 search 的過濾範圍與比對鍵？ → A: **同時過濾** sidebar 機台清單與主區卡片；比對 **machineId 與顯示名稱**（任一 `includes` 命中；空查詢回全部）。
- Q: US7 drawer active 的 job meta（attempt/queue/concurrency）如何呈現？ → A: **三者皆以靜態標示呈現、忠實對映 003 設定**：queue=`DIAGNOSIS_QUEUE`（＝`"diagnosis"`，前端 import 契約常數值）、concurrency=2、attempts=最多 3 次（重試政策）。（**契約核對**：契約 `JobStatus`／`CopilotJobState` 不帶 attempt/queue/concurrency，故**不呈現動態 attempt 計數**——要動態 attempt 須改契約，會違反 FR-023，見 research R11。）
- Q: US1 卡片相對時間戳是否保留絕對時間 tooltip？ → A: **保留**——hover／點擊時間戳時顯示絕對時間 tooltip 作輔助。

## User Scenarios & Testing *(mandatory)*

本 feature 的「使用者」是**監控台操作者**：在 004 監控台上盯著 5 台固定示範機台（`mixer-01`／`press-02`／`pack-03`／`oven-04`／`sorter-05`）的高頻遙測與狀態，並在 005 的 Copilot drawer 中觸發／檢視 AI 診斷。其痛點是：目前畫面與 `apps/web/design/design-spec.md` 及 `refs/*.png`（`layout.png`／`node-states.png`／`copilot-drawer.png`）這份**視覺唯一來源**之間仍有落差——有些是「已交付元件沒對齊規格」（保真缺陷），有些是「design-spec 早已定義、但 004／005 都沒把它收斂成需求」（漏做）。本 feature 的價值是：**不動後端與契約**，純粹把這些前端落差補齊，讓監控台第一次真正「長得跟設計稿一致、且該動的地方會動」，作為整個 demo 呈現面的收尾。

關鍵界線：**design-spec 這份視覺真實來源本身沒有改變**——所有項目一直都在稿子裡。因此本 feature 不回頭改已 merge 的 004／005，而是新開一條 feature 把落差補齊；所有工作皆為**前端-only**、只消費現有 telemetry 與診斷資料，不新增 `packages/contracts` 的 event／payload，也不動 `apps/api`／`apps/worker`。各 User Story 依優先級可獨立開發、獨立驗收，以 phase-by-phase 漸進交付。

### User Story 1 - 機台卡片保真對齊 node-states（Priority: P1）

操作者看著機台卡片時，應能一眼從**狀態文字徽章**（HEALTHY／WARNING／CRITICAL）判讀機台狀態，而不只靠一顆狀態燈點；當機台進入 warning，越界的遙測**數值本身**被染成 amber 以引導注意，而卡片邊框維持 subtle（不因 warning 額外加粗或變色邊框）；每個遙測數值都帶單位（如 °C、mm/s、u/min、%）；卡片上的時間資訊以相對「Ns ago」呈現且會隨時間更新。這些呈現對齊 `node-states.png` 與 design-spec §7.3。

**Why this priority**: 卡片是監控台的主體與視覺焦點，也是與 `node-states.png` 落差最明顯、最快見效的一批；屬純呈現層修正、風險低、可獨立驗收，故列 P1。

**Independent Test**: 啟動監控台，讓 mock producer 把某台推入 warning／critical，逐一比對卡片的狀態徽章文字、warning 時 amber 數值與 subtle 邊框、每個數值的單位、以及相對時間戳是否隨秒更新——對照 `node-states.png` 六態即可獨立驗收。

**Acceptance Scenarios**:

1. **Given** 一台機台目前為 healthy，**When** 卡片渲染，**Then** 卡片顯示狀態燈與一致的「HEALTHY」文字徽章、所有遙測數值帶正確單位、時間戳以相對「Ns ago」呈現。
2. **Given** 一台機台轉為 warning，**When** 卡片渲染，**Then** 越界的遙測數值本身被染為 amber、卡片邊框仍為 subtle（不加 warning 邊框）、狀態徽章顯示「WARNING」且與狀態燈一致。
3. **Given** 一台機台轉為 critical，**When** 卡片渲染，**Then** 狀態徽章顯示「CRITICAL」並與 `node-states.png` 的 critical 態一致；hover／selected／critical pulse 等狀態切換**不改變卡片尺寸、不造成 layout shift**。
4. **Given** 時間持續前進，**When** 未收到該機台新遙測，**Then** 相對時間戳（「Ns ago」）隨每秒更新遞增，數值與單位維持最後已知值。
5. **Given** 卡片顯示相對時間戳，**When** 操作者 hover／點擊該時間戳，**Then** 以 tooltip 顯示對應的絕對時間作輔助。

---

### User Story 2 - Fleet Health 聚合面板（Priority: P1）

操作者在 sidebar 左下應能看到一個 **Fleet Health** 面板，把目前所有機台依狀態（healthy／warning／critical／stale）聚合成計數與比例條，讓操作者不必逐張數卡片就掌握整體健康度；stale（超過門檻未回報遙測，沿用 004 `isStale`）獨立成一類但仍計入 total。此面板隨遙測即時更新，數字與卡片狀態一致，對齊 `layout.png` 左下區塊。

**Why this priority**: Fleet Health 是 design-spec 定義、卻從未進任何 feature FR 的漏做項；它把已在 store 中的機台狀態做輕量聚合即可完成，投報比高、可獨立驗收，與 US1 同屬「最快補齊的視覺缺口」，故列 P1。

**Independent Test**: 啟動監控台，讓不同機台落在不同狀態（含斷開一台使其變 stale），確認 Fleet Health 的 healthy／warning／critical／stale 計數與比例條和當下卡片狀態一致、四類之和等於訂閱機台數，並在狀態變化時即時更新——即可獨立驗收。

**Acceptance Scenarios**:

1. **Given** 監控台已訂閱全部示範機台，**When** Fleet Health 面板渲染，**Then** 顯示 healthy／warning／critical／stale 四類計數與對應比例條，四者相加等於目前納入統計的機台總數（含 stale）。
2. **Given** 某機台從 healthy 轉為 critical，**When** 遙測批次更新，**Then** Fleet Health 的計數與比例條隨之調整，且與該機台卡片顯示的狀態一致（不落後、不牴觸）。
3. **Given** 某機台超過 stale 門檻未回報遙測，**When** 每秒 tick 重算，**Then** 該機台在 Fleet Health 計入 stale 類（與卡片 Stale 呈現一致），且仍計入 total。

---

### User Story 3 - Event Stream 事件列（Priority: P2）

操作者在主區底部應能看到一條 **Event Stream**（design-spec §7.8 `EventStrip`），列出最近的「門檻跨越／錯誤」事件——每筆含時間、機台識別、嚴重度與一句短訊息，讓操作者回顧「剛剛哪台、何時、發生了什麼」。事件在機台**狀態轉換**時才記一筆（去重），連續在同一狀態內抖動不會重複灌爆；清單保留**最近 50 筆**，超過時淘汰最舊者，不會無限成長。此為 004 與 005 之間漏接的項目，於本 feature 以**前端衍生**方式補上。

**Why this priority**: Event Stream 讓「剛剛發生了什麼」可回顧，是 demo 中展示狀態變化的敘事載體；但它依賴 US1／US2 的狀態判斷邏輯先就位、且需要謹慎的去重與上限設計，故列 P2。

**Independent Test**: 觸發某台機台跨越門檻（如 mock producer 讓 `press-02` 尖峰進 critical），確認 Event Stream 立即出現對應一筆（時間、機台、severity、短訊息）；持續在 critical 內抖動時不重複新增；當事件數超過上限時最舊的被裁掉——即可獨立驗收。

**Acceptance Scenarios**:

1. **Given** 一台機台從 healthy 轉為 warning 或 critical，**When** 遙測批次更新，**Then** Event Stream 頂端新增一筆事件，內容含時間、機台識別、嚴重度與可讀短訊息。
2. **Given** 同一台機台已在 warning／critical 且數值持續抖動但狀態未再轉換，**When** 後續遙測抵達，**Then** 不新增重複事件（僅在狀態轉換時記錄）。
3. **Given** 事件數已達 50 筆上限，**When** 再有新事件產生，**Then** 最舊的事件被移除以維持上限，清單不會無限成長。
4. **Given** 操作者重新整理頁面，**When** 監控台重新載入，**Then** 先前的事件不保證留存（前端衍生、不回放歷史為已知取捨），新事件從當下重新累積。

---

### User Story 4 - TopBar 保真（pause/resume、延遲、search）（Priority: P2）

操作者在 TopBar 應能：以一個按鈕**暫停／恢復**遙測串流的畫面更新（demo 中「凍結畫面細看」）；在 connection chip 上看到目前即時通道的**延遲毫秒數**；用 search 欄位**實際過濾**機台（而非只有外觀）。對齊 `layout.png` 頂欄與 design-spec §7.2。

**Why this priority**: TopBar 的 pause/resume 與 search 是操作者實際會用到的互動，delay chip 則是連線品質的即時回饋；三者皆只用現有資料即可達成，但屬互動行為（非純呈現），需與 004 的高頻批次機制協調，故列 P2。

**Independent Test**: 按 pause 後確認畫面停止更新、按 resume 後恢復；觀察 connection chip 顯示合理的延遲毫秒數並隨時間更新；在 search 輸入片段字串，確認機台卡片／清單即時被過濾——即可獨立驗收。

**Acceptance Scenarios**:

1. **Given** 遙測正在高頻更新，**When** 操作者按下 pause，**Then** 畫面上的機台呈現停止更新（凍結在按下當下的狀態），期間到達的遙測仍續收進 buffer；**When** 再按 resume，**Then** 畫面**直接跳到最新**狀態（不補放暫停期間的中間畫格）。
2. **Given** 即時通道已連線，**When** TopBar 渲染，**Then** connection chip 顯示目前的延遲毫秒數，並隨連線品質變化更新。
3. **Given** 有多台機台顯示，**When** 操作者在 search 輸入片段字串，**Then** sidebar 清單與主區卡片**同時**只保留符合的機台（比對 machineId 與顯示名稱），清空後恢復全部。

---

### User Story 5 - 主區標題列（Fleet monitor · N machines）（Priority: P3）

操作者在主區頂部應能看到「**Fleet monitor · N machines**」的標題列，N 為目前納入的機台數，讓主區有明確的區域標題與規模指示。對齊 `layout.png` 主區。**僅補標題列，不含 Graph／拓樸圖視圖**（後者另案）。

**Why this priority**: 純呈現、範圍極小的視覺補齊，價值是讓主區與設計稿一致；不阻擋其他工作，故列 P3。

**Independent Test**: 進入監控台，確認主區標題顯示「Fleet monitor · N machines」且 N 等於目前機台數——即可獨立驗收。

**Acceptance Scenarios**:

1. **Given** 監控台顯示 N 台機台，**When** 主區渲染，**Then** 標題列顯示「Fleet monitor · N machines」，N 與實際機台數一致。

---

### User Story 6 - 機台分組（sidebar 分區）（Priority: P3）

操作者在 sidebar 的機台清單應依**群組**分區呈現（每個群組一個標題，底下列出該群組的機台），而非平鋪一長串。群組來源為前端靜態的「機台 → 群組」對照（比照 004 `machine-labels.ts` 的靜態對照做法），分三組：**Prep**（`mixer-01`）／**Forming & Baking**（`press-02`、`oven-04`）／**Fulfilment**（`pack-03`、`sorter-05`）。對齊 `layout.png` sidebar 與 design-spec §6.1。

**Why this priority**: 分組是 sidebar 的視覺結構補齊，價值中等且範圍侷限於前端靜態對照，故列 P3。

**Independent Test**: 進入監控台，確認 sidebar 依靜態對照把 5 台機台分到 Prep／Forming & Baking／Fulfilment 三個群組標題下呈現、每台機台恰屬一個群組、群組與成員與對照表一致——即可獨立驗收。

**Acceptance Scenarios**:

1. **Given** 存在前端靜態三組「機台 → 群組」對照，**When** sidebar 渲染，**Then** 機台依 Prep／Forming & Baking／Fulfilment 分區、每個群組有標題、每台機台恰出現在其所屬群組下一次。
2. **Given** 某 machineId 不在對照表中，**When** sidebar 渲染，**Then** 該機台落入 fallback 群組（如「Ungrouped」）而非被漏顯示。

---

### User Story 7 - Drawer active 保真（任務 meta 與處理步驟）（Priority: P3）

操作者在 Copilot drawer 的 **active** 狀態下，除了既有的串流與進度外，應能看到該診斷任務的 **meta 資訊**（如 attempt N/3、queue、concurrency）與一份**處理步驟清單**，步驟對應 005 既有進度里程碑（0／20／40／60／80／100），以「已完成／進行中／待辦」呈現任務推進。對齊 `copilot-drawer.png`。這些皆由既有 `job/status`／進度事件衍生，不需新事件。

**Why this priority**: 讓 drawer 的 active 呈現與設計稿一致、更有「任務執行中」的資訊密度；但依賴 005 診斷流程與既有進度里程碑，屬錦上添花，故列 P3。

**Independent Test**: 對某機台觸發診斷使 drawer 進入 active，確認顯示任務 meta（attempt／queue／concurrency）與步驟清單，且步驟隨進度里程碑（0/20/40/60/80/100）推進其「已完成／進行中／待辦」狀態——即可獨立驗收。

**Acceptance Scenarios**:

1. **Given** 某機台的診斷任務進入 active，**When** drawer 渲染 active 呈現，**Then** 顯示任務 meta（queue、concurrency、最多重試次數 attempts，皆為忠實對映 003 設定的靜態標示）與對應既有里程碑的處理步驟清單。
2. **Given** 任務進度推進經過各里程碑（0→20→…→100），**When** `job/status` 進度更新，**Then** 步驟清單中對應步驟由「待辦」轉「進行中」再轉「已完成」，與進度值一致。

---

### Edge Cases

- **stale／未連線機台**：一台機台超過門檻（004 `isStale`，預設 10s）未回報遙測時，卡片時間戳持續增長（Ns ago）並呈現 Stale；在 Fleet Health 計入獨立的 **stale 類**且仍計入 total（見 Clarifications）。
- **pause 期間到達的遙測**：pause 時訊息仍**續收進 buffer**、畫面不更新；resume 後**直接跳到最新**狀態，不補放暫停期間的中間畫格（見 Clarifications）。
- **同時多台跨越門檻**：一個批次內多台同時轉換狀態時，Event Stream 應各記一筆且不互相吞噬。
- **search 無相符**：查無符合機台時主區呈現「無結果」的空狀態，而非破版或空白。
- **群組對照缺項**：某 machineId 不在群組對照中時，需有 fallback 群組（如「Ungrouped」）而非漏顯示。
- **drawer 無 active 任務時**：US7 的 meta／步驟僅在 active 呈現；idle／completed／failed 不套用，維持 005 既有行為。

## Requirements *(mandatory)*

### Functional Requirements

**US1 · 卡片保真**

- **FR-001**: 機台卡片 MUST 顯示與狀態燈一致的狀態**文字徽章**（HEALTHY／WARNING／CRITICAL），對齊 `node-states.png`。
- **FR-002**: 當機台為 warning，卡片 MUST 把**越界的遙測數值本身**染為 amber（以具名 token），且卡片**邊框維持 subtle**（不因 warning 加粗或改色邊框）。
- **FR-003**: 卡片上的每個遙測數值 MUST 附帶對應單位（如 °C／mm/s／u/min／%）。
- **FR-004**: 卡片的時間資訊 MUST 以相對「Ns ago」呈現，並隨時間（每秒級）更新；hover／點擊該時間戳時 MUST 以 tooltip 顯示絕對時間作輔助。
- **FR-005**: 卡片呈現的所有變更 MUST NOT 改變卡片尺寸或造成 layout shift（維持既有 grid 與尺寸；hover／selected／critical pulse 皆不位移）。

**US2 · Fleet Health**

- **FR-006**: sidebar 左下 MUST 顯示 Fleet Health 面板，依機台狀態聚合 healthy／warning／critical／stale 四類的**計數**，對齊 `layout.png`；stale 判定 MUST 沿用 004 既有 `isStale`（`now - lastUpdated` 超過門檻，預設 10s）。
- **FR-007**: Fleet Health MUST 以**比例條**呈現四類佔比。
- **FR-008**: Fleet Health MUST 隨遙測即時更新，且 FR-006 定義的四類計數與各機台卡片當下狀態一致（不落後、不牴觸）；作為不變量，四類計數之和 MUST 恆等於目前納入統計的機台總數（stale 亦計入 total）。

**US3 · Event Stream**

- **FR-009**: 主區底部 MUST 顯示 Event Stream，列出最近的門檻跨越／錯誤事件，每筆 MUST 含時間、機台識別、嚴重度與可讀短訊息（design-spec §7.8 `EventStrip`）。
- **FR-010**: 事件 MUST 僅在機台**狀態轉換**時記錄一筆（去重）；同一狀態內的數值抖動 MUST NOT 產生重複事件。
- **FR-011**: Event Stream MUST 保留最近 **50** 筆為上限，超過時淘汰最舊者，避免無限成長。
- **FR-012**: 事件 MUST 為**前端衍生**（由既有 telemetry 在狀態轉換時產生），MUST NOT 新增 `packages/contracts` 的 event／payload；重整頁面前的歷史事件不保證留存為已知取捨。

**US4 · TopBar**

- **FR-013**: TopBar MUST 提供 pause／resume 控制；pause 後畫面 MUST 停止更新遙測呈現，期間到達的遙測 MUST 續收進 buffer（不更新畫面）；resume 後 MUST 直接反映最新狀態，MUST NOT 補放暫停期間的中間畫格。
- **FR-014**: connection chip MUST 顯示即時通道的延遲毫秒數（由 ping→pong RTT 導出），並隨連線品質於**心跳週期（~15s）**更新。
- **FR-015**: search 欄位 MUST **同時**對 sidebar 機台清單與主區卡片做**實際過濾**（非僅外觀）；比對鍵 MUST 涵蓋 machineId 與顯示名稱（任一 `includes` 命中），空查詢回全部。

**US5 · 主區標題列**

- **FR-016**: 主區頂部 MUST 顯示「Fleet monitor · N machines」標題列，N 為目前納入的機台數；**不含** Graph／拓樸圖視圖。

**US6 · 機台分組**

- **FR-017**: sidebar 機台清單 MUST 依前端**靜態**「機台 → 群組」對照分成三組呈現——**Prep**（`mixer-01`）／**Forming & Baking**（`press-02`、`oven-04`）／**Fulfilment**（`pack-03`、`sorter-05`），每群組一標題；對照缺項的機台 MUST 落入 fallback 群組而非被漏顯示。

**US7 · Drawer active 保真**

- **FR-018**: Copilot drawer 的 active 狀態 MUST 顯示任務 meta，**一律靜態標示且忠實對映 003 設定**：queue（`DIAGNOSIS_QUEUE`＝`"diagnosis"`，前端 import 契約常數值）、concurrency（2）、attempts（最多 3 次重試）。MUST NOT 呈現動態 attempt 計數（契約 `JobStatus`／`CopilotJobState` 不帶 attempt/queue/concurrency；動態化須改契約，違反 FR-023）。
- **FR-019**: drawer active MUST 顯示對應既有進度里程碑（0／20／40／60／80／100）的處理步驟清單，並依 `job/status` 進度以「已完成／進行中／待辦」呈現推進。

**跨 US 的共同約束（護欄）**

- **FR-020**: 所有新增／修改的視覺 MUST 使用 design-spec 具名 token，MUST NOT 在元件內散落 hex。
- **FR-021**: 高頻 telemetry 下，所有新元件 MUST NOT 逐筆觸發 reactive 重繪，MUST 沿用既有的批次（rAF）提交機制（constitution 高頻事件規則）。
- **FR-022**: 在四個 viewport（1366×768／1440×900／390×844／768×1024）下 MUST 不溢出、不重疊、不造成 layout shift；手機版 MUST 依 design-spec §6.2 退化。
- **FR-023**: 本 feature MUST NOT 新增 `packages/contracts` 的 event／payload，MUST NOT 改動 `apps/api`／`apps/worker`；驗收時 `git diff` MUST NOT 含 `packages/contracts`、`apps/api`、`apps/worker` 的變更。

### Key Entities *(include if data involved)*

- **機台狀態呈現（Machine card view state）**：由既有 store 中每台機台的最新遙測與衍生 state（healthy／warning／critical）、最後更新時間構成；卡片徽章、amber 數值、相對時間戳皆為其呈現投影。
- **Fleet health 聚合（Fleet health summary）**：對目前納入統計的機台，依 state 聚合的四類（healthy／warning／critical／stale）計數與佔比；stale 沿用 004 `isStale` 判定；由機台狀態即時衍生，無獨立資料來源。
- **衍生事件（Derived event）**：一筆門檻跨越／錯誤事件，屬性含時間、機台識別、嚴重度、短訊息；由「上一個 state → 當前 state」的轉換在前端產生，保留最近 50 筆上限。
- **機台群組對照（Machine group map）**：前端靜態的「機台 → 群組」對照（比照 `machine-labels.ts`），三組 Prep／Forming & Baking／Fulfilment，供 sidebar 分區；含 fallback 群組。
- **任務處理步驟（Job step）**：drawer active 中對應既有進度里程碑（0/20/40/60/80/100）的步驟項，狀態為已完成／進行中／待辦；由既有 `job/status` 進度衍生。

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 對照 `node-states.png` 六態，機台卡片的狀態文字徽章與狀態燈 100% 一致；warning 態的越界數值為 amber 且邊框為 subtle；每個遙測數值皆帶單位。
- **SC-002**: 卡片在 hover／selected／critical pulse 狀態切換時，量測到的版面位移為 0（無 layout shift）。
- **SC-003**: Fleet Health 四類（healthy／warning／critical／stale）計數之和恆等於目前納入統計的機台總數，且在任一機台狀態變化後即時（下一批次內）與卡片狀態一致。
- **SC-004**: 觸發某台機台跨越門檻後，Event Stream 於同一次批次更新內出現對應事件；在該機台狀態未再轉換的持續抖動下，不產生任何重複事件；事件總數不超過 50 筆上限。
- **SC-005**: 按下 pause 後畫面不再更新、按 resume 後恢復更新；connection chip 於首個 pong 後在連線期間持續顯示**非負**延遲毫秒數，並於心跳週期（~15s）重新量測更新；斷線→重連後會重新取得量測值。
- **SC-006**: 在 search 輸入任一片段字串後，sidebar 清單與主區卡片同時僅留相符機台（machineId 或顯示名稱命中）；清空後恢復顯示全部機台。
- **SC-007**: 主區標題列顯示的機台數 N 與目前實際機台數一致；sidebar 每台機台恰出現於其所屬群組一次。
- **SC-008**: drawer active 顯示任務 meta 與步驟清單，且步驟狀態隨進度里程碑（0/20/40/60/80/100）正確由待辦→進行中→已完成推進。
- **SC-009**: 在四個 viewport（1366×768／1440×900／390×844／768×1024）下皆無溢出、重疊或 layout shift；手機版依 §6.2 退化。
- **SC-010**: 驗收時 `git diff` 不含 `packages/contracts`、`apps/api`、`apps/worker` 的任何變更（護欄成立）。

## Assumptions

- **前端衍生事件（US3）**：採「前端衍生 MVP」——沿用 004 store 已收到的 telemetry，在 state 轉換為 warning／critical 時由前端產生事件；不動契約、不加後端負擔；歷史回放（跨重整留存）另案，不在本 feature。保留策略已定為**最近 50 筆**（見 Clarifications）。
- **事件去重與 US1 徽章共用判斷（US1／US3）**：以「上一個 state」判斷狀態轉換，US1 徽章與 US3 事件共用同一份判斷，比照 002 `HistoryService.lastState` 的思路搬到前端。
- **卡片相對時間戳（US1）**：沿用 004 既有每秒 tick（如 `store.tickNow()` / `store.now`）重算「Ns ago」，不另開計時器；**保留** hover／點擊顯示絕對時間的 tooltip（見 Clarifications）。
- **Fleet Health 分類與 total（US2）**：stale／未連線機台**獨立成第四類**（healthy／warning／critical／stale）且**仍計入 total**（見 Clarifications）；stale 判定沿用 004 `isStale`（`now - lastUpdated` > 門檻，預設 10s），與 US1 卡片 Stale 呈現共用同一判斷。
- **pause 期間遙測處理（US4）**：pause 時**續收訊息進 buffer、不更新畫面**，resume 後直接反映最新狀態、**不補放**暫停期間的中間畫格（見 Clarifications）。
- **延遲毫秒數來源（US4）**：由即時通道的 ping→pong RTT 導出並存 store，比照既有連線機制，不新增後端訊號。
- **search 範圍與比對鍵（US4）**：**同時**過濾 sidebar 機台清單與主區卡片，並比對顯示名稱（`machineLabel`）與 machineId，任一命中即保留（見 Clarifications）。
- **機台群組定義（US6）**：截圖中的 Stamping／Fluids／Machining／Handling 等群組為**視覺示意**；實際 roster 為 5 台固定示範機台（`mixer-01`／`press-02`／`pack-03`／`oven-04`／`sorter-05`，見 `machine-labels.ts`），兩者不直接對應。群組已定為三組——**Prep**（`mixer-01`）／**Forming & Baking**（`press-02`、`oven-04`）／**Fulfilment**（`pack-03`、`sorter-05`），並含 fallback 群組（見 Clarifications）。
- **Drawer 步驟里程碑與 meta（US7）**：沿用 005 FR-018 的 0/20/40/60/80/100 里程碑對應處理步驟，不新增事件；meta 一律**靜態標示**、忠實對映 003 設定（queue=`DIAGNOSIS_QUEUE`、concurrency=2、attempts=3），**不呈現動態 attempt 計數**——因契約 `JobStatus`／`CopilotJobState` 不帶這些欄位，動態化須改契約而違反 FR-023（見 Clarifications 與 research R11）。
- **視覺唯一來源不變**：所有項目皆為把 design-spec／refs 既有定義補齊或對齊，本 feature 不修改 design-spec，也不回改已 merge 的 004／005。
