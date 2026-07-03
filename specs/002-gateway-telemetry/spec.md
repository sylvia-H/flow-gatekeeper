# Feature Specification: 即時 Gateway、遙測產生器與 MongoDB 歷史層

**Feature Branch**: `002-gateway-telemetry`

**Created**: 2026-06-30

**Status**: Draft

**Input**: User description: "建立 flow-gatekeeper 的 NestJS realtime gateway 與 MongoDB history layer。範圍：WebSocket Gateway 支援 client connect/disconnect、ping/pong heartbeat、machine subscribe/unsubscribe；Mock telemetry producer 每 10-50ms 產生 machine telemetry；Gateway 只把 telemetry 推給訂閱該 machineId 的 client；MongoDB 建立 telemetry time-series collection，TTL 7 天；建立 errorlogs、maintenanceRecords collections 與 seed script；當 telemetry 達到 warning/critical threshold 時寫入 errorlogs。"

## Clarifications

### Session 2026-06-30

- Q: 高頻遙測要以什麼頻率持久化到時序歷史？ → A: 每個產生節拍（tick）全量寫入時序
  （與指南 §7.2/§7.4 一致）；保存期限可由 `TELEMETRY_TTL_SECONDS` 調整（預設 7 天，
  本機 demo 可調小，如 60 分鐘），逾期自動清理。
- Q: 歷史要存「全部機台」還是「只存有人訂閱的」？ → A: 存**全部示範機台**每個 tick 的
  遙測，與任何 client 的訂閱狀態無關；訂閱僅過濾「即時推送」對象，不影響「落地」範圍
  （與指南 producer／訂閱解耦一致，確保 AI 診斷可查任何機台歷史）。
- Q: 「異常斷線」（未正常關閉，如網路硬中斷）要靠什麼偵測清理？ → A: 伺服器端主動心跳
  ——每 `WS_HEARTBEAT_MS` 探活，對逾時未回應的連線判定失效並清理（涵蓋「半死」連線），
  與既有 `WS_HEARTBEAT_MS` 設定呼應；客戶端 ping→pong 仍保留供客戶端側確認通道存活。

## User Scenarios & Testing *(mandatory)*

本 feature 的「使用者」有二：一是**監控台操作者**（demo 展示時觀看即時機台狀態的人，以及
後續 004 前端的實作者），二是**後續 feature 的實作者**（003 的 AI 診斷需要可追溯的歷史
資料當 context）。其價值是：在 001 的骨架與契約之上，讓系統第一次「動起來」——持續產生
並依訂閱推送高頻遙測、並把遙測與異常事件落地成可追溯的歷史，作為即時監控與後續 AI 診斷
的共同地基。

### User Story 1 - 依訂閱接收高頻機台遙測 (Priority: P1)

監控台操作者連上即時通道後，訂閱自己關心的若干機台，便能持續收到「只屬於這些機台」的
高頻遙測（含正常、warning、critical 三種狀態的變化）。不同操作者訂閱不同機台時，彼此
收到的資料完全不互相串流。

**Why this priority**: 「依訂閱、即時、互不串流地推送遙測」是本 feature 的核心能力，也是
最小可行產物——只要這一條成立，就已能在前端畫出會動的監控台，並獨立展示與驗收。

**Independent Test**: 開兩個獨立連線分別訂閱不同機台集合，觀察一段時間後，各自只收到所
訂閱機台的遙測、且資料隨時間持續更新並出現狀態變化——即可獨立驗收，無需歷史層或後續
feature。

**Acceptance Scenarios**:

1. **Given** 即時通道可連線，**When** 操作者建立連線，**Then** 連線端會收到一則「已連線」
   通知並取得自己的連線識別。
2. **Given** 已連線，**When** 操作者以有效授權訂閱機台集合 A，**Then** 之後持續收到且只
   收到集合 A 內機台的遙測推送。
3. **Given** 兩個連線分別訂閱不相交的機台集合，**When** 系統持續推送遙測，**Then** 任一
   連線都不會收到對方所訂閱機台的資料。
4. **Given** 遙測持續產生一段時間，**When** 觀察某台會進入異常的機台，**Then** 其狀態會
   出現 healthy／warning／critical 的變化，而非恆定不變。
5. **Given** 操作者重新送出一份新的訂閱集合，**When** 訂閱更新生效，**Then** 後續推送以
   最新集合為準（新集合即為當前訂閱的唯一真實狀態）。

---

### User Story 2 - 遙測與異常事件可追溯地落地 (Priority: P2)

