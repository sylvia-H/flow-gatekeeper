# Feature Specification: 前端高頻 WebSocket Gatekeeper 監控台

**Feature Branch**: `004-frontend-ws-gatekeeper`

**Created**: 2026-07-02

**Status**: 已完成（v1.0.0；2026-07-02 以 `0773bac` 併入 develop）；之後變更見指南 §15.6「v1.0.0 之後的現況摘要」

> ⚠️ **已變更（2026-09-27 盤點）**：下列原敘述已被 v1.0.0 之後的修復／升級改變；內文保留為歷史，現況以指南 §15.6「v1.0.0 之後的現況摘要」為準（`docs/Flow-Gatekeeper-SDD-完整實作指南.md`）。
>
> - FR-013／FR-025 指數退避與重連 → 退避在 `machine/subscribed` 才歸零（非 `system/connected`）；換 clientId 重置訂閱；`online` 事件立即重連。
> - FR-012 ping／pong 容忍時間 → ping 後 5 秒未回 pong 即視為斷線、立即重連。
> - FR-018／FR-010 buffer 溢位丟最舊、比值由累積數導出 → 溢位改為合併（coalesce），`droppedMessages` 計入背壓比值（比值以資料點計、含丟棄筆數）。
> - （原 spec 未涵蓋）`system/unauthorized` 以 TopBar「未授權」chip 呈現，並關閉 Diagnose 入口的連線閘門（見 005 橫幅）。

**Input**: User description: "在 apps/web 實作 monitoring domain 與高頻 WebSocket gatekeeper。範圍：Vue 3 + Pinia 建立 monitoring store；useHighFrequencyWs hook（onmessage 只 push buffer，不直接寫 reactive state）；requestAnimationFrame 每幀批次提交 telemetry；支援 ping/pong heartbeat、指數退避重連、manual close；AppLayout、MachineNodeCard、StatusLight 使用 design-spec token；UI 可訂閱 machineIds，顯示最新 telemetry、state、lastUpdated；TopBar 放 BackpressureBadge，顯示 receivedMessages、renderedBatches 與比值（store getter batchRatio）。成功條件：10-50ms telemetry 下 UI 不明顯卡頓；Performance recording 中 reactive update 次數小於 message 次數；斷線後自動重連；卡片文字不溢出、不互相遮擋；BackpressureBadge 在畫面上即時顯示比值（高頻時應遠大於 1:1）。"

## Clarifications

### Session 2026-07-02

- Q: 卡片需要顯示機台名稱，但遙測契約只帶 `machineId`（5 台固定示範機台，無 `displayName`），名稱從何而來？
  → A: 前端維護一份靜態對照表（`machineId` → 友善名稱，如 `press-02` → 「Press 02」），不改契約；卡片同時呈現 machineId（mono）與名稱。缺對照時退回顯示 machineId。
- Q: 瀏覽器端訂閱需要在 `machine/subscribe` 帶 `WS_AUTH_SECRET` token，前端從何取得？
  → A: 開發階段不帶 token——依賴 Gateway「僅在伺服器端有設 `WS_AUTH_SECRET` 時才驗證」的行為；前端 subscribe 送出空 token，不把祕密打包進 bundle。訂閱在 dev 實質開放。
- Q: 機台選取（點卡片 → selected 視覺狀態、store `selectedMachineId`）是否屬於 004（診斷動作屬 005）？
  → A: 屬於 004——004 實作點選卡片設定 `selectedMachineId` 並呈現 design-spec 的 selected 視覺；消費該選取的 diagnose 按鈕與 CopilotDrawer 留在 005。
- Q: 首次遙測抵達前、或冷啟動連線尚未建立時，監控台要顯示什麼？
  → A: 直接渲染全部已知機台卡片為 placeholder（數值以 `—` 佔位）並搭配連線狀態橫幅（Connecting／Disconnected）；資料抵達時原地填入，不造成版面跳動。
- Q: Gateway 於斷線時清除該連線訂閱、且每次連線派新 `clientId`，前端是否要在「每次（重）連線」都重新訂閱 machineIds？
  → A: 要，且列為明確 FR——每次收到 `system/connected`（初次與重連皆是）MUST 重送 `machine/subscribe`；否則重連後顯示 Connected 卻收不到遙測（對齊 SC-003）。
