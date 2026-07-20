# Feature Specification: Observability Baseline（可觀測性基線）

**Feature Branch**: `009-Observability-Baseline`

**Created**: 2026-07-17

**Status**: 已收斂（clarify／plan／checklist／tasks／analyze 完成，analyze 修補回補於 2026-07-20），待 `/speckit-implement`

**Input**: User description: "009-Observability Baseline"（依 `docs/Flow-Gatekeeper-SDD-完整實作指南.md` §15 方向藍圖與 `docs/adr-002-productionization-scope.md` §5.3／§6.4 既定決策起草）

## User Scenarios & Testing *(mandatory)*

本 feature 的「使用者」有三種：**運維者／評估者**（想在系統跑起來後判讀「此刻健不健康、行為是否正常」、需要能被聚合與過濾的日誌與健康訊號的人）、**開發者**（日常追查問題時，想從日誌用同一個關聯鍵把一次診斷或一台機台的相關事件串起來的人）與**展示者**（demo 敘事的敘述者）。

現況痛點：這個專案本身是一座即時監控台，**但它自己目前不可被監控**——三端只有 console 純文字 log，無法聚合、無法用關聯鍵串接、也無法從外部判讀健康狀態。Feature 007 的監督者只回答「行程死沒死」，Feature 008 讓三端有了可部署的容器形態，但「系統此刻健不健康、關鍵指標是否正常」仍無承接。把「監控台自己不可被監控」這句話收掉，本身就是生產化三部曲（007 → 008 → 009）收尾的敘事重點。

本 feature 的價值：補上**可觀測性基線**——後端（api／worker）以結構化、機器可解析的日誌取代散落的純文字輸出並帶上關聯鍵；api 提供健康端點供編排器與人工判讀依賴狀態；關鍵營運指標週期性摘要入日誌；並把既有的有損寫入語意明文化。性質刻意壓在「基線」：**不做**告警系統、指標匯出器、追蹤與日誌聚合服務（ADR-002 §7 的邊界——這些不會讓三個核心賣點更亮）。同時本 feature 除「取代日誌輸出管道」外**不改變任何寫入語意與即時行為**，因此驗收的判準之一是「三端行為與改動前逐項一致」。

各 User Story 依優先級可獨立開發、獨立驗收，以 phase-by-phase 漸進交付。

### User Story 1 - 後端結構化日誌與關聯鍵（Priority: P1）

開發者／運維者在系統運行時，看到的 api 與 worker 日誌是**統一格式、機器可解析**的結構化紀錄，每筆都帶有等級（level）、時間、來源脈絡（context），並在相關事件上附帶關聯鍵（如 jobId、machineId、clientId）。開發者可用單一 jobId 把一次診斷從 api 接收、worker 處理到結果回傳的事件序列串接起來；並可透過 `LOG_LEVEL` 調整輸出量，在雜訊與細節之間取捨。

**Why this priority**: 結構化日誌是整個觀測基線的地基——健康端點的判讀理由、指標摘要都以它為載體，且它單獨交付即已把「三端只有純文字 log、無法聚合、無法串接」這個最核心的缺口補上，直接兌現「監控台自己可被監控」的敘事。故列 P1。

**Independent Test**: 在系統運行下觸發一筆診斷，只用日誌、以該次的 jobId 串起「api 接收請求 → worker 領取並處理 → 結果回傳」的完整事件序列；再把 `LOG_LEVEL` 調高（如 warn），確認 info 級雜訊消失而錯誤仍在——即可獨立驗收，無需健康端點或指標摘要就位。

**Acceptance Scenarios**:

