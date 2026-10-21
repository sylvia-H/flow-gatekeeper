# Feature Specification: 012-lite 串流韌性（Stream Resilience）

**Feature Branch**: `012-stream-resilience`

**Created**: 2026-10-21

**Status**: Draft

**Input**: User description: "012-lite 串流韌性：讓「後端已完成的 AI 診斷」一定能回到畫面，重連、worker 崩潰與 Redis 停頓都不再讓使用者看到假失敗或多付 LLM 費用。"（完成改以 BullMQ `returnvalue` 為權威、`ai/done` 降為 best-effort；新增 `GET /diagnoses/:jobId?socketId=` 供重連取回與 rebind；BullMQ 鎖參數調小並加 worker keepalive；以 jobId 冪等吸收重複執行、以短效失敗標記避免供應商故障時重複計費。技術棧不換、不實作 Redis Streams；契約 asyncapi 1.3.0 → 1.4.0 向後相容 minor。編號 012 沿用第三輪審查報告 roadmap 的 012-lite；起草依據為 `docs/adr-003-completion-semantics.md`（ADR-003）、`docs/20260927-research-review03.md` §3.2／§3.3／§5.4／§5.6 與 `CHANGELOG.md` `[2.1.0]` 相容性注意中帶著發布的項目 AR-4、AR-S7、WK-13、WK-4 補強、AR-5 根治）

## Clarifications

### Session 2026-10-21（代理裁決，待使用者覆核）

以下 14 條依 ADR-003 代理裁決，使用者離席期間採建議項；覆核後若推翻以 fix 分支修正，並於 ADR-003 §7 記為推翻紀錄。第 1 條與第三輪審查報告的建議不同，覆核時請優先看。

- Q: BullMQ `lockDuration`／`stalledInterval`／`maxStalledCount` 與 keepalive 間隔取多少？ → A: lock 15 s／stalled 5 s／maxStalled 2、keepalive 10 s（報告原值 15／10／2 在 keepalive 10 s 下最壞無事件正好 45 s、等於 watchdog；定案值上界 35 s）（見 FR-018、FR-019，ADR-003 D4）。
- Q: `job/status` 要新增哪些欄位、attempt／execution 怎麼傳？ → A: 新增 optional `attempt`、`execution`、`reason`（開放字串 `z.string()`）、`cached`；attempt／execution 由 worker 放進 `updateProgress` 物件，relay `safeParse` 後拆出（見 FR-020、FR-030，D1／D7）。
- Q: GET 的授權模型與 rebind 規則？ → A: jobId 即 bearer capability；已完成的任務任何已授權連線可讀、不 rebind；進行中且原綁定在線、不是本 socket → 409；原綁定離線或無綁定 → rebind；先綁定後查詢，「原綁定在線」的 409 判斷延到查詢之後（見 FR-009～FR-011，D8）。
- Q: 同簽章 LLM 失敗的負向標記 `ai-fail:<sig>` 怎麼設計？ → A: TTL 10 s、涵蓋不可重試錯誤、等待者看到即消耗一次 attempt、在限流 INCR 前檢查、標記是自己的 jobId 時忽略、持鎖者成功寫快取時 DEL（見 FR-028，D5）。
- Q: MongoDB 寫入診斷失敗時如何避免重打 LLM？ → A: 納入 per-job 結果暫存 `ai-result:<jobId>`（EX 3600）與可重試的 `persist_failed`，重試只重做寫庫、不重打 LLM（見 FR-027，D6）。
- Q: e2e 的 Redis 停頓用哪種方式？ → A: `docker compose pause redis`（50 s 後 unpause），不用 `redis-cli CLIENT PAUSE`（見 FR-046、SC-004，D13）。
- Q: 45 s watchdog 觸發時的語意與文案？ → A: 觸發先 GET 一次；文案「超過 45 秒沒有收到進度，結果未知，請重試」；不改單調時鐘（見 FR-022，D11）。
- Q: nginx 對 GET 怎麼限流？ → A: GET 獨立 regex location 與限流區 `diag_read`（60 r/m、burst 10），POST 維持原桶（見 FR-015，D9）。
- Q: 憲章 Principle III 是否補列 `GET /diagnoses/:jobId`？ → A: ADR-003 與本 spec 記錄**建議**以 PATCH（1.6.0 → 1.6.1）修訂，實際 `/speckit-constitution` 待使用者確認、不在本 feature 自動執行；GET 的 query 與成功回應仍以 Zod 定義（見 FR-032、FR-041，D8 第 6 點）。
- Q: UI 文案如何定？ → A: 採 FR-035 的 UI 文案表；以 `job/status`／GET 收尾即標「原始串流（不完整）」；同簽章失敗不加後綴；卡片 chip 不新增種類（見 FR-035～FR-038，D13）。
- Q: 完成以哪個訊號為準？ → A: `ai/done`、帶 `result` 的 `job/status: completed`、GET 回 completed 三者先到者為準，之後到的忽略；`ai/done` 契約描述改為可重複、可遺失（見 FR-003、FR-004，D1／D3／D10）。
- Q: `failed` 終態是否比照 `completed` 保留綁定寬限？ → A: 是，套用相同的 10 s 綁定寬限（同一段 registry 程式），ADR-002 §6.5.1「失敗終態沒有 relay 寬限」列由本 feature 收掉（見 FR-014，D12）。
- Q: 「重新派送」說明行何時顯示？ → A: 只在 `reason: "stalled"` 時顯示；`execution` 因重試或限流延後遞增時只清空串流、不顯示這行（見 FR-006、FR-035，D7／D13）。
- Q: Pub/Sub 斷線且 worker 在串流中被 SIGKILL 時最長約 55 s 無事件，是否加機制？ → A: 接受、不加機制；keepalive 計時器維持由任何對外事件（含 `ai/token`）重設，watchdog 觸發後先 GET（見 Edge Cases、SC-001，D2 殘餘風險）。

### Session 2026-10-21（clarify 階段，代理裁決第 17～21 條，待使用者覆核）

clarify 覆蓋度掃描後補的 5 題，依影響排序；使用者離席期間採建議項，同步記於 ADR-003 §7 第 17～21 條。

- Q: 網路閃斷後重連時，伺服器還沒回收舊的半開連線（心跳回收上限約 30 s），重連 GET 照 D8 規則會回 409，畫面誤顯示「正由另一個視窗接收」——怎麼處理？ → A: GET 新增 optional `previousSocketId`；web 對每個任務記住最後一次成功綁定的 socketId 並在 GET 時帶上；原綁定仍在線但等於 `previousSocketId` 時視同原綁定已離線、暫定改綁，不主動終止舊連線（見 FR-007、FR-009、FR-016、FR-032、SC-005；代理裁決第 17 條，待覆核）。
- Q: GET 回 `failed` 或 `job/status: failed` 只帶 `failedReason` 原文、沒有錯誤碼時，`persist_failed` 怎麼顯示正確文案、又不露出 MongoDB 原始錯誤？ → A: `persist_failed` 的 `failedReason` 為固定英文句並含 `persist_failed` 字樣，MongoDB 原始錯誤只進日誌；web 在錯誤碼或訊息含 `persist_failed` 時都對映為「診斷結果無法寫入資料庫，請稍後重試」；GET 的 `failed` 回應不加 `code` 欄位（見 FR-027、FR-035；代理裁決第 18 條，待覆核）。
- Q: 診斷進行中重新整理頁面（或關分頁再開），是否續接原診斷？ → A: 不續接，列 Out of Scope；web 不持久化 jobId，後端照常跑完並寫快取，同機台同狀態再按「診斷」以新 jobId 命中快取或等去重鎖、不多打 LLM；寫進 `PRODUCT.md` 已知產品限制（見 Edge Cases、FR-039、Out of Scope；代理裁決第 19 條，待覆核）。
- Q: 重連續接後若以 `ai/done` 收尾，斷線期間的 token 已遺失，「原始串流」標題要不要標「不完整」？ → A: 要；執行期間經歷過 WS 重連（FR-016 的續接旗標曾被設起）的任務一律標「原始串流（不完整）」，仍不比對 `seq`（見 FR-035、FR-038；代理裁決第 20 條，待覆核）。
- Q: 新增的冪等短路、`ai-fail`、`stalled`、rebind 等路徑要留什麼可觀測訊號？ → A: 只加結構化日誌（依 009 `log-fields.md`），`system/metrics`／`WorkerMetrics` 不加欄位；keepalive 補送不逐次記日誌；e2e 以既有 `LLM call` 日誌計數 LLM 呼叫（見 FR-047、SC-004；代理裁決第 21 條，待覆核）。

## User Scenarios & Testing *(mandatory)*

本 feature 的「使用者」與 `apps/web/PRODUCT.md` 一致：**監控台操作者**（在監控台按「診斷」、等待 AI 結果的工程／維運人員）與**展示者／評估者**（看 demo、驗收「背壓、串流、快取」賣點的人）；另加**系統擁有者**（付 LLM 帳單、看成本與稽核數字的人，也就是部署這套 demo 的人）。

現況痛點（2.1.0 之前的審查與實測，quick-fix 只縮短了等待、沒有解決）：

1. **結果在後端、畫面卻失敗。** 「完成」只靠一則 Pub/Sub 訊息 `ai/done`。Pub/Sub 訂閱斷線（WS 沒斷）時，畫面收到「後端已完成」卻拿不到結果，2 秒後顯示「診斷已在後端完成，但結果未送達畫面，請重試」；使用者按重試，若快取已過期還會再付一次 LLM 費用。
2. **重連或 api 重啟後，進行中的診斷全部作廢。** 結果明明已寫進 MongoDB，卻沒有讀取端點；重連拿到新連線編號後，原本的任務直接標「連線中斷，請重試」。
3. **worker 崩潰後畫面卡 45 秒再判失敗，結果其實 90 秒後才出來。** BullMQ 鎖參數全用預設（30 s／30 s／1），worker 被強制終止後約 92 秒才重新派送；同簽章的等待者在等別人持鎖時最長 80 秒沒有任何事件，也會被 45 秒 watchdog 誤判。
4. **同一個請求被重跑時重打 LLM、重複記錄。** Redis 停頓超過鎖期限時同一 jobId 跑兩次：觸發紀錄兩筆、快取命中統計重複、第二次被誤標「快取」；MongoDB 寫入失敗時每次重試都重打 LLM；LLM 供應商故障時，同一台機台同一狀態的多個請求各自重打 LLM（請求數 × 3 次嘗試，全部計費）。