- Q: 重連時伺服器派發新的 `clientId`，004 對「供 005 綁定的已存 `clientId`」如何處理？
  → A: 004 恆保存最新 `clientId` 並對外提供；spec 記為已知限制——重連會使任何 005 進行中的任務綁定失效（與 003 記憶體 Map 取捨一致），004 不負責跨重連 rebind。
- Q: 手機 viewport（390×844，SC-004 已列）是否為 004 的驗收阻斷需求（Copilot drawer/bottom-sheet 屬 005）？
  → A: 是——004 MUST 通過手機版：卡片退化為單欄清單、不溢出不重疊；不需 bottom-sheet（那是 005 的 drawer）。四個 viewport 皆為驗收基準。
- Q: design-spec 的 TopBar mock-frequency 控制項，其節拍調整需後端串接（不在 004 範圍），004 如何處置？
  → A: 渲染為 disabled placeholder（保 design-spec 視覺完整）但不作用；實際頻率串接延後至後續 feature，並明文記錄以免驗收爭議。

## User Scenarios & Testing *(mandatory)*

本 feature 的「使用者」有二：一是**監控台操作者**（demo 展示與長時間盯著看的工程／維運使用者，期望在第一屏就能即時看到高頻機台狀態、隨時可操作而不卡頓的人），二是**在意「背壓有沒有真的做到」的技術評審**（想在畫面上直接看到「收到很多訊息、卻只批次渲染少數幾次」這個賣點被量化的人）。其價值是：在 002 的即時 Gateway 與遙測、003 的 AI 診斷後端之上，讓系統第一次擁有**可操作的前端監控台**——依訂閱即時呈現高頻遙測、以 buffer + 每幀批次提交壓制高頻重繪、把背壓效果直接量化在畫面上，並在斷線時自動恢復，作為後續 005 AI Copilot Drawer 的載體。

### User Story 1 - 在監控台第一屏即時看到訂閱機台的高頻狀態 (Priority: P1)

監控台操作者打開應用即進入監控台（非 landing page），系統自動連上即時通道並訂閱示範機台；操作者持續看到每台機台的最新狀態（healthy／warning／critical）、關鍵遙測數值（溫度、振動、吞吐、錯誤率）與最後更新時間。即使遙測以 10–50ms 的高頻湧入，介面仍維持流暢、隨時可捲動與點選，不因逐筆更新而卡頓。

**Why this priority**: 「依訂閱、即時、流暢地呈現高頻機台狀態」是本 feature 的核心能力與最小可行產物——只要這一條成立，就已經有一個會動、可操作、可展示的監控台，並可獨立驗收。

**Independent Test**: 啟動前端與後端，開啟監控台第一屏，確認自動連線並看到訂閱機台的節點卡片持續更新數值、狀態與最後更新時間；把遙測頻率拉到最高（每 10ms），確認畫面仍可捲動、點選、無明顯卡頓——即可獨立驗收。

**Acceptance Scenarios**:

1. **Given** 前端已載入，**When** 進入應用，**Then** 第一屏直接呈現監控台（node grid／卡片），而非行銷首頁，並自動連上即時通道。
2. **Given** 即時通道已連線，**When** 前端訂閱一組機台，**Then** 只會收到並呈現這些機台的遙測，未訂閱的機台不會出現串流。
3. **Given** 某機台持續產生遙測，**When** 新的一筆抵達，**Then** 對應卡片更新其狀態、數值與最後更新時間，且數值以等寬字呈現、不造成版面跳動（layout shift）。
4. **Given** 遙測以每 10–50ms 的高頻湧入，**When** 操作者捲動或點選卡片，**Then** 介面即時回應、無明顯卡頓或畫面凍結。
5. **Given** 卡片呈現三種狀態，**When** 機台為 critical，**Then** 卡片以規格定義的 critical 樣式（tint／狀態燈／克制的 pulse）明確標示，且狀態不只靠顏色（另有文字或無障礙標籤）。
6. **Given** 前端載入但尚未收到第一批遙測（或冷啟動連線未建立），**When** 呈現第一屏，**Then** 直接渲染全部已知機台卡片為 placeholder（數值以 `—` 佔位）並顯示連線狀態橫幅，資料抵達時原地填入而不造成版面跳動。
7. **Given** 監控台呈現多張機台卡片，**When** 操作者點選某張卡片，**Then** 該機台被標記為選取（`selectedMachineId`）並以 design-spec 的 selected 視覺呈現；同一時間至多一台為選取。