1. **Given** api 與 worker 正在運行，**When** 觀察兩者的日誌輸出，**Then** 每一筆都是統一格式的結構化紀錄，含 level、時間與來源脈絡，無殘留的純文字 `console.log` 混雜。
2. **Given** 展示者觸發了一筆診斷，**When** 開發者以該次 jobId 在日誌中查找，**Then** 能串起跨 api 與 worker 的相關事件序列，而不需靠時間戳猜測對應關係。
3. **Given** `LOG_LEVEL` 設為較高的等級，**When** 系統照常運行，**Then** 低於該等級的日誌不再輸出，錯誤與關鍵事件仍可見。

---

### User Story 2 - api 健康端點反映依賴狀態（Priority: P2）

運維者／編排器可對 api 查詢一個健康端點，取得 api 自身與其關鍵依賴（Redis、Mongo）連通狀態的即時判讀。當某個依賴失聯時，端點以非健康狀態回報並指出是哪個依賴出問題，供容器編排的 healthcheck 與人工排查使用。

**Why this priority**: 健康端點是「系統此刻健不健康」最直接的外部訊號，也讓 008 的容器編排能對 api 做真正涵蓋依賴連通性的就緒判定（008 明確把 `/healthz` 劃歸 009，其自身只以 `/ws` 握手探活、不涵蓋 Redis／Mongo）。但它依賴 US1 的結構化日誌承載判讀理由，且核心敘事已由 US1 兌現，故列 P2。

**Independent Test**: 系統就緒後查詢健康端點得到健康狀態；手動停掉 Redis 或 Mongo，於數秒內再查，確認端點轉為非健康且指出失聯的依賴；恢復依賴後再查，確認轉回健康——即可獨立驗收。

**Acceptance Scenarios**:

1. **Given** api 與其依賴（Redis、Mongo）皆正常，**When** 查詢健康端點，**Then** 回報整體健康，並可看出各關鍵依賴的連通狀態。
2. **Given** api 正在運行，**When** 某個關鍵依賴（Redis 或 Mongo）失聯，**Then** 健康端點在數秒內轉為非健康狀態並指出是哪個依賴出問題。
3. **Given** 某個依賴無回應，**When** 查詢健康端點，**Then** 端點在有限時間內回應（不因依賴無回應而長時間阻塞）。

---

### User Story 3 - 關鍵指標週期摘要入日誌（Priority: P3）

運維者可直接從日誌讀出系統關鍵營運指標的週期性摘要，不需額外工具：佇列深度與 active／failed 計數、WebSocket 連線數、LLM 呼叫延遲、以及快取命中率。這讓「行為是否正常」有量化依據，而不只是「行程還活著」。除入日誌外，web 端另提供一個唯讀 dev 面板呈現同組指標的最新快照，供人工即時判讀。

**Why this priority**: 指標摘要把健康判讀從「存活」深化到「行為正常」，是觀測基線的加值層；但它依賴 US1 的結構化日誌作為輸出載體，且不像 US1／US2 那樣是入場券，故列 P3。

**Independent Test**: 讓系統承載一段遙測與至少一次診斷後，只讀日誌即可找到週期性的指標摘要，且四項指標（佇列深度、WS 連線數、LLM 延遲、快取命中率）皆有數值；同時開啟 web dev 面板可看到同組指標的最新快照——即可獨立驗收。

**Acceptance Scenarios**:

1. **Given** 系統正在承載遙測與診斷，**When** 觀察日誌，**Then** 能週期性地看到含佇列深度、WS 連線數、LLM 延遲與快取命中率的指標摘要。
2. **Given** 已發生數次快取命中與未命中，**When** 讀取下一則指標摘要，**Then** 快取命中率反映實際命中情形。
3. **Given** 系統正在承載遙測與診斷，**When** 開啟 web dev 面板，**Then** 面板以唯讀方式呈現同組四項指標的最新快照，且與日誌摘要一致。

---

### User Story 4 - 有損寫入語意明文化（Priority: P3）

任何閱讀原始碼與 README 的人，都能明確知道系統對 telemetry 持久化採「fire-and-forget、可丟失最後數秒」的有損語意，以及 errorlog 在重啟邊界可能重複——這些是**已宣告、被接受**的取捨，而非隱藏的缺陷。說明就寫在對應的持久化程式註解、README 與 ADR-002 §6.4 的引用中。