系統把高頻遙測持續寫入時序歷史（具保存期限，逾期自動清理），並在機台「轉入」warning 或
critical 時記錄一筆異常事件；另有可重播的維修紀錄種子資料。這讓後續 AI 診斷能讀到最近的
遙測、異常與維修脈絡，也讓驗收與事後審查有依據。

**Why this priority**: 歷史可追溯是憲章硬性原則，也是 003 AI 診斷組 context 的來源；但它
依賴 US1 的遙測先能產生，且即時監控不靠它也能先展示，故列 P2。

**Independent Test**: 讓系統運行一段時間後，檢查時序歷史中有遙測資料、且異常事件數與「機
台進入 warning/critical 的轉換次數」一致（同狀態連續多筆不重複記錄）；執行種子指令後維修
紀錄存在——即可獨立驗收。

**Acceptance Scenarios**:

1. **Given** 系統持續產生遙測，**When** 運行一段時間後檢視時序歷史，**Then** 遙測資料被
   持久化且可依機台與時間查詢。
2. **Given** 某機台狀態自 healthy 轉為 warning 或 critical，**When** 該轉換發生，**Then**
   系統記錄一筆對應的異常事件。
3. **Given** 某機台連續多筆維持同一個異常狀態，**When** 這些遙測陸續產生，**Then** 不會
   為每一筆重複記錄異常事件（僅於狀態轉換時記錄一次）。
4. **Given** 歷史落地與即時推送並行，**When** 落地進行中，**Then** 即時推送的節奏不被
   落地動作拖慢或阻塞。
5. **Given** 執行維修紀錄種子指令，**When** 指令完成，**Then** 可查到示範用的維修紀錄。
6. **Given** 時序歷史設有保存期限，**When** 資料超過保存期限，**Then** 逾期遙測會被自動
   清理而不需人工介入。

---

### User Story 3 - 連線存活偵測與離線清理 (Priority: P3)

即時通道具備心跳與離線清理：連線端可透過心跳確認通道存活；連線中斷時，系統清掉該連線的
訂閱與相關狀態，不留殘留。未通過授權的訂閱請求會被拒絕。

**Why this priority**: 提升即時通道的健壯性與資源衛生，是長時間展示與多連線情境的保障；
但不是「讓遙測能動起來」的硬前提，故列 P3。

**Independent Test**: 送出心跳並確認得到回應；建立連線並訂閱後關閉連線，確認其訂閱狀態
被清除；以無效授權送出訂閱，確認被拒絕——即可獨立驗收。

**Acceptance Scenarios**:

1. **Given** 已建立連線，**When** 連線端送出心跳請求，**Then** 系統回覆對應的心跳回應。
2. **Given** 一個已訂閱的連線，**When** 該連線中斷，**Then** 系統移除其訂閱與連線狀態，
   後續不再嘗試對其推送。
3. **Given** 即時通道，**When** 連線端以無效授權送出訂閱請求，**Then** 該訂閱被拒絕且
   不建立任何訂閱。
4. **Given** 連線端送出無法解析或格式錯誤的訊息，**When** 系統收到，**Then** 系統安全
   忽略該訊息且不影響既有連線與訂閱。

### Edge Cases

- 連線端訂閱一個不存在的機台識別時，系統 MUST 安全處理（該機台單純沒有資料），不得報錯
  或影響其他訂閱。
- 機台長時間維持同一異常狀態時，異常事件 MUST 只在「狀態轉換」時記錄一次，避免高頻洪水
  灌爆歷史。
- 歷史落地暫時變慢或失敗時，MUST NOT 阻塞或拖慢即時遙測推送的節奏（落地與推送解耦）。
- 連線在訂閱後異常中斷（未正常關閉）時，其訂閱與連線狀態仍 MUST 被清理。
- 缺少選用的手動驗證工具（如命令列 WebSocket／資料庫客戶端）時，仍能透過其他方式（容器
  狀態、最小整合腳本）完成驗收，不阻斷流程。

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: 系統 MUST 提供一條即時通道，接受連線端建立連線，於連線建立時指派唯一連線
  識別並通知該連線端。
- **FR-002**: 連線端 MUST 能以一組機台識別進行訂閱；後送的訂閱集合即為該連線當前訂閱的
  唯一真實狀態（取代而非累加）。
- **FR-003**: 訂閱請求 MUST 需通過授權（開發階段以共享密鑰驗證）；未通過者 MUST 被拒絕
  且不建立任何訂閱。