本 feature 的價值：把「完成」改以 lifecycle 通道上的 BullMQ job 回傳值為準、補上結果讀取端點與重連續接、讓 worker 崩潰後的重派在 watchdog 之前發生、並以 jobId 冪等讓重複執行對外只有一個結果與一次計費。性質刻意壓在**不換技術棧**：不實作 Redis Streams，token 串流維持 at-most-once（重連後直接顯示結果、不續播打字機動畫）。

各 User Story 依優先級可獨立開發、獨立驗收，以 phase-by-phase 漸進交付。US3 的鎖參數調小會讓重複執行變常見，**MUST 與 US4 的冪等同批交付**（第三輪報告 §3.2）。

### User Story 1 - 後端完成的診斷，畫面一定看得到結果（Priority: P1）

操作者按下診斷，後端只要完成，畫面就轉為「已完成」並顯示嚴重度、建議動作、可能原因與證據；即使中途 Redis Pub/Sub 訂閱斷了、`ai/done` 沒送到，畫面也從 lifecycle 通道的 `job/status: completed` 拿到同一份結果，不再出現「結果未送達」。`ai/done` 與 `completed` 誰先到都一樣，重複到也只轉一次、只公告一次。

**Why this priority**: 這是使用者看得到的「後端成功、畫面失敗」的主因（第三輪報告 §0 第 3、9 點、AR-5 根治），也是誘發重複計費的入口（使用者對已成功的診斷按重試）。單獨交付即可讓 Pub/Sub 故障不再變成假失敗。故列 P1。

**Independent Test**: 診斷期間以 `CLIENT KILL TYPE pubsub` 每 50 ms 持續斷開 Pub/Sub，確認任務以帶 `result` 的 `job/status: completed` 收尾、畫面轉「已完成」；web 單元測試覆蓋三種到達順序與 `ai/done` 重複。不需 GET 端點或重連續接就位（情境 3 的 GET 退路依賴 US2；US2 未就位時退回現行「結果未送達」）。

**Acceptance Scenarios**:

1. **Given** 診斷進行中、Redis Pub/Sub 訂閱在完成前斷線且 WS 未斷，**When** worker 完成，**Then** 畫面以 `job/status: completed` 帶的結果轉為「已完成」，嚴重度、建議動作、可能原因、證據與「快取」標記都正確，不出現「結果未送達」。
2. **Given** `ai/done` 與 `job/status: completed` 以任意順序抵達、或 `ai/done` 抵達兩次，**When** 畫面處理這些事件，**Then** 只轉一次「已完成」、螢幕閱讀器只公告一次、耗時只結算一次，結果與 `cached` 與先到者一致。
3. **Given** `job/status: completed` 沒有帶結果（舊版 worker、或回傳值驗證失敗），**When** 2 秒內等不到 `ai/done`，**Then** 畫面先以 GET 取回結果；GET 也取不到才顯示「結果未送達」。

---

### User Story 2 - 重連或 api 重啟後，續接原本的診斷（Priority: P1）

網路閃斷或 api 重啟後，瀏覽器重新連上並通過授權，原本進行中的診斷接著跑完、結果照常送到新連線；已在斷線期間完成的，直接顯示結果（不續播打字機動畫）；真的取不回時說明原因並提供重試。同一個診斷開在兩個視窗時，原視窗仍在線就不搶走它。

**Why this priority**: 結果已落庫卻取不回（第三輪報告 §5.4、ADR-002 §6.2 更正段）是「每次斷線都要重新診斷、可能多付一次 LLM」的直接原因；與 US1 合起來才算「後端完成的結果一定回得到畫面」。故列 P1。

**Independent Test**: 串流中 `docker compose restart api`，client 以新連線授權後帶新 socketId 呼叫 `GET /diagnoses/:jobId?socketId=`，分別驗證 job 已完成（200 completed＋result）與仍進行中（200 waiting／active 且 `rebound: true`，之後收到 `completed`；e2e 以「先停 worker 讓 job 停在佇列、再重啟 api」重現，因 fake 串流約 10 s 短於 api 冷啟動，見 research P18；active 狀態的改綁由 api 單元測試與 e2e 場景 8 的 `previousSocketId` 覆蓋）；另以 curl／e2e 驗 404、409、400。不需 US3、US4 就位。（checklist 階段修正 2026-10-21：原寫「200 active」，與 e2e 實際重現方式不一致。）

**Acceptance Scenarios**:

1. **Given** 診斷進行中，**When** api 重啟、瀏覽器重新連上並通過授權，**Then** 前端以新連線呼叫 `GET /diagnoses/:jobId?socketId=`：job 已完成 → 直接顯示結果；仍在進行 → 任務改綁到新連線，後續進度與結果照常送達；查無此 job → 顯示「連線中斷期間的診斷結果已無法取回，請重試」並提供重試。
2. **Given** 設了 `WS_AUTH_SECRET`，**When** 重連，**Then** 前端在授權成功（`machine/subscribed`）之後才 GET；授權完成前任務維持進行中並顯示「已重新連線，正在取回診斷狀態…」，不因授權尚未完成而被判中斷。
3. **Given** 原本發起診斷的連線仍在線，**When** 另一條連線以同 jobId GET 一個進行中的任務，**Then** 回 409、不改綁，畫面顯示「這個診斷正由另一個視窗接收，請在該視窗查看或重試」；**When** 另一條連線 GET 一個已完成的任務，**Then** 照常回結果（jobId 即存取憑證）。

---

### User Story 3 - worker 崩潰時不被誤判失敗（Priority: P2）

worker 在診斷途中被強制終止並由監督者重啟時，畫面持續顯示「進行中」，並說明「後端處理程序中斷，任務已重新排入佇列（第 N 次執行）」；任務重新派送後完成，期間不在 45 秒時轉失敗。等待同簽章其他請求完成時，畫面也持續收到進度。worker 連續中斷超過允許次數，才以明確文案轉失敗。

**Why this priority**: 現況 worker 崩潰後約 92 秒零事件，watchdog 先判失敗、使用者按重試後才發現原任務其實跑完（AR-S7）；但它只在 worker 崩潰或長等待時發生，頻率低於 US1、US2。故列 P2。

**Independent Test**: e2e 場景 3 改寫：診斷串流中（與首 token 前各一次）SIGKILL worker 並由 compose 重啟，訊息加收到時間戳，斷言 client 觀察到的最長無事件間隔 < 45 s、任務最終 `completed`；另以 worker 單元測試（fake timer）驗 keepalive 間隔。

**Acceptance Scenarios**:

1. **Given** 診斷串流中 worker 被 SIGKILL 並由監督者重啟，**When** 觀察畫面收到的事件，**Then** 最長無事件間隔 < 45 秒，任務被重新派送後完成，期間不轉失敗。
2. **Given** 任務被重新派送（`job/status: waiting`＋`reason: "stalled"`），**When** 檢視面板，**Then** 顯示「後端處理程序中斷，任務已重新排入佇列（第 N 次執行）」說明、處理步驟重新開始、嘗試次數正確，不無預警地從 60％ 跳回 0。
3. **Given** 任務在等待同簽章的其他請求完成（取不到去重鎖），**When** 等待持續，**Then** 至少每 10 秒有一次進度事件，45 秒 watchdog 不觸發。
4. **Given** worker 連續中斷超過允許次數（`maxStalledCount` 用盡），**When** 任務轉為 failed，**Then** 面板顯示「後端處理程序多次中斷，診斷已停止，請重試」並提供重試。

---

### User Story 4 - 同一請求被重跑時，不重打 LLM、不重複記錄（Priority: P2）

系統擁有者希望同一個 jobId 不論被重跑幾次（Redis 停頓後的 stalled 重派、寫庫失敗的重試、寫觸發紀錄失敗的重試），都只打一次 LLM、只留一筆觸發紀錄、快取命中率只計一次、「快取」標記正確，讓成本與稽核數字可信；資料庫拒寫時以具體文案告知，而不是誤報為 AI 逾時。

**Why this priority**: 這是成本與稽核正確性（AR-4、WK-4 補強），並且是 US3 縮短鎖期限的前提——鎖變短後 Redis 卡頓超過 15 秒就會雙重執行。使用者看得到的影響（誤標快取、錯誤文案）次於 US1、US2。故列 P2，且 MUST 與 US3 同批交付。

**Independent Test**: e2e 以 `docker compose pause redis` 在診斷中停頓 50 秒後 unpause，查 Mongo `diagnosisTriggers` 與 worker 日誌；worker 單元測試以 fake repo 模擬 `diagnoses` 拒寫與 trigger 寫入失敗，計數 LLM 呼叫次數。

**Acceptance Scenarios**:

1. **Given** 診斷進行中 Redis 停頓 50 秒（超過鎖期限、job 被重派），**When** 任務完成，**Then** 該 jobId 的觸發紀錄只有一筆、LLM 呼叫只有一次、快取命中統計只計一次、畫面結果不被標「快取」。
2. **Given** MongoDB 拒絕寫入診斷，**When** 重試用盡，**Then** LLM 只被呼叫一次，最終以 `persist_failed` 錯誤碼通知畫面，顯示「診斷結果無法寫入資料庫，請稍後重試」（不顯示 MongoDB 原始錯誤、不被誤報為 AI 逾時、不被吞成籠統的「診斷失敗」）。
3. **Given** 寫入診斷後、寫入觸發紀錄前失敗而重試，**When** 重試完成，**Then** 不重打 LLM、結果不被標「快取」。