**Why this priority**: 這是把既有取捨從「隱性」變「顯性」的低成本收尾——「有損是可以的，未宣告的有損才是問題」（ADR-002 §6.4）。它不改任何行為、與其他 story 無耦合，屬文件化工作，故列 P3。

**Independent Test**: 對照持久化程式的註解、README 的相關段落與 ADR-002 §6.4，確認三者對「可丟失最後數秒 telemetry、errorlog 在重啟邊界可能重複」的描述一致，且與程式實際行為相符——即可獨立驗收。

**Acceptance Scenarios**:

1. **Given** 有損寫入語意已明文化，**When** 閱讀持久化程式註解、README 與 ADR-002 §6.4，**Then** 三者對「可丟失什麼、何時可能重複」的描述一致，且與程式實際的 fire-and-forget 行為相符。

---

### Edge Cases

- **依賴部分或全部失聯**：Redis 通但 Mongo 不通（或反之）時，採二態判讀——任一關鍵依賴失聯即整體 unhealthy（回 HTTP 503），不設「單一依賴降級」中間態；但 body 仍逐項列出各依賴 up／down，讓讀者看出是哪個依賴出問題（見 FR-005）。**兩者皆失聯**時同樣回 unhealthy／503，body MUST 同時列出兩者為 down，不得只回報先偵測到的那一個。依賴恢復後，下一次探測即應轉回 healthy／200（見 SC-003）。
- **api 啟動中、依賴尚未就緒**：此為容器 `start_period` 內的實際狀態。健康端點 MUST 可回應（不得因未就緒而不存在或掛起），並將尚未就緒的依賴回報為 down、整體 unhealthy／503——即「尚未就緒」與「已失聯」對外採同一種表達，避免編排器誤判為就緒。
- **指標蒐集自身失敗**：讀取跨行程快照發生錯誤、佇列查詢逾時或資料畸形時，MUST NOT 中斷該則摘要輸出，亦 MUST NOT 影響主流程（遙測、診斷、streaming）；該項標記為不可用並記錄一則錯誤，其餘指標照常呈現（見 FR-008）。
- **健康端點自身不得被依賴拖垮**：依賴無回應時，端點必須在有限時間內回應，不因等待而長時間阻塞。
- **指標摘要的等級**：`LOG_LEVEL` 調高後，指標摘要仍須能被觀測（其設計等級不應被一般過濾意外濾掉），否則觀測能力隨過濾一起失效。
- **高頻 telemetry 不得淹沒日誌**：不得對每一筆遙測逐筆記錄日誌，否則結構化日誌本身會成為雜訊源、抵銷可觀測性。
- **跨重啟的關聯連續性**：**api 與 worker 兩端皆適用**——行程重啟（含 worker 崩潰重啟）後，不要求關聯鍵跨行程生命週期連續，但同一次生命週期內須一致。
- **與 007 heartbeat 的命名共存**：worker 的既有 heartbeat 探針與 api 健康端點各自獨立命名／格式、不共用命名空間，僅須確保 key 名與語意不相衝突（見 FR-010）。

## Clarifications

### Session 2026-07-17

