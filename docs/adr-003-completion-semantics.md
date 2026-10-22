# ADR-003：診斷完成語意與結果讀取——BullMQ `returnvalue` 為權威、`ai/done` 降為 best-effort

| 項目 | 內容 |
| --- | --- |
| 狀態 | Accepted（2026-10-21 離席期間代理裁決；2026-10-22 使用者覆核第 1、9、17、63 條與 §7.1 全部待覆核點（T081 除外），皆維持／接受，第 9 條落地為憲章 1.6.1；其餘條仍待覆核，覆核完畢後移除此註） |
| 日期 | 2026-10-21 |
| 範圍 | 診斷 job 的「完成」以哪個訊號為準、結果如何讀回、重連如何續接、重複執行如何冪等、BullMQ 鎖參數與前端 45 s watchdog 的關係、同簽章失敗的去重 |
| 相關 | 第三輪審查 `docs/20260927-research-review03.md` §3.2、§3.3、§5.2、§5.4（012-lite 列）、§5.5、§5.6、§7；ADR-001（原生 ws）；ADR-002 §3 第 5 列、§6.1（單實例狀態）、§6.2（Pub/Sub at-most-once，本 ADR 落地時改寫「生產路徑」）、§6.5「結果讀取與完成語意」列、§6.5.1 WK-4 列與「失敗終態沒有 relay 寬限」列；`CHANGELOG.md` `[2.1.0]` 相容性注意（AR-4、AR-S7、WK-13、WK-4 補強、AR-5 根治帶著發布）；指南 §15.5、§15.6「第三輪審查 quick-fix」（含「roadmap 版號順延」）、§15.7 012-lite 藍圖；憲章 Principle III／IV／V；roadmap **012-lite**（契約 asyncapi **1.4.0**） |
| 行號基準 | 文中所有 `檔名:行號` 皆為 2.1.0（`27bc587`）的行號；行號會漂移，以檔名與符號名為準 |
| 來源標記 | 每個決策點末尾一行「來源：」。「第三輪報告 §x.y」＝報告已有明確建議；「ADR-003 代理裁決第 n 條（待覆核）」＝報告未寫、或與報告不同，由本 ADR 補設計，並於 2026-10-21 由代理裁決採用，清單見 §7 |

---

## 1. 背景（Context）

（本節行號基準：2.1.0，`27bc587`。）

使用者看得到的「後端成功、畫面失敗」全部出在完成語意上（第三輪報告 §0 第 3、9 點）：

1. **完成只靠一則 Pub/Sub 訊息。** worker 成功後送 `ai/done`（Redis Pub/Sub，at-most-once）；`job/status: completed` 經 BullMQ QueueEvents 送達，但從不帶結果（`job-status-relay.service.ts:90` 丟掉 `returnvalue`，processor 也不回傳任何值，`processor.ts:165`）。Pub/Sub 訂閱斷線時（WS 沒斷），畫面收到 `completed` 卻等不到結果。2.1.0 quick-fix 讓 worker await 終態事件、relay 保留綁定 10 s、web 2 s 內收不到就轉「結果未送達，請重試」——**緩解了等待時間，沒有讓結果送達**。
2. **結果落庫但取不回。** `diagnoses` 有寫，api 沒有任何讀取端點（ADR-002 §6.2 更正段）。重連拿到新 `clientId` 後綁定失效，畫面只能「連線中斷＋重試」。
3. **worker 崩潰後約 92 s 零事件。** BullMQ `lockDuration`／`stalledInterval`／`maxStalledCount` 全用預設 30 s／30 s／1（`main.ts:147-152`），e2e 實測重派要 92 s，前端 45 s watchdog 先判失敗；另外同簽章的等待者在等待迴圈最長 80 s 沒有事件（`processor.ts:349`）。
4. **重複執行不冪等。** Redis 停頓超過 lock 期限時同一 jobId 跑兩次（AR-4 實測）：`diagnosisTriggers` 兩筆、hit／miss 各記一次、快取沒寫成時重打 LLM；寫庫失敗的重試每次都重打 LLM（WK-4 補強）；持鎖者失敗即放鎖，等待者接著各自打 LLM（WK-13，2 個 job 共 6 次）。

約束：

- 憲章 IV「雙通道分流」：job lifecycle MUST 走 BullMQ QueueEvents、AI token MUST 走 Redis Pub/Sub。把結果放進 `returnvalue` 經 QueueEvents 送出，正好落在 lifecycle 通道上，不混流。
- 憲章 V：結果 MUST 經 `DiagnosisResultSchema` 驗證；從 Redis 讀回的 `returnvalue` 是任何能寫 Redis 的一方都寫得進去的資料，api 轉發前必須再驗一次（比照 `ai-stream-relay.service.ts:154`）。憲章 III 例外 (c)：跨 process 傳輸型別（`returnvalue`、progress 物件）SHOULD 以 Zod 定義並在消費端 `safeParse`，且 MUST 以 `packages/contracts` 為單一來源。
- BullMQ 5.79.2 已具備需要的能力：`completed` 事件帶 `returnvalue`（`queue-events.js:101-102` 已 parse）、`stalled` 事件（`moveStalledJobsToWait-9.lua:106`）、`Job.fromId` 讀 `returnvalue`／`stalledCounter`／`attemptsStarted`；`removeOnComplete: { age: 3600 }`（`jobs.service.ts:184`）讓 `returnvalue` 保留 1 小時。QueueEvents 本身就是 Redis Stream 的讀者：同一個 api 行程內連線斷了再接，`XREAD` 會從上次的 id 續讀（`queue-events.js:79` 的 `id` 變數跨迴圈保留），所以 `completed` 不像 Pub/Sub 那樣在斷線期間遺失；只有 api 重啟時從 `$` 開始讀、錯過重啟期間的事件——這段由讀取端點補。

---

## 2. 決策（Decision）

1. **(a) 完成以 BullMQ `returnvalue` 為權威。** processor 成功時回傳 `{ result, cached }`；api relay 在 `completed` 事件讀 `returnvalue`、以契約 schema 驗證後填進 `job/status.result`（與新增的 `cached`）。`ai/done` 保留，但降為**可能重複、可能遺失的 best-effort 訊號**：畫面以三個來源中最先到的一個收尾——`ai/done`、帶 `result` 的 `job/status: completed`、`GET /diagnoses/:jobId` 回 `completed`——之後到的同 jobId 結果一律忽略。（D1、D3、D10）
   來源：第三輪報告 §3.2（AR-5 根治）、§5.4、§5.6；ADR-003 代理裁決第 11 條（待覆核）。
2. **(b) 不實作 Redis Streams。** ADR-002 §6.2「生產路徑：改用 Redis Streams」改寫為「已拒絕（ADR-003）」，§6.2「已變更」註記中的「Streams 降為備選」一併收斂；指南 §15.5「Redis Streams token 回放」候選方向標為已拒絕（回補清單見 §6）。
   來源：第三輪報告 §5.5、§7。
3. **(c) 冪等與重派。** jobId 是一次診斷請求的身分，同 jobId 的任何再執行都必須產生同一個結果、同一筆 trigger、同一次 hit／miss：processor 開頭以 jobId 查既有結果（D6）、trigger 以 jobId 冪等寫入、hit／miss 以 jobId 只計一次；`ai/done` 因此**可能重複**（每次再執行都會再送一次相同結果），契約描述明寫消費端必須冪等。（D3、D6）
   （實作階段更新，2026-10-21）再執行在快取命中、回 `cached:true` 之前再查一次自己的結果，命中即回 `cached:false`（D6 第 1 點，第 49 條）；`ai-result` 暫存寫入改為 best-effort（D6 第 4 點，第 50 條）。
   來源：第三輪報告 §3.2（AR-4、WK-4 補強）；實作細節為 ADR-003 代理裁決第 5 條（待覆核）；再執行與暫存的補裁為第 49、50 條（待覆核）。
4. **(d) BullMQ 參數改為 lock 15 s／stalled 5 s／maxStalled 2**，並以 worker 端 keepalive 保證「worker 活著就每 10 s 至少一則事件」；兩者合起來讓「worker 被 SIGKILL 後到下一則事件」的設計上界為 35 s，低於 45 s watchdog。**與第三輪報告不同**：報告建議 15／10／2，在 keepalive 10 s 下最壞情況剛好 45 s、沒有餘裕（D4）。
   來源：第三輪報告 §3.2（AR-S7）、§5.4；ADR-003 代理裁決第 1 條（待覆核）。
5. **(e) 新增 `GET /diagnoses/:jobId?socketId=`**：沿用 POST 的授權閘門（`socketId` 必須在線且已授權）；查詢順序 BullMQ（`Job.fromId` → state／`returnvalue`）→ Mongo `diagnoses` → 404；進行中的 job 只有在原綁定的連線已離線（或綁定已不存在，例如 api 重啟後）才允許 rebind 到本次 socketId；已完成的 job 任何已授權連線都可讀；授權模型是「jobId 即 bearer capability」。綁定改由新抽出的 `JobRoutingRegistry` 持有，rebind 寫在它裡面；`completed` 與 `failed` 兩種終態後綁定都保留 10 s 寬限（同一段 registry 程式，D12）。nginx 對 GET 另設限流區。（D8、D9、D12）
   （clarify／checklist／實作階段更新，2026-10-21）端點形狀改為 **`GET /diagnoses/:jobId?socketId=[&previousSocketId=]`**；`previousSocketId`（optional UUID）是呼叫端分頁上一次成功綁定此任務的 socketId，只用於改綁判斷。進行中 job 的 rebind 條件改為三者之一：原綁定的連線已離線、綁定不存在，或**原綁定仍在線但等於請求帶的 `previousSocketId`**（同一分頁重連、舊連線尚未被心跳回收；不主動終止舊連線，第 17 條）。409 分兩種機器可讀 `code`：`socket_unauthorized`（連線不在線或未授權）與 `job_bound_elsewhere`（進行中且綁定在另一條在線連線，第 23 條）；Redis 或 Mongo 不可用、BullMQ 查詢超過 5 s 或 Mongo 查詢超過 3 s（合計上限 8 s）回 503（第 25 條）。`jobId` 與 `previousSocketId` 都會出現在 nginx access log（D8 方案 A 的代價）。
   來源：第三輪報告 §5.3、§5.4、§5.6；ADR-003 代理裁決第 3、8、12 條；`previousSocketId` 為第 17 條、409 `code` 為第 23 條、503 為第 25 條（皆待覆核）。
6. **(f) keepalive 與負向快取。** worker 在一次執行中只要 10 s 沒有對外事件，就以 `job.updateProgress(目前里程碑)` 補送一次（D2）；同簽章的 LLM 階段失敗寫 `ai-fail:<sig>`（TTL 10 s），其他 job 在取鎖前與限流計數前看到它就不打 LLM（D5）。
   來源：第三輪報告 §3.3（WK-13）、§5.4；機制與數值為 ADR-003 代理裁決第 1、4 條（待覆核）。
7. **(g) 逾時語意定為「結果未知」**：45 s watchdog 觸發只代表「畫面這麼久沒收到進展」，不代表後端失敗；觸發時先 GET 一次，查得到結果就照常完成（D11）。
   來源：第三輪報告 §5.6；GET 一次與文案為 ADR-003 代理裁決第 7 條（待覆核）。
8. **(h) 契約升 asyncapi 1.4.0（向後相容的 minor）**：`job/status` 新增 optional `attempt`／`execution`／`reason`／`cached`、`completed` 時填 `result`；`ai/done` 描述改為可重複、可遺失；`http.ts` 新增 GET 的 query 與回應 schema；contracts 新增傳輸型別 `DiagnosisJobReturnValue` 與 `DiagnosisJobProgress`（D7）。GET 的 query 與成功回應以 Zod 定義；建議以 PATCH 修訂憲章 Principle III 補列 GET，但**不在使用者離席期間執行**，實際 `/speckit-constitution` 待使用者確認（D8 第 6 點）。
   來源：第三輪報告 §5.4（版號依指南 §15.6「roadmap 版號順延」由 1.3.0 改為 1.4.0）；ADR-003 代理裁決第 2、9 條（待覆核）。

---

## 3. 決策細節與方案比較

（本節行號基準：2.1.0，`27bc587`。）每點列 2～3 個替代方案；不選的理由寫實際代價。

### D1. 完成訊號與 `returnvalue` 形狀

**決定**：processor 回傳 `DiagnosisJobReturnValue = { result: DiagnosisResult; cached: boolean }`（contracts 的 api↔worker 傳輸型別，比照 `DiagnosisJobPayload`）。relay 以 Zod schema 驗證後送 `job/status { status:"completed", result, cached, attempt, execution }`；驗證失敗或缺值（舊版 worker、外部寫入）時照送不帶 `result` 的 `completed`、記 warn，web 走 2 s 未送達 → GET 的退路（D10）。

**`job/status.cached`**：報告的契約清單只列 `attempt`／`execution`／`reason`。web 的「AI：嚴重度 · 快取」chip（`diagnosis-badge.ts:25`）、完成 meta 的快取耗時對比（`copilot.store.ts:370` 的 `settleTiming(…, cached, …)`）、螢幕閱讀器公告「診斷完成（快取）」（`CopilotDrawer.vue:193`）都讀 `cached`；只帶 `result` 時，以 `job/status` 收尾的快取命中會全部顯示成非快取，demo 的「快取秒回」賣點在 Pub/Sub 出問題時就看不到。定案：`cached: z.boolean().optional()`，`completed` 帶 `result` 時必帶。

| 方案 | 做法 | 不選的理由 |
| --- | --- | --- |
| **A（選）** `returnvalue`＋`job/status.result` | QueueEvents 本來就帶 `returnvalue`，零額外 Redis 往返；Stream 讀者斷線續讀 | — |
| B 維持只有 `ai/done`、拉長寬限或自動重送 | relay 寬限從 10 s 拉長、web 收不到就自動重試 | Pub/Sub 訂閱斷線期間 worker 的 PUBLISH 直接沒人收，寬限再長也收不到；自動重試只能命中快取（快取命中的 job 不寫 `diagnoses`、快取未寫成時重打 LLM），使用者等更久且可能多花一次 LLM |
| C relay 收到 `completed` 再 `Job.fromId` 讀結果 | 事件不信任、改查 job hash | 每個完成多一次 Redis 讀；`removeOnComplete` 與查詢之間有競態（極少）；QueueEvents 事件裡已經有同一份資料，查一次只是重複 |

來源：第三輪報告 §3.2（AR-5 根治）、§5.4；`cached` 欄位為 ADR-003 代理裁決第 2 條（待覆核）。

### D2. keepalive 機制

**決定**：worker 每個執行開一個 10 s 的閒置計時器，任何對外事件（`updateProgress`、`ai/token` 發布）都重設它；到期就 `job.updateProgress(目前里程碑)` 補送一次。範圍涵蓋整個執行（不只等待者與首 token 前），因為里程碑 80 → 100 之間的 Mongo 寫入最長 20 s（`socketTimeoutMS`，`main.ts:73-76`）。QueueEvents 的 `progress` 事件會被 relay 照常轉成 `job/status: active`（`job-status-relay.service.ts:86-88`），web 的 `applyEvent` 對任何屬於當前 job 的 active 事件都會重設 watchdog（`copilot.store.ts:354-355`），**WS channel 不必新增**（progress 物件形狀見 D7）。

> **殘餘風險（整理時發現；代理裁決第 14 條接受）**：`ai/token` 發布也重設計時器，代表串流期間 worker 不會補送 keepalive。草稿原本把「token 因背壓被 Gateway 略過（`monitoring.gateway.ts:684`）」列為涵蓋整個執行的理由，但在這個設計下串流期間的 keepalive 本來就不會發出，該理由已刪除。實際影響只在**複合故障**：Pub/Sub 斷線（token 送不到畫面）且 worker 在串流中被 SIGKILL 時，畫面最長無事件約為 `A + L + 2S`＝30＋15＋10＝55 s，超過 watchdog（單一故障時上界仍為 D4 的 35 s）。接受、不加機制：watchdog 觸發後先 GET（D11），重派完成後仍能取回結果；替代做法「計時器只由 `updateProgress` 重設」不採用（見 §7 第 14 條）。

| 方案 | 做法 | 不選的理由 |
| --- | --- | --- |
| **A（選）** worker `updateProgress(同值)` | 走 lifecycle 通道；worker 死了就自然停 | 每個 active job 每 10 s 多一次 HSET＋XADD；以 demo 規模（concurrency 個位數）可忽略 |
| B 新增 Pub/Sub 事件 `ai/heartbeat` | worker 每 10 s PUBLISH | 要新增第 13 個 channel 與契約；而且 Pub/Sub 斷線正是最需要 keepalive 的時候，它會跟 `ai/done` 一起丟 |
| C api 端替 active job 合成 keepalive | 比照 delayed 期間補送 `waiting` | api 不知道 worker 活著沒有，worker 被 SIGKILL 後 api 還在補送，畫面會一直顯示進行中、watchdog 永遠不觸發——`DELAYED_GRACE_MS` 的註解（`job-status-relay.service.ts:22-27`）就是為了避免這件事 |

來源：第三輪報告 §5.4（10 s、等待者與首 token 前）；機制與涵蓋範圍隨 ADR-003 代理裁決第 1 條（keepalive 10 s）一併採用，殘餘風險為代理裁決第 14 條（皆待覆核）。

### D3. 冪等的鍵與 `ai/done` 可重複

jobId 是前端產生的 idempotency key（`http.ts` `CreateDiagnosisBodySchema.jobId`），BullMQ 以它為 job id。同 jobId 的再執行有三種來源：BullMQ 重試（`attemptsMade` 遞增）、stalled 重派（`attemptsMade` 不變、`stalledCounter`／`attemptsStarted` 遞增）、限流或關閉時的 `moveToDelayed`（`attemptsStarted` 遞增）。012-lite 之後，三種再執行對外的結果一致：同一個 `result`、同一筆 trigger、hit／miss 只記一次；每次成功的再執行都會再送一則 `ai/done`，所以 `ai/done` 的契約描述改為：

> `ai/done` is a best-effort notification. It MAY be delivered more than once for the same jobId (re-execution after a stalled lock or a retry normally carries the same result; in a rare residual case documented in ADR-003 section 4 a re-execution may carry a different result, so keep the first one received) and MAY be lost (Redis Pub/Sub is at-most-once). The authoritative completion is `job/status` with `status: completed` and `result`; consumers MUST treat the first completion they receive for a jobId as final and ignore later ones.

web 現況已滿足「之後的忽略」：reducer 只在 active 消費事件（`copilot-reducer.ts:163`），唯一例外是「結果未送達」失敗可被遲到的 `ai/done` 救回（`:151-162`），012-lite 之後這條例外改由 D10 的規則取代。

（specify 階段更新，2026-10-21）上句的「取代」已由第 15 條改定：這條例外**保留並擴充**到三種來源——已轉「結果未送達」之後，同 jobId 的 `ai/done`、帶 `result` 的 `job/status: completed`、GET 回 completed 再抵達時都救回為「已完成」；其他失敗態（`ai/error`、`failed`）不被覆蓋（spec FR-005）。D10 的 2 s 退路是在轉「結果未送達」之前多查一次 GET，兩者並存。

（合併門第 1、2 輪更新，2026-10-22）救回的**實際**來源只有 `ai/done` 與帶 `result` 的 `job/status: completed`，且只在 api 綁定的 10 s 終態寬限內送得到；GET 只對進行中任務發出，不會替「結果未送達」的失敗取回（第 55 條；spec FR-005）。reducer 仍接受 GET 回 completed 救回，只是實務上不會發生。

| 方案 | 不選的理由 |
| --- | --- |
| **A（選）** 以 jobId 冪等、`ai/done` 可重複 | — |
| B 以分散式鎖保證同 jobId 不會同時執行 | BullMQ lock 本身就是這把鎖，問題正是它在 Redis 停頓時會過期；再加一把同樣存在 Redis 的鎖會在同一個停頓裡一起過期，解不了 |
| C 引入 HA／多 worker 協調 | 報告 §7 已拒絕：冪等就夠，HA 是部署選擇（ADR-002 §7） |