- **FR-004**: 系統 MUST 只將某機台的遙測推送給已訂閱該機台的連線；任一連線 MUST NOT 收到
  其未訂閱機台的遙測。
- **FR-005**: 系統 MUST 持續以高頻節奏為一組固定的示範機台產生遙測，且涵蓋
  healthy／warning／critical 狀態的變化情境，以利展示與驗收重播。cadence MUST 可由
  `MOCK_TELEMETRY_INTERVAL_MS` 設定，**預設 50ms**（10–50ms 等級）；遙測各欄位的合理範圍與
  「telemetry → 狀態」的判定門檻 MUST 依 mock producer 規格（指南 §7.3）為單一來源，spec
  不另訂平行門檻。
- **FR-006**: 遙測推送與訂閱／事件的結構 MUST 沿用 001 既有的單一通訊契約
  （`packages/contracts` / `asyncapi.yaml`），MUST NOT 另立平行定義。
- **FR-007**: 系統 MUST 支援心跳：(a) 連線端送出心跳請求時回覆對應心跳回應，供連線端確認
  通道存活；(b) 伺服器 MUST 以 `WS_HEARTBEAT_MS` 為間隔**主動探活**，對逾時未回應的連線
  判定為失效。
- **FR-008**: 連線中斷時，系統 MUST 清除該連線的訂閱與連線狀態，且後續 MUST NOT 再嘗試
  對其推送。「連線中斷」MUST 涵蓋兩種情形：正常關閉，以及伺服器端心跳探活逾時所判定的
  失效（網路硬中斷的「半死」連線）。
- **FR-009**: 系統 MUST 將**每個產生節拍（tick）的遙測全量**持久化至 MongoDB 時序歷史集合，
  落地範圍涵蓋**所有示範機台、與任何 client 的訂閱狀態無關**（FR-004 的訂閱過濾僅作用於即時
  推送，MUST NOT 影響落地範圍）；保存期限 MUST 可由 `TELEMETRY_TTL_SECONDS` 調整（預設 7 天，
  本機 demo 可調小，如 60 分鐘），逾期資料 MUST 被自動清理。
- **FR-010**: 歷史落地 MUST 與即時推送解耦，MUST NOT 阻塞或拖慢推送節奏。
- **FR-011**: 當機台狀態「轉入」warning 或 critical 時，系統 MUST 記錄一筆異常事件；對連續
  維持同一狀態的後續遙測 MUST NOT 重複記錄（僅於狀態轉換時記錄）。
- **FR-012**: 系統 MUST 建立 errorlogs 與 maintenanceRecords 集合並具備可依機台與時間查詢的
  索引。
- **FR-013**: 系統 MUST 提供可重播的維修紀錄種子指令，產生示範用維修紀錄。
- **FR-014**: 連線端送出無法解析或格式錯誤的訊息時，系統 MUST 安全忽略，不得影響既有連線
  與訂閱。
- **FR-015**: 本 feature 範圍 MUST 僅止於連線生命週期、訂閱、遙測推送與歷史落地；診斷任務
  狀態（job/status）與 AI 串流（ai/token、ai/done、ai/error）的實際轉發 MUST 留待
  Feature 003（本 feature 僅需保留可對單一連線推送任意 payload 的通用能力作為其銜接點）。
  此銜接點（`send(clientId, payload)`）本 feature **不獨立驗收**——其實際轉發行為於 003 驗收；
  本 feature 只要求該能力存在且被連線生命週期正確管理。
- **FR-016**: 本 feature MUST 至少提供一支實際（非 no-op）的純函式單元測試作為驗收佐證，
  覆蓋核心決定性邏輯之一或多者，例如「依訂閱過濾遙測（只送訂閱者）」或「異常事件僅於
  狀態轉換時記錄一次」。
- **FR-017**: 系統 MUST 至少記錄（log）連線建立、連線中斷（含心跳逾時回收）、授權失敗與
  歷史落地錯誤四類事件，以利展示與除錯；結構化 metrics／tracing 不在本 feature 範圍。

### Key Entities *(include if feature involves data)*

- **TelemetryPoint（遙測資料點）**：單台機台某時刻的量測（溫度、振動、吞吐、錯誤率）與
  健康狀態（healthy／warning／critical），含機台識別與時間；結構沿用 001 契約。
- **連線與訂閱狀態**：每個連線的唯一識別，以及該連線當前訂閱的機台識別集合（連線中斷即
  清除）。