- Q: US2 健康端點的狀態模型與 HTTP 回應契約？ → A: 二態（healthy/unhealthy）；任一關鍵依賴（Redis 或 Mongo）失聯即 unhealthy；健康回 HTTP 200、非健康回 503；body 以 JSON 列出各依賴 up/down 與失聯原因。
- Q: US3 關鍵指標的呈現範圍？ → A: 週期摘要入日誌為基線，並額外在 web 端提供唯讀 dev 面板呈現指標快照（僅展示後端輸出的指標，不涉及瀏覽器日誌蒐集／上報）。
- Q: api 健康端點與 007 既有 worker heartbeat 的命名／格式如何共存？ → A: 各自獨立命名與格式，僅確保 key 名／語意不相衝突，不共用命名空間、不強行統一。
- Q: 關鍵指標週期摘要的輸出間隔？ → A: 固定週期，預設每 60 秒一則，可經環境變數調整。（變數名後續定為 `METRICS_INTERVAL_MS`、下限 5000ms，現況以 FR-008 為準）

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: api 與 worker MUST 以統一、機器可解析的結構化格式輸出所有日誌，每筆至少含等級（level）、時間與來源脈絡（context）。「機器可解析」的判準為：**production 模式下輸出的每一行皆為可獨立剖析的合法 JSON**；開發模式的人類可讀 pretty-print 屬呈現層例外，不影響此判準。
- **FR-002**: 結構化日誌 MUST 支援關聯鍵（至少 jobId、machineId、clientId），使一次診斷或一台機台的相關事件可被跨 api／worker 串接，而不需靠時間戳推測。關聯鍵 MUST 為日誌條目的**獨立結構化欄位**（可直接依欄位過濾），MUST NOT 僅內嵌於訊息字串中。
- **FR-003**: 日誌等級 MUST 可透過 `LOG_LEVEL` 環境變數調整；未設定時預設為 `info`。收到無法辨識的等級值時 MUST 回退至預設等級並**實際輸出**一則 `warn` 級日誌（載明收到的非法值與實際採用的等級），MUST NOT 因此中止行程。
- **FR-004**: 系統 MUST 以統一結構化日誌取代現有手寫 `log()`／`console.log` 輸出，MUST NOT 留下兩套並存的日誌格式。本要求的判定範圍為 **api／worker 長駐服務行程在運行期產生的日誌**；一次性 CLI 腳本（如 seed／smoke 工具）的終端回饋不在此列，維持人類可讀輸出。**唯一例外為 worker 致命路徑**：致命訊息 MUST 維持同步寫出 stderr，MUST NOT 改走結構化 logger。（理由須隨例外留痕：容器內 stderr 為 pipe，非同步寫入會在 `process.exit` 時遺失最後一則致命訊息；且該格式已是 Feature 007 交付的運維契約。此例外為刻意保留，MUST NOT 被後續 review 當作漏改而「修正」。）
- **FR-005**: api MUST 提供健康端點 **`GET /healthz`**，反映自身與關鍵依賴（**僅** Redis、Mongo，清單封閉）的連通狀態，採**二態**判讀（healthy／unhealthy）：任一關鍵依賴失聯即 unhealthy。健康時 MUST 回 HTTP 200、非健康時 MUST 回 HTTP 503；回應 body MUST 以 JSON 列出各關鍵依賴的連通狀態（up／down）與失聯原因。判讀 MUST 為**每次請求即時探測**，MUST NOT 快取先前結果（快取會使 SC-003 的時效要求不成立）。此端點 MUST NOT 涵蓋 worker 存活——worker 由 007 的 heartbeat 與其自身容器 healthcheck 承接，api 不代 worker 發言（見 FR-010）。（不設 degraded 中間態——Redis 與 Mongo 皆為關鍵依賴，任一失聯即整體不可正常服務。）
- **FR-006**: 健康端點 MUST 可被外部探測消費（供容器編排 healthcheck 與人工檢查使用），且 MUST NOT 要求任何認證或祕密——若需 secret，容器 healthcheck 與人工排查皆無法消費。
- **FR-006a**（跨 Feature 銜接）: Feature 008 既有的 api 容器 healthcheck MUST 改由本 feature 的健康端點消費，取代現行的 `/ws` 握手探活，使容器就緒判定涵蓋 Redis／Mongo 的連通深度。改寫後 MUST 維持僅使用 Node 內建 HTTP 能力，MUST NOT 引入 `wget`／`curl` 等外部相依（沿用 008 已收斂的「healthcheck 去外部相依」結論），且自我逾時 MUST 小於編排層的 healthcheck timeout。
- **FR-007**: 健康端點的依賴探測 MUST 有逾時保護，MUST NOT 因依賴無回應而長時間阻塞回應；逾時分支 MUST 將該依賴回報為 down 並註明逾時原因，MUST NOT 拋錯。具體逾時值由 plan 定案並 MUST 可經環境變數調整，且 MUST 使端點總回應時間小於 SC-003 的上限。
- **FR-008**: 系統 MUST 週期性將關鍵指標摘要輸出至日誌，至少涵蓋下列四項，且各自的統計語意 MUST 明確：
  - **佇列深度與 active／failed 計數**——採**瞬時值**（查詢當下的佇列快照），非窗內增量；
  - **WebSocket 連線數**——採**瞬時值**；
  - **LLM 呼叫延遲**——MUST 以統計形狀呈現（至少：週期內樣本數、平均、p95、最大值），MUST NOT 只給單一數字（長尾分布下無判讀價值）；
  - **快取命中率**——採**週期內**計數（每週期結算後清零，非開機累計）；分母為零時 MUST 回報為「本週期無樣本」而非 0%，避免誤讀為命中率崩潰。

  摘要輸出間隔採固定週期，預設每 60 秒一則，MUST 可經環境變數 `METRICS_INTERVAL_MS` 調整；為與 FR-009 相容，間隔下限為 **5000ms**，低於下限的設定值 MUST 回退至預設（60000ms）。任一指標來源缺席或蒐集失敗時，摘要 MUST 仍照常輸出、僅將該項標記為不可用（worker 側缺席時以 `worker: null` 表達，見 data-model E3），MUST NOT 因單一來源缺席而中止整則摘要。