---

### User Story 2 - 在畫面上直接看到被量化的背壓比值 (Priority: P2)

操作者在頂部工具列看到一個背壓計量：累積收到的遙測訊息數、實際渲染批次數，以及兩者比值（例如 `41:1`）。這個數字即時反映「收到很多訊息、卻只批次提交少數幾次渲染」的效果，讓「高頻不逐筆重繪」的設計成果不用打開開發者工具就能被看見與驗證。

**Why this priority**: 背壓量化是本專案最直接的賣點佐證，也是憲章「高頻事件 MUST 先進 buffer、再以 rAF 每幀批次提交」的可視化證據；但它依賴 US1 的即時呈現先跑通，故列 P2。

**Independent Test**: 在高頻遙測下觀察頂部工具列的背壓計量，確認收到訊息數持續增加、渲染批次數增加得慢很多、比值明顯大於 1；把頻率調高時比值隨之上升——即可獨立驗收。

**Acceptance Scenarios**:

1. **Given** 遙測正在高頻湧入，**When** 一段時間後觀察背壓計量，**Then** 顯示的「收到訊息數」明顯大於「渲染批次數」，比值遠大於 1:1。
2. **Given** 背壓計量顯示於工具列，**When** 遙測頻率提高，**Then** 比值隨之上升（相同時間內收到更多訊息但批次數不等比增加）。
3. **Given** 背壓計量恆為中性資訊而非錯誤指標，**When** 任何時候呈現，**Then** 使用中性樣式（不使用 warning／critical 色），並可透過提示說明其意義。
4. **Given** 數值高頻變動，**When** 計量更新，**Then** 以等寬字與千分位呈現、不因寬度變化而抖動，且更新節奏跟隨批次提交而非逐筆訊息。

---

### User Story 3 - 斷線自動恢復並清楚呈現連線與資料新鮮度 (Priority: P3)

即時通道中斷（例如後端重啟或網路中斷）時，前端明確顯示連線狀態（connected／reconnecting／disconnected），並以指數退避自動重連；恢復後繼續推送。斷線期間不清空最後已知資料，而是把過舊的機台標示為 stale，讓操作者知道哪些數值不再新鮮。

**Why this priority**: 連線韌性與資料新鮮度是長時間展示與可信監控的前提，但屬於在 US1 可運作之後的健壯化，故列 P3。

**Independent Test**: 在監控台運行中關閉後端，確認狀態轉為 disconnected 且資料標示為 stale、畫面不清空；再開啟後端，確認前端在數十秒內自動重連並恢復更新——即可獨立驗收。

**Acceptance Scenarios**:

1. **Given** 即時通道已連線，**When** 連線中斷，**Then** 連線狀態轉為 disconnected（或重連中時為 reconnecting），並保留最後已知資料。
2. **Given** 連線中斷且非使用者主動關閉，**When** 前端嘗試重連，**Then** 以指數退避（間隔逐次拉長、加入抖動）自動重試，直到恢復。
3. **Given** 後端恢復可用，**When** 重連成功，**Then** 連線狀態轉為 connected，前端**重新訂閱**其 machineIds，並繼續呈現新的遙測（不因訂閱在斷線時被清除而空白）。
4. **Given** 某機台超過新鮮度門檻未更新，**When** 呈現該機台，**Then** 標示為 stale（降低視覺權重並顯示 stale 標記），但不清空既有數值。
5. **Given** 通道存活探測（heartbeat）啟用，**When** 對端在容忍時間內未回應探測，**Then** 前端判定連線失效並觸發重連流程。

---

### Edge Cases