---

### User Story 5 - 供應商故障時不放大計費（Priority: P3）

LLM 供應商故障時，同一台機台同一狀態的多個診斷請求不各自重打 LLM：第一個請求失敗後，短時間內的其他同簽章請求直接拿到相同的錯誤分類，也不消耗 `AI_RPM` 額度；供應商恢復後新請求照常運作。

**Why this priority**: 只在供應商故障且同簽章多請求並發時發生（WK-13），影響是成本而非畫面正確性。故列 P3。

**Independent Test**: worker 單元測試（fake store、fake timer、fake provider 注入持續錯誤）建立兩個同簽章 job，計數 LLM 呼叫與 `ai-rpm` 計數；另以整合測試驗 `ai-fail:<sig>` 的 TTL 與清除。

**Acceptance Scenarios**:

1. **Given** 兩個同簽章的請求、供應商持續回錯誤，**When** 兩個請求都結束，**Then** 合計 LLM 呼叫次數 ≤ 4（現況 6），第二個請求收到與第一個相同的錯誤碼，且不因第二個請求增加 `AI_RPM` 計數。
2. **Given** 供應商恢復，**When** 失敗標記過期（10 秒）或持鎖者重試成功（標記被清除），**Then** 新請求正常呼叫 LLM 或命中快取。

---

### User Story 6 - 嘗試次數與執行次數可見（Priority: P3）

評估者在面板上看到的「嘗試 N / 3」在重試、重派、等待、快取命中時都正確；stalled 重派時串流文字清空、從新一次執行重新開始，讓人看得懂 BullMQ 的重試與重新派送是怎麼運作的。

**Why this priority**: 屬可見性與 demo 敘事（WEB-20 的 attempt 部分），不影響結果正確性。故列 P3。

**Independent Test**: web 單元測試以 `job/status` 帶 `attempt`／`execution` 的事件序列驅動 reducer，確認「嘗試」推進與 `execution` 遞增時清空串流；e2e 場景 3 斷言重派後 `execution` 遞增。

**Acceptance Scenarios**:

1. **Given** 任務進入第 2 次嘗試（BullMQ 重試），**When** 收到帶 `attempt: 2` 的 `job/status`，**Then** 面板顯示「嘗試 2 / 3」，即使該次嘗試尚無 `ai/token`（等待中或快取命中）。
2. **Given** 任務被 stalled 重派，**When** 收到更大的 `execution`，**Then** 串流文字清空並在「原始串流」收合區呈現新一次執行；`attempt` 不變。
3. **Given** `execution` 因 BullMQ 重試或限流延後而遞增（`reason` 不是 `"stalled"`），**When** 檢視面板，**Then** 只清空串流，不顯示「重新排入佇列」說明。

---

### Edge Cases

- **`ai/done` 重複抵達**：stalled 重派或重試的再執行每次成功都會再送一則 `ai/done`（同一個結果）。畫面以第一個完成為準，之後同 jobId 的 `ai/done`、`completed` 與 GET 結果一律忽略；不新增畫面、不重複公告。
- **`completed` 不帶 `result`**（舊版 worker 滾動升級、或 `returnvalue` 驗證失敗）：relay 照送不帶 `result` 的 `completed` 並記 warn；web 等 2 秒寬限、先 GET 一次，GET 回 completed 即完成，否則才轉「結果未送達」。
- **GET 在 1 小時之後回 404**：快取命中的 job 不寫 `diagnoses`，`returnvalue` 隨 `removeOnComplete`（1 h）消失，之後 GET 回 404，畫面顯示「連線中斷期間的診斷結果已無法取回，請重試」。接受：重連續接的時間尺度是秒到分鐘；寫進 `PRODUCT.md` 已知產品限制。LLM 路徑的結果在 `removeOnComplete` 後仍可由 Mongo `diagnoses` 取回。
- **原綁定仍在線時另一條連線 GET**：進行中的任務回 409、不改綁（畫面「這個診斷正由另一個視窗接收…」）；已完成或已失敗（含 10 s 終態寬限內）照常回結果、不 rebind。
- **同一分頁重連時舊連線尚未被伺服器回收**（代理裁決第 17 條）：網路閃斷（換 Wi-Fi、睡醒）後，瀏覽器以 pong 逾時或 `online` 事件立刻重連，伺服器端要等心跳回收（`WS_HEARTBEAT_MS` 預設 15 s，上限約 30 s）才知道舊連線已死。重連 GET 帶 `previousSocketId`（該任務最後一次成功綁定的 socketId），原綁定等於它時視同已離線、改綁到新連線，不回 409；舊連線不主動終止，交給心跳回收。另一個視窗拿不到本分頁的 socketId（只經 `system/connected` 送給連線本身），兩個視窗不互搶的規則不變。
- **重新整理頁面或關分頁再開**（代理裁決第 19 條，不在範圍）：web 不持久化進行中的 jobId，重新整理後面板回到未診斷狀態；後端照常跑完並寫快取。同機台同狀態再按「診斷」以新 jobId 命中快取（`AI_CACHE_TTL_SECONDS` 預設 600 s 內）或等待同簽章的去重鎖，不多打 LLM；狀態已改變則是新的一次診斷。寫進 `PRODUCT.md` 已知產品限制。
- **重連續接後以 `ai/done` 收尾**（代理裁決第 20 條）：斷線期間的 `ai/token` 不補送，串流中間缺一段；執行期間經歷過重連的任務一律標「原始串流（不完整）」，即使串流其實完整（例如重連發生在首 token 前）也標——寧可多標不漏標。
- **重連 GET 回 `failed` 且原因是寫庫失敗**（代理裁決第 18 條）：GET 與 `job/status: failed` 只帶 `failedReason` 原文、沒有錯誤碼；`persist_failed` 的 `failedReason` 為含 `persist_failed` 字樣的固定英文句，web 據此顯示「診斷結果無法寫入資料庫，請稍後重試」，不露出 MongoDB 原始錯誤。
- **GET 查詢期間任務剛好完成**：GET 在任何 await 前先暫定綁定，查到 active 時保留綁定，因此查詢與綁定之間抵達的 `completed` 仍送得到新連線；查到終態時撤回暫定綁定（只撤回本次請求自己做的動作）。
- **api 重啟期間錯過的 `completed`**：QueueEvents 在 api 重啟後從 `$` 開始讀、錯過重啟期間的事件；由重連後的 GET 補回（同一 api 行程內的 Redis 斷線則由 Stream 續讀補回，不遺失）。
- **Redis 停頓 > `AI_DEDUPE_LOCK_SECONDS`（預設 45 s；e2e 為 20 s）且落在 LLM 串流中**（殘餘風險）：停頓超過 `AI_DEDUPE_LOCK_SECONDS`（預設 45 s；e2e 為 20 s）且正好落在 LLM 呼叫期間時，第二次執行可能在第一次寫入快取前取得 `ai-lock`、再打一次 LLM。罕見（兩條件同時成立），記為殘餘風險，不加第二把鎖（第二把鎖存在同一個 Redis，會在同一次停頓裡一起過期）。
- **Pub/Sub 斷線＋worker 在串流中被 SIGKILL**（殘餘風險，代理裁決第 14 條）：串流期間 keepalive 由 `ai/token` 重設，token 送不到畫面時最長無事件約 30＋15＋10＝55 s，會先觸發 45 s watchdog；watchdog 先 GET，重派完成後仍可由 GET 或重試取回結果。單一故障的上界仍為 35 s。
- **MongoDB 拒寫 `diagnoses`**（validator、磁碟滿、LLM 期間重啟）：結果先暫存 `ai-result:<jobId>`（1 h），每次重試只重做寫庫、不重打 LLM；重試用盡以 `persist_failed` 收尾。快取（`ai-cache:<sig>`）只在 `diagnoses` 寫入成功後才寫，維持「快取有值就代表已落庫」。
- **`failed` 先於 `ai/error` 抵達 api**：`failed` 終態保留 10 s 綁定寬限，寬限內抵達的具體 `ai/error`（`persist_failed`、`provider_error` 等）仍送到原連線，畫面顯示具體文案而非籠統的 `worker_failed`（web 先收到哪一則都一樣：api 補送的 `ai/error(worker_failed)` 與 `failed` 都帶 `failedReason` 原文，由 `humanizeError` 對映，research P14）。寬限內同 jobId 的 POST 回 409（與綁定已刪時查到既有 job 的 409 相同，POST 無新行為）。
- **`maxStalledCount` 用盡**：BullMQ 以英文 `failedReason`「job stalled more than allowable limit」轉 failed；web 對映為「後端處理程序多次中斷，診斷已停止，請重試」，不照顯英文原文。
- **限流延後或 BullMQ 重試造成 `execution` 遞增**：`execution`（`attemptsStarted`）在重試與限流延後時也會遞增；畫面只清空串流、不顯示「後端處理程序中斷」說明（只看 `reason: "stalled"`），避免把供應商錯誤後的重試誤標為處理程序中斷。
- **Redis 卡頓超過 15 s 但 worker 沒死**：lock 過期觸發 stalled 重派、同 jobId 雙重執行；由 jobId 冪等吸收（同一結果、一筆 trigger、一次 hit／miss），`maxStalledCount` 2 留一次額度給真正的崩潰。
- **job 被 `removeOnComplete` 清掉後同 jobId 再 POST**（API-16）：重新入列後 processor 開頭以 jobId 查到既有結果，直接回舊結果、不打 LLM，語意正是「同 jobId＝同一個請求」。
- **`ai-fail` 標記是自己寫的**：持鎖者自己的重試看到標記的 `jobId` 等於自己時忽略，才能真的再試一次；供應商只抖 1～2 s 時，同簽章等待者會在 10 s 內直接拿到同一個錯誤（接受的代價）。
- **watchdog 觸發時任務其實仍在跑**（keepalive 失效或牆上時鐘往前跳）：GET 回 active／waiting，維持「進行中」、重設 watchdog、記一則 console 警告，不轉失敗。
- **重連 GET 遇到網路錯誤或 nginx 429**：轉失敗「連線中斷，請重試」；GET 走獨立的 60 r/m 桶，5 台同時重連加上退路 GET 不會擠掉使用者接著按的「重試」POST。
- **未設 `WS_AUTH_SECRET`**：授權即時完成，重連後仍以 `machine/subscribed` 為 GET 的觸發點，行為一致。
- **重連後授權失敗**（token 錯誤或過期；checklist 階段依 FR-016、FR-022 推導補記，2026-10-21，待覆核）：續接 GET 不會發出，任務維持「已重新連線，正在取回診斷狀態…」，由 45 s watchdog 承接（GET 以 409 `socket_unauthorized` 失敗 → 「超過 45 秒沒有收到進度，結果未知，請重試」）。不為此新增立即失敗的分支。
- **舊新版本混跑**（滾動升級；research R12）：舊 web＋新 api 行為同 2.1.0（新欄位被略過）；新 web＋舊 api 的 GET 回 404，退回「結果未送達」／「連線中斷期間的診斷結果已無法取回」；新 api＋舊 worker 見上方「`completed` 不帶 `result`」；舊 api＋新 worker 時 progress 物件不被舊 relay 認得、進度條退化為不確定進度。因此升級順序 MUST 為**先 api、後 worker**（web 不限），寫進 `CHANGELOG.md` 相容性注意（FR-034）；一鍵 demo 同時重建，不受影響。（checklist 階段補 2026-10-21。）