- **FR-008a**: 除「摘要入日誌」外，web 端 MUST 額外提供一個唯讀的 dev 面板，呈現同組關鍵指標的最新快照供人工判讀。指標 MUST 經既有即時通道以**新增的控制訊息**送達前端，且該訊息 MUST 依契約先行原則納入共用通訊契約與 AsyncAPI 文件；MUST NOT 為此新增 HTTP 端點。面板 MUST 標示快照的新鮮度，當快照超過 **2 個摘要週期**（預設 120 秒）未更新時 MUST 以過期樣態呈現，MUST NOT 讓過期數值看起來像即時值。此面板僅**展示**後端輸出的指標，MUST NOT 承擔瀏覽器端日誌蒐集／上報（與 FR-013 不衝突），MUST NOT 提供任何觸發後端動作的控制項，亦 MUST NOT 改變任何即時行為或寫入語意。
- **FR-009**: 高頻 telemetry MUST NOT 被逐筆寫入日誌（避免日誌量爆炸而抵銷可觀測性）。可驗證門檻為：**正常路徑下，每筆遙測的接收與處理 MUST 不產生任何日誌條目**；僅異常、狀態轉換與週期摘要得記錄。
- **FR-010**: 本 feature 對關聯鍵與健康／心跳訊號的命名 MUST 與 007 既有 heartbeat 探針共存不衝突：api 健康端點與 worker heartbeat 各自獨立命名與格式，MUST NOT 共用命名空間、亦不強行統一；僅須確保 key 名／語意不相衝突，且不破壞 007 已交付的 heartbeat key。
- **FR-011**: 有損寫入語意（telemetry 持久化為 fire-and-forget、可丟失最後數秒；errorlog 在重啟邊界可能重複）MUST 明文化於對應的持久化程式註解、README，並引用 `ADR-002 §6.4`。
- **FR-012**: 本 feature MUST NOT 改變任何**既有的**寫入語意或即時行為；telemetry、診斷、streaming 全流程 MUST 與改動前逐項一致（判準見 SC-007）。例外僅限下列兩類**不影響既有流程**的變更：(a) 日誌輸出管道的替換（FR-001／FR-004）；(b) 本 spec 明文要求的**純增添式**新增——健康端點（FR-005）與指標控制訊息（FR-008a）。此二者 MUST NOT 改動既有訊息的形狀與 cadence、既有端點的行為，或既有的背壓與優雅關閉語意。
- **FR-013**: web 端（瀏覽器）的日誌蒐集／上報 MUST NOT 納入本 feature。
- **FR-014**: Prometheus／Grafana、`/metrics` 匯出器、OpenTelemetry tracing、告警系統、日誌聚合服務 MUST NOT 納入本 feature（ADR-002 §7 邊界）。FR-008a 的 dev 面板為唯讀 UI 呈現，MUST NOT 演變為機器可抓取的匯出端點，故與本條不衝突。
- **FR-015**（跨 Feature 回補）: 本 feature 於 SDD 各階段所定、影響當前 feature 以外範圍的決策，MUST 於收尾前寫回真實來源，並同步修訂既有內容以消除矛盾，MUST NOT 殘留指向舊決策的敘述。標的逐項為：(1) 實作指南 §15.2／§15.3——四項 clarify 問題標記為已定案並填入答案，「要做」清單補上 web dev 面板；(2) 實作指南 §14（Feature 008 章節）——api 容器 healthcheck 由 `/ws` 握手改為健康端點的現況描述（FR-006a）；(3) 實作指南 §15.4——驗收清單補「web dev 面板」與「二態 200／503」判準；(4) `ADR-002 §6.4`——「落地」欄位由「Feature 009 將寫入…」改為已落地的現況描述；(5) `README.md`——新增「已宣告的取捨」小節（FR-011）、新增環境變數說明與 dev 指標面板開關說明；(6) `asyncapi.yaml`——新增指標控制訊息定義（FR-008a）。回補 MUST NOT 重寫歷史：既有的決策背景與由來敘述保留（必要時改過去式並標註現況出處），僅更新現況描述。
- **FR-016**: 本 feature 新增的所有環境變數 MUST 同步登錄於 `.env.example`，並註明用途與預設值，使設定形狀有單一可查來源（憲章 VI 只規範不得提交祕密，未涵蓋此項）。

