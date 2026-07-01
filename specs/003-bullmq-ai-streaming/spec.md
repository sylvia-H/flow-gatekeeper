# Feature Specification: 診斷任務佇列、AI 串流診斷與 Redis 快取

**Feature Branch**: `003-bullmq-ai-streaming`

**Created**: 2026-07-01

**Status**: Draft

**Input**: User description: "建立 flow-gatekeeper 的 BullMQ 診斷任務、獨立 worker process、AI streaming、Redis cache-aside、MongoDB diagnosis persistence。範圍：API 提供 POST /diagnoses 建立 diagnosis job；BullMQ queue 使用 Redis，設定 limiter、attempts、exponential backoff；Worker 獨立 process 消化 job；Worker 先用 prompt signature 查 Redis ai-cache；Cache miss 才呼叫 LLM provider streaming；Worker 每個 token publish 到 Redis Pub/Sub channel ai-stream:<jobId>；Gateway 訂閱 ai-stream:*，把 token/done/error 轉發給對應 client；Worker 讀 MongoDB 最近 telemetry/errorlogs/maintenanceRecords 組 prompt；Final diagnosis 寫入 MongoDB diagnoses collection。成功條件：連續觸發 20 個 diagnosis request 不超過 AI_RPM；Cache hit 回傳 cached:true 且不呼叫 LLM；Worker 掛掉時 API/Gateway 不崩潰；前端可看到 token streaming 與 job status。"

## Clarifications

### Session 2026-07-01

- Q: 診斷結果來自快取（cache hit）時，是否每次都要在 MongoDB `diagnoses` 新增一筆紀錄？
  → A: 只記輕量觸發稽核——快取命中 MUST NOT 重複寫入完整診斷結果；改為每次觸發（含命中）
  記一筆輕量觸發稽核紀錄（機台、任務識別、發起者、觸發時間、是否來自快取），使觸發可追溯又
  不讓結果集合膨脹（對齊指南 §8.10：cache-hit 只 publish `ai/done` cached:true，不寫 `diagnoses`）。
- Q: AI streaming 呼叫應設多長的應用層逾時上限？ → A: 30 秒；逾時 MUST 轉為 `ai/error` 並依
  重試策略（`attempts`／指數退避）處理，MUST NOT 讓發起連線無限等待。
- Q: POST /diagnoses（建立診斷的 HTTP 入口）開發階段是否需要授權？ → A: 不需授權；REST 入口
  於開發階段開放，即時通道的訂閱仍需 `WS_AUTH_SECRET`（與指南 §8.4 的 demo 用法一致）。

## User Scenarios & Testing *(mandatory)*

本 feature 的「使用者」有二：一是**監控台操作者**（在監控台上對某台機台按下「診斷」、期望即時看到 AI 逐字產出診斷與任務進度的人，以及後續 004 前端的實作者），二是**營運成本的守門人**（在意 LLM 額度不被重複、爆量呼叫的維運角色）。其價值是：在 002 已能持續產生並落地遙測／異常／維修歷史的基礎上，讓系統第一次能「就某台機台的近期脈絡，產出可追溯的 AI 診斷」——診斷工作在獨立 worker 執行、逐字串流回操作者、可重複的相同情境命中快取而不重打 LLM，且 worker 崩潰不會拖垮即時服務。

### User Story 1 - 觸發診斷並即時看到串流結果與任務狀態 (Priority: P1)

監控台操作者對某台機台發起一次診斷請求，立刻取得一個任務識別；隨後透過即時通道，逐字收到 AI 產出的診斷文字，並看到該任務的生命週期狀態（等待中 → 進行中 → 完成／失敗）。診斷完成時，收到一份結構完整、可據以行動的診斷結果（摘要、嚴重度、可能原因、建議動作、佐證）。