- **分頁切到背景**：瀏覽器分頁在背景時逐幀提交會暫停，遙測若持續累積可能無限成長吃記憶體。系統 MUST 以 buffer 上限護住（超過上限丟最舊、保最新），切回前景時一次性提交最新累積。
- **重連風暴**：多個客戶端或後端反覆抖動時，重連間隔 MUST 加入抖動避免同時湧入。
- **未授權訂閱**：即時通道訂閱需要正確的通道憑證；憑證缺失或錯誤時 MUST 明確不推送對應機台資料，而非靜默假裝已訂閱。
- **控制訊息與遙測混流**：心跳回應、連線識別、訂閱確認等控制訊息 MUST NOT 混入遙測 buffer 而被當成一筆機台資料呈現。
- **元件卸載**：離開監控台時 MUST 清理計時器、逐幀迴圈與連線，避免殘留連線或記憶體洩漏。
- **長機台名稱／窄視窗**：過長的機台名稱與最小尺寸視窗下 MUST NOT 造成文字溢出或卡片重疊。

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: 應用第一屏 MUST 是可操作的監控台（node grid／卡片），MUST NOT 是行銷型 landing page。
- **FR-002**: 前端 MUST 透過原生 WebSocket（非 Socket.IO）連上即時通道。訂閱時 MUST 送出 `machine/subscribe`；開發階段 MUST NOT 於前端打包通道祕密（`WS_AUTH_SECRET`），token 送空值，依賴 Gateway「僅在伺服器端設有祕密時才驗證」的行為。
- **FR-003**: 前端 MUST 能訂閱一組機台識別，且 MUST 只呈現被訂閱機台的遙測；未訂閱者不得串流呈現。
- **FR-004**: 收到的高頻遙測 MUST 先進入 buffer，MUST NOT 逐筆寫入 reactive state。
- **FR-005**: 系統 MUST 以每幀（requestAnimationFrame）批次的方式，把 buffer 內累積的遙測一次提交到畫面狀態。
- **FR-006**: 每台機台的卡片 MUST 呈現：機台識別（machineId，等寬字）、機台顯示名稱、狀態（healthy／warning／critical）、關鍵遙測數值（溫度、振動、吞吐、錯誤率）與最後更新時間。
- **FR-006a**: 機台顯示名稱 MUST 取自前端維護的靜態對照表（`machineId` → 友善名稱）；對照表缺項時 MUST 退回顯示 machineId，MUST NOT 因缺名稱而空白或報錯。
- **FR-007**: 機台狀態 MUST 依 design-spec 具名 token 呈現（狀態燈、tint、critical 的克制 pulse），MUST NOT 在元件內散落 hex 或自創狀態色。
- **FR-008**: 狀態資訊 MUST NOT 只以顏色表達，MUST 另附文字標籤或無障礙標籤。
- **FR-009**: 頂部工具列 MUST 呈現背壓計量，內容包含累積收到訊息數、累積渲染批次數與兩者比值。
- **FR-010**: 背壓比值 MUST 由累積數值即時導出（渲染批次為 0 時比值為 0），並隨批次提交更新而非逐筆訊息更新。
- **FR-011**: 背壓計量 MUST 使用中性樣式，MUST NOT 使用 warning／critical 色；數值 MUST 以等寬字與千分位呈現以避免寬度抖動。
- **FR-012**: 前端 MUST 以週期性 ping／pong 探測通道存活；對端在容忍時間內未回應 MUST 判定連線失效並觸發重連。
- **FR-013**: 非使用者主動關閉的斷線，前端 MUST 以指數退避（間隔逐次拉長並加入抖動、設有上限）自動重連。
- **FR-014**: 使用者主動關閉或元件卸載時 MUST 停止自動重連並清理連線、計時器與逐幀迴圈。
- **FR-015**: 連線狀態 MUST 明確呈現三態（connected／reconnecting／disconnected）並依 design-spec token 呈現對應顏色與標籤。**進入條件**：`disconnected` 用於冷啟動尚未連上、以及使用者主動關閉／元件卸載；**非使用者主動的斷線 MUST 直接進入 `reconnecting`**（立即退避重試），MUST NOT 要求先短暫顯示 `disconnected`（對齊 data-model §3 狀態機與 US3 驗收情境 1「disconnected 或重連中時為 reconnecting」）。
- **FR-016**: 斷線期間 MUST 保留最後已知資料，MUST NOT 清空畫面。
- **FR-017**: 超過新鮮度門檻（預設 10 秒）未更新的機台 MUST 標示為 stale（降低視覺權重、顯示 stale 標記），且 MUST NOT 清空其既有數值。
- **FR-018**: buffer MUST 設有上限，超過上限時 MUST 丟棄最舊者、保留最新者，避免分頁背景時記憶體無限成長。
- **FR-019**: 控制訊息（如心跳回應、連線識別、訂閱確認、未授權通知）MUST 與遙測分流處理，MUST NOT 被當成機台遙測呈現。
- **FR-020**: 監控台 MUST 在 design-spec §11 指定的各 viewport（1366×768／1440×900／390×844／768×1024；其中 390×844 為手機尺寸，此處僅指該 viewport 尺寸，mobile bottom-sheet 本身屬 005）下不發生文字溢出、卡片重疊；hover／selected／critical pulse MUST NOT 造成 layout shift。手機尺寸的單欄退化細節見 FR-026。
- **FR-021**: icon-only 控制項 MUST 具備無障礙標籤或提示；鍵盤焦點環 MUST 保留（使用 accent，不可移除）。
- **FR-022**: 前端 MUST 恆保存**最新**的連線識別（clientId）並對外提供，供後續 AI 診斷觸發（005）作為對應連線的依據；重連會派發新的 clientId，004 只保存最新值，MUST NOT 負責跨重連保留舊綁定（見 Assumptions 已知限制）。
- **FR-023**: 前端 MUST 支援點選機台卡片以設定選取（`selectedMachineId`，同時至多一台），並以 design-spec 的 selected 視覺呈現；消費該選取的 diagnose 動作與 CopilotDrawer 不在本 feature 範圍（屬 005）。
- **FR-024**: 首次遙測抵達前或連線尚未建立時，前端 MUST 直接渲染全部已知機台的 placeholder 卡片（數值以佔位符呈現）並顯示連線狀態橫幅；實際資料抵達時 MUST 原地填入，MUST NOT 造成版面跳動或整屏空白。
- **FR-025**: 前端 MUST 在**每次**建立連線（初次連線與每次重連皆然，即每次收到 `system/connected`）時重送 `machine/subscribe` 重新訂閱其 machineIds；MUST NOT 假設訂閱在重連後仍存在（Gateway 於斷線時清除該連線訂閱）。
- **FR-026**: 監控台 MUST 於手機 viewport（含 390×844）將機台卡片退化為**單欄清單**並維持不溢出、不重疊；此為驗收阻斷需求（與 FR-020 的四 viewport 無溢出／無 layout shift 一致，本條為其手機單欄的具體化）。004 不含 mobile bottom-sheet（屬 005 的 CopilotDrawer）。
- **FR-027**: TopBar 的 mock-frequency 控制項 MUST 以 **disabled placeholder** 呈現（保留 design-spec 視覺）但不作用；實際頻率串接不在本 feature 範圍。