### Key Entities *(include if feature involves data)*

- **結構化日誌條目（Structured Log Entry）**：一筆機器可解析的日誌，含等級、時間、來源脈絡、訊息與選配的關聯鍵（jobId／machineId／clientId）。是 US1／US3 的共同載體。
- **健康狀態報告（Health Report）**：api 對外回報的健康判讀，採二態整體狀態（healthy／unhealthy，分別對應 HTTP 200／503），並在 body 中逐項列出各關鍵依賴（Redis、Mongo）的連通狀態（up／down）及非健康時的原因。
- **指標摘要（Metrics Summary）**：一則週期性的營運指標快照，含佇列深度與 active／failed 計數、WebSocket 連線數、LLM 呼叫延遲、快取命中率，以及其涵蓋的時間窗。

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: api 與 worker **長駐服務行程**的日誌輸出 100% 為統一結構化格式（含 level 與 context），無殘留純文字 `console.log`。計算母體**不含**一次性 CLI 腳本（seed／smoke）與 worker 致命路徑——兩者的範圍界定與例外理由見 FR-004。
- **SC-002**: 給定一次診斷的 jobId，運維者能**只用日誌**還原「api 接收 → worker 處理 → 結果回傳」的完整事件序列，無需依賴外部相關性推測；且該 jobId 可作為**獨立欄位直接過濾**，無需對訊息字串做子字串比對。
- **SC-003**: 停掉 Redis 或 Mongo 後，健康端點於 **5 秒內**轉為非健康（HTTP 503）並在 body 明確指出失聯的依賴；依賴恢復後轉回健康（HTTP 200）。008 的容器 healthcheck 依此端點判定 api 就緒（FR-006a）。
- **SC-004**: 運維者能只讀日誌，即找到含四項關鍵指標（佇列深度、WS 連線數、LLM 延遲、快取命中率）的週期摘要，無需任何額外工具；同組指標亦可於 web dev 面板以唯讀方式即時查看，且與日誌摘要一致。
- **SC-005**: 調整 `LOG_LEVEL` 能改變日誌輸出量（如設為 warn 後不再出現 info 級雜訊），且關鍵指標摘要仍可被觀測到——摘要具**獨立於 `LOG_LEVEL` 的專屬等級**（即 Edge Case 所稱「設計等級」），不隨根 logger 的過濾一併失效。
- **SC-006**: 有損寫入語意在持久化程式註解與 README 皆明文，且與程式實際行為一致（可由讀者一致驗證，不出現文件與行為矛盾）。
- **SC-007**: 三端行為零回歸——逐項對照清單為：**遙測推送 cadence、背壓比值、AI 診斷 streaming 延遲與 token 順序、快取命中行為、優雅關閉語意**，全流程與改動前逐項一致。