**Why this priority**: 「發起診斷 → 即時串流 → 拿到結構化結果」是本 feature 的核心能力與最小可行產物——只要這一條成立，就已能在前端展示一次完整的 AI 診斷體驗並獨立驗收。

**Independent Test**: 對一台有近期遙測／異常歷史的機台發起診斷，觀察是否先取得任務識別，接著在即時通道上逐段收到診斷文字，最後收到一則「完成」事件夾帶結構化結果；同時任務狀態依序推進——即可獨立驗收。

**Acceptance Scenarios**:

1. **Given** 即時通道已連線且指定機台有近期歷史，**When** 操作者發起一次診斷請求，**Then** 系統立即回覆一個唯一任務識別，並標記任務為「等待中」。
2. **Given** 診斷任務開始被處理，**When** AI 逐段產出診斷文字，**Then** 發起該任務的連線會依序收到帶有遞增序號的診斷文字片段。
3. **Given** 診斷任務完成，**When** 最終結果產生，**Then** 發起連線收到一則「完成」事件，內含通過結構驗證的診斷結果（摘要、嚴重度、可能原因、建議動作、佐證）。
4. **Given** 診斷任務在生命週期中推進，**When** 狀態改變（等待中／進行中／完成／失敗），**Then** 發起連線能收到對應的任務狀態更新。
5. **Given** 診斷所需的 AI 產出無法解析為有效結構，**When** 驗證失敗，**Then** 系統對發起連線送出一則「診斷錯誤」事件，而非把未驗證內容當作結果。

---

### User Story 2 - 可重複情境命中快取、不重複消耗 LLM 額度 (Priority: P2)

當同一台機台在相同的嚴重度脈絡下被重複診斷時，系統直接回傳先前算好的診斷結果並標示「來自快取」，不再呼叫 LLM；且大量並發的診斷請求受速率限制保護，不會在短時間內對 LLM 超量呼叫。同一情境同時湧入多筆請求時，只會有一筆真正呼叫 LLM，其餘共用其結果。

**Why this priority**: 成本與額度控制是憲章硬性原則（Cache before API、對同簽章去重），也是長時間展示與多次觸發的前提；但它依賴 US1 的診斷流程先能跑通，故列 P2。

**Independent Test**: 對同一機台在相同狀態下連續發起兩次診斷，確認第二次回覆標示「來自快取」且未觸發新的 LLM 呼叫；再連續快速發起大量請求，確認一分鐘內實際 LLM 呼叫次數不超過設定上限——即可獨立驗收。

**Acceptance Scenarios**:

1. **Given** 某機台在特定嚴重度脈絡下已被診斷過且結果仍在快取有效期內，**When** 相同情境再次被診斷，**Then** 系統回傳標示「來自快取」的結果且不呼叫 LLM。
2. **Given** 快取簽章反映機台當前狀態，**When** 同一機台的狀態已由異常轉為正常，**Then** 舊的異常診斷不會被誤命中（不同狀態不共用快取）。
3. **Given** 設定了每分鐘 LLM 呼叫上限，**When** 短時間內連續發起遠超上限的診斷請求，**Then** 一分鐘內實際 LLM 呼叫次數不超過設定上限（其餘請求排隊或改吃快取）。
4. **Given** 同一情境同時湧入多筆診斷請求，**When** 尚無快取結果，**Then** 只有一筆真正呼叫 LLM，其餘在其完成後共用該結果，不各自重打。

---

### User Story 3 - Worker 隔離：耗時工作不拖垮即時服務 (Priority: P3)

診斷這類耗時、需呼叫外部 AI、會 retry/backoff 的工作全部在獨立的 worker process 執行；即時通道與 API 服務不因診斷工作而阻塞。當 worker process 停擺或崩潰時，API 與即時通道仍持續運作、不崩潰，待 worker 恢復後積壓的任務可被消化；失敗的任務會依設定自動重試。

**Why this priority**: Worker 隔離與失敗韌性是憲章即時通道紀律的一部分，提升系統健壯性；但不是「讓一次診斷能跑通」的硬前提，故列 P3。