來源：第三輪報告 §3.2（AR-4）、§5.6、§7；`ai/done` 契約描述為 ADR-003 代理裁決第 11 條（待覆核）。

### D4. BullMQ 參數與 45 s watchdog 的上界

符號：`L`＝`lockDuration`、`S`＝`stalledInterval`、`K`＝keepalive 間隔、`W`＝worker 被殺到新 worker 跑第一次 stalled 檢查的時間（compose 重啟延遲＋冷啟動：Node 載入、Mongo 連線、建索引、Redis ready，本機約 3～8 s，需 e2e 實測）、`A`＝`AI_TIMEOUT_MS`。

BullMQ 的 stalled 判定（`moveStalledJobsToWait-9.lua`）：每次檢查先把「上一輪標記過、而且 lock 已不存在」的 job 搬回 wait（同時寫 `waiting` 與 `stalled` 事件），再把目前所有 active job 標記起來；worker 續租 lock 時（每 `L/2`）會把自己的 job 從標記集合移除；`stalled-check` 鍵以 `S` 為期互斥，所以新 worker 的第一次檢查可能是空轉。由此：

- worker 在時刻 `t` 被殺，lock 最晚在 `t + L` 到期。被搬回 wait 的時刻 ≤ `max(t + L, t + W + S) + S`；保守寫法為 `t + L + 2S`（`W ≤ L` 時成立）。預設 30／30 時保守值 90 s，與 e2e 實測 92 s 相符。
- **前端看到的最長無事件間隔**不是從 `t` 起算，而是從 `t` 之前的最後一則事件起算。worker 活著時 keepalive 保證每 `K` 至少一則事件，所以被殺前最後一則事件最早在 `t − K`。最長間隔 ≈ `K + L + 2S`。
- 第三輪報告 §3.2 寫的「上界約 35 s」是 `L + 2S`（15＋2×10），沒有計入被殺前最後一則事件到 `t` 的 `K`；計入後報告值為 45 s。

| 參數（L／S／maxStalled，K） | 保守上界 `K + L + 2S` | 與 45 s watchdog | 備註 |
| --- | --- | --- | --- |
| 現況 30／30／1，無 keepalive | 不設限（等待迴圈 80 s、重派 90 s） | 超過 | e2e 92 s |
| 報告 15／10／2，K＝10 | 10＋15＋20＝**45 s** | **等於門檻、沒有餘裕** | e2e 在第 3 個 token 後殺（token 間隔 0.5 s），實測會在 ~35 s 內通過；最壞情況（首 token 前、keepalive 剛送完就被殺）會在 45 s 邊緣誤判 |
| **定案 15／5／2，K＝10** | 10＋15＋10＝**35 s** | 餘裕 10 s | `W` 最多可到 15 s 仍成立（`W + 2S ≤ L + 2S`） |
| 替代 15／10／2，K＝5 | 5＋15＋20＝40 s | 餘裕 5 s | keepalive 寫入量加倍 |

**定案 lock 15 s／stalled 5 s／maxStalled 2、keepalive 10 s。** 理由：`S` 只影響「多快發現」，不影響「多容易誤判」（誤判由 lock 是否過期決定，看的是 `L`），縮小 `S` 的代價是每個 worker 每 5 s 跑一次 stalled 檢查的 Lua（`LRANGE active`＋`SADD`，demo 規模下微秒級）；縮小 `L` 才會提高誤判率。`maxStalledCount` 2 是因為 `L` 縮短後 Redis 卡頓超過 15 s 就會觸發一次 stalled，留一次額度給真正的 worker 崩潰（現況 1 次額度會被一次卡頓用掉，AR-4 實測）。`lockRenewTime` 維持 BullMQ 預設 `L/2`＝7.5 s。（合併門第 2 輪更正，2026-10-22：BullMQ 的續租計時器實際每 `lockRenewTime/2` 約 3.75 s 觸發一次，最慢 7.5 s；因此 Redis 卡頓的容忍約 11.25～15 s——最後一次成功續租可能發生在卡頓開始前 0～3.75 s，lock 剩餘 11.25～15 s。35 s 上界的推導不變——`K + L + 2S` 只看 lock 期限、stalled 間隔與 keepalive 間隔，不依賴續租節拍（合併門第 3 輪更正措辭：原寫「它只用到 `L` 與 `S`」，漏了 `K`）。）四個值寫成具名常數並在 README 說明。

另：重派後的 job 若要等死掉的持鎖者留下的 `ai-lock:<sig>`（TTL `AI_DEDUPE_LOCK_SECONDS`，預設 45 s），等待期間由 keepalive 補事件，不影響上界；首 token 前最長 `A`（30 s），同樣由 keepalive 覆蓋。`A` 本身的上限驗證（`AI_TIMEOUT_MS ≤ 35 s`）屬 010-lite，不在本 ADR。

| 方案 | 不選的理由 |
| --- | --- |
| **A（選）** 15／5／2＋worker keepalive 10 s | — |
| B 報告原值 15／10／2 | 最壞情況 45 s 正好等於 watchdog，誤判時使用者看到「結果未知，請重試」而 3～5 s 後重派又開始跑；要靠 e2e 剛好不踩到最壞情況才過 |
| C 把 watchdog 拉長到 60 s 以上、參數不動 | worker 真的死掉（restart 次數用盡）時使用者多等 15 s 以上才看到失敗；預設 30／30 的重派要 90 s，60 s 也不夠 |
| D lock 再縮到 10 s 以下 | Redis 卡頓或 worker 事件迴圈短暫忙碌（Mongo 驅動回呼堆積）超過 10 s 就雙重執行；冪等雖然能吸收，但每次都會多一次 context 查詢與快取讀，且 `ai-lock` 若同時過期會重打 LLM |

來源：第三輪報告 §3.2（AR-S7）、§5.4（15／10／2）；stalled 改 5 s 與上界推導為 ADR-003 代理裁決第 1 條（待覆核，**與報告不同**）。

### D5. `ai-fail:<sig>` 負向快取

**定案**：

- **鍵與值**：`ai-fail:<sig>` ＝ `{ code, message, jobId, at }`（JSON），`SET … EX 10`。
- **TTL 10 s**：BullMQ 退避為 5 s、10 s（`jobs.service.ts:183`），10 s 涵蓋持鎖者第一次退避重試的時間點；再長的話，供應商已恢復但標記還在，新來的請求會被白白擋掉；再短（5 s）的話，等待者的第一次退避重試（+5 s）剛好遇到標記過期、各自去打 LLM，放大回來。
- **誰會寫**：LLM 階段的所有失敗（`provider_error`、`ai_timeout`、`schema_invalid`，含不可重試的安全攔截與截斷）。不可重試也寫，因為同簽章＝同一份 prompt，換一個 job 重打也是同樣結果。`no_context`（簽章之前）、`persist_failed`（LLM 之後）、限流延後不寫。
- **誰會讀**：等待者每輪輪詢（`processor.ts:386` 之後）與新 job 取鎖前，**且在限流 INCR 之前**（避免被擋下的 job 還吃 `AI_RPM`）。標記的 `jobId` 等於自己時忽略（持鎖者自己的重試要能真的再試一次）。
- **看到標記時**：非最終 attempt → throw 可重試錯誤（交 BullMQ 退避，會消耗一次 attempt）；最終 attempt → `fail(code, message)` 送同 code 的 `ai/error`。
- **何時清除**：持鎖者成功寫入快取時 `DEL`；否則等 TTL。

| 方案 | 不選的理由 |
| --- | --- |
| **A（選）** 負向標記＋錯誤傳遞 | 代價：供應商只是 1～2 s 的短暫抖動時，等待中的使用者會在 10 s 內直接拿到同一個錯誤，而不是自己再試一次 |
| B 失敗時不放鎖，改 `PEXPIRE` 成冷卻期（報告的替代做法） | 等待者只是被延後、不是被擋下：冷卻期一過每個等待者照樣各自打 LLM、各自走滿 3 次 attempt，2 個 job 仍是 6 次 LLM 計費，只是攤在更長的時間裡；而且等待者等得更久，最後一個要等 N × 冷卻期 |
| C 看到標記時 `moveToDelayed` 到 TTL 之後（不消耗 attempt） | 供應商持續故障時，等待者每 10 s 被延後一次而 attempt 不減，持鎖者用完 3 次後等待者接手又是 3 次，放大倍數回到 N × 3；且 delayed 期間只有 api 的 `waiting` 補送撐著 |

來源：第三輪報告 §3.3（WK-13：短 TTL 5–15 s、等待者與新 job 不打 LLM）；值、TTL、涵蓋範圍與處置為 ADR-003 代理裁決第 4 條（待覆核）。

### D6. 冪等的實作：結果查詢、trigger、hit／miss、寫庫失敗

**定案做法**：

1. **processor 開頭的查詢順序**：`updateProgress(0)` 之後、`buildContext` 之前，依序查 (i) `ai-result:<jobId>`（Redis，見第 4 點）、(ii) Mongo `diagnoses.findOne({ jobId })`。命中即冪等補寫 trigger（`cached:false`）、`updateProgress(100)`、送 `ai/done(cached:false)`、回傳 `{ result, cached:false }`，不建 context、不取鎖、不打 LLM。放在 `buildContext` 之前是因為 context 要跑 4 支 Mongo 查詢（`context-builder.ts`），已完成的 job 沒必要再跑；快取命中的 job 本來就不寫 `diagnoses`，再執行時會走一般路徑再命中一次快取，trigger 冪等吸收重複。
   （實作階段更新，2026-10-21）**再執行命中快取前先查自己的結果**：再執行（`attemptsStarted > 1` 或 `attemptsMade > 0`）在快取命中、回 `cached:true` 之前，再跑一次上面的 (i)／(ii)；前一次執行在這段期間已落地（例如等鎖期間舊執行跑完、寫了 `diagnoses` 與快取）就照短路語意回 `cached:false`（第 49 條）。上一句「再執行時會走一般路徑再命中一次快取」因此只適用於前一次執行從未落地的情況。短路命中時不回填 `ai-cache`、不 DEL `ai-fail`（短路不建 context、沒有簽章，第 32 條）。
2. **trigger 冪等**：`diagnosisTriggers` 新增 `{ jobId: 1 }` unique 索引；既有資料可能已有重複（AR-4 的歷史），沿用 `ensureUniqueJobIdIndex` 的「衝突時退回非 unique＋記 error」邏輯（`diagnosis-repository.ts:69-96`）。寫入改 `updateOne({ jobId }, { $setOnInsert: {…} }, { upsert: true })`，failed handler（`main.ts:245-247`）同樣改用它。一個 jobId 只會有一筆：成功（`cached` true／false）或最終失敗，兩者互斥。（plan 階段更新，2026-10-21）方法改名 `upsertTrigger`，併發 upsert 撞 E11000 視為成功；unique 建立泛化 `ensureUniqueJobIdIndex`（第 31 條）。
3. **hit／miss 只計一次**：`SET ai-metric:<jobId> 1 NX EX 86400`，回 OK 才 `recordCacheHit`／`recordCacheMiss`。TTL 24 h 對齊 `removeOnFail`（`jobs.service.ts:185`）。不用 `attemptsStarted === 1`：限流延後的再執行也會遞增它，限流後才真正打 LLM 的那次 miss 會漏記。
4. **寫庫失敗不重打 LLM（WK-4 補強）**：LLM 成功、`parseResult` 通過後，先 `SET ai-result:<jobId> <result> EX 3600` 再寫 `diagnoses`；`diagnoses` 寫入失敗時經 `fail("persist_failed", …, retryable: true)` 送出（最終 attempt 才送 `ai/error`），重試時在第 1 點的 (i) 命中暫存、只重做寫庫。寫庫成功後 `DEL ai-result:<jobId>`。TTL 1 h 對齊 `removeOnComplete`。快取寫入（`ai-cache:<sig>`）維持在 `diagnoses` 之後，保留「快取有值就代表已落庫」的既有不變量（`processor.ts:335-336` 的註解）。
   （實作階段更新，2026-10-21）**暫存 SET 為 best-effort**：`SET ai-result:<jobId>` 失敗只記 warn、照常寫 `diagnoses`；寫庫後的 `DEL` 失敗同樣只 warn、由 TTL 回收（第 50 條）。`diagnoses` 一旦落地，之後任何一步失敗都能由第 1 點的 (ii) 回收；讓暫存失敗中斷流程，已拿到的 LLM 結果會作廢、重試再打一次 LLM。
5. **先落地後宣告**維持 2.1.0 的順序：trigger → `updateProgress(100)` → `ai/done` → return。

| 方案（針對第 4 點） | 不選的理由 |
| --- | --- |
| **A（選）** per-job 結果暫存 `ai-result:<jobId>` | 代價：每個成功 job 多一次 SET／DEL；Redis 記憶體在 `maxmemory 256mb noeviction` 下，暫存存活至多 1 h、單筆數 KB，demo 規模可忽略 |
| B 只加 `persist_failed` 錯誤碼、接受重打 | Mongo 拒絕寫入（validator、磁碟滿）或在 LLM 呼叫期間重啟時，每個 job 打 3 次 LLM 並全數計費（`CHANGELOG.md` `[2.1.0]` 已向使用者揭露的成本問題不會消失） |
| C 改成先寫快取、再寫 `diagnoses` | 重試會命中以簽章為鍵的快取並回 `cached:true`，無從分辨「別人的結果」與「自己還沒落庫的結果」，`diagnoses` 永遠缺這筆——這正是現行順序要避免的（`processor.ts:335-336`） |

來源：第三輪報告 §3.2（AR-4：`findByJobId`、trigger 冪等、hit／miss 去重；WK-4 補強：`persist_failed`）；查詢順序、索引、`SET NX` 與 `ai-result:<jobId>` 暫存為 ADR-003 代理裁決第 5 條；`upsertTrigger` 為第 31 條、短路不回填快取為第 32 條、再執行命中快取前先查自己的結果為第 49 條、暫存 SET best-effort 為第 50 條（皆待覆核）。

### D7. `job/status` 新欄位與 attempt／execution 的傳遞

**定案**：

- `attempt`＝`job.attemptsMade + 1`（與 `ai/*` 的 `attempt` 同義）；`execution`＝`job.attemptsStarted`（BullMQ 每次 `moveToActive` 都遞增，涵蓋重試、stalled 重派、限流延後的再執行；從 1 起、單調遞增）。web 收到更大的 `execution` 就清空串流文字，比 `seq <= lastSeq`（AR-S8）更直接；`lastSeq` 保留為備援。**`execution` 遞增不等於「worker 中斷」**（重試與限流延後也會遞增），畫面的「重新派送」說明只看 `reason: "stalled"`（D13；代理裁決第 13 條）。
- **傳遞方式**：worker 呼叫 `job.updateProgress({ value, attempt, execution })`（BullMQ progress 接受物件）；relay 把它拆成 `job/status { progress: value, attempt, execution }`，數字型 progress（舊版 worker）照舊處理。物件形狀定為 contracts 的傳輸型別 `DiagnosisJobProgress` 並由 relay `safeParse`（Redis 讀回的資料）。
- `reason`：`stalled` 事件 → `job/status { status:"waiting", reason:"stalled" }`。**wire 上用 `z.string()` 開放字串**、文件列舉已知值，不用封閉 enum：web 以 Zod 驗整則 `job/status`（`job-status.ts:5-9`），封閉 enum 時，日後 api 加一個新的 reason，舊版 web 會把整則 `job/status`（含 `completed`＋`result`）丟掉。這與報告對 `AiErrorCode` 的建議一致（§5.4 010-lite 列）。
- `cached`：見 D1。

| 方案 | 不選的理由 |
| --- | --- |
| **A（選）** worker 把 attempt／execution 放進 progress 物件 | 代價：BullMQ job hash 的 `progress` 欄位從數字變物件，用 BullMQ 管理介面看 progress 的人看到的是物件 |
| B relay 在 `active` 時 `Job.fromId` 查 | 每個 active 多一次 Redis 讀；查詢是非同步的，`active` 的 `job/status` 可能晚於緊接著的 `progress: 0` 送出，畫面進度先跳 0 再出現「嘗試 2 / 3」，要另做每 job 的序列化 |
| C 不加欄位，web 維持從 `ai/token` 推 attempt | stalled 重派期間「嘗試」恆為 1 / 3、進度從 60％ 退回 0 沒有任何說明（現況）；快取命中與等待中的 job 沒有 token，永遠看不到換輪 |

來源：第三輪報告 §5.4（`attempt`／`execution`／`reason`）、§4 WEB-20；傳遞方式、定義與開放字串為 ADR-003 代理裁決第 2 條、「重新派送」只看 `reason` 為第 13 條（待覆核）。

### D8. `GET /diagnoses/:jobId?socketId=[&previousSocketId=]` 的授權與 rebind

**授權模型**：沒有使用者身分（ADR-002 §6.3），jobId（UUID v4，122 bits 亂數，前端 `crypto.randomUUID` 產生）即 bearer capability：知道 jobId 且持有一條在線、已授權的 WS 連線，就能讀這個 job 的結果。這與 POST 的冪等規則同一模型（POST 以 jobId 重送拿到同一個 job）。

**處理流程（定案；整理時修正了草稿「第 4 點 rebind 規則」與「第 5 點先綁定後查詢」的先後矛盾——草稿在查詢前就對「原綁定在線」回 409，會讓已完成任務在 10 s 完成寬限內被擋，違反「已完成任何已授權連線可讀」）**：

1. `jobId`、`socketId` 皆以 `z.uuid()` 驗證，不符 400（只回 issue 路徑與代碼，比照 POST）。
   （clarify 階段更新，2026-10-21）optional 的 `previousSocketId` 同樣以 `z.uuid()` 驗證、不符 400；它是呼叫端分頁上一次成功綁定此任務的 socketId（POST 送出時的 socketId，或上一次 GET 回 `rebound: true` 時的 socketId），只用於第 3 點的改綁判斷（第 17 條）。
2. `socketId` 不是在線且已授權的連線 → 409（訊息與 POST 相同）。
   （checklist 階段更新，2026-10-21）此 409 的 body 另帶機器可讀 `code: "socket_unauthorized"`，與第 4 點的 `job_bound_elsewhere` 區分，web 才不會把「連線未授權」顯示成「正由另一個視窗接收」；POST 的 409 body 不變（第 23 條）。
3. **先綁定（暫定）**，在任何 await 之前於 `JobRoutingRegistry` 完成（與 POST「綁定必須在任何 await 之前建立」同理，`jobs.service.ts:133-135`），否則查詢回 active 之後、綁定建立之前若剛好 `completed`，那則事件會找不到對象：
   - 綁定不存在（api 重啟後 Map 清空，或已被孤兒回收）→ 暫定建立，指向本次 socketId；（plan 階段更新，2026-10-21）此時 machineId 未知，先以 `machineId: null` 建立，relay 對 null 綁定的 `job/status` 先擱置並記 `deferred`，`Job.fromId` 後補上 machineId、`deferred` 為真就再查一次 state 回應（第 22 條）；
   - 綁定存在、已標記終態（`completed` 或 `failed` 後的 10 s 寬限中，D12）→ 不動，直接視為終態；
   - 綁定存在且原 clientId 已離線（`gateway.isOnline` 為 false）→ 暫定改綁到本次 socketId，記下原綁定以便撤回；
   - （clarify 階段更新，2026-10-21）綁定存在、原 clientId 仍在線但**等於請求帶的 `previousSocketId`**（同一分頁重連、舊連線尚未被心跳回收）→ 比照「已離線」暫定改綁並記下原綁定；**不主動終止舊連線**，交給心跳回收（第 17 條）；
   - 綁定存在且等於本次 socketId → 不動；
   - 綁定存在、原 clientId 仍在線且不等於本次 socketId → **不動、記為「衝突」**，等查詢結果再決定。（clarify 階段更新：且不等於 `previousSocketId`。）
   - （plan 階段更新，2026-10-21）改綁時更新綁定的 `boundAt`，孤兒回收（10 分鐘）自改綁起算（第 44 條）。