### Key Entities *(include if feature involves data)*

- **機台即時狀態（Machine live state）**：某台機台的最新一筆快照——機台識別、狀態（healthy／warning／critical）、溫度、振動、吞吐、錯誤率、最後更新時間；以「每台機台只保留最新值」的方式維護。顯示名稱不在此快照內，而是由前端靜態對照表以 machineId 對應。
- **機台名稱對照（Machine label map）**：前端維護的靜態 `machineId` → 友善名稱對照，缺項時退回 machineId。
- **選取狀態（Selection）**：目前被選取的機台識別（`selectedMachineId`，至多一台），供 selected 視覺與後續 005 診斷觸發使用。
- **連線狀態（Connection status）**：即時通道當前狀態（connected／reconnecting／disconnected）與連線識別（clientId）。
- **背壓計量（Backpressure metrics）**：累積收到訊息數、累積渲染批次數，以及由兩者導出的比值。
- **訂閱（Subscription）**：目前被訂閱、需即時呈現的機台識別集合。

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 在高頻遙測（每台每 10ms 一筆的量級；實際節拍由 mock producer 的 `MOCK_TELEMETRY_INTERVAL_MS` 決定，可再調高）下，操作者對捲動與點選的互動回應時間維持在 100ms 內，30 秒操作期間無明顯卡頓或畫面凍結。
- **SC-002**: 高頻情境下，畫面渲染批次數顯著少於收到的訊息數，且比值即時顯示在畫面上、無需開發者工具即可看到。比值隨遙測頻率上升：因每則遙測訊息含 5 台各一筆，於一般節拍（每 tick 各佔一個 rAF 幀）時比值下限約 **5:1**；當 producer 間隔 ≤ 8ms（5 台合計 ≳ 600 筆/秒、多個 tick 併入同一幀）時比值 **≥ 10:1**。此門檻與 SC-001 的 10ms「量級」不衝突——10ms 節拍下比值約 8:1，達 ≥10:1 需 ≤8ms 節拍（驗收見 quickstart AC2）。
- **SC-003**: 即時通道中斷後，系統於 30 秒內自動重連並恢復遙測推送；期間連線狀態明確呈現三態，且不清空最後已知資料。
- **SC-004**: 在 1366×768、1440×900、390×844、768×1024 四個 viewport 下，卡片文字不溢出、不重疊，且 hover／selected／critical pulse 不造成 layout shift。
- **SC-005**: 超過 10 秒未更新的機台會被標示為 stale 並降低視覺權重，同時保留其最後已知數值不清空。
- **SC-006**: 只呈現被訂閱機台的遙測——對未訂閱機台，畫面上不出現其串流更新。