**Independent Test**: 在 worker 停止的情況下發起診斷，確認 API 仍正常回覆任務識別且即時通道不崩潰；重新啟動 worker 後，確認積壓任務被處理；模擬一次處理失敗，確認任務依設定重試——即可獨立驗收。

**Acceptance Scenarios**:

1. **Given** worker process 未在運行，**When** 操作者發起診斷請求，**Then** API 仍回覆任務識別、即時通道維持連線且不崩潰，任務進入等待狀態待處理。
2. **Given** 有積壓的等待任務，**When** worker process 啟動或恢復，**Then** 積壓任務被逐一消化。
3. **Given** 某次診斷處理因暫時性錯誤失敗，**When** 尚未達重試上限，**Then** 系統依指數退避自動重試；達上限後標記為失敗並通知發起連線。
4. **Given** worker process 在處理中途崩潰或被關閉，**When** 崩潰發生，**Then** API 與即時通道不受影響、不崩潰。

### Edge Cases

- 指定一台**沒有近期歷史**的機台發起診斷時，系統 MUST 安全處理（以可得的最小脈絡產出診斷或回報資料不足），不得崩潰。
- AI 產出**不含可解析結構**或結構不合法時，MUST 走「診斷錯誤」路徑，MUST NOT 把未驗證內容寫入結果或當成成功。
- 發起診斷的連線在串流途中**中斷／重連**時，系統 MUST 安全處理：舊連線的綁定失效不得導致崩潰；跨重連不保證續傳（屬已知限制，需於驗收說明）。
- 同一情境的 dedupe 保護期間，**持鎖者逾時或崩潰**時，MUST NOT 造成後續請求永久卡死（鎖具過期，逾時後可放行重算）。
- 任務終態（完成／失敗）後，MUST 清理其「任務 → 連線」綁定，避免對應關係無限累積。
- LLM 呼叫**逾時（≥ 30 秒）或回傳錯誤**時，MUST 轉為「診斷錯誤」事件並依重試策略處理，MUST NOT 讓發起連線無限等待而無任何回饋。

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: 系統 MUST 提供一個建立診斷任務的請求入口，接受欲診斷的機台識別與發起者資訊，並於受理後立即回覆一個唯一任務識別與初始狀態（等待中）。
- **FR-002**: 建立診斷任務 MUST 攜帶發起連線的識別，使後續串流與任務狀態能被推送回**正確的發起連線**；此「任務 → 連線」綁定 MUST 於任務終態後被清理。
- **FR-003**: 診斷任務 MUST 進入以 Redis 為後端的佇列，並具備速率限制（每分鐘 LLM 呼叫上限，`AI_RPM`）、重試上限（`attempts`）與指數退避（exponential backoff）設定。
- **FR-004**: 耗時的診斷工作（組脈絡、呼叫 AI、retry/backoff、rate limit）MUST 在**獨立的 worker process** 執行；API process MUST NOT 執行 long-running 診斷工作。
- **FR-005**: worker MUST 在呼叫 LLM 前，先以能反映「機台、當前嚴重度狀態、近期錯誤類型、prompt 版本、模型」的快取簽章查詢 Redis 快取；命中則直接回傳並標示「來自快取」，MUST NOT 呼叫 LLM。簽章組成與快取／鎖鍵命名以指南 §8.7 為單一來源，spec 不另訂平行定義。
- **FR-006**: 對同一快取簽章 MUST 去重：同一情境同時湧入多筆請求時，MUST 只有一筆真正呼叫 LLM，其餘等待後共用其結果；去重鎖 MUST 具過期時間，持鎖者逾時／崩潰後 MUST NOT 使後續請求永久卡死。
- **FR-007**: 快取未命中時，worker MUST 透過 `AiProvider` interface 以**串流方式**取得診斷；主邏輯只依賴該 interface，替換 LLM provider MUST 只需更換 adapter（憲章 Principle V）。
- **FR-008**: worker MUST 將每段 AI 產出的 token 以帶遞增序號的事件發布到 Redis Pub/Sub 通道 `ai-stream:<jobId>`；job 生命週期狀態與 AI token 串流 MUST 分走兩條流（job 走 BullMQ 佇列事件、token 走 Pub/Sub），MUST NOT 混為同一條流（憲章 Principle IV）。
- **FR-009**: worker MUST NOT 直接對 WebSocket client emit；即時轉發 MUST 由 Gateway 統一負責：Gateway MUST 訂閱 `ai-stream:*`，把 `ai/token`、`ai/done`、`ai/error` 事件轉發給該任務所綁定的連線。
- **FR-010**: Gateway MUST 就診斷任務的生命週期（等待中／進行中／完成／失敗／進度）組出任務狀態事件（`job/status`），並推送給發起連線。
- **FR-011**: worker MUST 讀取 MongoDB 中該機台**近期**的遙測彙總、異常事件與維修紀錄，組成診斷 prompt 的脈絡；讀取窗口 MUST 可由任務參數（`windowMinutes`）界定。
- **FR-012**: AI 回傳 MUST 經診斷結果結構驗證（`DiagnosisResultSchema` 解析）後才視為成功；驗證失敗 MUST 走 `ai/error`，MUST NOT 把未驗證物件當作結果使用（憲章 Principle V）。
- **FR-013**: 經驗證的最終診斷結果 MUST 於**實際呼叫 LLM 產生時（快取未命中）**持久化至 MongoDB `diagnoses` 集合，含機台、任務識別與產生時間，供事後追溯（憲章 Principle VII）；**快取命中時 MUST NOT 重複寫入完整診斷結果**。
- **FR-013a**: 每次診斷觸發（含快取命中）MUST 記錄一筆**輕量觸發稽核紀錄**（機台、任務識別、發起者、觸發時間、是否來自快取），使每次觸發皆可追溯，且 MUST NOT 使 `diagnoses` 結果集合因快取命中而膨脹。
- **FR-014**: 診斷任務 payload、AI 串流事件（`ai/token`、`ai/done`、`ai/error`）與任務狀態事件（`job/status`）的結構 MUST 沿用單一通訊契約（`packages/contracts` / `asyncapi.yaml`），新增者 MUST 先改契約再改各端，MUST NOT 另立平行定義。
- **FR-015**: 用於佇列、發布、訂閱、快取的 Redis 連線 MUST 分離；訂閱用連線 MUST NOT 拿去執行一般 command（憲章 Principle IV）。
- **FR-016**: worker process 停擺、崩潰或被關閉時，API 與即時通道 MUST 不受影響、不崩潰；worker 恢復後積壓任務 MUST 可被消化。
- **FR-017**: 在接入佇列前，MUST 提供一支可獨立執行的 LLM 連通性煙霧測試（smoke test），用以確認 API key、模型名稱與額度可用。
- **FR-018**: 本 feature MUST 至少提供一支實際（非 no-op）的純函式單元測試作為驗收佐證，覆蓋核心決定性邏輯之一或多者，例如「快取簽章對相同輸入具決定性、對不同狀態/錯誤類型會改變」或「串流文字抽取 JSON 後對壞資料會丟錯」。
- **FR-019**: 系統 MUST 至少記錄（log）任務建立、任務進入處理、快取命中、LLM 呼叫、任務完成與任務失敗六類事件，以利展示與除錯；結構化 metrics／tracing 不在本 feature 範圍。
- **FR-020**: worker 對單次 AI streaming 呼叫 MUST 設 **30 秒**應用層逾時上限；逾時 MUST 轉為 `ai/error` 並依重試策略（`attempts`／指數退避）處理，MUST NOT 讓發起連線無限等待而無任何回饋。
- **FR-021**: 建立診斷的 HTTP 入口（POST /diagnoses）於**開發階段 MUST NOT 要求授權**（REST 入口開放）；即時通道的訂閱仍 MUST 通過 `WS_AUTH_SECRET`（授權範圍僅涵蓋即時通道，不涵蓋 REST 入口）。正式環境的 REST 認證不在本 feature 範圍。