4. 查詢 `Job.fromId`：
   - **completed** → 驗 `returnvalue` → 200 `{ status:"completed", result, cached }`；撤回步驟 3 的暫定建立或改綁（**不 rebind**，之後不會再有事件）；衝突者也照常回結果。
   - **failed** → 200 `{ status:"failed", error: failedReason }`；同樣撤回暫定動作、衝突者照常回。
   - **waiting／delayed／active／prioritized** → 衝突者 **409「此診斷仍綁定在另一條連線」**；其餘保留步驟 3 的綁定，200 `{ status:"waiting"|"active", progress?, attempt?, execution?, rebound:true }`。
   - job 不存在（`removeOnComplete` 1 h／`removeOnFail` 24 h 已清）→ Mongo `diagnoses.findOne({ jobId })` → 有則 200 completed（`cached:false`），無則 **404**；兩者都撤回暫定動作。快取命中的 job 不寫 `diagnoses`，1 h 後查不到、回 404——接受（D12）。
   - （clarify／checklist／analyze／實作階段更新，2026-10-21）上面各分支的補充與修正：
     - **completed 但 `returnvalue` 不合法**（舊版 worker、外部寫入）→ 記 warn、退到 Mongo，Mongo 也無合法結果則 404；不回未驗證物件（第 16 條）。
     - **進行中的 state** 補 `waiting-children`（回應的 `status` 歸為 `waiting`）；`getState` 回未列舉的值（例如 `unknown`）**視同 job 不存在**、走 Mongo 分支（spec FR-010）。
     - **衝突者的 409** body 帶 `code: "job_bound_elsewhere"`（第 23 條）。
     - **回 `rebound: true` 前核對 owner**：BullMQ 查詢期間綁定可能已被另一個 GET（例如以 `previousSocketId`）改綁走；回應前確認 `JobRoutingRegistry` 目前的 owner 仍是本次 socketId，不是就與衝突同樣回 409 `job_bound_elsewhere`（實作交叉審查補，見 §7.1）；讀取期間綁定已消失則回 503（合併門第 2 輪，第 62 條）。綁定原本就是本 socket（不動）時也回 `rebound: true`，意思是「之後的事件送到這條連線」（第 43 條）。
     - **終態綁定 × BullMQ 仍進行中** → **503、不重判**：照理不可達（終態事件晚於 state 寫入，registry 禁止改綁終態綁定），不猜測要不要改綁，讓 web 稍後重試；寬限 10 s 過後再查會走「綁定不存在」路徑（data-model §2.4，實作時更新，見 §7.1）。
     - **依賴故障 → 503**：Redis 或 Mongo 不可用、BullMQ 查詢超過 5 s（沿用 `ENQUEUE_TIMEOUT_MS`）或 Mongo 查詢超過 3 s（`maxTimeMS`，合計上限 8 s）→ 503「診斷狀態暫時無法查詢，請稍後再試」，撤回暫定動作；GET 不無上限等待依賴恢復（第 25 條；spec FR-010）。
     - 四種 200 回應都帶 `jobId`，web 比對不符視為格式錯誤（第 24 條）。
5. 撤回只針對本次請求自己做的暫定動作，不刪除別人建立的綁定。
6. 回應 schema 為 `DiagnosisLookupResponseSchema`（以 `status` 區分的 discriminated union）與 query schema `DiagnosisLookupQuerySchema`，放 `http.ts`；query 與成功回應 MUST 以 Zod 定義（本 ADR 與 spec 的要求，不待憲章修訂）。憲章 Principle III 現行條文只列舉 POST，本 ADR **建議**以 `/speckit-constitution` 補成「`POST /diagnoses` 與 `GET /diagnoses/:jobId`」（PATCH 1.6.0 → 1.6.1 的措辭修正）；修訂憲章屬「改流程規則本身」的單向門，**不在使用者離席期間執行**，實際修訂待使用者確認。

| 方案 | 不選的理由 |
| --- | --- |
| **A（選）** GET＋socketId 閘門＋bearer jobId＋「原綁定離線才 rebind」 | 代價：任何已授權連線只要知道 jobId 就讀得到結果；jobId 會出現在 nginx access log 的路徑裡（ADR-002 §6.3 提醒過 query string 進 log），能讀 log 的人可讀結果、可在原連線斷線後接手進行中的 job。demo 的結果是 mock 遙測的診斷，不含機密。（clarify／checklist 階段更新，2026-10-21）`previousSocketId` 同在 query、會進同一份 log，能讀 log 的人也可在原連線**仍在線**時改綁進行中的任務；與 jobId 同一模型、同一曝險面，接受（plan 風險 3；spec FR-034） |
| B GET 只回給「與原綁定相同的 socketId」 | 重連一定拿到新 clientId（Gateway 每次連線 `randomUUID()`），這條規則讓 rebind 永遠不可能，GET 只剩「同一條連線查自己」，解不了重連問題 |
| C POST 回傳一次性 rebind token（HMAC(jobId)），GET 帶 token | 能把「讀結果」從 jobId 分離出來，但 api 要多管一把簽章金鑰（多實例時要共享）、契約多一個欄位、web 要保存 token；沒有使用者身分的前提下，token 與 jobId 一樣存在同一個前端記憶體裡，換不到實質安全 |
| D 不用 HTTP，改 WS 控制訊息 `job/resume { jobIds }` | 不經 nginx 限流、沿用 WS 授權，但要新增第 13 個 channel（client→server）、Gateway 多一種控制訊息與入站限速分類，結果也要經 WS 下發；HTTP 版本可以用 curl 直接驗收，e2e 與排查都簡單 |

來源：第三輪報告 §5.3（`JobRoutingRegistry` 隨 012-lite 抽出）、§5.4（閘門、`Job.fromId`→Mongo→404、原綁定離線才 rebind）、§5.6（jobId 即 bearer capability）；狀態分支、先綁定後查詢與回應形狀為 ADR-003 代理裁決第 3 條（待覆核）；憲章修訂建議為代理裁決第 9 條（實際修訂待使用者）；`returnvalue` 不合法退 Mongo 為第 16 條、`previousSocketId` 為第 17 條、null 綁定與 `deferred` 為第 22 條、409 `code` 為第 23 條、回應帶 `jobId` 為第 24 條、503 為第 25 條、`rebound` 恆為 true 為第 43 條、改綁更新 `boundAt` 為第 44 條（皆待覆核）；owner 核對與終態 × 進行中回 503 為實作階段補（§7.1，待覆核）。

### D9. nginx 對 GET 的限流

`apps/web/nginx.conf:86-90` 的 `location /diagnoses` 是前綴匹配，GET `/diagnoses/<uuid>` 會共用 POST 的 `limit_req zone=diag`（10 r/m、burst 5）。web 重連時最多 5 台同時 GET、2 s 未送達與 watchdog 也各會 GET 一次，加上使用者接著按「重試」的 POST，會在同一個桶裡互搶，使用者看到「診斷請求過於頻繁」。

**定案**：新增 `limit_req_zone $binary_remote_addr zone=diag_read:1m rate=60r/m;` 與 `location ~ "^/diagnoses/[0-9a-fA-F-]{36}$" { limit_req zone=diag_read burst=10 nodelay; limit_req_status 429; … }`（regex location 優先於前綴 location；location 比對不含 query string，`?socketId=` 不影響），POST 維持原桶。新 location 沿用 `/diagnoses` 的 `proxy_pass http://$api_upstream;` 寫法，且**不寫 `add_header`**，才會繼承 server 層的安全 header（`nginx.conf:44-45` 的繼承規則）。理由：讀取是冪等、成本低（一次 Redis HGETALL、最多一次 Mongo `findOne`），60 r/m 足以涵蓋 5 台重連＋退路；仍保留上限，避免被拿來掃 jobId（UUID v4 也掃不出來）。Docker Desktop 下全體共用一桶的既有限制不變（ADR-002 §6.5）。

| 方案 | 不選的理由 |
| --- | --- |
| **A（選）** GET 獨立 location 與限流區 | — |
| B 共用 POST 的桶 | 見上：重連後重試拿 429 |
| C GET 不限流 | nginx 是 GET 唯一的流量上限（api 端無 HTTP 限流），不限等於讓單一來源可無上限打 Redis／Mongo |

來源：ADR-003 代理裁決第 8 條（待覆核；報告未提 nginx 前綴匹配的問題）。

### D10. web 的收斂規則

- **三種到達順序收斂到同一狀態**：(1) `ai/done` → `completed+result`；(2) `completed+result` → `ai/done`；(3) `completed`（無 result）→ 2 s → GET → （遲到的 `ai/done`）。三者都在第一個結果到達時轉 completed，`result`、`cached` 相同，之後的忽略；耗時只結算一次、螢幕閱讀器公告只一次。
- **onReconnect 要等授權成功才 GET**：App 在 `system/connected` 就呼叫 `onReconnect`（`App.vue:273-277`），但有設 `WS_AUTH_SECRET` 時新連線要等 `machine/subscribed` 才算已授權（`useHighFrequencyWs.ts:50-53`），太早 GET 會被 409、任務被誤判中斷。定案：`onReconnect` 只記下「哪些 active 任務需要續接」並把它們標為「重新連線中」（仍是 active，不轉失敗），`onAuthResult(true)` 時才逐台 GET；GET 回 completed／failed 照轉，active／waiting 留在 active 並重設 watchdog；404、409、網路錯誤與 429 轉失敗，文案依 spec 的 UI 接點表（404：「連線中斷期間的診斷結果已無法取回，請重試」；409：「這個診斷正由另一個視窗接收，請在該視窗查看或重試」；其他：「連線中斷，請重試」）。（整理時修正：草稿此處把四種回應一律寫成「連線中斷，請重試」，與接點表 #7 不一致，以接點表為準。）
  （clarify／checklist 階段更新，2026-10-21）續接細節：
  - 觸發點為 store action `onAuthorized(socketId)`，App 於 `onAuthResult(true)` 呼叫；同一連線多次 `machine/subscribed` 只消化一次待續接清單（第 41 條）。重連後授權失敗時續接 GET 不發出，任務維持「已重新連線，正在取回診斷狀態…」，由 45 s watchdog 承接（D11，第 47 條）。
  - web 對每個任務記住最後一次成功綁定的 socketId（POST 送出時的 socketId，或 GET 回 `rebound: true` 時的本次 socketId），所有 GET 都以 `previousSocketId` 帶上（第 17、43 條）；任務設「執行期間經歷過重連」旗標，收尾時供 D13 判斷，任務結束前不清除（第 20 條）。
  - 失敗對映改為：GET 回 failed → 依 `humanizeError(error)` 轉失敗；404 →「連線中斷期間的診斷結果已無法取回，請重試」；409 **依 body 的 `code` 分流**：`job_bound_elsewhere` →「這個診斷正由另一個視窗接收，請在該視窗查看或重試」，`socket_unauthorized` 與 **503**、429、網路錯誤、逾時、回應格式不符 →「連線中斷，請重試」（第 23、25 條；spec FR-016、FR-035）。
  - GET 收尾的耗時以 `recovered` 記錄，不作為「上一次非快取耗時」的對比基準（含斷線時間，第 37 條）。
- **2 s 未送達先 GET 一次**：`completed` 不帶 result（舊版 api／returnvalue 驗證失敗）時，2 s 寬限到期先 GET；GET 回 completed 就完成，否則才轉現行的「結果未送達」失敗。
  （analyze 階段更新，2026-10-21）「否則」細分為：GET 回 **failed** → 依 `humanizeError(error)` 轉失敗（與 D11 的 watchdog 退路同一規則；此失敗不屬「結果未送達」、不可被救回，spec FR-005）；GET 回 **waiting／active**（理論上不會發生：`completed` 已到）、404、409、503、429、網路錯誤、回應格式不符 → 才轉「結果未送達」（第 42 條）。已轉「結果未送達」之後，同 jobId 的結果再抵達仍救回為「已完成」（第 15 條；見 D3 的更新段）。
  （合併門第 2 輪更新，2026-10-22）WS 斷線期間跳過 2 s 退路，交由重連 → 授權 → 續接收尾（第 63 條）；救回來源的實際範圍見 D3 的更新段（第 55 條）。
- **attempt** 改由 `job/status.attempt` 推進；`ai/token` 的 attempt 判斷保留（換輪清空邏輯不變）。`MAX_ATTEMPTS`（`CopilotDrawer.vue:134`）收進 contracts 屬 010-lite，本 feature 不動。

來源：第三輪報告 §5.4（`completed` 帶 result 即收尾、`onReconnect` 先 GET、Attempt 改用 `job/status.attempt`）；授權後才 GET、2 s 退路與失敗文案為 ADR-003 代理裁決第 10、11 條；救回為第 15 條、`previousSocketId` 為第 17 條、重連旗標為第 20 條、409 `code` 為第 23 條、503 為第 25 條、`recovered` 耗時為第 37 條、`onAuthorized` 為第 41 條、2 s 退路回進行中轉「結果未送達」為第 42 條、`rebound` 恆為 true 為第 43 條、授權失敗交給 watchdog 為第 47 條（皆待覆核）。

### D11. 逾時語意「結果未知」

45 s watchdog 觸發時先 GET 一次：completed → 完成（照常公告）；仍在進行 → 維持 active、重設 watchdog（後端還在跑，只是 45 s 沒送事件，表示 keepalive 失效，記一則 console 警告）；其他 → 轉失敗，文案改為「超過 45 秒沒有收到進度，結果未知，請重試」（取代「診斷逾時或無回應，請重試」）。理由：012-lite 之後 worker 活著就有 keepalive，watchdog 只會在「worker 死了且沒人重派」或「整條即時通道壞了」時觸發，兩種情況後端都可能其實已經完成；不查一次就宣告失敗，會讓使用者對一個已完成的診斷按重試。

（analyze 階段更新，2026-10-21）上段的「其他」細分為：GET 回 **failed** → 依 `humanizeError(error)` 轉失敗（與 D10 的 2 s 退路同一規則）；404、409（兩種 `code`）、**503**、429、網路錯誤、回應格式不符 → 才用「超過 45 秒沒有收到進度，結果未知，請重試」（spec FR-022）。由這裡承接的情況另有兩種：重連後 WS 授權失敗、續接 GET 沒發出的任務（GET 以 409 `socket_unauthorized` 失敗 → 「結果未知」文案，第 47 條）；api 重啟時正在限流延後的 job 不補送 `waiting`，45 s 後 GET 得到 waiting、維持進行中（第 38 條）。Redis 整個凍結超過 45 s 時 GET 回 503 → 「結果未知」，Redis 恢復後後端照常完成並寫快取，使用者按重試以新 jobId 命中快取（research R13）。

watchdog 維持牆上時鐘（ADR-002 §6.5.1「45 s watchdog 仍用牆上時鐘」列留在 backlog）：觸發後先 GET，時鐘往前跳造成的誤觸會得到「仍在進行」而不轉失敗，改單調時鐘的收益因此更小。

（合併門第 2 輪更新，2026-10-22）WS **斷線**期間 watchdog 凍結、不觸發，交由重連 → 授權 → 續接 GET 收尾；已連線但未授權時照常觸發（第 47 條仍成立）。理由：斷線時以舊 socketId 發的 GET 必失敗，會把已完成的診斷誤標「結果未知」且重連後不再續接（第 63 條）。代價：長時間斷線時任務停在「進行中」，頂部橫幅顯示斷線、可中止。

來源：第三輪報告 §5.6（逾時語意為「結果未知」）；GET 一次、文案與不改單調時鐘為 ADR-003 代理裁決第 7 條；503 為第 25 條、delayed 不補送為第 38 條、授權失敗交給 watchdog 為第 47 條（皆待覆核）。

### D12. 其餘小決定

- **快取命中的 job 1 h 後 GET 回 404**：快取命中不寫 `diagnoses`（避免同一份結果複製多筆，`processor.ts:254-256`），`returnvalue` 隨 `removeOnComplete` 1 h 消失。接受：重連續接的時間尺度是秒到分鐘，1 h 後的 GET 只會來自手動查詢。若要涵蓋，可把 `result` 寫進該筆 trigger，代價是 `diagnosisTriggers` 變大（30 天 TTL）。
- **POST 的 jobId 冪等延伸到 1 h 之後**（API-16）：job 被 `removeOnComplete` 清掉後，同 jobId 的 POST 會重新入列；012-lite 之後 processor 開頭的 `findByJobId` 會直接回舊結果，不打 LLM——語意上正是「同 jobId＝同一個請求」，不需另外改 POST。
- **失敗終態**：`failed` 仍只帶 `failedReason` 原文，具體錯誤碼要等 010-lite 的 `AiErrorCode`；`maxStalledCount` 用盡時的 `failedReason` 是英文 `job stalled more than allowable limit`，web `humanizeError` 對 < 120 字的英文原文會照顯（`copilot-reducer.ts:110`），012-lite 補一條對映（文案見 D13）。（已變更：`fix/20261022-ui-humanize-error-zh` 起未知的英文原文不再照顯、改顯通用句並收進「技術細節」，現況見指南 §15.6「失敗訊息英文後援改繁中」；這條對映仍需要，固定句才不會退成通用句。）
- **失敗終態的 relay 寬限**（ADR-002 §6.5.1「review03 新增：失敗終態沒有 relay 寬限」列，由 012-lite 收掉）：`failed` 終態套用與 `completed` 相同的 10 s 綁定寬限，由 `JobRoutingRegistry` 的同一段終態寬限程式處理（2.1.0 的 `markCompleted`／`COMPLETED_BINDING_GRACE_MS` 一般化為兩種終態共用）。理由：`ai/error` 走 Pub/Sub、`failed` 走 QueueEvents，跨連線的先後與 `ai/done`／`completed` 一樣沒有保證；`failed` 先到時綁定即刪，worker 送的具體錯誤碼（`persist_failed`、`provider_error` 等）送不到原連線，畫面只看到 api 補送的籠統 `ai/error(worker_failed)`——012-lite 新增的 `persist_failed` 文案就會被這條吞掉。寬限內同 jobId 的 POST 回 409，與綁定已刪時 `enqueueOnce` 查到既有 job 的 409 相同（`jobs.service.ts:116-123`），對 POST 沒有新行為；寬限內的 GET 依 D8 視為終態。

來源：前三點為 ADR-003 補充，隨定稿採用（不在代理裁決條目內，待覆核）；失敗終態寬限為 ADR-003 代理裁決第 12 條（待覆核）。

### D13. 驗收方法與 UI 接點

- **e2e 的 Redis 停頓方式**：`docker compose pause redis` 50 s 後 `unpause`，斷言該 jobId 的 `diagnosisTriggers` 恰 1 筆、LLM 呼叫恰 1 次、hit／miss 合計恰 1 次、最終 `cached` 為 false。理由：它凍結整個 Redis 行程（含 lock 續租與 stalled 檢查的回應），對應的是真實世界的主機／VM 停頓；harness 的 `compose()` 已能直接呼叫，不需新工具。`redis-cli CLIENT PAUSE` 只擋客戶端指令、Redis 本身照常運作，與 key 到期及 Lua 腳本的互動依模式（`WRITE`／`ALL`）而異，要另外驗證才能確定重現的是同一種故障。
  （checklist／analyze／實作階段更新，2026-10-21）場景 7 MUST 斷言停頓確實造成重派（該 jobId 收到 `job/status` `reason: "stalled"` 或 `execution ≥ 2`），沒有重派視為「未重現 AR-4」、不放寬判準（第 48 條）；停頓在收到該 jobId 第 3 個 `ai/token` 之後才開始，並印出重派那次 `idempotent short-circuit` 的 `source` 作為短路吸收重派的證據（第 46 條）。場景 3b（首 token 前 SIGKILL）以收到 `job/status` progress 20 為 kill 觸發點（第 45 條），e2e 的 fake provider 以 `FAKE_AI_FIRST_TOKEN_DELAY_MS=2000` 延遲第一個 token，讓 kill 確實落在首 token 前（第 51 條）。