## Requirements *(mandatory)*

### Functional Requirements

**完成語意（US1、US6）**

- **FR-001**: worker 每個成功的執行（LLM 路徑、快取命中路徑、jobId 冪等命中路徑）MUST 以 BullMQ `returnvalue` 回傳 `{ result, cached }`（contracts 傳輸型別 `DiagnosisJobReturnValue`），`result` MUST 為已通過 `DiagnosisResultSchema` 的結果。（US1；SC-002）
- **FR-002**: api 的 job-status relay 收到 `completed` 事件時 MUST 以 `DiagnosisJobReturnValue` schema `safeParse` 其 `returnvalue`；通過時送 `job/status { status: "completed", result, cached }`，並帶上（已知時）`attempt`、`execution`；驗證失敗或缺值時 MUST 照送不帶 `result` 的 `completed` 並記 warn，MUST NOT 轉發未驗證物件。（US1 情境 3；SC-002；憲章 V）
- **FR-003**: worker MUST 維持送出 `ai/done`，且維持「先落地後宣告」順序：trigger → `updateProgress(100)` → `ai/done` → return；`ai/done` 的定位為 best-effort 提前通知，可重複、可遺失，權威完成為帶 `result` 的 `job/status: completed`。（US1；SC-010）
- **FR-004**: web MUST 以三個完成來源中最先到者收尾：`ai/done`、帶 `result` 的 `job/status: completed`、GET 回 `completed`；之後到的同 jobId 結果 MUST 忽略；耗時 MUST 只結算一次、螢幕閱讀器公告 MUST 只一次。四種情況（`ai/done`→`completed+result`、`completed+result`→`ai/done`、`completed` 無 result→GET→遲到 `ai/done`、`ai/done` 重複兩次）MUST 收斂到相同的 completed 狀態（`result`、`cached`、`jobId` 相同）。（US1 情境 2；SC-006）
- **FR-005**: `completed` 不帶 `result` 時，web 在 2 秒未送達寬限到期時 MUST 先 GET 一次；GET 回 completed 即完成；GET 回 failed 即依 `humanizeError(error)` 轉失敗（與 FR-022 的 watchdog 退路同一規則，此失敗不屬「結果未送達」、不可被救回）；其餘（waiting／active、404、409、503、429、網路錯誤、回應格式不符）才轉「結果未送達」失敗（文案不變；analyze 階段修正 2026-10-21）。已轉「結果未送達」之後，同 jobId 的結果（`ai/done`、帶 `result` 的 `completed`、GET 回 completed）再抵達時 MUST 救回為「已完成」；其他失敗態（`ai/error`、`failed`）MUST NOT 被覆蓋。（US1 情境 3；SC-006；ADR-003 代理裁決第 15 條）
- **FR-006**: 面板「嘗試 N / 3」MUST 由 `job/status.attempt` 推進（`ai/token` 的 attempt 判斷保留、換輪清空邏輯不變）；收到更大的 `execution` 時 MUST 清空串流文字（`seq <= lastSeq` 判斷保留為備援）；`execution` 遞增本身 MUST NOT 觸發「重新派送」說明（只看 `reason: "stalled"`）。（US6；US3 情境 2）

**結果讀取與 rebind（US2）**

- **FR-007**: api MUST 提供 `GET /diagnoses/:jobId?socketId=[&previousSocketId=]`；`jobId`、`socketId` 與 optional 的 `previousSocketId` 皆以 UUID 驗證，不符 MUST 回 400（只回 issue 路徑與代碼，比照 POST）。`previousSocketId` 為呼叫端分頁上一次成功綁定此任務的 socketId，只用於 FR-009 的改綁判斷（代理裁決第 17 條）。（US2；SC-005）
- **FR-008**: `socketId` 不是在線且已授權的連線時 MUST 回 409（訊息與 POST 相同），body 另帶機器可讀 `code: "socket_unauthorized"`，與 FR-010 的 `job_bound_elsewhere` 區分，讓 web 不把「連線未授權」誤顯示成「正由另一個視窗接收」（research P2；POST 的 409 body 不變；checklist 階段補 2026-10-21）。（US2；SC-005）
- **FR-009**: GET MUST 在任何 await 之前於 `JobRoutingRegistry` 完成暫定綁定（先綁定後查詢）：綁定不存在 → 暫定建立指向本 socketId；綁定已標記終態（10 s 寬限中）→ 不動、視為終態；原綁定連線已離線 → 暫定改綁並記下原綁定以便撤回；原綁定仍在線但等於請求的 `previousSocketId`（同一分頁重連、舊連線尚未被心跳回收）→ 比照「已離線」暫定改綁並記下原綁定，MUST NOT 主動終止舊連線；綁定等於本 socketId → 不動；原綁定仍在線、不等於本 socketId 也不等於 `previousSocketId` → 不動、記為「衝突」待查詢結果決定。（US2 情境 1、3；SC-003、SC-005；代理裁決第 17 條）
- **FR-010**: GET 的查詢順序 MUST 為 BullMQ（`Job.fromId` 的 state 與 `returnvalue`）→ Mongo `diagnoses.findOne({ jobId })` → 404，並依結果處理綁定：
  - completed → 驗 `returnvalue` 後 200 `{ status: "completed", result, cached }`，撤回暫定動作（不 rebind）；衝突者照常回。
  - failed → 200 `{ status: "failed", error }`（`error` 為 `failedReason`），撤回暫定動作；衝突者照常回。
  - waiting／delayed／active／prioritized／waiting-children → 衝突者 409（`code: "job_bound_elsewhere"`，「此診斷仍綁定在另一條連線」）、不改綁；其餘保留暫定綁定，200 `{ status: "waiting" | "active", progress?, attempt?, execution?, rebound: true }`。未列於本 FR 的 state（例如 `getState` 回 `unknown`）MUST 視同查無 job，走下一點（analyze 階段補 2026-10-21）。
  - job 不存在 → Mongo 有則 200 completed（`cached: false`），無則 404；兩者皆撤回暫定動作。
  - Redis 或 Mongo 不可用、或 BullMQ 查詢超過 5 s 或 Mongo 查詢超過 3 s（合計上限 8 s）→ 503（「診斷狀態暫時無法查詢，請稍後再試」），撤回暫定動作；GET MUST NOT 無上限等待依賴恢復（research P4；checklist 階段補 2026-10-21；逾時拆分於 analyze 階段修正 2026-10-21）。
  - 撤回 MUST 只針對本次請求自己做的暫定動作，MUST NOT 刪除別人建立的綁定。（US2；SC-003、SC-005）
- **FR-011**: GET 的授權模型 MUST 為「jobId 即 bearer capability」：持有在線、已授權連線且知道 jobId 即可讀該 job；已完成（含 `removeOnComplete` 之後由 Mongo 取回）的結果 MUST 對任何已授權連線可讀，包括原綁定仍在線時。（US2 情境 3；SC-005）
- **FR-012**: api MUST 具備 `diagnoses` collection 的唯讀存取（不寫入、不建索引；索引仍由 worker 建立），供 GET 的第二來源使用。（US2；SC-005）
- **FR-013**: GET 回應中的 `result`（不論來自 `returnvalue` 或 Mongo）MUST 經 `DiagnosisResultSchema` 驗證後才回，MUST NOT 回未驗證物件；`returnvalue` 驗證失敗時記 warn 並退到 Mongo 查詢，Mongo 也無合法結果則 404。（憲章 V；SC-005）
- **FR-014**: api MUST 抽出 `JobRoutingRegistry` 持有 jobId ↔ 接收連線的綁定，提供綁定、rebind、終態寬限、刪除與孤兒回收；兩支 relay、`JobsService` 與 GET MUST 經它存取綁定。`completed` 與 `failed` 兩種終態 MUST 共用同一段 10 s 綁定寬限程式（2.1.0 的 `markCompleted`／`COMPLETED_BINDING_GRACE_MS` 一般化）；寬限內同 jobId 的 POST 維持回 409；寬限內 GET 依 FR-009 視為終態。（US2；US4 情境 2；SC-008）
- **FR-015**: nginx MUST 為 GET 新增獨立 regex location `^/diagnoses/[0-9a-fA-F-]{36}$` 與限流區 `diag_read`（`rate=60r/m`、`burst=10 nodelay`、`limit_req_status 429`），沿用 `/diagnoses` 的 `proxy_pass` 寫法且 MUST NOT 寫 `add_header`（以繼承 server 層安全 header）；POST 維持既有 10 r/m、burst 5 的桶。（US2；Edge Cases）
- **FR-016**: web 的 `onReconnect` MUST 只記下需續接的 active 任務並維持 active（顯示「已重新連線，正在取回診斷狀態…」，不新增 chip 種類），並在該任務上設「執行期間經歷過重連」旗標（收尾時供 FR-038 判斷，任務結束前不清除）；MUST 在連線授權成功（`machine/subscribed`／`onAuthResult(true)`）之後才逐台 GET。web MUST 對每個任務記住最後一次成功綁定的 socketId（POST 送出時的 socketId，或 GET 回 `rebound: true` 時的本次 socketId），所有 GET MUST 以 `previousSocketId` 帶上（代理裁決第 17 條）。GET 回應對映：completed → 完成；failed → 失敗；active／waiting → 留在 active 並重設 watchdog；404、409（依 `code` 區分 `job_bound_elsewhere` 與 `socket_unauthorized`）、503、網路錯誤與 429 → 依 FR-035 文案轉失敗。（US2 情境 1、2；SC-003）
- **FR-017**: web 的診斷 API 模組 MUST 新增 GET 呼叫，回應以契約 schema 驗證，HTTP 狀態碼對映比照既有 `postDiagnose`。（US2；SC-005）