## Assumptions

- **後端契約已就緒**：即時通道行為、遙測 payload 與控制訊息型別以 002 的 Gateway 與 `packages/contracts` 為單一真實來源；本 feature 只消費既有契約，不新增後端 event/payload。
- **AI Copilot Drawer 屬 Feature 005**：本 feature 只交付監控台外殼與高頻遙測管線，並預留連線識別供 005 使用；AI 診斷觸發、串流呈現與 CopilotDrawer 元件不在本 feature 範圍（雖然 design-spec 同時涵蓋兩者）。
- **通道憑證於開發階段不由前端持有**：即時通道訂閱在 dev 階段實質開放——Gateway 僅在伺服器端設有 `WS_AUTH_SECRET` 時才驗證，前端 `machine/subscribe` 送空 token 且不把祕密打包進 bundle（見 Clarifications）。若之後需要正式授權，token 來源將另行設計，不在本 feature 範圍。REST 診斷入口的授權屬 003 範圍。
- **視覺唯一來源**：所有顏色、圓角、陰影、間距、狀態樣式一律取自 `apps/web/design/design-spec.md` 與 `refs/*.png` 的具名 token；本 feature 不新增未載於 design-spec 的視覺樣式。
- **示範機台集合固定**：訂閱對象為 002 產生器定義的 5 台固定示範機台（`mixer-01`、`press-02`、`pack-03`、`oven-04`、`sorter-05`）；預設訂閱全部以便展示。前端顯示名稱由對應這 5 個 id 的靜態對照表提供（見 Clarifications 與 FR-006a）。
- **實作技術**：依 design-spec 與指南，前端為 Vue 3 + Pinia + Tailwind + lucide icons，於 `apps/web` monorepo 套件內實作。
- **mock frequency 控制**：design-spec 的 TopBar 列有 mock frequency 控制項；本 feature 以 **disabled placeholder** 呈現（FR-027），實際調整產生器節拍需後端支援，端到端串接延後至後續 feature。
- **重連的已知限制（clientId）**：Gateway 每次連線派發新 `clientId`，前端只保存最新值（FR-022）。重連會使任何 005 進行中的診斷任務「任務↔連線」綁定失效（與 003 指南 §8.4 記錄的記憶體 Map 取捨一致）；004 不負責跨重連 rebind，此為已知限制而非缺陷。
- **手機為驗收範圍**：390×844 等手機 viewport 屬 004 驗收阻斷需求（FR-026、SC-004），以單欄卡片清單達成；mobile bottom-sheet／Copilot drawer 屬 005，不在本 feature。

## Dependencies

- **Feature 002（即時 Gateway、遙測產生器與 MongoDB 歷史層）**：提供 WebSocket Gateway、訂閱過濾、心跳與高頻遙測來源。
- **`packages/contracts`**：提供遙測與控制訊息的 Zod schema 與型別，作為前端消費的單一真實來源。
- **`apps/web/design/design-spec.md` 與 `refs/`**：提供視覺 token、layout、component states 與 screenshot 驗收基準（已於本 branch 落地 v0.4 與 Tailwind `theme.extend`）。