- **UI 文案**：採 spec 的「與 013 UI 的接點」表。原始串流標題以「是否以 `job/status`／GET 收尾」判斷，收尾即標「原始串流（不完整）」，不比對 `seq` 與結果；（clarify 階段更新，2026-10-21）**或執行期間經歷過 WS 重連**（不論收尾來源，含 `ai/done`；第 20 條）也標「不完整」，判斷只看收尾來源與重連旗標；同簽章失敗標記命中時沿用既有錯誤分類文案、不加後綴；卡片的診斷 chip 不新增種類，重派、取回、重連續接都屬「診斷中」，只在面板內用說明行交代。「重新派送」說明行只在 `reason: "stalled"` 時出現（見 D7）；`execution` 因重試或限流延後遞增時只清空串流、不顯示這行。`maxStalledCount` 用盡（`failedReason` 為英文 `job stalled more than allowable limit`，D12）時，web `humanizeError` 對映為「後端處理程序多次中斷，診斷已停止，請重試」，不照顯英文原文。畫面不出現「worker」「stalled」字樣；「停滯」保留給機台資料 10 秒未更新，不拿來形容診斷任務。（clarify 階段更新，2026-10-21）說明行的「第 N 次執行」在收到 `reason: "stalled"` 時先估 `(目前 execution ?? 1) + 1`，再由下一則帶 `execution` 的 `job/status` 校正（第 36 條）；`persist_failed`（`ai/error.code`，或 `failed` 原因含該字樣）對映「診斷結果無法寫入資料庫，請稍後重試」（第 18 條）；PRODUCT.md 的新術語為「重新排入佇列（內部稱重新派送）」「取回」「結果未知」（spec FR-036）。

來源：e2e 停頓方式為 ADR-003 代理裁決第 6 條（待覆核）；UI 文案為代理裁決第 10 條、「重新派送」只看 `reason` 為第 13 條；`persist_failed` 文案為第 18 條、重連旗標為第 20 條、第 N 次執行為第 36 條、3b kill 時點為第 45 條、場景 7 停頓觸發點為第 46 條、SC-004 須證明重派為第 48 條、fake 首 token 延遲為第 51 條（皆待覆核）。

---

## 4. 接受的代價（Trade-offs）

| 代價 | 如何承擔 |
| --- | --- |
| lock 15 s 讓 Redis 卡頓或 worker 事件迴圈卡住超過 15 s 就觸發 stalled 重派，雙重執行比現在常見 | D6 冪等讓重複執行對外結果一致；`maxStalledCount` 2 留一次額度給真的崩潰 |
| （實作階段改寫，2026-10-21）Redis 停頓**開始於 exec1 取得 `ai-lock` 之後、發出 LLM 請求之前，且停頓超過 `AI_DEDUPE_LOCK_SECONDS`（預設 45 s；e2e 20 s）**時，stalled 重派的 exec2 在 `ai-result` 短路查不到結果（exec1 還沒拿到 LLM 回應），又取得已過期的 `ai-lock`，與恢復後繼續執行的 exec1 各打一次 LLM。兩次結果可能不同：`diagnoses` 留先寫者（jobId unique），exec2 的 `returnvalue`／`ai/done` 帶它自己的結果，所以畫面顯示的結果可能與 `diagnoses` 那筆不同。（原寫法「停頓超過 45 s 且正好發生在 LLM 串流中」：有了 `ai-result` 短路後，停頓落在 LLM 請求送出之後時，exec1 會在停頓期間收完串流，恢復後它的 SET `ai-result` 領先 exec2 的短路查詢至少 1 個 Redis 往返，exec2 在短路 (i) 命中，不雙打——第 46 條） | 罕見（停頓要剛好開始在取鎖到送出 LLM 請求之間的幾個 Redis 往返內，且長於 45 s）；記為殘餘風險，不為它加第二把鎖（D3 方案 B 的理由）。另一種「不雙打、但 exec2 在快取命中時把權威 `completed` 標成 `cached:true`」的情況（前一次執行在 exec2 等鎖期間落地）已由第 49 條吸收：再執行命中快取前先查自己的結果。實測（e2e 第 3 輪，2026-10-21）：兩次皆為短路 (ii) `diagnoses`——exec1 解凍後在 exec2 查詢前已寫庫並 DEL 暫存；判準不受影響（LLM 恰 1 次、trigger 1 筆照樣成立）（第 46 條） |
| Pub/Sub 斷線**且** worker 在串流中被 SIGKILL 時，畫面最長無事件約 55 s，會觸發「結果未知」 | 複合故障，接受、不加機制（代理裁決第 14 條）；觸發後先 GET，重派完成後仍可由重試或 GET 取回（D2 殘餘風險註） |
| `failed` 後綁定保留 10 s，寬限內同 jobId 的 POST 回 409 | 與綁定已刪時查到既有 job 的 409 相同，對 POST 沒有新行為；換到的是具體錯誤碼能送到原連線（D12） |
| `ai/done` 會重複、仍可能遺失；自寫 WS client 要以 jobId 去重 | 契約描述明寫（D3）；`CHANGELOG.md` 相容性注意列出 |
| `ai-fail` 讓同簽章的其他請求在 10 s 內直接拿到同一個錯誤，不給它們自己再試的機會 | 只發生在供應商剛失敗的 10 s 內；錯誤碼與持鎖者相同，畫面文案可讀；省下的是 N × 3 次計費呼叫 |
| GET 讓任何已授權連線憑 jobId 讀結果；jobId 會進 nginx access log | 沒有使用者身分的前提下無從更細；log 的保存與存取屬部署面（ADR-002 §6.3 生產路徑：握手驗身分後改以使用者為授權主體） |
| Redis 寫入量增加：lock 續租計時器每 `lockRenewTime/2` 約 3.75 s（最慢 7.5 s；原約 7.5 s／最慢 15 s；合併門第 2 輪更正，原寫「每 7.5 s（原 15 s）」）、stalled 檢查每 5 s（原 30 s）、keepalive 每 10 s、`ai-metric`／`ai-result`／`ai-fail` 三種新鍵 | demo 規模（concurrency 個位數、一分鐘數次診斷）可忽略；新鍵都有 TTL，不受 `noeviction` 影響長期記憶體 |
| （合併門第 2 輪補，2026-10-22）ioredis `commandTimeout` 逾時的指令**仍會在 Redis 恢復後執行**：`SET ai-metric:<jobId> NX` 逾時後仍生效時，該次執行以為沒搶到、其他執行又搶不到，這個 jobId 的 hit／miss 計 0 次；逾時的 `tryAcquireLock` 實際寫入時，留下一把沒人持有、也沒人釋放的 `ai-lock:<sig>`，同簽章的請求要等它過期（`AI_DEDUPE_LOCK_SECONDS`，預設 45 s） | 已知限制，只在 Redis 停頓長於 `commandTimeout` 時發生；計數少一次只影響指標，殘留的鎖由 TTL 回收、等待者有 keepalive 撐著 watchdog。要根治需讓逾時的指令可撤銷（改用帶 token 的 Lua 檢查或停頓後重驗），未排程 |
| （合併門第 2 輪補）**失去 lock 的舊執行仍會送事件**：stalled 重派後，舊執行若還活著（Redis 停頓而非崩潰），它的 keepalive、`updateProgress` 與 `ai/token` 照常送出。web 對 progress 以 `execution` 單調處理（舊執行的較小值被略過），但 `ai/token` 不帶 `execution`，兩次執行的串流文字可能交錯 | 結果正確（以第一個完成為準，且重派過的任務標「原始串流（不完整）」）；只影響原始串流的可讀性。backlog：worker 監聽 `lockRenewalFailed` 時停 keepalive 並 abort LLM 呼叫，或 `ai/token` 加 `execution`（契約變更） |
| （合併門第 2 輪補）**去重鎖的收尾餘裕只有 5 s**：啟動驗證只要求 `AI_DEDUPE_LOCK_SECONDS × 1000 ≥ AI_TIMEOUT_MS + 5000`；LLM 用滿 `AI_TIMEOUT_MS` 後，`insertDiagnosis` 最長 20 s（`socketTimeoutMS`）再加 012 新增的兩次 Redis 往返（SET／DEL `ai-result`），MongoDB 變慢時 `ai-lock` 可能在寫快取前過期，等待者取得鎖後會再打一次 LLM | 012 之前即存在（012 只多了兩次往返）；預設 30 s／45 s 下正常情況遠低於上限。要根治需把餘裕改為涵蓋寫庫上限，或寫庫前續租 `ai-lock`，未排程 |
| 打字機動畫在重連後不會續播，只直接出現最終結果 | 這是拒絕 Streams 的直接後果；結果完整、只少過場（ADR-002 §6.2 原本就把它定義為「動畫的過場」） |
| 快取命中的結果 1 h 後無法以 GET 取回（404） | 重連續接的時間尺度是秒到分鐘；寫進 `PRODUCT.md` 已知產品限制 |
| BullMQ job hash 的 `progress` 改為物件 | 只影響直接看 BullMQ 資料的人；relay 同時接受數字（舊版 worker） |

---

## 5. 什麼情況下這個決策會被推翻

- **需要第二個 api 實例**：綁定（`JobRoutingRegistry`）在行程內，rebind 只在收到 WS 的那一台成立；屆時 registry 外置 Redis，並重看 ADR-001／ADR-002 §6.1。
- **需要逐 token 可回放**（例如要保存並重播 AI 的推理過程、或斷線續播動畫成為產品需求）：Redis Streams（或 token 落地＋offset 續傳）重新評估。
- **BullMQ 升 6.x**：`returnvalue`、`stalled` 事件、`attemptsStarted`、`moveStalledJobsToWait` 的語意需逐項重驗（報告 §5.5 已提 BullMQ 6.3.9 待評估）。
- **`AI_TIMEOUT_MS`、`lockDuration`、`stalledInterval` 或 keepalive 任一調整**：D4 的上界要重算；watchdog 門檻若改由 `system/connected` 下發（010-lite），公式要寫進該處。
- **`removeOnComplete` 縮短到分鐘級**：GET 的第一來源失效時間跟著縮短，快取命中的 job 很快就 404，要改為把結果寫進 trigger。
- **改用真實多使用者身分**：「jobId 即 bearer capability」改為以使用者為授權主體，GET 與 rebind 規則重寫。

---

## 6. 與其他真實來源的關係

依 CLAUDE.md「跨 Feature 決策 MUST 回補真實來源」，下列各處在 012-lite merge 回 `develop` 前 MUST 回補；未回補前本 ADR 的決策視為「未落地」。回補時不重寫歷史：原敘述保留、改過去式並標「已落地／已變更，現況見 ADR-003」。

- [x] **ADR-002 §6.2「生產路徑：改用 Redis Streams」**：改寫為「已拒絕（2026-10-21，ADR-003）：結果改以 BullMQ `returnvalue`＋`job/status.result`＋`GET /diagnoses/:jobId` 取回；token 串流維持 at-most-once，重連後直接顯示結果、不續播動畫」；「已變更」註記的「Streams 降為備選」收斂為「已由 ADR-003 定案拒絕」；「更正」段的「目前沒有任何結果讀取端點」標已落地。
- [x] **ADR-002 §3 第 5 列（Streaming 可靠性）**：後段加「已變更（012-lite）：已有讀取端點與 rebind，完成以 `returnvalue` 為權威；token 串流仍 at-most-once」。
- [x] **ADR-002 §6.5「結果讀取與完成語意」列**：現況改為「已落地（012-lite，ADR-003）」並一句摘要（`returnvalue` 權威、GET＋rebind、`stalled` 監聽帶 `reason`、keepalive 10 s、lock 15／5／2）；92 秒實測改為過去式；升級路徑改指 ADR-003 §5。
- [x] **ADR-002 §6.5「api 行程內單實例狀態」列**：升級路徑「`jobRooms` 的 owner 先移到獨立 `JobRoutingRegistry`」改為「已移（012-lite），外置見 ADR-003 §5」。
- [x] **ADR-002 §6.5.1 WK-4／AR-F4 列**：標「已落地（012-lite）」：processor 開頭以 jobId 查 `ai-result:<jobId>`／`diagnoses`、`persist_failed` 經 `fail()` 送出、trigger 冪等；`cached:true` 誤標子項一併修掉。
- [x] **ADR-002 §6.5.1「review03 新增：失敗終態沒有 relay 寬限」列**：標「已落地（012-lite，ADR-003 D12）」：`failed` 終態套用與 `completed` 相同的 10 s 綁定寬限；原「使用者 2026-10-18 裁決接受」改為過去式保留。
- [x] **ADR-002 §6.5.1 末尾**：補一列「review03 roadmap 012-lite：已落地」，列 AR-4、AR-S7、WK-13、WK-4 補強、AR-5 根治（含失敗終態寬限）、WK-20、WEB-20（attempt 部分）、DOC-29，指向 ADR-003 與 `CHANGELOG.md`（現況這幾項沒有獨立列，只出現在 `CHANGELOG.md` `[2.1.0]` 與指南 §15.6 裁決 15）。
- [x] **ADR-002 §6.1 單實例狀態第 4 項**：由「`jobRooms`（`AiStreamRelayService`：jobId → 接收者綁定）」改為「`JobRoutingRegistry`（jobId → 接收者綁定、完成寬限、rebind；012-lite 自 `AiStreamRelayService` 抽出）」。
- [x] **指南 §15.5「Redis Streams token 回放」候選方向**：段末加「已變更（2026-10-21，ADR-003）：已拒絕」註記，指向本 ADR 與 §15.7（與 §15.7 藍圖同批加入）。（2026-10-21 立案時已加。）
- [x] **指南新增 §15.7 012-lite 藍圖（DOC-16）**：立案前加入。（2026-10-21 立案時已加。）
- [x] **指南 §15.7 落地回補**（merge 時完成）：§15.7 狀態改「已落地」；§15.6 的「e2e 實測發現（留給 012-lite）」條加「已落地（012-lite）」註記。（T075 對齊 spec FR-039 補，2026-10-21）§15.6「1.0.0 之後的現況摘要」補 012-lite 一段。
- [x] **指南 §2 架構圖下的現況註記**（合併門第 1 輪補，2026-10-22）：「`JobsController` 只有 `POST /diagnoses`…也沒有任何結果讀取端點」原文保留，其後加「已變更（012-lite，2026-10-21）：已有 `GET /diagnoses/:jobId`…」，並補 Redis 新增的三種鍵。
- [x] **指南 §16.3 第 6 列、§17「streaming 推不到前端」列**（T075 對齊 spec FR-039 補，2026-10-21）：§16.3 第 6 列「目前無結果讀取端點」改寫為「已有 `GET /diagnoses/:jobId`（012-lite）」；§17 該列的「重連後舊 jobId 不會改綁」改寫為「重連以 jobId 續接（GET＋rebind），原連線仍在線且不等於 `previousSocketId` 時不改綁」。
- [x] **README「已知限制」**（README:888 起；注意這四條在「已知限制」，不在「已宣告的取捨」）：「重連不 rebind」改為「重連以 jobId 續接（GET＋rebind），原連線仍在線時不改綁」；「診斷結果目前沒有讀取端點」改為「快取命中的結果 1 小時後無法以 GET 取回」；「worker 崩潰後的重派有長時間靜默」改為「設計上界約 35 秒無事件，超過 45 秒才標『結果未知』」；「AI token 串流為 at-most-once」保留但改寫為「重連後直接顯示結果、不續播」；「第三輪審查的現況」條把 AR-4、AR-S7、WK-13、WK-4 補強、AR-5 根治從「仍未修」移到「已修（012-lite）」。（T075 對齊 spec FR-039 補，2026-10-21）另新增兩條：「重新整理頁面後不續接進行中的診斷（再按一次診斷會命中快取或等待同簽章的去重鎖）」（第 19 條）；「jobId 與 `previousSocketId` 會進 nginx access log 的路徑與 query，能讀 log 的人可讀已完成結果、並可在原連線仍在線時改綁進行中的任務」（plan 風險 3）。
- [x] **README 資料表**：`diagnoses`（README:468）的「目前只寫不讀」改為「api 經 `GET /diagnoses/:jobId` 讀取（`returnvalue` 過期後的第二來源）」；`diagnosisTriggers` 補「`jobId` unique，每個 jobId 一筆」；Redis 職責清單補 `ai-fail:*`／`ai-result:*`／`ai-metric:*`。
- [x] **README 契約版本字串**：1.3.0 → 1.4.0（README:19、289、400、544、842 等；`docs-contract-version.test.ts` 會比對）；nginx 限流敘述補 GET 的 60 r/m 獨立桶；BullMQ 參數具名常數的說明。
- [x] **`apps/web/PRODUCT.md` 已知產品限制（:77）**：改為「AI token 串流 at-most-once（重連後不續播動畫，直接顯示結果）、快取命中的結果 1 小時後無法以 GET 取回、Mock 頻率控制無後端作用」（Mock 那條保留）；失敗段（:54）「只在後端完成後約 10 秒內、而且中間沒有重連時才救得回來」改寫為新規則（2 s 退路先 GET）；新增術語（重新派送、取回、結果未知）補進 PRODUCT.md。（T075 對齊 spec FR-039／FR-036 更新，2026-10-21）已知產品限制另補「重新整理頁面後不續接進行中的診斷（再按一次診斷會命中快取或等待同簽章的去重鎖）」（第 19 條）；術語改為「重新排入佇列（內部稱重新派送）」「取回」「結果未知」。
- [x] **`tests/e2e/README.md` 場景 3**：「反映的現況語意」改寫為新語意（relay 監聽 `stalled` 並送 `reason`、最長無事件間隔斷言 < 45 s、attempt／execution 由 `job/status` 帶）；「注意」段補 GET 走獨立限流桶、新增的故障場景與耗時。
- [x] **`tests/e2e/README.md` 場景 3 的現況語意改為新實測**（實作交叉審查補，2026-10-21）：場景 3 那段寫的數字（舊的 92 s 重派、無事件間隔）改為 T080 實測的 `maxGap`、`W` 與 3a／3b 的觸發點（3b 依第 51 條的 `FAKE_AI_FIRST_TOKEN_DELAY_MS`）；與上一項同一段落，上一項改語意描述、這一項換實測值。
- [x] **`asyncapi.yaml` 與 `CHANGELOG.md`**：`info.version` 1.4.0；`job/status` 描述（DOC-29 的 "optionally carrying the final result" 改為實際行為）、`ai/done` 描述（D3）；`CHANGELOG.md` 契約小節記 1.4.0，相容性注意記「`ai/done` 可重複可遺失」「BullMQ `progress` 改為物件」「lock 參數」，並把 `[2.1.0]` 帶著發布的 012-lite 項標為已修。
  （T075 對齊 spec FR-033／FR-034 更新，2026-10-21）`asyncapi.yaml` 另補 `ai/error.code` 已知值 `persist_failed`，GET 409 兩種 `code` 的語意記於 `info.description`。相容性注意改為 FR-034 的 7 條：(1) `ai/done` 可重複、可遺失，自寫 client 須以 jobId 去重；(2) BullMQ job 的 `progress` 改為物件；(3) BullMQ lock 參數 15／5／2；(4) 新增 `GET /diagnoses/:jobId`（含 409 的兩種 `code`、503、nginx 獨立 60 r/m 桶）；(5) `job/status` 新增 optional `attempt`／`execution`／`reason`／`cached`，`completed` 帶 `result`；(6) 升級順序先 api、後 worker（web 不限），反過來時進度條退化為不確定進度；(7) jobId 與 `previousSocketId` 會出現在 nginx access log 的路徑與 query，能讀 log 的人可讀已完成結果、並可在原連線仍在線時改綁進行中的任務（plan 風險 3，接受）。`[2.1.0]` 原文不改寫，只在該條末加「已修，見 [Unreleased]」註。