**重派與 keepalive（US3）**

- **FR-018**: worker 的 BullMQ Worker options MUST 設 `lockDuration` 15000 ms、`stalledInterval` 5000 ms、`maxStalledCount` 2（`lockRenewTime` 維持預設 `lockDuration / 2`），寫成具名常數並在 README 說明；keepalive 間隔 10 s 同為具名常數。（US3；SC-001）
- **FR-019**: worker MUST 在每次執行開一個 10 s 閒置計時器，任何對外事件（`updateProgress`、`ai/token` 發布）重設它；到期時 MUST 以 `job.updateProgress(目前里程碑)` 補送一次；範圍涵蓋整個執行（等待去重鎖、首 token 前、寫庫期間）。keepalive MUST NOT 由 api 端合成（api 不知道 worker 是否存活），MUST NOT 新增 WS channel。（US3 情境 3；SC-009）
- **FR-020**: worker MUST 以物件 `{ value, attempt, execution }`（contracts 傳輸型別 `DiagnosisJobProgress`）呼叫 `job.updateProgress`，`attempt` ＝ `job.attemptsMade + 1`、`execution` ＝ `job.attemptsStarted`；relay MUST `safeParse` 後拆成 `job/status { progress: value, attempt, execution }`，數字型 progress（舊版 worker）照舊處理。（US3 情境 2；US6；SC-009）
- **FR-021**: relay MUST 監聽 QueueEvents 的 `stalled` 事件，送 `job/status { status: "waiting", reason: "stalled" }` 到綁定連線。（US3 情境 2；SC-001）
- **FR-022**: web 的 45 s 無進展 watchdog 觸發時 MUST 先 GET 一次：completed → 照常完成並公告；failed → 依 `humanizeError(error)` 轉失敗（與 FR-005 的 2 s 退路同一規則）；仍在進行（waiting／active）→ 維持 active、重設 watchdog、記一則 console 警告；其餘（404、409、503、429、網路錯誤、回應格式不符）→ 轉失敗，文案「超過 45 秒沒有收到進度，結果未知，請重試」（取代「診斷逾時或無回應，請重試」；failed 分支於 analyze 階段補 2026-10-21）。watchdog 維持牆上時鐘。（US3；SC-001）
- **FR-023**: web MUST 把 `failedReason`「job stalled more than allowable limit」對映為「後端處理程序多次中斷，診斷已停止，請重試」。（US3 情境 4）

**冪等與成本（US4、US5）**

- **FR-024**: processor MUST 在 `updateProgress(0)` 之後、建 context 之前，依序以 jobId 查 (i) Redis 暫存 `ai-result:<jobId>`、(ii) Mongo `diagnoses`；命中 (i) 時 MUST 只重做 `diagnoses` 寫入（成功後 DEL 暫存）；命中任一者後 MUST 冪等補寫 trigger（`cached: false`）→ `updateProgress(100)` → 送 `ai/done(cached: false)` → 回傳 `{ result, cached: false }`，MUST NOT 建 context、取鎖或呼叫 LLM。（US4 情境 1、3；SC-004）
- **FR-025**: `diagnosisTriggers` MUST 新增 `{ jobId: 1 }` unique 索引（既有資料衝突時沿用 `ensureUniqueJobIdIndex` 的退回非 unique＋記 error 邏輯）；所有寫入點（快取命中、LLM 路徑、冪等命中、最終失敗 handler）MUST 改為以 jobId upsert（`$setOnInsert`）；一個 jobId MUST 只有一筆（成功或最終失敗，兩者互斥）。（US4 情境 1；SC-004）
- **FR-026**: 快取 hit／miss 統計 MUST 以 jobId 只計一次（`SET ai-metric:<jobId> 1 NX EX 86400` 回 OK 才記）；MUST NOT 以 `attemptsStarted === 1` 判斷（限流延後的再執行也會遞增，會漏記真正打 LLM 的 miss）。（US4 情境 1；SC-004）
- **FR-027**: LLM 成功且結果通過驗證後，worker MUST 先寫 `ai-result:<jobId>`（EX 3600）再寫 `diagnoses`；`diagnoses` 寫入失敗時 MUST 經既有失敗路徑以錯誤碼 `persist_failed`（可重試）送出，只在最終 attempt 送 `ai/error`；寫庫成功後 MUST DEL 暫存；快取 `ai-cache:<sig>` 的寫入 MUST 維持在 `diagnoses` 寫入之後。`persist_failed` 傳給失敗路徑的訊息（即 BullMQ `failedReason` 與 `ai/error.message`）MUST 為含 `persist_failed` 字樣的固定英文句（例如 `persist_failed: diagnosis record could not be written`），MongoDB 原始錯誤 MUST 只進日誌的 `err` 欄位、MUST NOT 進訊息（代理裁決第 18 條）。（US4 情境 2；SC-008）
- **FR-028**: worker MUST 實作同簽章負向標記 `ai-fail:<sig>`（值 `{ code, message, jobId, at }`，`SET … EX 10`）：
  - 寫入：LLM 階段的所有失敗（`provider_error`、`ai_timeout`、`schema_invalid`，含不可重試的安全攔截與截斷）；`no_context`、`persist_failed`、限流延後 MUST NOT 寫。
  - 讀取：等待者每輪輪詢與新 job 取鎖前，且 MUST 在限流 INCR 之前（被擋下的 job 不消耗 `AI_RPM`）；標記的 `jobId` 等於自己時 MUST 忽略。
  - 看到標記：非最終 attempt → 拋出可重試錯誤（交 BullMQ 退避、消耗一次 attempt）；最終 attempt → 送同 code 的 `ai/error`。
  - 清除：持鎖者成功寫入快取時 MUST DEL；否則等 TTL 到期。（US5；SC-007）
- **FR-029**: 同簽章失敗標記命中時，畫面 MUST 沿用既有錯誤分類文案、不加後綴（不需新增 `ai/error` 來源欄位）。（US5 情境 1）

**契約（SC-010）**

- **FR-030**: `job/status` MUST 新增 optional `attempt`（整數 ≥ 1）、`execution`（整數 ≥ 1）、`reason`（開放字串 `z.string()`，文件列舉已知值 `"stalled"`）、`cached`（boolean；`completed` 帶 `result` 時必帶）；`completed` 時填 `result`。新欄位皆為 optional，舊版 client 照常運作。（SC-010）
- **FR-031**: `packages/contracts` MUST 新增跨 process 傳輸型別 `DiagnosisJobReturnValue` 與 `DiagnosisJobProgress`，以 Zod 定義、消費端 `safeParse`（憲章 III 例外 (c)），MUST NOT 在 api／worker 另寫平行型別。（SC-010）
- **FR-032**: `http.ts` MUST 新增 `DiagnosisLookupQuerySchema`（`socketId` 必填、`previousSocketId` optional，皆 UUID）與 `DiagnosisLookupResponseSchema`（以 `status` 區分的 discriminated union：completed／failed／waiting／active），型別由 `z.infer` 推導；400／404／409 錯誤 body 依憲章 III 例外 (b) 不另定 schema，但語意 MUST 記於 `asyncapi.yaml`／`CHANGELOG.md`。此要求由本 spec 規定，不待憲章修訂。（SC-005、SC-010）
- **FR-033**: `asyncapi.yaml` 的 `info.version` MUST 升為 1.4.0；`job/status` 描述 MUST 改為實際行為（`completed` 帶 `result` 與 `cached`，修正 DOC-29 的 "optionally carrying the final result"）；`ai/done` 描述 MUST 改為 ADR-003 D3 的 best-effort 敘述（MAY be delivered more than once、MAY be lost、consumers MUST treat the first completion as final）；`ai/error.code` 的已知值 MUST 補 `persist_failed`；漂移測試與文件版本測試 MUST 通過。（SC-010）
- **FR-034**: `CHANGELOG.md` 契約小節 MUST 記 1.4.0；相容性注意 MUST 記「`ai/done` 可重複、可遺失，自寫 client 須以 jobId 去重」「BullMQ job 的 `progress` 改為物件」「BullMQ lock 參數 15／5／2」「新增 `GET /diagnoses/:jobId`（含 409 的兩種 `code`、503、nginx 獨立 60 r/m 桶）」「`job/status` 新增 optional `attempt`／`execution`／`reason`／`cached`，`completed` 帶 `result`」「升級順序先 api、後 worker（web 不限），反過來時進度條退化為不確定進度」「jobId 與 `previousSocketId` 會出現在 nginx access log 的路徑與 query，能讀 log 的人可讀已完成結果、並可在原連線仍在線時改綁進行中的任務（plan 風險 3，接受）」（後三條為 checklist 階段補，2026-10-21），並把 `[2.1.0]` 帶著發布的 AR-4、AR-S7、WK-13、WK-4 補強、AR-5 根治標為已修（012-lite）。（SC-010）