- **時序遙測歷史**：以時間為主軸、依機台分群的遙測持久化資料，具保存期限。
- **異常事件（errorlog）**：機台轉入 warning/critical 時的事件紀錄，含機台、狀態、發生
  時間與當時量測，可依機台與時間查詢。
- **維修紀錄（maintenanceRecord）**：機台的維修歷史（機台、執行時間、摘要），由種子資料
  提供，供後續診斷組 context。

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 兩個並行連線分別訂閱不相交的機台集合，運行 ≥ 60 秒，任一連線收到「非自身
  訂閱機台」資料的比例為 0%。
- **SC-002**: 遙測以設定的高頻節奏持續產生，**≥ 60 秒的觀察期**內訂閱者能穩定、不中斷地
  收到更新，且觀察到至少一次 healthy→warning 或 warning→critical 的狀態變化。
- **SC-003**: 系統運行 **≥ 60 秒**後（以停止產生後查詢為量測時點，避免落地與觀察的時間差），
  時序歷史中可查得遙測資料；異常事件的筆數等於同期「機台進入 warning/critical 的狀態轉換
  次數」（連續同狀態不重複計入）。
- **SC-004**: 執行種子指令後，維修紀錄存在且可查詢，數量 ≥ 1。
- **SC-005**: 連線中斷後（含正常關閉，以及心跳探活逾時偵測到的失效連線），該連線的訂閱
  狀態被清除（殘留訂閱數為 0），系統不再對其推送；失效連線 MUST 於 **≤ 2 × `WS_HEARTBEAT_MS`**
  內被回收。
- **SC-006**: 以無效授權送出的訂閱請求 100% 被拒絕，且不產生任何訂閱。
- **SC-007**: 至少 1 支實際（非 no-op）單元測試存在且通過，覆蓋訂閱過濾或異常事件去重的
  決定性邏輯。
- **SC-008**: 歷史落地進行時，即時推送節奏不受可觀察的拖慢——量測一段串流期間的推送間隔，
  其 **p95 MUST ≤ 設定 cadence × 2**。

**覆蓋備註**：FR-006（沿用 001 契約）以 `pnpm contract:lint` 與 typecheck 覆蓋；FR-012（集合
與索引）與 FR-015（send() 銜接點）以場景 3 的歷史查詢與 003 整合驗收覆蓋，無獨立 SC；FR-017
（記錄）以人工觀察 log 覆蓋，亦無獨立量化 SC。

## Assumptions

以下多為專案憲章（`.specify/memory/constitution.md`）與實作指南（§7）既已固定的約束，
於此記錄以界定範圍，非本 spec 任意決定：

- 沿用 001 既有的單一通訊契約與既定通道（machine/subscribe、machine/data、job/status、
  ai/token、ai/done、ai/error）；本 feature 只實作其中與遙測／訂閱／連線生命週期相關者。
- 即時通道一律使用原生 `ws`（後端為 `ws` 套件掛在 NestJS HTTP server，path `/ws`），
  MUST NOT 使用 Socket.IO（憲章 Principle IV、ADR-001）。
- 訂閱授權於開發階段以共享密鑰（`WS_AUTH_SECRET`）驗證；正式環境的認證機制不在本 feature
  範圍。
- 示範機台為一組**固定的 5 台**，識別字為 `mixer-01`、`press-02`、`pack-03`、`oven-04`、
  `sorter-05`；遙測由 mock producer 以決定性規律產生並內含週期性 warning/critical 尖峰，
  以滿足「可重播驗收」（憲章可重播門檻）。各欄位範圍與狀態門檻同依 mock producer 規格
  （指南 §7.3）。
- 「unsubscribe」以「送出新的訂閱集合取代舊集合」達成；送出空集合即等同取消所有訂閱。
- 歷史持久化於 MongoDB（憲章 Principle VII），Redis 不作為歷史來源；時序集合保存期限預設
  7 天（`TELEMETRY_TTL_SECONDS`），可由環境設定調整。
- 落地採批次、與推送解耦（fire-and-forget），以免拖慢即時節奏；單筆寫入失敗不得中斷推送。
- 連線端「重連後 clientId 會更換、需重新訂閱」屬已知行為，本 feature 不維護跨重連的訂閱
  記憶。
- job/status 與 AI 串流的實際轉發留待 003；本 feature 僅保留「對單一連線推送任意 payload」
  的通用能力作為銜接點。
- 完整端到端整合（前端 rAF 批次接收）於 Feature 004 驗收；本 feature 的手動驗收可用命令列
  WebSocket 客戶端或最小整合腳本完成。