- [x] **009 `specs/009-observability-baseline/contracts/log-fields.md` §3**（實作交叉審查補，2026-10-21）：api context 清單加 `JobRoutingRegistry`（孤兒回收的 warn 由 relay 移入 registry，context 跟著變）。
- [x] **`specs/012-stream-resilience/contracts/diagnosis-lookup.contract.md` §8**（實作交叉審查補，2026-10-21）：`DiagnoseLookupError` 補 `kind`（`http`／`network`／`timeout`／`invalid`；`status` 只在 `http` 時必有、`code` 只在 409 時讀 body），與 `diagnose-api.ts` 實作一致。
- [x] **`specs/012-stream-resilience/data-model.md` §5 步驟 10 的「失敗時」欄**（實作交叉審查補，2026-10-21）：改為逐步寫清楚——SET `ai-result` 失敗只 warn、照常寫庫（第 50 條）；`insertDiagnosis` 失敗 → `persist_failed`；DEL `ai-result`、DEL `ai-fail` 失敗只 warn、由 TTL 回收；SET `ai-cache`、`upsertTrigger` 等其他寫入失敗 → 拋出 → 重試（下次步驟 2 或 3 短路）。
- [x] **research P24／P25 措辭**（實作交叉審查補，2026-10-21）：`specs/012-stream-resilience/research.md` P24「fake 第一個 token 約在 progress 40 後 500 ms」與實作不符，改為「fake 首 token 無延遲，e2e 以 `FAKE_AI_FIRST_TOKEN_DELAY_MS=2000` 拉開窗口」（第 51 條）；P25「SET `ai-result` 先於 exec2 的冪等短路查詢」改為「領先至少 1 個 Redis 往返」（第 46 條）。spec SC-004 末段與 `tests/e2e/src/worker-kill.e2e.test.ts` 檔頭註解有同一句，一併改。
- [ ] **憲章 Principle III**（**待使用者**）：建議 `/speckit-constitution` PATCH（1.6.0 → 1.6.1）補列 `GET /diagnoses/:jobId`；離席期間不執行，由使用者確認後才修訂。merge 前若仍未確認，在 spec 與本 ADR 保留「建議修訂、待使用者」的註記，GET 的 Zod 定義照做。（2026-10-22 合併門第 1 輪：保留未勾——憲章修訂待使用者確認）
- [ ] **repo `CLAUDE.md` 開頭的現況段**：立案時改為「進行中：012-lite」，落地後改為最近一次完成。（2026-10-22 合併門第 1 輪：保留未勾——merge 時改（T076））

---

## 7. 代理裁決清單（2026-10-21，使用者離席期間，待覆核）

使用者離席期間授權對 012-lite 的技術決策採建議項，逐題記錄如下（第 1～11 條為首批，第 12～14 條為整理定稿時發現的矛盾與缺口，經協調者同日補裁；第 9 條同日改寫為「只建議、不在離席期間修訂」；第 15～16 條為 specify 階段補裁、第 17～21 條為 clarify 階段補裁；第 22～46 條為 plan 階段自行決定的設計點（`specs/012-stream-resilience/research.md` 文末 P1～P25，第 n 條＝P(n−21)；P25 為 analyze 階段補）、第 47～48 條為 checklist 階段推導（`checklists/resilience.md` Notes 第 3 點）、第 49～51 條為實作交叉審查補裁，三批皆於 T075 補錄（spec FR-040）；第 52～54 條為 web 交叉審查補裁（US2），皆同日；第 55～56 條為 2026-10-22 合併門第 1 輪 web 審查補裁、第 57 條為同輪契約／文件審查補裁；第 58～63 條為合併門第 2 輪補裁——58～60 worker 審查、61～62 api 審查、63 web 審查）。**第 1 條與第三輪報告的建議不同**，覆核時請優先看；第 45 條的前提已由第 51 條更正，兩條請一起看。覆核後若有推翻，於本節記為推翻紀錄（原提案／裁決），並移除檔頭的「待覆核」註。**2026-10-22 使用者覆核**：第 1、9、17、63 條與 §7.1 全部待覆核點（T081 除外）逐題確認，皆維持／接受（各條下「覆核」行）；第 9 條落地為憲章 1.6.1。其餘條待下次覆核。

**1. BullMQ lock／stalled／maxStalled 與 keepalive 間隔**（D4）
- **覆核**：2026-10-22 使用者覆核——維持 15／5／2＋keepalive 10 s。
- 影響範圍：worker 被強制終止（SIGKILL、OOM）後，AI 診斷面板多久看到「重新派送」說明或結果、45 秒「結果未知，請重試」是否誤觸；worker 的 BullMQ Worker options（README 常數說明）；Redis 寫入頻率。
- 裁決：lock 15 s／stalled 5 s／maxStalled 2、keepalive 10 s。**與第三輪報告不同**（報告 15／10／2）。
- 理由：報告值在 keepalive 10 s 下最壞無事件時間是 10＋15＋2×10＝45 s，正好等於 watchdog——首 token 前被殺時使用者會看到「結果未知，請重試」，3～5 s 後重派又開始跑，按了重試就多一個請求；stalled 5 s 把上界壓到 35 s，代價只是每 5 s 一次 stalled Lua（微秒級），誤判率不變（看的是 lock）。報告的「上界約 35 s」是 L＋2S，沒算 keepalive 間隔。
- 替代方案：報告原值 15／10／2（零餘裕）；15／10／2＋keepalive 5 s（上界 40 s，keepalive 寫入加倍）；watchdog 拉長到 60 s（worker 真的死掉時使用者多等 15 s 才看到失敗）。

**2. `job/status` 新增欄位與 attempt／execution 的傳遞**（D1、D7）
- 影響範圍：WS `job/status` payload（契約 1.4.0）；面板「嘗試 N / 3」、卡片「AI：嚴重度 · 快取」chip、完成 meta「快取 · N ms」與螢幕閱讀器公告；BullMQ job hash 的 `progress` 欄位形狀。
- 裁決：新增 optional `attempt`、`execution`、`reason`（開放字串 `z.string()`）、`cached`；attempt／execution 由 worker 放進 `updateProgress` 物件，relay `safeParse` 後拆出。
- 理由：少了 `cached`，Pub/Sub 出狀況時以 `job/status` 收尾的快取命中全部顯示成非快取，demo「快取秒回」看不到；`reason` 用封閉 enum 時，日後加一個值，舊版 web 會把整則 `job/status`（含 `completed`＋`result`）丟掉，結果又回不到畫面；改由 relay `Job.fromId` 查 attempt，每個 active 多一次 Redis 讀，且畫面可能先跳 0 再出現「嘗試 2 / 3」。
- 替代方案：只加報告列的三欄；`reason` 封閉 enum；relay 在 `active` 時 `Job.fromId` 查。

**3. GET 的授權與 rebind**（D8）
- 影響範圍：新 HTTP 端點 `GET /diagnoses/:jobId?socketId=`（`http.ts` 的 query／回應 schema）；網路閃斷或 api 重啟後面板能否接回原診斷；同一個診斷開在兩個分頁時誰收結果；nginx access log 內含 jobId。
- 裁決：jobId 即 bearer capability；已完成的任務任何已授權連線可讀、不 rebind；進行中且原綁定在線、不是本 socket → 409；原綁定離線或無綁定 → rebind；先綁定後查詢。整理時修正草稿的先後矛盾：「原綁定在線」的 409 判斷延到查詢之後，查到終態就照常回結果並撤回暫定綁定。
- 理由：沒有使用者身分，改用 rebind token 也存在同一個前端記憶體，換不到安全卻多一把金鑰與一個契約欄位；只回原 socketId 會讓重連永遠接不回（每次連線都是新 clientId）；不先綁定，查詢回 active 到綁定建立之間若剛好完成，那則 `completed` 會找不到收件者，畫面又要等 2 s 退路。代價：能讀 nginx log 的人可讀 mock 診斷結果。
- 替代方案：只回給原 socketId；POST 回一次性 rebind token；WS 控制訊息 `job/resume`。

**4. `ai-fail:<sig>` 負向標記**（D5）
- 影響範圍：LLM 供應商故障時，同一機台同一狀態的其他請求在 10 s 內直接看到相同錯誤（面板錯誤文案）；LLM 計費次數與 `AI_RPM` 額度；Redis 新鍵 `ai-fail:*`。
- 裁決：TTL 10 s；涵蓋不可重試錯誤；等待者看到即消耗一次 attempt（非最終 attempt throw、最終 attempt 送同 code 的 `ai/error`）；在限流 INCR 前檢查；標記的 jobId 是自己時忽略；持鎖者成功寫快取時 `DEL`。
- 理由：2 個同簽章 job 由 6 次 LLM 呼叫降到 ≤ 4 次；TTL 10 s 涵蓋第一次退避 5 s，5 s 會剛好過期又放大回來，更長則供應商恢復後白擋新請求；不可重試錯誤同簽章＝同 prompt，重打也是同結果；INCR 前檢查才不吃 `AI_RPM`；忽略自己的 jobId，持鎖者的重試才能真的再試。代價：供應商只抖 1～2 s 時，等待者拿到同一個錯誤而不是自己再試。
- 替代方案：失敗時 `PEXPIRE` 鎖成冷卻期（仍是 6 次計費、只是延後）；看到標記時 `moveToDelayed`、不耗 attempt（放大倍數回到 N × 3）；TTL 5 s 或 15 s。

**5. 寫庫失敗的 per-job 結果暫存**（D6 第 4 點）
- 影響範圍：MongoDB 拒絕寫入（validator、磁碟滿、LLM 期間重啟）時的 LLM 計費次數；面板錯誤文案「診斷結果無法寫入資料庫，請稍後重試」；新錯誤碼 `persist_failed`；Redis 新鍵 `ai-result:*`。
- 裁決：納入 `ai-result:<jobId>`（`EX 3600`）＋`persist_failed`（可重試）。
- 理由：只加錯誤碼時，每個 job 仍打 3 次 LLM 全數計費，2.1.0 已向使用者揭露的成本問題不會消失；改成先寫快取，重試會回 `cached:true` 而 `diagnoses` 永遠缺這筆。代價：每個成功 job 多一次 SET／DEL，暫存至多 1 h、數 KB。
- 替代方案：只加 `persist_failed`、接受重打；先寫快取再寫 `diagnoses`。

**6. e2e 的 Redis 停頓方式**（D13）
- 影響範圍：新 e2e 場景（SC-004）能否重現 AR-4 雙重執行；本機 e2e 全套耗時。
- 裁決：`docker compose pause redis`（50 s 後 unpause）。
- 理由：凍結整個 Redis 行程，對應真實的主機／VM 停頓；harness 的 `compose()` 已可直接呼叫，不需新工具。`CLIENT PAUSE` 與 key 到期、Lua 腳本的互動依模式而異，要多花時間驗證才能確定重現的是同一種故障，否則場景可能沒重現雙重執行就綠燈。
- 替代方案：`redis-cli CLIENT PAUSE 50000 WRITE` 或 `ALL`。

**7. 45 s watchdog 的語意**（D11）
- 影響範圍：45 秒沒有進度時面板的文案與是否轉失敗（`checkStalls`）；觸發時多一次 GET。
- 裁決：觸發先 GET 一次；文案「超過 45 秒沒有收到進度，結果未知，請重試」；單調時鐘不做。
- 理由：012-lite 之後 watchdog 只在 worker 死了且沒重派、或整條通道壞了時觸發，兩者後端都可能已完成；不先查就宣告失敗，使用者會對已完成的診斷按重試（快取過期時多付一次 LLM）。先 GET 之後，時鐘往前跳造成的誤觸會查到「仍在進行」而不轉失敗，改單調時鐘的收益更小。
- 替代方案：不 GET、直接轉失敗（沿用現行文案）；一併改用 `performance.now()`（ADR-002 §6.5.1 backlog 列）。

**8. nginx 對 GET 的限流**（D9）
- 影響範圍：一鍵 demo 入口（`http://localhost:8080`）的 GET 流量上限；重連後按「重試」是否拿到 429「診斷請求過於頻繁」。
- 裁決：GET 獨立 regex location `location ~ "^/diagnoses/[0-9a-fA-F-]{36}$"`（regex 含 `{36}`，nginx 設定中 MUST 整段加雙引號，否則 nginx 拒絕啟動）＋`diag_read` 60 r/m、burst 10 nodelay；POST 維持 10 r/m、burst 5。
- 理由：共用 POST 的桶時，5 台重連 GET 加上退路 GET 就把 burst 用完，使用者接著按重試拿 429；不限流則 GET 成為可無上限打 Redis／Mongo 的入口（api 端沒有 HTTP 限流）。
- 替代方案：共用 POST 的桶；GET 不限流。

**9. 憲章 Principle III 補列 GET**（D8 第 6 點）
- **覆核**：2026-10-22 使用者裁決——現在 PATCH 補列；已落地為憲章 1.6.1（`.specify/memory/constitution.md` Principle III「三端契約」）。
- 影響範圍：`.specify/memory/constitution.md` Principle III（1.6.0 → 1.6.1）；GET 回應 schema 的義務層級。
- 裁決：ADR-003 與 spec 記錄**建議**以 PATCH 修訂 Principle III、補列 `GET /diagnoses/:jobId`；實際 `/speckit-constitution` **待使用者確認**，不在離席期間做（改流程規則屬單向門）。GET 的 query 與成功回應仍以 Zod 定義於 contracts（由本 ADR 與 spec 要求，不等憲章修訂）。
- 理由：GET 回應沒有 Zod 定義的話，之後改 handler 可能只回手寫物件，web 的 schema 驗證與 api 對不上時沒有閘門擋，所以 Zod 定義現在就做；憲章補列只是把既有原則延伸到新端點的措辭澄清，晚一點修訂不影響實作，但屬單向門，要使用者本人決定。
- 替代方案：離席期間直接 PATCH（違反單向門規則）；不補（只靠 spec 約束）；改寫為「所有 HTTP 端點」（MINOR，會牽動 `/healthz` 例外 (a)）。

**10. UI 文案**（D13；細表見 spec 的「與 013 UI 的接點」）
- 影響範圍：AI 診斷面板的進行中說明行、完成 meta、原始串流標題、失敗文案；卡片的診斷 chip；`apps/web/PRODUCT.md` 術語。
- 裁決：採 spec 的接點表（`specs/012-stream-resilience/spec.md`）；#4 簡化為「以 `job/status`／GET 收尾即標『原始串流（不完整）』」；#10 不加後綴；卡片 chip 不新增種類。
- 理由：#4 精確比對 `seq` 與結果要多一套判斷與測試，收益只是 token 剛好全到時少標一個「不完整」，寧可多標不漏標，符合「狀態永遠誠實」；#10 要加後綴，web 得知道錯誤來自別人的失敗標記，需要在 `ai/error` 多帶一個來源欄位、擴大契約；新增卡片 chip 會擠壓 220px 卡片的 id 列，違反 DESIGN.md「徽章出現或消失不改變容器高度」。
- 替代方案：#4 依 `seq` 精確判斷；#10 加「（同一機台同一狀態剛剛診斷失敗）」後綴（需契約欄位）；卡片新增「重新派送」chip。

**11. 完成的三個來源**（D1、D3、D10）
- 影響範圍：WS `ai/done` 的契約描述（自寫 client 必須以 jobId 去重）；面板「診斷完成」公告只念一次；`CHANGELOG.md` 相容性注意。
- 裁決：`ai/done`、帶 `result` 的 `job/status: completed`、GET 回 completed 三者先到者為準，之後到的忽略；`ai/done` 契約描述改為可重複、可遺失。
- 理由：只認 `job/status` 會讓 Pub/Sub 正常時也要多等一個 QueueEvents 往返；只認 `ai/done` 就是現況的假失敗；冪等重執行必然重送 `ai/done`，不寫進契約，自寫 client 會把同一個結果顯示兩次。
- 替代方案：只以 `job/status` 為準（`ai/done` 只當動畫結尾）；保證 `ai/done` 只送一次（要跨執行記狀態，Redis 停頓時做不到）。

**12. 失敗終態的 relay 寬限**（D12）
- 影響範圍：api 的 job-status relay 與 `JobRoutingRegistry`（終態寬限）；`ai/error` 能否送達原連線，也就是面板失敗時顯示具體文案（如「診斷結果無法寫入資料庫，請稍後重試」）還是籠統的「診斷失敗，請重試」；ADR-002 §6.5.1「失敗終態沒有 relay 寬限」列。
- 裁決：納入 012-lite——`failed` 終態套用與 `completed` 相同的 10 s 綁定寬限（同一段 registry 程式）；ADR-002 §6.5.1 該列由 012-lite 收掉。
- 理由：抽 `JobRoutingRegistry` 時把完成寬限一般化成終態寬限只要幾行；`ai/error`（Pub/Sub）與 `failed`（QueueEvents）的跨連線順序和 `ai/done`／`completed` 一樣沒有保證，`failed` 先到時具體錯誤碼送不到原連線，012-lite 新增的 `persist_failed` 文案就會被吞成籠統訊息。
- 替代方案：維持 backlog、追蹤位置改指 010-lite（`AiErrorCode` 讓 `failed` 自帶錯誤碼後問題消失，但 012-lite 與 010-lite 之間的發版會帶著這個缺口）。

**13. 「重新派送」說明的觸發條件**（D7、D13；修正 feature-description 接點表 #11）
- 影響範圍：AI 診斷面板進行中區塊的說明行「後端處理程序中斷，任務已重新排入佇列（第 N 次執行）」；`job/status.reason` 與 `execution` 的 web 消費邏輯。
- 裁決：說明行只看 `reason: "stalled"`；`execution` 因重試或限流延後遞增時只清空串流、不顯示這行。
- 理由：`execution`（`attemptsStarted`）在 BullMQ 重試與限流延後時也會遞增，照接點表 #11 字面以 `execution > 1` 觸發，會把供應商錯誤後的重試、限流延後都顯示成「後端處理程序中斷」，違反「狀態永遠誠實」。
- 替代方案：照接點表字面以 `execution > 1` 觸發；另為重試與限流延後各加一種說明行（多一組文案與測試）。

**14. keepalive 在複合故障下的殘餘風險**（D2、§4）
- 影響範圍：Redis Pub/Sub 斷線、同時 worker 在串流中被強制終止時，面板最長約 55 s 沒有進度，45 s 會先出現「超過 45 秒沒有收到進度，結果未知，請重試」。
- 裁決：接受，不加機制；keepalive 計時器維持由任何對外事件（含 `ai/token`）重設。
- 理由：要兩種故障同時發生；watchdog 觸發後先 GET（第 7 條），重派完成後仍能取回結果；改成只由 `updateProgress` 重設，串流期間每個 job 每 10 s 多一次 HSET＋XADD，換來的只是這個複合故障少一次誤觸。
- 替代方案：計時器只由 `updateProgress` 重設（上界回到 35 s）。

**15. 已轉「結果未送達」之後再抵達的同 jobId 結果仍救回**（D3、D10；spec FR-005、Assumptions）
- 影響範圍：面板上已顯示「診斷已在後端完成，但結果未送達畫面，請重試」的任務，之後若收到同 jobId 的 `ai/done`、帶 `result` 的 `job/status: completed` 或 GET 回 completed，狀態改回「已完成」並顯示結果；既有 AR-6 測試（2.1.0 的「遲到 `ai/done` 救回」）保留並擴充到三種來源。
- 裁決：救回。「結果未送達」是送達失敗、不是診斷失敗，後端結果一到就該呈現；只有這一種失敗態允許被同 jobId 的結果覆蓋，其他失敗態（`ai/error`、`failed`）不覆蓋。
- 理由：不救回時使用者會對一個其實已完成的診斷按「重試」，多等一次、快取過期時多付一次 LLM；救回只是沿用 2.1.0 已有的路徑，沒有新機制。
- 替代方案：轉失敗後一律忽略（reducer 更簡單，但 2 s 退路與 watchdog 的 GET 若剛好慢於結果抵達，結果會被丟掉）。