### Key Entities *(include if feature involves data)*

- **DiagnosisJob（診斷任務）**：一次診斷請求的工作單位，含唯一任務識別、目標機台、發起者、發起時間、脈絡窗口與 prompt 版本；具生命週期狀態（等待中／進行中／完成／失敗）。
- **任務 → 連線綁定**：把任務識別對應到發起該任務的連線識別，供串流與狀態推回正確對象；任務終態後清除（跨重連不保證維持，屬已知限制）。
- **診斷脈絡（DiagnosisContext）**：由機台近期遙測彙總、近期異常事件與維修紀錄組成的 prompt 素材，及據以決定快取簽章的當前狀態與錯誤類型。
- **快取簽章與去重鎖**：反映「機台／當前狀態／近期錯誤類型／prompt 版本／模型」的穩定簽章，作為快取鍵；同簽章的去重鎖具過期時間，確保同情境只算一次。
- **DiagnosisResult（診斷結果）**：通過結構驗證的最終診斷，含摘要、嚴重度、可能原因、建議動作與佐證；於快取未命中而實際產生時持久化於 MongoDB `diagnoses`。
- **診斷觸發稽核紀錄（DiagnosisTrigger）**：每次診斷觸發（含快取命中）的輕量稽核，含機台、任務識別、發起者、觸發時間與是否來自快取；供追溯「誰在何時觸發、是否命中快取」，不重複攜帶完整診斷結果。
- **AI 串流事件**：`ai/token`（帶遞增序號的文字片段）、`ai/done`（含最終結果與是否來自快取）、`ai/error`（含錯誤碼與訊息）。
- **任務狀態事件（job/status）**：任務生命週期狀態的推送，供發起連線追蹤進度。

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 對一台有近期歷史的機台發起一次診斷，發起連線能在收到任務識別後，於即時通道上依序收到 ≥ 1 段診斷文字，並最終收到一則含結構化結果的「完成」事件。回應性以**首個診斷文字（token）在 ≤ 5 秒內出現**衡量；整體單次診斷（快取未命中）在 **AI 逾時上限 + 合理開銷（≤ 35 秒）** 內完成——刻意寬於 FR-020 的 30 秒 AI 逾時，避免在邊界（LLM 用滿 30 秒 + 組脈絡／解析／落地開銷）誤判失敗。
- **SC-002**: 對同一機台在相同狀態下連續發起兩次診斷，第二次回覆 100% 標示「來自快取」，且該次未新增任何 LLM 呼叫。
- **SC-003**: 在一分鐘內連續發起 20 個診斷請求，實際 LLM 呼叫次數 **≤ 設定的每分鐘上限（`AI_RPM`）**。
- **SC-004**: 同一情境同時湧入多筆請求時，真正觸發 LLM 呼叫的次數為 **恰好 1**，其餘共用其結果。
- **SC-005**: 在 worker 未運行時發起診斷，API 回覆任務識別的成功率為 100%，且即時通道維持連線、不崩潰；worker 啟動後積壓任務被消化的比例為 100%。
- **SC-006**: worker 於處理中途被關閉或崩潰時，API 與即時通道存活率 100%（不崩潰）。
- **SC-007**: 產生 AI 無法解析為有效結構的情境時，發起連線 100% 收到「診斷錯誤」事件，且 `diagnoses` 集合中 MUST NOT 出現該次未驗證的結果。
- **SC-008**: 快取未命中而實際產生的診斷，MongoDB `diagnoses` 集合皆可查得對應**結果**紀錄；每次診斷觸發（含快取命中）皆可透過輕量觸發稽核紀錄追溯（機台、任務識別、是否來自快取），且快取命中 **不新增** `diagnoses` 結果紀錄。
- **SC-009**: 至少 1 支實際（非 no-op）單元測試存在且通過，覆蓋快取簽章決定性或串流結果解析的決定性邏輯。