## Assumptions

- **指標呈現以「入 log」為基線並加 web dev 面板**：關鍵指標以「週期摘要入日誌」為基線；經 Clarifications 定案，另在 web 端加一個唯讀 dev 面板呈現指標快照（指南 §15.3 Q2 所列選配加值中的「前端 dev 面板」）。不另做 `/stats` 端點。
- **結構化日誌方案**：以生態成熟的結構化日誌方案實作（指南 §15.2 指名 pino 為 reference）；dev 是否 pretty-print、prod 純 JSON 等呈現細節屬實作層，留待 plan 定案，spec 不綁定特定套件（但 FR-001 已就「機器可解析」給出可驗證判準）。
- **健康端點判準**：經 Clarifications 定案採二態（healthy／unhealthy），任一關鍵依賴失聯即 unhealthy；健康／非健康以 HTTP 200／503 承載，body 逐項列出依賴狀態（見 FR-005）。degraded 中間態不納入。
- **與 007 heartbeat 整合**：經 Clarifications 定案，worker 既有心跳與 api 健康端點各自獨立、不共用格式／命名空間；僅確保 key 名不衝突、不破壞 007 已交付的 heartbeat key（見 FR-010）。
- **範圍限後端（web 僅限指標 dev 面板）**：本 feature 後端涵蓋 api／worker；web 端**除唯讀指標 dev 面板（FR-008a）外**不納入其他改動，特別是**不含**瀏覽器端日誌蒐集／上報（FR-013）與離線效能量測（ADR-002 §7 之外的候選方向，見指南 §15.5）。
- **不改寫入語意**：telemetry 的 fire-and-forget 維持不變，本 feature 只將該語意明文化，不引入寫入佇列或重試（升級路徑見 ADR-002 §6.4）。

## Dependencies

- **Feature 007（worker 監督與 heartbeat）已併回 `develop`**：本 feature 的健康訊號與 007 的 heartbeat 探針**各自獨立命名與格式、不共用命名空間、不強行統一**；僅 MUST NOT 破壞 007 已交付的 heartbeat key 與語意（FR-010）。此外，007 交付的致命 log 格式為既有運維層契約，構成 FR-004 例外的依據。
- **Feature 008（整棧容器化）**：008 的容器 healthcheck 目前以 `/ws` 握手探活、明文不涵蓋 Redis／Mongo 連通性（008 clarify 已將 `/healthz` 劃歸 009）；本 feature 的健康端點（US2）即補上這層深度，供 compose healthcheck 消費。可與 008 並行或先後（指南 §15 前置）。
- **ADR-002 §5.3／§6.4／§7**：範圍邊界（只做日誌 + healthz + 指標入 log）、有損寫入語意的決策與明文化落地標的、以及明確拒絕的路線，均以此 ADR 為準。