**16. GET 的 `returnvalue` 驗證失敗時退到 Mongo**（D8；spec FR-013）
- 影響範圍：`GET /diagnoses/:jobId` 在 BullMQ 回 completed 但 `returnvalue` 不符 `DiagnosisResultSchema`（舊版 worker、外部寫入）時的回應。
- 裁決：記 warn、改查 Mongo `diagnoses`；Mongo 也無合法結果則 404。不回未驗證物件（憲章 V）。
- 理由：Mongo 是結果的持久來源，`returnvalue` 只是快路徑；壞掉的 `returnvalue` 不該讓一個已落庫的結果取不回。
- 替代方案：直接 500（讓問題浮現，但使用者看到的是「連線中斷，請重試」而結果其實在庫裡）。

**17. 同一分頁重連時舊連線尚未被回收的 409 誤判**（D8、D10；spec FR-007、FR-009、FR-016、FR-032、SC-005；clarify 階段補）
- **覆核**：2026-10-22 使用者覆核——維持 `previousSocketId`（本專案無多分頁的產品需求，此欄位解的是單一分頁閃斷重連被誤判為第二個視窗）。
- 影響範圍：網路閃斷（換 Wi-Fi、筆電睡醒）後重連的 AI 診斷面板——原本會誤顯示「這個診斷正由另一個視窗接收，請在該視窗查看或重試」，結果繼續送往已死的舊連線；`GET /diagnoses/:jobId` 的 query（新增 optional `previousSocketId`，`http.ts` 的 `DiagnosisLookupQuerySchema`）；`JobRoutingRegistry` 的改綁判斷；web 對每個任務多記一個 socketId。
- 裁決：GET 新增 optional `previousSocketId`（UUID）。web 對每個任務記住最後一次成功綁定的 socketId（POST 送出時的 socketId，或 GET 回 `rebound: true` 時的本次 socketId），所有 GET 都帶上；伺服器端原綁定仍在線、但等於 `previousSocketId` 時，比照「原綁定已離線」暫定改綁並記下原綁定以便撤回；不主動終止舊連線，交給心跳回收。
- 理由：伺服器以心跳回收半開連線，`WS_HEARTBEAT_MS` 預設 15 s、回收上限約 30 s；瀏覽器端 pong 逾時（15＋5 s）或 `online` 事件後就重連，新連線很可能在舊連線被回收前 GET，照 D8 規則回 409——使用者在唯一的視窗看到「正由另一個視窗接收」，最後只能對一個還在跑的診斷按重試。`clientId` 只經 `system/connected` 送給連線本身，別的分頁拿不到，所以不放寬「兩個視窗不互搶」。代價：query 多一個 optional 欄位、registry 多一個分支與對應測試。
- 替代方案：web 收到 409 時延遲重試 GET，等舊連線被回收（web 不知道伺服器心跳設定、要猜等待時間；真正的雙視窗衝突也要多等約 30 s 才看到訊息）；原綁定在線時一律改綁（另一個真的在線的視窗會被搶走結果）；接受誤判、寫進已知限制（使用者看到錯誤的說明）。

**18. `failed` 只帶原因原文時的 `persist_failed` 文案**（D6 第 4 點、D12；spec FR-027、FR-035）
- 影響範圍：重連後 GET 回 `failed`、或 `job/status: failed` 在 10 s 寬限外才收到時，AI 診斷面板的失敗文案；worker 對 `persist_failed` 寫進 BullMQ `failedReason` 與 `ai/error.message` 的訊息內容；web `humanizeError` 的對映。
- 裁決：`persist_failed` 的訊息為含 `persist_failed` 字樣的固定英文句（例如 `persist_failed: diagnosis record could not be written`），MongoDB 原始錯誤只進日誌的 `err` 欄位；web 在錯誤碼或訊息含 `persist_failed` 時都對映為「診斷結果無法寫入資料庫，請稍後重試」。GET 的 `failed` 回應不新增 `code` 欄位。
- 理由：GET 與 `job/status: failed` 只有 `failedReason` 原文、沒有錯誤碼（`AiErrorCode` 屬 010-lite）；`humanizeError` 對 120 字以內的未知原文會照顯（`copilot-reducer.ts` `humanizeError` 末段；`fix/20261022-ui-humanize-error-zh` 起英文原文改收進「技術細節」，現況見指南 §15.6），訊息若夾帶 MongoDB 錯誤，重連後的使用者會看到 `MongoServerSelectionError…` 之類的內部錯誤，違反 spec US4 情境 2。固定訊息加一條關鍵字對映，只動一個字串與一條判斷。
- 替代方案：GET 的 `failed` 回應加 `code`（worker 要把錯誤碼另存進 job data、api 讀出，等於提前做 010-lite 的 `AiErrorCode`）；接受原文顯示（使用者看得到資料庫內部錯誤）。

**19. 重新整理頁面後不續接**（D10；spec Edge Cases、FR-039、Out of Scope；clarify 階段補）
- 影響範圍：診斷進行中按 F5 或關分頁再開時，AI 診斷面板是否接回原診斷；web 是否把進行中的 jobId 存進瀏覽器儲存；`apps/web/PRODUCT.md` 與 README 的已知限制多一條。
- 裁決：不續接，列 Out of Scope。web 不持久化進行中的 jobId；重新整理後面板回到未診斷狀態，後端照常跑完並寫快取；同機台同狀態再按「診斷」以新 jobId 命中快取（`AI_CACHE_TTL_SECONDS` 預設 600 s 內）或等待同簽章的去重鎖，不多打 LLM。
- 理由：續接要把 jobId、機台、最後綁定的 socketId 存進 sessionStorage，啟動時還原 store 狀態、處理過期與已完成的項目，另加一組測試；不做的代價只是重新整理後再按一次、等幾秒（快取或去重鎖），不多付 LLM 費用。US2 要解的是網路閃斷與 api 重啟，頁面本身還在。
- 替代方案：sessionStorage 存進行中任務、重新整理後 GET 續接（同分頁有效）；localStorage 跨分頁共享（還要處理多個分頁同時續接同一個 job 的 409）。

**20. 重連續接後以 `ai/done` 收尾的原始串流標題**（D13；spec FR-016、FR-035、FR-038；clarify 階段補）
- 影響範圍：AI 診斷面板「原始串流」收合區的標題；`copilot.store.ts` 任務上的「執行期間經歷過重連」旗標。
- 裁決：執行期間經歷過 WS 重連的任務，不論以哪個來源收尾（含 `ai/done`），都標「原始串流（不完整）」；判斷只看收尾來源與重連旗標，不比對 `seq`。
- 理由：斷線期間的 `ai/token` 不補送（at-most-once），重連續接後即使以 `ai/done` 收尾，串流也缺了中間一段；只看收尾來源會把有缺口的串流標成完整，與第 10 條「寧可多標不漏標」相反。旗標本來就要為「已重新連線，正在取回診斷狀態…」設起，只是收尾時多讀一次。代價：重連發生在首 token 前、串流其實完整時也會被標「不完整」。
- 替代方案：維持只看收尾來源（有缺口的串流被標成完整）；依 `seq` 是否連續精確判斷（多一套判斷與測試，第 10 條已拒絕同類做法）。

**21. 新增路徑的可觀測訊號**（D5、D6、D8；spec FR-047、SC-004；clarify 階段補）
- 影響範圍：worker／api 日誌（`docker compose logs` 排查與 e2e 驗收 SC-004 的計數依據）；`system/metrics` 與 `WorkerMetrics` 契約是否變動。
- 裁決：只加結構化日誌、不加指標欄位。依 009 `log-fields.md`（`jobId`、`sig` 為欄位、不串進 `msg`；等級依 §4）記：jobId 冪等短路命中（info，帶來源 `ai-result`／`diagnoses`）、`ai-fail` 寫入（info）與命中（warn，皆帶 `sig`、`code`）、`persist_failed`（沿用失敗路徑既有的重試中 warn／最終 error）、relay 轉發 `stalled`（warn）、GET 的 rebind 與衝突 409（info）。keepalive 補送不逐次記日誌（比照 §9 高頻路徑）。`system/metrics`／`WorkerMetrics` 不新增欄位；e2e 以既有每次 LLM 呼叫一則的 `LLM call` 日誌計數。
- 理由：SC-004、SC-008 要數 LLM 呼叫次數與確認走了冪等短路，現有 `LLM call` 日誌已能計數，新路徑各補一則就能從日誌看出每次再執行走了哪條路；加進 `system/metrics` 要改契約與 asyncapi，也碰到 011 的指標重定義。keepalive 每 10 s 一次，逐次記會讓每個 active job 每分鐘多 6 行。
- 替代方案：`WorkerMetrics` 新增冪等短路、`ai-fail` 命中計數（契約變更、與 011 重疊）；不加日誌（e2e 要從 Mongo 與 Redis 狀態反推路徑，排查時看不出再執行的原因）。

**以下第 22～46 條：plan 階段設計點（research P1～P25，T075 補錄，待覆核）**

**22. api 重啟後 GET 暫定建立綁定時 machineId 未知**（D8 第 3 點；plan 階段 P1）
- 影響範圍：api 重啟後重連的 AI 診斷面板，續接 GET 回應前後那一刻的 `job/status`（進度或 `completed`）會不會漏送；`GET /diagnoses/:jobId` 的 query 形狀（不加欄位）；`JobRoutingRegistry` 綁定的 `machineId`（可為 null）與 `deferred` 欄位。
- 裁決：綁定先以 `machineId: null` 建立；relay 對 null 綁定的 `job/status` 先擱置並記 `deferred`；`Job.fromId` 後補上 machineId，`deferred` 為真就再查一次 state 再回應。
- 理由：不改 GET query 形狀；擱置窗只有一個 Redis 往返，再查一次的代價是一次 HGETALL；`ai/*` 只看 clientId，照常送達。接受窗內遺失時，被丟的那則若是 `completed`，使用者要等 45 s watchdog 才取回結果。
- 替代方案：GET query 加 `machineId`（契約多一欄、與 spec FR-032 不符）；接受窗內遺失、等 45 s watchdog。

**23. GET 的兩種 409 以機器可讀 `code` 區分**（D8 第 2、4 點、D10；plan 階段 P2）
- 影響範圍：重連後面板的失敗文案——「這個診斷正由另一個視窗接收，請在該視窗查看或重試」與「連線中斷，請重試」各在什麼情況出現；GET 409 的回應 body 新增 `code`（`socket_unauthorized`／`job_bound_elsewhere`，記於 `asyncapi.yaml` `info.description` 與 `CHANGELOG.md`）。
- 裁決：GET 的 409 body 加 `code`；POST 的 409 不動。
- 理由：不加的話，連線未授權也會顯示「正由另一個視窗接收」，使用者會去找一個不存在的視窗。比對中文 message 時改一個字 web 就壞；以 web 自身授權狀態推斷，在 watchdog 與 2 s 退路的 GET 時推斷不準。成本是一個欄位。
- 替代方案：web 比對中文 message；web 以自身授權狀態推斷。

**24. GET 回應帶 `jobId`**（D8 第 4 點；plan 階段 P3）
- 影響範圍：`DiagnosisLookupResponseSchema` 四個分支各多一個 `jobId`；web `getDiagnosis` 收到 jobId 不符的回應時當作格式錯誤，面板走該用途的失敗文案。
- 裁決：四個分支都帶 `jobId`，web 比對不符視為格式錯誤。
- 理由：與 `postDiagnose` 的 jobId 比對是同一道防線；proxy 錯路由時，不帶 jobId 的話面板會把別的診斷結果顯示在這台機台上。成本一個欄位。
- 替代方案：不帶（web 無法發現錯路由）。

**25. GET 遇 Redis／Mongo 不可用或逾時回 503**（D8 第 4 點、D10、D11；plan 階段 P4）
- 影響範圍：Redis 或 MongoDB 故障時 GET 的回應（新增 503「診斷狀態暫時無法查詢，請稍後再試」）與面板多久才看到失敗；api 日誌能否看出是依賴故障。
- 裁決：BullMQ 查詢上限 5 s（沿用 `ENQUEUE_TIMEOUT_MS`）、Mongo 查詢 3 s（`maxTimeMS`；合計上限 8 s，逾時拆分於 analyze 階段定），逾時或不可用回 503、撤回暫定動作；web 對 503 比照「網路錯誤」文案。
- 理由：不設上限時 GET 會掛到 Redis 恢復，使用者看到的是 15 s 後的 fetch 逾時；回 500 看起來像程式錯誤，排查會先往 api 程式碼找。
- 替代方案：500；無上限。

**26. api 讀 `diagnoses` 複用 `HistoryService` 的連線**（D8 第 4 點；plan 階段 P5）
- 影響範圍：api 對 MongoDB 的連線數與關閉流程；GET 的第二來源（`removeOnComplete` 1 h 之後的 LLM 結果）。
- 裁決：`HistoryService` 新增唯讀 `findDiagnosisResult`，複用其 Mongo 連線，不建索引。
- 理由：另開 MongoClient 要多一組連線池、啟動與關閉流程與對應測試；HealthModule 已有複用先例。
- 替代方案：另開 MongoClient。

**27. GET 邏輯放在新的 `DiagnosisLookupService`**（D8；plan 階段 P6）
- 影響範圍：api 程式結構（`JobsController` 加 `@Get(":jobId")`、jobs 模組新 service）；`JobsService` 的覆蓋率門檻。使用者面無變化。
- 裁決：新 `DiagnosisLookupService`。
- 理由：`JobsService` 是覆蓋率門檻檔、職責是入列；寫進去後它的測試要同時 mock 查詢與入列兩組依賴，門檻更難維持。
- 替代方案：寫進 `JobsService`。

**28. `completed` 的 `attempt`／`execution` 取自綁定記下的最近值**（D7；plan 階段 P7）
- 影響範圍：以 `job/status: completed` 收尾時面板「嘗試 N / 3」是否正確；`completed` payload 何時省略 `attempt`／`execution`。
- 裁決：registry 綁定記最近一次 progress 物件帶的值，`completed` 時沿用；不知道就省略（web 沿用先前的值）。
- 理由：QueueEvents `completed` 不帶這兩欄；每次完成去 `Job.fromId` 多一次 Redis 讀；塞進 `returnvalue` 會讓傳輸型別多兩個與結果無關的欄位。
- 替代方案：relay 在 `completed` 時 `Job.fromId`；塞進 `returnvalue`。

**29. 「`completed` 帶 `result` 必帶 `cached`」放在 relay 組裝層**（D1、D7；plan 階段 P8）
- 影響範圍：`job/status` schema（`cached` 維持 optional）；收到帶 `result` 但缺 `cached` 的訊息時，卡片與面板是否顯示「快取」。
- 裁決：schema 層維持 optional、不 `refine`；由 relay 的組裝純函式保證並單元測試；web 收到帶 `result` 缺 `cached` 時當 false。
- 理由：`refine` 不出現在 `z.toJSONSchema`，asyncapi 漂移比對看不到，等於兩邊規則不一致；web 當 false 的最壞結果只是少顯示一個「快取」字樣。
- 替代方案：`superRefine`（漂移測試無法覆蓋）。

**30. `ai-metric` 與 `ai-fail` 的存取與驗證留在 worker 內部**（D5、D6；plan 階段 P9）
- 影響範圍：worker 的 Redis 存取介面（`ProcessorStore.setIfAbsent`）；`ai-fail` 值的驗證 schema 放哪（影響 web bundle 是否多一個 schema）。使用者面無變化。
- 裁決：新增 `ProcessorStore.setIfAbsent`；`ai-fail` 值以 worker 內部 `AiFailMarkerSchema` 驗證，不進 contracts。
- 理由：讀寫都在 worker 同一份程式碼，不是 api↔worker 傳輸；放 contracts 會讓 web bundle 多一個用不到的 schema；借 `tryAcquireLock` 會讓「鎖」與「計數去重」混用一個方法，審查時易誤讀。
- 替代方案：借 `tryAcquireLock`；放 contracts。

**31. trigger 寫入改名 `upsertTrigger`、E11000 視為成功**（D6 第 2 點；plan 階段 P10）
- 影響範圍：`diagnosisTriggers` 每個 jobId 一筆的保證；worker repository 方法名稱。
- 裁決：`insertTrigger` 改名 `upsertTrigger`（`$setOnInsert`），併發 upsert 撞 E11000 視為成功；unique 建立泛化 `ensureUniqueJobIdIndex`。
- 理由：名稱反映冪等語意，審查時不會誤讀成「每次插一筆」；E11000 只在兩個 upsert 同時插入時出現，結果已經是一筆，拋錯會讓 job 白白重試一次。
- 替代方案：保留舊名。

**32. 冪等短路不回填快取、不清 `ai-fail`**（D6 第 1 點；plan 階段 P11）
- 影響範圍：冪等短路命中後，同機台同狀態的下一個新請求是否命中快取；`ai-fail:<sig>` 是否被清除。
- 裁決：短路不回填 `ai-cache`、不 DEL `ai-fail`。
- 理由：短路刻意不建 context（省 4 支 Mongo 查詢），沒有簽章就無從組鍵；快取通常在第一次執行已寫入，或由之後的新請求重寫。代價：前一次執行落庫後、寫快取前就失敗的少數情況，下一個新請求會再打一次 LLM。
- 替代方案：短路也建 context 以回填（每次再執行多 4 支查詢）。

**33. keepalive 寫入失敗時吞掉、至多 warn 一則**（D2；plan 階段 P12）
- 影響範圍：Redis 斷線期間 worker 日誌量；keepalive 寫不進 Redis 時 job 是否因此失敗（面板是否因此看到錯誤）。
- 裁決：吞掉、每次執行至多 warn 一則、下一個 10 s 再試；`finally` 停止計時器。
- 理由：Redis 斷線時其他指令本來就會拋錯走既有失敗路徑；逐次記 warn 會在故障期間每 10 s 每 job 一行；讓 keepalive 失敗使 job 失敗，Redis 抖一下就會讓本來能完成的診斷失敗。
- 替代方案：失敗即讓 job 失敗。

**34. `ai-fail` 在兩處檢查**（D5；plan 階段 P13）
- 影響範圍：供應商故障時同簽章的第二個請求是否還會多打一次 LLM、多吃一次 `AI_RPM`（SC-007 的 ≤ 4 次）。
- 裁決：取鎖迴圈每輪開頭，以及取得鎖後、限流 INCR 前，兩處都查。
- 理由：只放開頭會漏「持鎖者寫標記放鎖、等待者剛好搶到鎖」的窗口，該等待者會吃 `AI_RPM` 並再打一次 LLM；多一處的代價是一次 Redis GET。
- 替代方案：只放一處。

**35. `failed` 先到時不讓後到的具體 `ai/error` 覆寫文案**（D12；plan 階段 P14）
- 影響範圍：`failed` 先於具體 `ai/error` 到達畫面時，面板失敗文案是籠統的還是具體的（例如「診斷結果無法寫入資料庫，請稍後重試」）。
- 裁決：web 不新增覆寫規則；具體文案由 `failedReason`（＝worker 的 `ai/error.message`，同源）與 `persist_failed` 固定句（第 18 條）經 `humanizeError` 承接。
- 理由：`fail()` 拋出的訊息就是 `failedReason`，`humanizeError` 對兩者的結果相同或相近；不多一條「非 active 也吃事件」的 reducer 例外——例外越多，第 15 條的救回規則越難推理與測試。
- 替代方案：reducer 允許具體 `ai/error` 覆寫籠統失敗（多一條例外與測試）。