**覆蓋備註**：FR-013a（觸發稽核）與 FR-020（AI 逾時）分別由 SC-008、SC-007／SC-001 的時限與錯誤路徑覆蓋；FR-014（沿用契約）以 `pnpm contract:lint` 與 typecheck 覆蓋；FR-015（Redis 連線分離）、FR-017（smoke test）與 FR-021（REST 開發階段免授權）以人工／腳本驗證覆蓋，無獨立量化 SC；FR-019（記錄）以人工觀察 log 覆蓋，亦無獨立量化 SC。

## Assumptions

以下多為專案憲章（`.specify/memory/constitution.md`）與實作指南（§8）既已固定的約束，於此記錄以界定範圍，非本 spec 任意決定：

- 沿用 001／002 既有的單一通訊契約與既定通道（`job/status`、`ai/token`、`ai/done`、`ai/error`）；新增診斷任務 payload（`DiagnosisJobPayload`）與相關事件 MUST 先改契約再改各端。
- 授權範圍僅涵蓋即時通道：訂閱仍需 `WS_AUTH_SECRET`，但建立診斷的 HTTP 入口（POST /diagnoses）於開發階段開放、不要求授權（與指南 §8.4 demo 用法一致）；正式環境的 REST 認證留待後續，不在本 feature 範圍。
- 單次 AI streaming 呼叫設 30 秒應用層逾時上限（逾時走 `ai/error` 並依重試策略處理）；此上限與快取／鎖有效期等參數同屬可調環境設定。
- 佇列與快取以 Redis 為後端；job 生命週期走 BullMQ 佇列事件、AI token 走 Redis Pub/Sub，兩者分流（憲章 Principle IV、指南 §8.11）。
- 歷史脈絡讀自 MongoDB（002 落地的 telemetry／errorlogs／maintenanceRecords）；最終診斷持久化於 MongoDB `diagnoses`（憲章 Principle VII）。Redis 僅供佇列、快取、Pub/Sub、鎖等暫態用途。
- LLM provider 於開發階段採 Gemini（`GEMINI_API_KEY`、`GEMINI_MODEL`，預設 `gemini-2.5-flash`），包在 `AiProvider` interface 後面；換 provider 只改 adapter。API key 等祕密只放本機／`.env`，只提交 `.env.example`（憲章 Principle VI）。
- 快取有效期（`AI_CACHE_TTL_SECONDS`，預設 600 秒）、去重鎖有效期（`AI_DEDUPE_LOCK_SECONDS`，預設 45 秒）、速率上限（`AI_RPM`，預設 8）、脈絡窗口（`windowMinutes`，預設 5）與重試（`attempts` 3、指數退避）等參數可由環境／任務設定調整；預設值以指南 §8 為準。
- 「任務 → 連線」綁定於開發階段以記憶體 Map 實作；client 重連後連線識別會更換、舊綁定失效，跨重連不保證續傳（屬已知限制，需於 README／驗收註明；正式做法可改存 Redis）。
- 前端完整整合（按下「診斷」帶上連線識別、rAF 批次接收 token 串流與狀態）於 Feature 004 驗收；本 feature 的手動驗收可用命令列 HTTP／WebSocket 客戶端或最小整合腳本完成，`socketId` 於純後端 smoke test 可填任意字串（任務仍會跑完、寫入 Mongo、進快取，只是無 client 收得到串流）。
- 診斷結果結構以 001 既有的 `DiagnosisResultSchema` 為單一來源；本 feature 不另訂平行結果結構。