**前端呈現（US1～US3、US6）**

- **FR-035**: web MUST 依下表落地 UI 文案與位置（依 `apps/web/PRODUCT.md` 與 `apps/web/DESIGN.md`，代理裁決第 10、13 條）：

  | 觸發 | 畫面 | 位置 |
  | --- | --- | --- |
  | `job/status: waiting`＋`reason: "stalled"` | 進度列下說明「後端處理程序中斷，任務已重新排入佇列（第 N 次執行）」；面板 chip 維持「進行中」、卡片 chip 維持「診斷中 N%」；串流清空並在「原始串流」收合區呈現新一次執行。只看 `reason`：`execution` 因重試或限流延後遞增時只清空串流、不顯示這行 | `CopilotDrawer.vue` 進行中區塊 |
  | 重連後、GET 尚未回應 | 維持「進行中」，說明「已重新連線，正在取回診斷狀態…」 | `copilot.store.ts` `onReconnect`（active 上的旗標，不新增 chip kind） |
  | GET 回 completed（重連、2 s 退路、watchdog 退路） | 結果整塊直接出現、不走逐字動畫；完成 meta 可加中性小字「重新連線後取回」；耗時照常顯示但不作為「上一次非快取耗時」的對比基準 | `CopilotDrawer.vue` 完成 meta；`diagnosis-timing.ts` |
  | 以 `job/status`／GET 收尾，或執行期間經歷過 WS 重連（不論收尾來源） | 串流標題「原始串流（不完整）」（與「原始串流（中斷前）」「原始串流」區分） | `StreamDisclosure.vue`／`CopilotDrawer.vue` |
  | `ai/done` 重複 | 不新增；螢幕閱讀器公告只念一次 | — |
  | 45 s watchdog，GET 回 404、409、503、429、網路錯誤或回應格式不符（GET 回 failed 時改依 `humanizeError(error)`；回 waiting／active 時維持進行中） | 「超過 45 秒沒有收到進度，結果未知，請重試」 | `copilot.store.ts` `checkStalls` |
  | 重連 GET 404 | 「連線中斷期間的診斷結果已無法取回，請重試」 | `copilot.store.ts`；`diagnose-api.ts` GET 狀態碼對映 |
  | 重連 GET 409 `code: "job_bound_elsewhere"` | 「這個診斷正由另一個視窗接收，請在該視窗查看或重試」 | 同上 |
  | 重連 GET 網路錯誤、逾時、429、503、409 `socket_unauthorized` 或回應格式不符 | 「連線中斷，請重試」 | 同上 |
  | `failed`：`job stalled more than allowable limit` | 「後端處理程序多次中斷，診斷已停止，請重試」 | `copilot-reducer.ts` `humanizeError` |
  | `ai/error.code = "persist_failed"`，或 `failed`（`job/status`／GET）的原因含 `persist_failed` 字樣 | 「診斷結果無法寫入資料庫，請稍後重試」 | 同上 |
  | 同簽章失敗標記命中 | 沿用既有分類文案，不加後綴 | 同上 |
  | 嘗試 N / 3 | 由 `job/status.attempt` 推進；job meta `<dl>` 維持兩項（佇列、嘗試） | `CopilotDrawer.vue` |
  | 結果未送達（2 s） | 文案不變，只在 GET 退路回 completed、failed 以外的結果時出現（GET 回 failed 時改依 `humanizeError(error)`） | `copilot.store.ts` `checkStalls`；PRODUCT.md |

- **FR-036**: 畫面 MUST NOT 出現「worker」「stalled」字樣（合併門第 1 輪補註 2026-10-22，ADR-003 代理裁決第 56 條：路徑類文字（如 `apps/worker/.env`）與 BullMQ 原文 `failedReason` 不視為違反；禁用的是拿這兩個字當說明用語描述任務狀態）；「停滯」保留給機台資料 10 秒未更新，MUST NOT 用來形容診斷任務；新增術語（重新排入佇列（內部稱重新派送）、取回、結果未知）MUST 補進 `apps/web/PRODUCT.md`。（US3；FR-035）
- **FR-037**: 卡片的診斷 chip（診斷中 N%／AI：嚴重度／AI：嚴重度 · 快取／AI 失敗）MUST NOT 新增種類；重派、取回、重連續接都屬「診斷中」，只在面板內以說明行交代。（US2、US3；DESIGN.md「徽章出現或消失不改變容器高度」）
- **FR-038**: 以 `job/status` 或 GET 收尾的診斷，以及執行期間經歷過 WS 重連（FR-016 的旗標）的診斷（不論收尾來源，含 `ai/done`），「原始串流」標題 MUST 標「原始串流（不完整）」；判斷只看收尾來源與重連旗標，MUST NOT 比對 `seq` 與結果（寧可多標不漏標；代理裁決第 20 條）。（US1、US2；FR-035）

**文件回補（merge 回 `develop` 前 MUST，依 CLAUDE.md「跨 Feature 決策 MUST 回補真實來源」）**

- **FR-039**: merge 前 MUST 完成 `docs/adr-003-completion-semantics.md`（ADR-003）§6 回補清單並同步 ADR-003 本文（消除與本 spec 的矛盾），回補清單至少包括：
  - ADR-002：§3 第 5 列加「已變更（012-lite）」；§6.1 單實例狀態第 4 項改指 `JobRoutingRegistry`；§6.2「生產路徑：改用 Redis Streams」改寫為「已拒絕（ADR-003）」、「更正」段的「沒有讀取端點」標已落地；§6.5「結果讀取與完成語意」列與「api 行程內單實例狀態」列改為已落地；§6.5.1 WK-4 列與「失敗終態沒有 relay 寬限」列標已落地（012-lite 收掉）；§6.5.1 末尾補 012-lite 落地列（AR-4、AR-S7、WK-13、WK-4 補強、AR-5 根治含失敗終態寬限、WK-20、WEB-20 attempt 部分、DOC-29）。
  - README：「已知限制」四條（重連不 rebind、沒有讀取端點、92 秒靜默、at-most-once）與「第三輪審查的現況」條改寫；資料表 `diagnoses`「目前只寫不讀」改寫、`diagnosisTriggers` 補 jobId unique、Redis 職責補 `ai-fail:*`／`ai-result:*`／`ai-metric:*`；契約版本字串 1.3.0 → 1.4.0；nginx GET 獨立限流桶；BullMQ 參數具名常數說明；「已知限制」補 jobId 與 `previousSocketId` 進 nginx access log 的曝險（checklist 階段補，2026-10-21）。
  - `apps/web/PRODUCT.md`：「已知產品限制」改為「AI token 串流 at-most-once（重連後不續播動畫，直接顯示結果）、快取命中的結果 1 小時後無法以 GET 取回、重新整理頁面後不續接進行中的診斷（再按一次診斷會命中快取或等待同簽章的去重鎖）、Mock 頻率控制無後端作用」（代理裁決第 19 條）；README「已知限制」同步補「重新整理頁面後不續接」一條；失敗語意段改寫為 2 s 退路先 GET；新增術語。
  - `tests/e2e/README.md` 場景 3 的現況語意與「注意」段（GET 獨立限流桶、新增故障場景與耗時）。
  - 指南：§15.7 012-lite 藍圖（DOC-16）落地後狀態改「已落地」；§15.5「Redis Streams token 回放」候選方向標「已拒絕（ADR-003）」；§15.6「e2e 實測發現（留給 012-lite）」條加已落地註記；§15.6 現況摘要補 012-lite；§16.3 第 6 列「目前無結果讀取端點」與 §17「streaming 推不到前端」列的「重連後舊 jobId 不會改綁」改寫（後兩項取自 plan「文件回補」，checklist 階段補，2026-10-21）。
  - `asyncapi.yaml` 與 `CHANGELOG.md`（見 FR-033、FR-034）。
  - repo `CLAUDE.md` 開頭現況段：落地後改為最近一次完成的 feature。
  回補 MUST 不重寫歷史：原敘述保留、改過去式並標「已落地／已變更，現況見 ADR-003」。（SC-010）
- **FR-040**: ADR-003 檔頭與 §7 的「代理裁決、待覆核」註記 MUST 保留到使用者覆核為止；覆核若有推翻，MUST 於 ADR-003 §7 記推翻紀錄並以 fix 分支修正 spec 與實作。plan 與 analyze 階段自行決定的設計點（`research.md` P1～P25）MUST 在 merge 前補進 ADR-003 §7（第 22 條起，同樣標「待覆核」），不得只留在 research（checklist 階段補，2026-10-21；依 plan「文件回補」）。
- **FR-041**: 本 feature MUST NOT 自動執行 `/speckit-constitution`；憲章 Principle III 補列 `GET /diagnoses/:jobId`（PATCH 1.6.0 → 1.6.1）為**建議**，待使用者確認；merge 前若仍未確認，ADR-003 與本 spec MUST 保留「建議修訂、待使用者」的註記，GET 的 Zod 定義（FR-032）照做。

**不變量與驗收基礎建設（全 feature）**