**36. 「第 N 次執行」先估再校正**（D13；plan 階段 P15）
- 影響範圍：面板說明行「後端處理程序中斷，任務已重新排入佇列（第 N 次執行）」的 N。
- 裁決：收到 `reason:"stalled"` 時 N＝`(目前 execution ?? 1) + 1`，之後由下一則帶 `execution` 的 `job/status` 校正；`execution` 再遞增而沒有新的 stalled 時移除說明行。
- 理由：`stalled` 事件本身不帶 execution；先估再校正，畫面不會出現「第 1 次執行」這種錯值。不顯示 N 則要改 spec 的文案表。
- 替代方案：不顯示 N。

**37. GET 收尾的耗時另記、不作對比基準**（D10；plan 階段 P16）
- 影響範圍：完成 meta 的耗時與「上一次非快取耗時」對比橫條（`diagnosis-timing.ts` 的 `lastRecoveredMs`／`lastKind`）。
- 裁決：`settleTiming(…, { recovered: true })` 寫 `lastRecoveredMs`、`lastKind:"recovered"`，不動 `lastUncachedMs`／`lastCachedMs`，不畫對比橫條。
- 理由：重連取回的耗時含斷線時間，拿來當「上一次」基準，下一次快取命中的對比會顯示出誇大的加速（spec FR-035）；不記則完成 meta 少一項資訊。
- 替代方案：不記耗時。

**38. api 重啟後 delayed job 不補送 `waiting`**（D11；plan 階段 P17）
- 影響範圍：api 重啟時正在限流延後（delayed）的診斷，重連後面板最長 45 s 沒有進度，watchdog 觸發後 GET 得到 waiting、維持「進行中」。
- 裁決：不補建 `delayedUntil`；由 watchdog GET 承接。
- 理由：補建要讓 lookup service 回頭操作 job-status relay 的內部表，兩個模組互相依賴；最壞情況是使用者看到 45 s 後仍「進行中」，不轉失敗。
- 替代方案：lookup 時依 `job.delay` 補登記。

**39. e2e 以「先停 worker」重現 api 重啟後 job 仍進行**（D13；plan 階段 P18）
- 影響範圍：e2e 場景 6b（SC-003「仍進行」）的重現方式；active 狀態的改綁改由 api 單元測試與場景 8 的 `previousSocketId` 覆蓋。
- 裁決：先停 worker → POST → `restart api` → 重連 GET（waiting、`rebound:true`）→ 啟動 worker → 收到 completed。
- 理由：fake 串流約 10 s，短於 api 冷啟動 10～17 s，串流中重啟 api 時 job 一定先完成，測不到「仍進行」；拉長 `FAKE_AI_TOKEN_DELAY_MS` 會牽動全部場景的等待上限。代價：e2e 驗到的是 waiting 而不是 active（SC-003 已據此修正）。
- 替代方案：e2e override 拉長 `FAKE_AI_TOKEN_DELAY_MS`（影響全部場景）。
- 實測（e2e 第 3 輪，2026-10-21）：api 約 8 s 即 healthy（短於規劃時估的 10～17 s），6a 改為第 10 個 token 後才重啟 api，並容許重連前先收到 active、再以 GET 取回。

**40. Pub/Sub 斷線迴圈在 redis 容器內執行**（D13；plan 階段 P19）
- 影響範圍：e2e 場景 5（SC-002，Pub/Sub 每 50 ms 斷一次）在 Windows 上能否照設計頻率重現。
- 裁決：在 redis 容器內以 `sh -c` 迴圈執行（T003 已確認 busybox 接受小數秒）。
- 理由：Windows 上每次 `docker exec` 數百 ms，從 harness 每 50 ms spawn 一次做不到，場景會在斷線頻率遠低於設計的情況下綠燈。
- 替代方案：harness 每 50 ms spawn 一次。

**41. 續接 GET 由新 store action `onAuthorized(socketId)` 觸發**（D10；plan 階段 P20）
- 影響範圍：重連後續接 GET 的觸發時機（面板「已重新連線，正在取回診斷狀態…」持續多久）；copilot store 與 monitoring store 的依賴關係；nginx `diag_read` 額度用量。
- 裁決：新 store action `onAuthorized(socketId)`，App 於 `onAuthResult(true)` 呼叫；同一連線多次 `machine/subscribed` 只消化一次待續接清單。
- 理由：維持兩個 store 不互相匯入的現行分工，App 是唯一同時知道兩者的地方；同一連線每訂閱一台機台都會收到 `machine/subscribed`，不去重會對同一任務 GET 多次。
- 替代方案：copilot store watch monitoring store 的授權狀態（store 互相依賴）。

**42. 2 s 退路 GET 回 waiting／active 時轉「結果未送達」**（D10；plan 階段 P21）
- 影響範圍：`completed` 不帶 result、2 s 後 GET 卻回 waiting／active 時，面板顯示「結果未送達」還是繼續「進行中」。
- 裁決：視同取不到結果，轉「結果未送達」（可被後到的結果救回，第 15 條）。
- 理由：理論上不會發生（`completed` 已到）；留在 active 會讓已完成的任務再等 45 s；轉成可救回的失敗，結果一到仍會改回已完成。
- 替代方案：留在 active。

**43. `rebound` 恆為 true**（D8 第 4 點、D10；plan 階段 P22）
- 影響範圍：GET 進行中回應的 `rebound` 欄位；web 何時把該任務的 `previousSocketId` 換成本次 socketId。
- 裁決：綁定原本就是本 socket（不動）時也回 `rebound: true`，意思是「之後的事件送到這條連線」。
- 理由：web 只需一條規則（收到 `rebound:true` 就換 `previousSocketId`）；新增 `rebound:false` 要多一種契約值與 web 分支，而 false 時 web 的處理與 true 相同。
- 替代方案：新增 `rebound:false` 分支。

**44. 改綁時更新 `boundAt`**（D8 第 3 點；plan 階段 P23）
- 影響範圍：重連改綁後還要跑很久的診斷（等去重鎖、限流延後），綁定會不會被孤兒回收（10 分鐘）提早刪掉、導致面板收不到後續事件。
- 裁決：rebind 時更新 `boundAt`。
- 理由：沿用原始建立時間時，改綁後的 job 會因原始建立時間被提早回收，之後的事件送不到新連線，只能等 watchdog。
- 替代方案：沿用原 `boundAt`。

**45. e2e 場景 3b 在收到 progress 20 時 kill**（D13；plan 階段 P24；前提由第 51 條更正）
- 影響範圍：e2e 場景 3b（SC-001「首 token 前」SIGKILL）的觸發點，以及它驗的是不是首 token 前的情境。
- 裁決：收到 `job/status` progress 20（context 已返回、尚未呼叫 LLM）即 kill。
- 理由（plan 階段原文）：fake 第一個 token 約在 progress 40 後 500 ms，以 20 為觸發點確定落在首 token 前；以 40 為觸發點則只差 500 ms，容易落到之後。（實作階段更正：fake 首 token 實際上一呼叫就送出、沒有延遲，前提不成立；觸發點不變，改由第 51 條為 e2e 加首 token 延遲。）
- 替代方案：收到 progress 40 才 kill。

**46. e2e 場景 7 的停頓在第 3 個 token 之後才開始**（D13、§4；plan 階段 P25，analyze 階段補）
- 影響範圍：e2e 場景 7（SC-004，Redis 停頓 50 s）的「LLM 恰 1 次」判準是否穩定；失敗時能否從 worker 日誌判讀重派走了哪條短路。
- 裁決：收到該 jobId 第 3 個 `ai/token` 後才 `pauseRedis()`；場景印出重派那次 `idempotent short-circuit` 的 `source`。
- 理由：e2e 的 `AI_DEDUPE_LOCK_SECONDS` 為 20 s，停頓 50 s 必然超過；停頓若開始在 exec1 發出 LLM 請求之前，exec1 卡在 LLM 呼叫前、恢復後與 exec2 競爭（§4 殘餘風險），「LLM 恰 1 次」會偶發失敗。停頓排在首 token 之後時，token 發布不等 Redis 回應，exec1 在停頓期間跑完 LLM 串流、停在 `report(80)`；恢復後 exec1 的 SET `ai-result` 領先 exec2 的冪等短路查詢至少 1 個 Redis 往返（exec2 要先被 stalled 檢查搬回 wait、被取出、`updateProgress(0)` 才查短路），exec2 在短路 (i) 命中。（實作交叉審查更正措辭：research 原寫「先於」，實際依據是這個往返差，不是同一連線上的指令順序；§6 已列待改。）印 `source` 讓失敗時看得出走的是 `ai-result` 還是 `diagnoses`，不必重跑才能判讀。
- 替代方案：e2e 把 `AI_DEDUPE_LOCK_SECONDS` 拉到 60 s，讓停頓不超過去重鎖（kill 場景 3a／3b 中死掉的持鎖者留下的 `ai-lock` 要等 60 s 才過期，每個 kill 場景多等約 40 s，全套 e2e 再拉長，既有場景的等待上限也要跟著調）。
- 實測（e2e 第 3 輪，2026-10-21）：兩次皆為短路 (ii) `diagnoses`——exec1 解凍後在 exec2 查詢前已寫庫並 DEL 暫存；判準不受影響（LLM 恰 1 次、trigger 1 筆照樣成立）。

**以下第 47～48 條：checklist 階段推導（`checklists/resilience.md` Notes 第 3 點，T075 補錄，待覆核）**

**47. 重連後授權失敗交給 45 s watchdog**（D10、D11；spec Edge Cases「重連後授權失敗」；checklist 階段 CHK021）
- 影響範圍：重連後 WS 授權失敗（`WS_AUTH_SECRET` 下 token 錯誤或過期）時，AI 診斷面板維持「已重新連線，正在取回診斷狀態…」最長 45 s，才轉「超過 45 秒沒有收到進度，結果未知，請重試」。
- 裁決：不新增立即失敗的分支；續接 GET 不發出，由 45 s watchdog 承接（watchdog 的 GET 以 409 `socket_unauthorized` 失敗 → 「結果未知」文案）。
- 理由：代價是使用者最多多等 45 s 才看到失敗；換到的是 copilot store 不多一條授權失敗分支與對應測試。授權失敗是設定錯誤，不是網路閃斷的常態路徑。
- 替代方案：`onAuthResult(false)` 時立即把待續接任務轉「連線中斷，請重試」（多一條 store 分支與測試）。

**48. SC-004 必須證明重派確實發生**（D13；spec SC-004；checklist 階段 CHK052）
- 影響範圍：e2e 場景 7 的判準；本機 Docker 的 pause 時序若無法穩定觸發 stalled，場景會紅、T080 要停下回報，而不是綠燈。
- 裁決：場景 MUST 斷言該 jobId 收到 `job/status` `reason: "stalled"` 或 `execution ≥ 2`；沒有重派視為「未重現 AR-4」，不放寬判準讓它綠燈。
- 理由：停頓若沒造成重派，trigger 筆數、LLM 次數、hit／miss 計數天然都是 1，場景會在根本沒測到雙重執行時通過（第 6 條理由提到的風險）。代價是時序不穩時要人工判讀、不能自動綠燈。
- 替代方案：只斷言計數（未重現也綠燈）。

**以下第 49～51 條：實作交叉審查補裁（2026-10-21，T075 補錄，待覆核）**

**49. 再執行命中快取前先查自己的結果**（D3、D6 第 1 點、§4；來源：實作交叉審查）
- 影響範圍：stalled 重派、重試或延後後再跑的診斷完成時，卡片「AI：嚴重度 · 快取」chip、完成 meta 的快取耗時對比與螢幕閱讀器「診斷完成（快取）」是否誤標；`job/status.cached`、`ai/done.cached`、`returnvalue.cached`。
- 裁決：再執行（`attemptsStarted > 1` 或 `attemptsMade > 0`）在快取命中、回 `cached:true` 之前，先重跑一次冪等短路（`ai-result:<jobId>` → `diagnoses`）；命中就照短路語意回 `cached:false`。首次執行不受影響。
- 理由：開頭短路沒命中、但前一次執行在 exec2 等鎖期間落地並寫了快取時，exec2 會命中快取、回 `cached:true`；前一次執行已失去 lock、無法把 job 移到 completed，所以權威的 `completed` 來自 exec2，帶著錯的 `cached:true`，與 `diagnoses`／trigger 的 `cached:false` 不一致，demo 會把一次真的打了 LLM 的診斷標成「快取秒回」。代價只在再執行且命中快取的路徑多一次 Redis GET 與一次 Mongo `findOne`。
- 替代方案：記為殘餘風險（重派那次被標成快取，結果本身正確）。
- （合併門第 1、2 輪延伸，2026-10-21～22；實作 `bac9426`、`0d97fc8`）**延伸到取鎖後未命中路徑（限流 INCR 前）**：取得 `ai-lock`、double-check 快取仍未命中時，若 `isReExecution` 或 `ai-metric:<jobId>` 已有值（`countedElsewhere`，只讀不 claim——提前 claim 會讓限流延後後真正打 LLM 的那次記不到 miss），先重查冪等短路再決定是否 INCR 與呼叫 LLM。快取命中路徑則先 `claimMetric`，`isReExecution || !first` 時重查（第 58 條）。理由同本條：前一次執行可能在等鎖期間已落地，不重查就會再打一次 LLM。

**50. `ai-result` 暫存 SET 改為 best-effort**（D6 第 4 點；來源：實作交叉審查）
- 影響範圍：LLM 成功後 Redis 寫入暫存失敗時，該 job 是否多打一次 LLM（計費）；worker warn 日誌「ai-result 暫存寫入失敗（照常寫 diagnoses）」。
- 裁決：`SET ai-result:<jobId>` 失敗只 warn、照常寫 `diagnoses`；寫庫後的 `DEL` 失敗同樣只 warn、由 TTL 回收。
- 理由：`diagnoses` 一旦落地，之後任何一步失敗都能由短路 (ii) 回收；讓暫存失敗拋出交重試，已拿到的 LLM 結果作廢、重試再打一次 LLM，正是第 5 條要避免的計費。代價：暫存與 `diagnoses` 寫入都失敗時，重試仍會重打 LLM（與沒有暫存時相同）。
- 替代方案：失敗拋出交 BullMQ 重試（多打一次 LLM）。

**51. fake provider 加 e2e 專用的首 token 延遲**（D13；更正第 45 條的前提；來源：實作交叉審查）
- 影響範圍：e2e 場景 3b 能否真的在首 token 前 kill（SC-001 的首 token 前情境）；fake provider 新增 env `FAKE_AI_FIRST_TOKEN_DELAY_MS`（預設 0，一鍵 demo 與單元測試行為不變），`docker-compose.e2e.yml` 設 2000；e2e 每個走 LLM 路徑的 fake 診斷多約 2 s。
- 裁決：只延遲第一個 token；e2e 設 2000 ms；第 45 條的觸發點（progress 20）不變。
- 理由：第 45 條的前提與實作不符——fake 首 token 一呼叫就送出，progress 20 到首 token 只差幾十 ms，從 Windows host 下 kill（compose CLI 約 1～2 s；改用 `docker kill <容器 id>` 後實測約 431 ms）打不進這個窗口，3b 實際會變成「串流中 kill」，首 token 前的情境沒測到卻綠燈。2 s 讓窗口夠寬；e2e fake 串流約 2＋9.5＝11.5 s，仍低於 `AI_TIMEOUT_MS` 15 s。
- 替代方案：把 3b 改定義為「第 N 個 token 前」kill（不改 fake，但不再驗首 token 前、context 已建好那段的 keepalive 上界）。

**以下第 52～54 條：web 交叉審查補裁（2026-10-21，US2，待覆核）**

**52. 耗時 recovered 判定含「重連過」**（D10、D13；第 37 條的延伸；來源：web US2 交叉審查）
- 影響範圍：AI 診斷面板完成 meta 的耗時與「上一次非快取耗時」對比橫條；`diagnosis-timing.ts` 的 `lastRecoveredMs`／`lastKind`（data-model §6.4）。
- 裁決：recovered 判定為 `source === "lookup" || reconnected`——以 GET 收尾，或執行期間經歷過重連（即使最後以 `ai/done` 或 `job/status` 收尾），都記為 recovered，不作為下一次快取對比的基準。
- 理由：第 37 條（P16）的理由同樣適用於重連後由 `ai/done` 收尾的任務：耗時含斷線與重連時間，拿來當「上一次非快取耗時」，下一次快取命中的對比會顯示出誇大的加速。只看收尾來源會漏掉這一類。
- 替代方案：只在 GET 收尾時記 recovered（重連後以 `ai/done` 收尾的耗時會汙染對比基準）。

**53. 「重新連線後取回」小字只在重連過時顯示**（D10、D13；spec FR-035；來源：web US2 交叉審查）
- 影響範圍：AI 診斷面板完成 meta 的中性小字「重新連線後取回」；web reducer 的 completed 狀態多帶 `reconnected` 旗標。
- 裁決：小字只在任務執行期間經歷過重連時顯示；completed 狀態帶 `reconnected` 供畫面判斷。2 s 退路與 45 s watchdog 退路以 GET 收尾、但沒有重連時不顯示。
- 理由：2 s 與 watchdog 退路通常沒有發生重連，顯示「重新連線後取回」是在描述一件沒發生的事，違反 PRODUCT.md「狀態永遠誠實」。
- 替代方案：所有 GET 收尾都顯示，但改用中性字「已取回」（多一組文案，且使用者不一定看得懂「取回」的來由）。

**54. 進度說明行允許改變進行中區塊高度**（D13；spec FR-035；DESIGN.md；來源：web US2 交叉審查）
- 影響範圍：AI 診斷面板進行中區塊的高度——說明行「後端處理程序中斷，任務已重新排入佇列（第 N 次執行）」「已重新連線，正在取回診斷狀態…」出現或消失時區塊會長高或縮回；`apps/web/DESIGN.md` 的「讀數、徽章、標記的出現或消失不改變所屬容器的高度」補一條例外。
- 裁決：進度說明行不視為 DESIGN.md 所指的「標記」，允許改變進行中區塊高度；卡片與 chip 不受影響（卡片 chip 不新增種類）。
- 理由：spec 與 research R10 明文要這一行，且兩種說明共用同一個位置（T059）；預留恆在的佔位會讓沒有說明時（大多數診斷）的進行中區塊多一行空白。
- 替代方案：恆在佔位（不改變高度，但閒置時多一行空白）。

**以下第 55～57 條：合併門第 1 輪補裁（2026-10-22，待覆核；55～56 來自 web 審查、57 來自契約／文件審查）**

**55. 「結果未送達」救回的實際範圍照實寫**（D3、D10；第 15 條的實際效果；來源：合併門第 1 輪 web 審查）
- 影響範圍：`apps/web/PRODUCT.md` 失敗段的救回敘述；spec FR-005「已轉『結果未送達』之後，同 jobId 的結果再抵達 MUST 救回」在畫面上實際能救回的情況。
- 裁決：不改行為，改文件。PRODUCT.md 改寫為「reducer 接受三種來源救回；實際送達仍受 api 10 s 終態寬限限制、重連後不主動替未送達失敗取回」：已轉「結果未送達」的任務，只有在 api 綁定的 10 s 終態寬限內抵達原連線的結果才救得回；重連後的續接 GET 只針對進行中的任務，不會替這種失敗態再查一次。
- 理由：reducer 確實接受三種來源（第 15 條成立），但結果要送得到畫面才救得回——寬限過後綁定已刪，`ai/done`／`completed` 送不到；重連後主動取回要讓 FR-016 的續接範圍從「active 任務」擴大到「結果未送達的失敗態」，屬規格變更，不在合併門內做。原 PRODUCT.md 寫成「不論從哪條路先到都救回、不再有 10 秒與重連的限制」，誇大了實際效果。
- 替代方案：`onReconnect` 也續接「結果未送達」失敗態（重連後對它們 GET 一次；要改 FR-016 與對應測試）。

**56. 路徑類文字與 BullMQ 原文不算違反「畫面不出現 worker」**（D13；spec FR-036；來源：合併門第 1 輪 web 審查）
- 影響範圍：spec FR-036「畫面 MUST NOT 出現『worker』『stalled』字樣」的判準；既有金鑰錯誤文案（指名 `apps/worker/.env` 的 `GEMINI_API_KEY`）與 `humanizeError` 對短英文 `failedReason` 原文的照顯（已變更：`fix/20261022-ui-humanize-error-zh` 起未對映的英文 failedReason 只出現在預設收合的「技術細節」，現況見指南 §15.6）。
- 裁決：FR-036 加註——路徑類文字（如 `apps/worker/.env`）與 BullMQ 原文 `failedReason` 不視為違反。禁用的是拿「worker」「stalled」當說明用語描述任務狀態。
- 理由：金鑰文案要讓操作者知道去哪個檔案改設定，路徑是操作指引、不是狀態說明；BullMQ 原文只在沒有對映時照顯（`maxStalledCount` 用盡那句已有中文對映），全面改寫屬 010-lite `AiErrorCode` 的範圍（已變更：`fix/20261022-ui-humanize-error-zh` 起未對映的英文 failedReason 只出現在預設收合的「技術細節」，現況見指南 §15.6）。
- 替代方案：把既有金鑰文案改寫為「AI 服務的 .env」（操作者要自己找是哪個檔案，且動到 2.1.0 起的既有文案與測試）。

**57. 瀏覽器端 UI 演練交給使用者**（D13；tasks T081、quickstart §4；來源：合併門第 1 輪 契約／文件審查）
- 影響範圍：quickstart §4 演練 2／3 的 UI 驗收——AI 診斷面板的說明行（「後端處理程序中斷，任務已重新排入佇列（第 N 次執行）」「已重新連線，正在取回診斷狀態…」）、完成 meta「重新連線後取回」、「原始串流（不完整）」、畫面無「worker」「stalled」字樣；tasks T081 的勾選狀態。
- 裁決：使用者離席期間不做瀏覽器演練，T081 改回 `[ ]`、交使用者驗收；驗收紀錄註明「e2e 自動化覆蓋後端與 WS client 行為，瀏覽器端 UI 未手動演練」。
- 理由：e2e 的 client 是原生 `ws`，不經瀏覽器，也不經 `App.vue` 把 `onAuthResult` 接到 copilot store 的接線，上述畫面行為只有 web 單元測試覆蓋；原記錄把 e2e 當成演練判準，會把沒驗過的畫面記成已驗。自動化驅動瀏覽器跑這幾個故障情境（kill worker、重啟 api、pause redis 時同時操作畫面）成本高。
- 替代方案：以 playwright 劇本演練（比照 `apps/web/scripts/screenshots.cjs`，要另寫故障注入與畫面斷言）。

**以下第 58～62 條：合併門第 2 輪補裁（2026-10-22，待覆核；58～60 來自 worker 審查、61～62 來自 api 審查）**

**58. 舊執行落後於重派執行時改走短路**（D6；第 49 條的延伸；來源：合併門第 2 輪 worker 審查）
- 影響範圍：Redis 停頓造成 stalled 重派、舊執行恢復後才走到快取或 LLM 步驟時，畫面與卡片是否誤標「快取」、該 jobId 是否多打一次 LLM；`diagnosisTriggers` 與 hit／miss 計數。
- 裁決：舊執行在記 hit／miss 前 `claimMetric`（`SET ai-metric:<jobId> NX`）回 false，代表另一次執行已先處理過這個 jobId；此時不往下走快取命中或 LLM，改為重查冪等短路（`ai-result` → `diagnoses`），命中就以 `cached:false` 回原結果。
- 理由：第 49 條只在「再執行」（`attemptsStarted > 1` 或 `attemptsMade > 0`）的快取命中前重查；落後的是**舊執行**（它自己的計數仍是首次）時第 49 條不觸發，舊執行會命中重派執行剛寫的快取並回 `cached:true`，或在快取還沒寫成時再打一次 LLM。`claimMetric` 回 false 是現成、零額外往返的「有人先到」訊號。
- 替代方案：每次快取命中與呼叫 LLM 前都重查短路（首次執行也多一次 Redis GET＋Mongo `findOne`）。

**59. `ai-fail` 標記加 `attempt` 與 `retryable`**（D5；第 4 條的延伸；來源：合併門第 2 輪 worker 審查）
- 影響範圍：`ai-fail:<sig>` 的值形狀（worker 內部 `AiFailMarkerSchema`，不進 contracts）；同簽章等待者看到標記時是照標記失敗、交重試，還是白等。
- 裁決：標記加 `attempt`（寫入者的 attempt）與 `retryable`（寫入者的錯誤是否可重試）。同 jobId 的兄弟執行（stalled 重派）遇到同 attempt 的標記照標記失敗；標記為不可重試時，等待者直接以最終失敗收尾，不再進入退避。
- 理由：只看 `jobId` 等於自己就忽略時，重派的兄弟執行會無視舊執行剛寫的同一次失敗、再打一次 LLM；不可重試的錯誤（金鑰無效、安全攔截）重試結果必然相同，等待者照可重試處理會白等一輪退避（約 15 s）才看到同一個錯誤。
- 替代方案：維持只記 `jobId`（兄弟執行重打一次 LLM；不可重試錯誤多等一輪退避）。

**60. SET `ai-cache` 改為 best-effort**（D6 第 4 點；第 50 條的延伸；來源：合併門第 2 輪 worker 審查）
- 影響範圍：LLM 成功、`diagnoses` 已落地後寫快取失敗時，該 job 是完成還是失敗重試；之後同簽章的新請求是否命中快取。
- 裁決：SET `ai-cache:<sig>` 失敗只 warn、照常寫 trigger 並完成。
- 理由：`diagnoses` 已落地，失敗拋出交重試時，重試只會走短路 (ii) 回原結果，而短路刻意不回填快取（第 32 條），拋出換不到快取、只換到一次多餘的重試與延遲；「快取有值就代表已落庫」的不變量不受影響（快取仍只在寫庫成功後才寫）。代價：這次的結果沒進快取，下一個同簽章新請求會再打一次 LLM。
- 替代方案：維持失敗拋出交重試（多一次重試與延遲，快取照樣沒寫）。

**61. `revertClaim` 的 rebound 改為放回原綁定物件**（D8 第 5 點；來源：合併門第 2 輪 api 審查）
- 影響範圍：GET 查到終態或失敗、撤回改綁時，`JobRoutingRegistry` 裡的綁定物件身分；終態寬限與孤兒回收以參照比對刪除（`deleteIfCurrent`）是否仍有效。
- 裁決：撤回 rebound 時放回**原來那個物件**，不複製一份新的。
- 理由：registry 的寬限期滿與撤回都只刪「當初那一份物件」（data-model §2.1 不變量）；撤回時換成一個內容相同的新物件，原本排定的 `deleteIfCurrent` 比對不到，綁定會一直留到孤兒回收（10 分鐘），期間同 jobId 的 POST 被擋。
- 替代方案：撤回時重新排定寬限與回收計時器（多一段計時器管理與測試）。

**62. GET 的多項加固**（D8；來源：合併門第 2 輪 api 審查）
- 影響範圍：`GET /diagnoses/:jobId` 在罕見狀態下的回應碼（200／409／503）與 api 日誌；綁定的 `boundAt`（孤兒回收起算點）與終態標記。
- 裁決：(1) 查詢期間 owner 消失（綁定已被刪）回 503，不回 `rebound:true`；(2) claim 為 unchanged 時也刷新 `boundAt`；(3) `job.data.machineId` 不是合法字串時回 503（不留 null 綁定）；(4) BullMQ job hash 解析失敗時退到 MongoDB；(5) unchanged 且查到終態時 `markTerminal`，綁定照常進入 10 s 寬限；(6) 第一次讀取就是終態時直接回，不為 `deferred` 重讀；(7) 503 的 warn 以節流記錄；(8) rebound 日誌的 clientId 改記雜湊。
- 理由：(1) 綁定已消失時回 `rebound:true`，畫面以為之後會收到事件、實際收不到，只能等 45 s watchdog；回 503 讓 web 依既有對映處理。(2)(5) 同一分頁反覆 GET 的長任務不該被孤兒回收提早刪掉，查到終態也要走同一段寬限，否則綁定留到孤兒回收。(3)(4) Redis 讀回的資料不可信（憲章 V 的精神），壞資料不該變成 500 或錯誤的綁定。(6) 終態不會再有事件，重讀只多一次往返。(7)(8) Redis 長時間故障時每個 GET 一則 warn 會洗版；clientId 是連線的存取憑證之一，不以明文進日誌。
- 替代方案：逐項維持原行為，接受上述罕見狀態下的錯誤回應與日誌量。

**以下第 63 條：合併門第 2 輪 web 審查補裁（2026-10-22，待覆核）**

**63. 斷線期間凍結 45 s watchdog 與 2 s 退路**（D10、D11；取代 §7.1「斷線超過約 45 s 時不再續接」的接受；來源：合併門第 2 輪 web 審查 M1）
- **覆核**：2026-10-22 使用者覆核——維持凍結。
- 影響範圍：WS 斷線期間 AI 診斷面板的進行中任務——不再在斷線中途轉「超過 45 秒沒有收到進度，結果未知，請重試」或「結果未送達」；`copilot.store.ts` `checkStalls` 的觸發條件。
- 裁決：`checkStalls` 以連線狀態為條件：連線**斷開**時跳過 45 s watchdog 與 2 s 退路，交由重連 → 授權 → 續接 GET 收尾；已連線但尚未授權時不跳過（授權失敗仍由 watchdog 承接，第 47 條）。
- 理由：斷線時 watchdog 與退路發出的 GET 帶的是舊 socketId，必回 409 `socket_unauthorized` 或網路錯誤，把可能已在後端完成的診斷誤標「結果未知」，而且任務已不是進行中，重連後也不會再續接——使用者只能對已完成的診斷按重試。代價：長時間斷線時任務一直停在「進行中」（頂部橫幅顯示斷線、使用者可中止診斷）。
- 替代方案：維持 watchdog 照常計時，並在重連後替「結果未知」等失敗態續接（要擴大 FR-016 的續接範圍與對應測試）。

### 7.1 整理時發現、不在首批 11 條內的待覆核點

- D2：keepalive 計時器被 `ai/token` 重設，與「涵蓋串流期間」的理由矛盾；複合故障下最長無事件約 55 s。→ 已由第 14 條裁決接受。
- D12：「失敗終態沒有 relay 寬限」原本未處理，ADR-002 §6.5.1 該列的追蹤位置要改。→ 已由第 12 條裁決納入 012-lite。
- 接點表 #11：以 `execution > 1` 顯示「重新派送」會誤標重試與限流延後。→ 已由第 13 條裁決改為只看 `reason`。
- D8／D10：GET 的 409 先後矛盾、404／409 文案與接點表不一致，整理時已修正（協調者同意採此修法）。→ 之後再由第 17 條（`previousSocketId`）、第 23 條（409 分 `code`）、第 25 條（503）擴充，D8、D10 本文已於 T075 同步（2026-10-21）；修法本身仍待覆核。
- D12：快取命中 1 h 後 GET 404、POST 冪等延伸到 1 h 後，兩點為草稿補充、隨定稿採用。→ 2026-10-22 使用者覆核接受。
- （T075 補，2026-10-21）D3「『結果未送達』救回的例外改由 D10 取代」與第 15 條（保留並擴充救回）矛盾。→ 已以第 15 條為準，D3 加更新段。
- （T075 補）research P1～P25 只留在 research、未進 ADR（spec FR-040）。→ 已補錄為第 22～46 條。
- （T075 補）checklist 階段推導的兩點（重連後授權失敗、SC-004 須證明重派）未進 ADR。→ 已補錄為第 47、48 條。
- （T075 補）§4 殘餘風險原寫「停頓 > 45 s 且落在 LLM 串流中」，有了 `ai-result` 短路後窗口實際在「取鎖之後、送出 LLM 請求之前」；且有一種不雙打但 `cached` 標錯的情況。→ §4 已改寫；標錯的情況已由第 49 條吸收。
- （T075 補）P24 的前提（fake 首 token 約在 progress 40 後 500 ms）與實作不符。→ 已由第 51 條更正；research P24／P25 的措辭修正列於 §6。
- （T075 補）`ai-result` 暫存寫入失敗時中斷流程會多打一次 LLM。→ 已由第 50 條改為 best-effort。
- （實作階段補，未編條，2026-10-22 使用者覆核接受）**GET 回 `rebound: true` 前核對 owner**：BullMQ 查詢期間綁定可能已被另一個 GET 改綁走，回應前確認 `JobRoutingRegistry` 的 owner 仍是本次 socketId，不是就回 409 `job_bound_elsewhere`（D8 第 4 點）。代價只是一次 Map 讀取；不核對時兩個 GET 都會回 `rebound: true`，其中一個分頁以為自己在收事件、實際收不到，只能等 45 s watchdog。已寫入 data-model §2.4 與 contracts/diagnosis-lookup §3（2026-10-21 補，合併門第 1 輪確認）。
- （實作階段補，未編條，2026-10-22 使用者覆核接受）**終態綁定 × BullMQ 仍進行中回 503、不重判**（data-model §2.4「實作時更新」）：照理不可達；回 503 讓 web 稍後重試，不猜測要不要改綁（D8 第 4 點）。
- （合併門第 1 輪補，2026-10-22）**瀏覽器端 UI 演練（T081）待使用者**：由第 57 條裁決交使用者驗收——quickstart §4 演練 2／3 的說明行、「重新連線後取回」、「原始串流（不完整）」與無「worker」「stalled」字樣，需在一鍵 demo（`AI_PROVIDER=fake`）實際操作確認；確認前 T081 維持 `[ ]`。
- （合併門第 1 輪 web 審查補，2026-10-22）**斷線超過約 45 s 時不再續接**：→ **已由第 63 條處理**（合併門第 2 輪：斷線期間凍結 watchdog 與 2 s 退路，下列敘述為處理前的情況）。原記錄：斷線期間 45 s watchdog 照常計時，觸發時以**舊 socketId** 發 GET——舊連線已不在線，必回 409 `socket_unauthorized`，任務轉「超過 45 秒沒有收到進度，結果未知，請重試」，之後重連也不再續接（已不是進行中）。重連退避 1／2／4／8／16 s 加 30% 抖動，api 冷啟動超過約 19 s 時，重連成功到 watchdog 觸發只剩約 5～14 s 的餘裕。行為符合 D11「結果未知」的語意（後端可能已完成，使用者按重試以新 jobId 命中快取），列為待覆核的上界。替代方案：斷線期間凍結 watchdog（重連後才繼續計時；要改 `checkStalls` 與對應測試，且整條通道長時間壞掉時畫面會一直停在進行中）。
- （合併門第 1 輪實作補，2026-10-21，未編條，2026-10-22 使用者覆核接受（含 (f) 覆蓋率 13 檔）；`561dee6`、`bac9426`、`97487f7`）：
  - (a) **GET 先讀 state、再讀 job hash**（正確性條件）：反過來讀時，讀 hash 當下 job 仍在跑（沒有 `returnvalue`）、讀 state 時已 completed，會被當成 `returnvalue` 不合法而退到 MongoDB；快取命中的 job 不寫 `diagnoses`，於是誤回 404。先讀 state 的話，state 為 completed 時 hash 裡一定已有 `returnvalue`。寫入 data-model §2.4 與 contracts/diagnosis-lookup §3。
  - (b) POST 入列失敗時只刪本次建立的綁定（`deleteIfCurrent`），不誤刪別人的。
  - (c) worker 把 job 交回佇列（限流延後、關閉中）前先停 keepalive，避免交回後仍以舊執行送 progress。
  - (d) worker 端 `findDiagnosisResult` 加 `maxTimeMS` 5000（比照 context 查詢），Mongo 卡頓時冪等短路不無限期掛著。
  - (e) web `onAuthorized` 略過 POST 仍在往返的機台（job 可能還沒入列，GET 會 404 而誤轉「無法取回」），由 `resumeAfterPost` 在 POST 結束後補一次續接；`retryOnNewSocket` 作廢 GET 往返期間重連造成的結果，改以新連線重發。
  - (f) 逐檔覆蓋率門檻由 10 檔增為 13 檔：加入 `job-routing-registry.ts`、`diagnosis-lookup.service.ts`、`job-status-payload.ts`（推翻 research R11「新檔不加入逐檔門檻」；新檔都是行為核心，納入後重構時退步會被擋下）。
- （合併門第 2 輪實作補，2026-10-22，未編條，同日使用者覆核接受；`0d97fc8`、`eb36537`、`48a20f7`）：
  - worker：第 58～60 條的落地細節見 data-model §3、§5（`ai-fail` 值加 `attempt`／`retryable`，只在 `marker.jobId === jobId && marker.attempt < attempt` 時忽略；等待者以 `retryable` 決定是否直接最終失敗；SET `ai-cache` 失敗只 warn）。
  - web：`lookup/result` 的 progress 只往前（大於目前值或目前為 null 才採用；回應讓任務換到新一輪或新一次執行時採用回應值）；重連時清掉 2 s 寬限起點 `backendCompletedAt`；同 jobId 的 `ai/token`／`job/status` 抵達即清「正在取回」，此後該次續接 GET 若失敗不轉失敗、交 watchdog（新連線確實在收事件，GET 失敗不代表取不回）。
  - api（第 61、62 條的落地細節）：`revertClaim` 把改綁期間補的 machineId／attempt／execution／deferred 寫回原物件再放回（參照不變）；新增 `touch(jobId, clientId, now)` 就地刷新 `boundAt`（僅綁定仍送往該 clientId 且未終態），unchanged × 進行中時呼叫；讀取期間綁定消失回 503（warn `binding vanished while reading job`）、owner 為別條連線回 409；`job.data.machineId` 非字串或不在機台名冊回 503 並撤回（rebound 且原綁定已有 machineId 時照常回應）；job hash 解析失敗（SyntaxError）warn 後退 MongoDB，其他錯誤仍 503；讀到終態且綁定為本 socket 原本那份、尚未標終態時 `markTerminal`；第一次讀到終態直接回應；Redis／Mongo 不可用的 warn 共用節流器、以 key 分開；rebound／衝突 info 的 clientId 改記 sha256 前 12 碼；400 的 `issues` params 與 query 各最多 5 則；新 job 的 GET 回 `progress: 0`（BullMQ 預設）；新增真 Redis 整合測試 `apps/api/src/integration/diagnosis-lookup.int.test.ts`。

---

## 8. demo 時可直接講的取捨說明（60–90 秒）

> 這個系統的 AI 結果原本只靠一則 Redis Pub/Sub 訊息送到畫面，Pub/Sub 是 at-most-once，訂閱斷一下結果就沒了——後端明明成功，畫面卻顯示失敗。第三輪審查用 `CLIENT KILL TYPE pubsub` 重現了這件事。
>
> 我沒有去自己實作 Redis Streams。BullMQ 的 QueueEvents 本身就是一條 Redis Stream，`completed` 事件本來就帶 job 的回傳值，只是我們一直沒用。所以我讓 worker 把結果當 `returnvalue` 回傳，api 驗證過 schema 後放進 `job/status`，Pub/Sub 的 `ai/done` 降成「早一點到的通知」，到不了也沒關係；斷線重連就用 `GET /diagnoses/:jobId` 把結果拿回來，同時把進行中的任務改綁到新連線。
>
> 另一半是「重複執行」：我把 BullMQ 的鎖從 30 秒縮到 15 秒、stalled 檢查從 30 秒縮到 5 秒，worker 活著時每 10 秒至少送一次進度，崩潰後 25 秒內一定會被重新派送，畫面最長 35 秒沒有事件，低於前端 45 秒的逾時；代價是 Redis 卡一下就可能同一個 job 跑兩次，所以 jobId 必須冪等——再跑一次會拿到同一個結果、不會多寫一筆紀錄、也不會再打一次 LLM。供應商出狀況時，同一個問題的其他請求看到失敗標記就不再重打，省下的是乘以重試次數的 API 費用。