- **FR-042**: 憲章 IV 的雙通道分流 MUST 維持：結果經 BullMQ QueueEvents（lifecycle 通道）送出、AI token 經 Redis Pub/Sub；worker MUST NOT 直接 emit WebSocket；MUST NOT 實作 Redis Streams token 回放。
- **FR-043**: 憲章 VII MUST 維持：診斷結果仍持久化於 Mongo `diagnoses`（LLM 路徑），新增的 Redis 鍵（`ai-result:*`、`ai-fail:*`、`ai-metric:*`）皆為帶 TTL 的暫態用途。
- **FR-044**: 既有 e2e 場景 1／2／4a／4b MUST 照過；`pnpm test:coverage` 全域與十個核心檔逐檔門檻（`vitest.config.ts`）MUST 照過；硬規則 1（token 不逐筆寫 reactive 的既有範圍）MUST NOT 惡化。（SC-011）
- **FR-045**: 新增或修改的邏輯 MUST 各有單元測試：worker（回傳值形狀、jobId 冪等短路、trigger 冪等、hit／miss 只計一次、`ai-fail` 寫讀與忽略與清除、`persist_failed`（含訊息不夾帶原始錯誤）、keepalive 計時）、api（`completed` 讀 `returnvalue` 的合法／不合法／缺值、`stalled` 轉發、attempt／execution 轉發、`JobRoutingRegistry` 的 rebind 與終態寬限與孤兒回收、GET 的 200 三種狀態與 400／404／409 與 Mongo 退回與先綁定後查詢、`previousSocketId` 等於在線原綁定時改綁而不回 409）、web（三種到達順序收斂、onReconnect 授權後 GET 的各回應、GET 帶 `previousSocketId`、重連旗標使 `ai/done` 收尾也標「不完整」、`reason: "stalled"` 文案、GET 錯誤對映、`failed` 原因含 `persist_failed` 的文案對映）。（SC-005～SC-009）
- **FR-046**: e2e harness MUST 為收到的訊息加時間戳（計算最長無事件間隔）、提供 GET helper 與「斷線後建新連線、訂閱、帶新 socketId GET」的流程、Pub/Sub 斷線迴圈 helper、以及查 Mongo `diagnosisTriggers` 筆數與計數 LLM 呼叫的方法；Redis 停頓 MUST 用 `docker compose pause redis`／`unpause`。快取 hit／miss「只計一次」的量測 MUST 用 worker 既有的 `cache.hits + cache.misses` 計數（即 `system/metrics` 的 `worker.cache` 來源），不為此新增欄位；這組計數是每個 `METRICS_INTERVAL_MS` 窗結算後歸零的窗內值，且 Redis 停頓期間的快照寫不進 Redis、會被下一窗覆蓋，因此 MUST 以 worker 每窗一則的 `worker metrics summary` 日誌（結算時先記日誌、再寫 Redis）加總場景期間各窗的值，不取 `system/metrics` 前後兩次快照相減；場景 MUST 在 POST 前等到一個窗界，避免前一場景的計數混進同一窗（e2e 把 `METRICS_INTERVAL_MS` 設為下限 5000）；全套 e2e 循序執行，場景期間沒有其他 job（analyze 階段補 2026-10-21）。（SC-001～SC-005）
- **FR-047**: 新增路徑 MUST 依 `specs/009-observability-baseline/contracts/log-fields.md` 記結構化日誌（`jobId`、`sig` 等關聯鍵為欄位、不串進 `msg`；等級依該文件 §4）：jobId 冪等短路命中（info，帶來源 `ai-result` 或 `diagnoses`）、`ai-fail` 寫入（info，帶 `sig`、`code`）與命中（warn，帶 `sig`、`code`）、`persist_failed`（沿用失敗路徑既有的重試中 warn／最終 error）、relay 轉發 `stalled`（warn）、GET 的 rebind 與衝突 409（info）。keepalive 補送 MUST NOT 逐次記日誌（比照該文件 §9 高頻路徑）。`system/metrics`／`WorkerMetrics` MUST NOT 為本 feature 新增欄位；e2e 以既有每次 LLM 呼叫一則的 `LLM call` info 日誌計數 LLM 呼叫（代理裁決第 21 條）。（SC-004、SC-007、SC-008）

### Key Entities

- **診斷任務（Diagnosis Job）**：一次診斷請求，以前端產生的 `jobId`（UUID v4，idempotency key）為身分，亦為 BullMQ job id。屬性：狀態（waiting／delayed／active／completed／failed）、`attempt`（`attemptsMade + 1`，與 `ai/*` 的 attempt 同義）、`execution`（`attemptsStarted`，涵蓋重試、stalled 重派、限流延後，單調遞增）、`result`（通過 `DiagnosisResultSchema` 的診斷結果）、`cached`（是否命中簽章快取）、`reason`（重回 waiting 的原因，已知值 `stalled`）。`returnvalue` 保留 1 h（`removeOnComplete`）、失敗保留 24 h（`removeOnFail`）。
- **綁定（Job Routing Binding）**：jobId ↔ 接收該 job 事件的 WS 連線（clientId），由 `JobRoutingRegistry` 持有於 api 行程內（單實例）。屬性：目前接收連線、是否已達終態與終態時間（10 s 寬限）、建立時間（孤兒回收）。可在原連線離線、綁定不存在，或原連線等於請求帶的 `previousSocketId`（同一分頁重連、舊連線尚未被心跳回收）時 rebind 到新連線；web 端對應記住每個任務最後一次成功綁定的 socketId。
- **結果暫存（Per-job Result Stash）**：`ai-result:<jobId>`，LLM 成功後、`diagnoses` 寫入成功前的結果副本（EX 3600），讓寫庫失敗的重試只重做寫庫；寫庫成功即刪除。
- **失敗標記（Negative Cache Marker）**：`ai-fail:<sig>`，同簽章（同機台同狀態同 prompt／model）最近一次 LLM 階段失敗的 `{ code, message, jobId, at }`，TTL 10 s；持鎖者成功寫快取時刪除。
- **觸發紀錄（Diagnosis Trigger）**：`diagnosisTriggers` 中每個 jobId 恰一筆的稽核紀錄（成功含 `cached`，或最終失敗），以 jobId unique 與 upsert 保證冪等；TTL 30 天不變。
- **診斷結果紀錄（Diagnosis Record）**：`diagnoses` 中 LLM 路徑的持久化結果（jobId unique），012-lite 起由 api 唯讀作為 GET 的第二來源；快取命中的 job 不寫此表。
- **計數去重標記（Metric Once Marker）**：`ai-metric:<jobId>`（`SET NX EX 86400`），保證快取 hit／miss 每個 jobId 只計一次。

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: worker 在串流中與首 token 前各被 SIGKILL 一次後，操作者畫面（e2e client）觀察到的**最長無事件間隔 < 45 秒**（設計上界 35 秒），任務最終完成、無 `ai/error`；Pub/Sub 同時斷線的複合故障（最長約 55 秒）已接受，不在本判準內。驗證：e2e 場景 3 改寫（訊息加收到時間戳、斷言最大間隔、記錄 worker 冷啟動時間）。
- **SC-002**: 診斷期間 Pub/Sub 每 50 ms 被斷開一次（`CLIENT KILL TYPE pubsub` 迴圈），任務仍以帶 `result` 的 `job/status: completed` 收尾，`result` 通過 `DiagnosisResultSchema`，畫面直接轉為已完成、不經「結果未送達」。驗證：新 e2e 場景。
- **SC-003**: 診斷期間重啟 api（`docker compose restart api`），重連後以新 socketId GET：job 已完成 → 200 completed＋result；仍進行 → 200 waiting 或 active 且 `rebound: true`，之後新連線收到 `completed`；兩種情況都在 api healthy 後 60 秒內完成。驗證：新 e2e 場景 6a（串流中重啟、期間完成）與 6b（先停 worker 讓 job 停在佇列，research P18）；active 狀態的改綁由 api 單元測試覆蓋。（checklist 階段修正 2026-10-21：原寫「仍進行 → 200 active」，e2e 實際重現的是 waiting。）
- **SC-004**: 診斷中 Redis 停頓 50 秒（`docker compose pause redis` 後 unpause）：該 jobId 的觸發紀錄恰 1 筆、LLM 呼叫恰 1 次、快取 hit／miss 合計恰 1 次、最終完成結果的 `cached` 為 false；且場景 MUST 斷言停頓確實造成重派（client 收到該 jobId 的 `job/status` `reason: "stalled"`，或 `execution ≥ 2`），沒有重派的執行視為「未重現 AR-4」而非通過，MUST NOT 放寬判準讓它綠燈（ADR-003 代理裁決第 6 條的顧慮；checklist 階段補 2026-10-21）。驗證：新 e2e 場景（查 Mongo 與 worker 日誌；LLM 呼叫以 `LLM call` 日誌計數，見 FR-047；hit／miss 以 FR-046 的窗內計數加總）。場景 7 的停頓 MUST 在 exec1 收到首 token 之後才開始（以第 3 個 `ai/token` 為觸發點）：token 發布不等 Redis 回應，exec1 會在停頓期間跑完 LLM 串流、停在 `report(80)`；恢復後它排在前面的 SET `ai-result` 先於 exec2 的冪等短路查詢（實作交叉審查更正措辭 2026-10-21：準確說法是領先至少 1 個 Redis 往返——exec2 要先被 stalled 檢查搬回 wait、被取出、`updateProgress(0)` 後才查短路，兩者沒有同一連線上的指令順序保證；ADR-003 代理裁決第 46 條），所以殘餘風險不適用（e2e 的 `AI_DEDUPE_LOCK_SECONDS` 為 20 s，停頓 50 s 已超過它，見 Edge Cases；research P25；analyze 階段補 2026-10-21）。（實測（e2e 第 3 輪，2026-10-22）：兩次皆為短路 (ii) `diagnoses`——exec1 解凍後在 exec2 查詢前已寫庫並 DEL 暫存；判準不受影響（LLM 恰 1 次、trigger 1 筆照樣成立）。）
- **SC-005**: `GET /diagnoses/:jobId` 至少下列七種回應全數符合（另含 503、failed，見 FR-010）：不存在的 jobId → 404；socketId 不在線或未授權 → 409；進行中且原綁定連線仍在線的他人 socketId（未帶或帶了不相符的 `previousSocketId`）→ 409；進行中、原綁定連線仍在線但等於請求的 `previousSocketId` → 200 active 且 `rebound: true`；jobId／socketId／`previousSocketId` 非 UUID → 400；已完成 → 200 且 `result` 通過 schema（原綁定仍在線也照常回）；`removeOnComplete` 清掉後仍可由 Mongo 取回 LLM 結果。驗證：e2e（404／409）＋ api 單元／整合測試。
- **SC-006**: 四種完成事件順序（`ai/done`→`completed+result`、`completed+result`→`ai/done`、`completed` 無 result→GET→遲到 `ai/done`、`ai/done` 重複兩次）100% 收斂到相同的已完成狀態（`result`、`cached`、`jobId` 相同），耗時只結算一次、公告只一次。驗證：web 單元測試。
- **SC-007**: 兩個同簽章請求、供應商持續失敗時，LLM 呼叫總數 ≤ 4（現況 6），第二個請求的錯誤碼與第一個相同，`AI_RPM` 計數不因第二個請求增加。驗證：worker 單元測試（fake store／fake timer）＋整合測試。
- **SC-008**: Mongo 拒絕寫入 `diagnoses` 時，該 job 的 LLM 呼叫恰 1 次、最終 `ai/error.code` 為 `persist_failed`；`failed` 先於 `ai/error` 抵達 api 時，10 秒寬限內到達的 `ai/error` 仍送到原連線；不論兩者到達畫面的順序，畫面都顯示具體文案而非籠統的「診斷失敗」——web 不在失敗態後改寫文案，具體文案由 `failedReason`（＝worker 的 `ai/error.message`，同源）經 `humanizeError` 對映承接（research P14；checklist 階段補 2026-10-21）。驗證：worker 單元測試＋ relay 單元測試＋ web `humanizeError` 對 `worker_failed` 搭配 `persist_failed` 訊息的單元測試；可選整合測試（Mongo validator）。
- **SC-009**: 等待去重鎖、首 token 前與寫庫期間，worker 每 10 秒（容許 ±1 秒）至少送出一次進度，api 轉成 `job/status: active`。驗證：worker 單元測試（fake timer）＋ relay 單元測試。
- **SC-010**: 契約與文件一致：`asyncapi.yaml` `info.version` 為 1.4.0；`job/status` 新增 optional `attempt`／`execution`／`reason`／`cached`；`http.ts` 新增 GET 的 query 與回應 schema；漂移測試與文件版本測試通過；`CHANGELOG.md` 契約小節與相容性注意記錄 `ai/done` 可重複、可遺失。驗證：`pnpm check`。
- **SC-011**: 不退步：既有 e2e 場景 1／2／4a／4b 照過；`pnpm test:coverage` 全域與十個核心檔逐檔門檻照過；硬規則 1 不惡化。驗證：`pnpm check`、`pnpm test:e2e`。

## Assumptions

**待使用者覆核的點（ADR-003 §7、§7.1）**

- Clarifications 的 14 條全為代理裁決，待覆核；第 1 條（15／5／2）與第三輪報告的 15／10／2 不同，優先覆核。
- ADR-003 D8／D10 整理時修正的兩處（GET 的 409 判斷延到查詢之後；404／409 文案以 UI 文案表為準）已由協調者同意採此修法，仍列待覆核。
- ADR-003 D12 的兩點草稿補充隨定稿採用、待覆核：快取命中的結果 1 小時後 GET 回 404（不把 `result` 寫進 trigger）；POST 的 jobId 冪等延伸到 `removeOnComplete` 之後（不另改 POST）。
- 轉「結果未送達」之後再抵達的同 jobId 結果仍救回（三種來源），既有 AR-6 測試保留並擴充——已由 ADR-003 代理裁決第 15 條定案（2026-10-21），FR-005 已照此撰寫；原本留給 plan 決定的問題已關閉。（原句：ADR-003 D3 寫明 2.1.0「『結果未送達』失敗可被遲到 `ai/done` 救回」的例外「改由 D10 的規則（2 s 退路先 GET）取代」；plan 階段 MUST 明定轉失敗之後再抵達的同 jobId 結果是否仍救回，並據以調整既有 AR-6 單元測試（不改變 SC-006 的四種順序判準）。
- FR-013「GET 時 `returnvalue` 驗證失敗退到 Mongo、仍無則 404」為本 spec 補的細節（ADR-003 D8 未寫驗證失敗的分支），已記為 ADR-003 代理裁決第 16 條、待覆核。
- 憲章 Principle III 補列 GET 的 PATCH 修訂為建議，待使用者決定是否執行 `/speckit-constitution`（FR-041）。
- clarify 階段補的 5 題（ADR-003 代理裁決第 17～21 條）全為代理裁決、待覆核：GET 的 `previousSocketId`（第 17 條，會新增一個 optional query 欄位）、`persist_failed` 的固定 `failedReason`（第 18 條）、重新整理頁面不續接（第 19 條）、重連過的任務標「原始串流（不完整）」（第 20 條）、只加結構化日誌不加指標欄位（第 21 條）。

**環境與範圍假設**

- **本機環境**：Windows＋Docker Desktop；本機 infra 與 e2e 以 `docker compose` 起 Redis 7、MongoDB 7、api、worker、web（nginx）。Docker Desktop 下 nginx 限流為全體共用一桶的既有限制不變（ADR-002 §6.5）。
- **e2e 使用 fake provider**：`AI_PROVIDER=fake`（20 段 × 500 ms；實作時補 2026-10-21：首 token 前另延遲 2 s，`FAKE_AI_FIRST_TOKEN_DELAY_MS=2000`，讓場景 3b 的 kill 落在首 token 前，整段串流約 11.5 s，ADR-003 代理裁決第 51 條）、`AI_TIMEOUT_MS=15000`、`AI_DEDUPE_LOCK_SECONDS=20`；e2e 不在 CI（只手動觸發），本 feature 的故障場景只在本機驗收；全套 e2e 預估由約 6 分鐘增至 10～15 分鐘。
- **worker 冷啟動時間 W**（compose 重啟延遲＋Node 載入＋Mongo／Redis ready）本機約 3～8 秒，需 e2e 實測並記錄；`W ≤ 15 s` 時 35 秒上界成立。
- **Gemini 額度**：實際 demo 與手動驗收使用 Gemini（預設 `gemini-3.5-flash-lite`）會消耗免費額度；自動化驗收一律走 fake provider，手動驗收以最少次數為原則。
- **BullMQ 版本**：5.79.2；`completed` 事件帶 `returnvalue`、`stalled` 事件、`attemptsStarted`、`Job.fromId` 的語意以此版本為準（升 6.x 須重驗，ADR-003 §5）。
- **單一 api 實例**：綁定在 api 行程內，rebind 只在收到 WS 的那一台成立；多實例不在範圍。
- **伺服器端心跳**：`WS_HEARTBEAT_MS` 預設 15 s，半開連線最長約 30 s 才被回收；`previousSocketId`（FR-009）就是為了這段時間內同一分頁的重連不被誤判為衝突。
- **demo 規模**：worker concurrency 個位數、一分鐘數次診斷；新增的 Redis 寫入（lock 續租 7.5 s、stalled 檢查 5 s、keepalive 10 s、三種新鍵）可忽略。
- **沒有使用者身分**：jobId 即存取憑證；jobId 會出現在 nginx access log 的路徑，能讀 log 的人可讀結果——demo 結果為 mock 遙測的診斷，不含機密（ADR-002 §6.3）。`previousSocketId` 同在 GET 的 query、會進同一份 log，能讀 log 的人可在原連線仍在線時改綁進行中的任務；與 jobId 同一模型、同一曝險面，接受（plan 風險 3；checklist 階段補，2026-10-21）。
- **`AI_TIMEOUT_MS` 預設 30 s**：上界推導以此為前提；其上限驗證（≤ 35 s）屬 010-lite。

## Out of Scope（明確不做）

- **Redis Streams token 回放**（定案拒絕）：QueueEvents 本身是 Stream 且已帶 `returnvalue`；重連後不續播打字機動畫，直接呈現結果。
- **010-lite 的單一來源與協定協商**：`contracts/infra`（channel、key builder、`COLLECTIONS`、`DIAGNOSIS_JOB_OPTIONS`、`STALL_TIMEOUT_MS`）、`AiErrorCode`（`failed` 仍只帶原文 `failedReason`）、`DiagnosisJobPayloadSchema` 的 `safeParse`、`WorkerMetrics.windowMs`、`system/connected` 的 `protocolVersion`／`stallTimeoutMs`、`AI_TIMEOUT_MS ≤ 35 s` 的啟動驗證、`MAX_ATTEMPTS` 常數化。
- **011 的效能量測**：`system/metrics` 的 `ws` 計數、背壓 badge 重定義、headless 量測 harness、bundle 預算。
- Gateway 拆 `WsConnectionRegistry`／`SubscriptionService`／`TelemetryPipeline`（只抽 `JobRoutingRegistry`）。
- 多 api 實例、綁定外置 Redis、使用者身分驗證、`wss://`。
- **重新整理頁面或關分頁再開後續接進行中的診斷**（代理裁決第 19 條）：web 不把 jobId 存進 sessionStorage／localStorage；US2 的續接只涵蓋頁面仍在、WS 重連的情況。
- 為冪等短路、`ai-fail` 命中等新路徑在 `system/metrics`／`WorkerMetrics` 新增計數欄位（代理裁決第 21 條；指標重定義屬 011）。
- WEB-17 餘項（`jobs` 逐 token 寫 reactive、partial-json 每則重解析；使用者 2026-10-18 裁決 12 留在 backlog）。
- 45 s watchdog 改用單調時鐘（留在 ADR-002 §6.5.1 backlog）。
- 憲章修訂的實際執行（只建議，見 FR-041）。
