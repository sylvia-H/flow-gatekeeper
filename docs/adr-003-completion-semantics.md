# ADR-003：診斷完成語意與結果讀取——BullMQ `returnvalue` 為權威、`ai/done` 降為 best-effort

| 項目 | 內容 |
| --- | --- |
| 狀態 | Accepted（2026-10-21，離席期間代理裁決、待使用者覆核；覆核後移除此註） |
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
   來源：第三輪報告 §3.2（AR-4、WK-4 補強）；實作細節為 ADR-003 代理裁決第 5 條（待覆核）。
4. **(d) BullMQ 參數改為 lock 15 s／stalled 5 s／maxStalled 2**，並以 worker 端 keepalive 保證「worker 活著就每 10 s 至少一則事件」；兩者合起來讓「worker 被 SIGKILL 後到下一則事件」的設計上界為 35 s，低於 45 s watchdog。**與第三輪報告不同**：報告建議 15／10／2，在 keepalive 10 s 下最壞情況剛好 45 s、沒有餘裕（D4）。
   來源：第三輪報告 §3.2（AR-S7）、§5.4；ADR-003 代理裁決第 1 條（待覆核）。
5. **(e) 新增 `GET /diagnoses/:jobId?socketId=`**：沿用 POST 的授權閘門（`socketId` 必須在線且已授權）；查詢順序 BullMQ（`Job.fromId` → state／`returnvalue`）→ Mongo `diagnoses` → 404；進行中的 job 只有在原綁定的連線已離線（或綁定已不存在，例如 api 重啟後）才允許 rebind 到本次 socketId；已完成的 job 任何已授權連線都可讀；授權模型是「jobId 即 bearer capability」。綁定改由新抽出的 `JobRoutingRegistry` 持有，rebind 寫在它裡面；`completed` 與 `failed` 兩種終態後綁定都保留 10 s 寬限（同一段 registry 程式，D12）。nginx 對 GET 另設限流區。（D8、D9、D12）
   來源：第三輪報告 §5.3、§5.4、§5.6；ADR-003 代理裁決第 3、8、12 條（待覆核）。
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

> `ai/done` is a best-effort notification. It MAY be delivered more than once for the same jobId (re-execution after a stalled lock or a retry always carries the same result) and MAY be lost (Redis Pub/Sub is at-most-once). The authoritative completion is `job/status` with `status: completed` and `result`; consumers MUST treat the first completion they receive for a jobId as final and ignore later ones.

web 現況已滿足「之後的忽略」：reducer 只在 active 消費事件（`copilot-reducer.ts:163`），唯一例外是「結果未送達」失敗可被遲到的 `ai/done` 救回（`:151-162`），012-lite 之後這條例外改由 D10 的規則取代。

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

**定案 lock 15 s／stalled 5 s／maxStalled 2、keepalive 10 s。** 理由：`S` 只影響「多快發現」，不影響「多容易誤判」（誤判由 lock 是否過期決定，看的是 `L`），縮小 `S` 的代價是每個 worker 每 5 s 跑一次 stalled 檢查的 Lua（`LRANGE active`＋`SADD`，demo 規模下微秒級）；縮小 `L` 才會提高誤判率。`maxStalledCount` 2 是因為 `L` 縮短後 Redis 卡頓超過 15 s 就會觸發一次 stalled，留一次額度給真正的 worker 崩潰（現況 1 次額度會被一次卡頓用掉，AR-4 實測）。`lockRenewTime` 維持 BullMQ 預設 `L/2`＝7.5 s。四個值寫成具名常數並在 README 說明。

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
2. **trigger 冪等**：`diagnosisTriggers` 新增 `{ jobId: 1 }` unique 索引；既有資料可能已有重複（AR-4 的歷史），沿用 `ensureUniqueJobIdIndex` 的「衝突時退回非 unique＋記 error」邏輯（`diagnosis-repository.ts:69-96`）。寫入改 `updateOne({ jobId }, { $setOnInsert: {…} }, { upsert: true })`，failed handler（`main.ts:245-247`）同樣改用它。一個 jobId 只會有一筆：成功（`cached` true／false）或最終失敗，兩者互斥。
3. **hit／miss 只計一次**：`SET ai-metric:<jobId> 1 NX EX 86400`，回 OK 才 `recordCacheHit`／`recordCacheMiss`。TTL 24 h 對齊 `removeOnFail`（`jobs.service.ts:185`）。不用 `attemptsStarted === 1`：限流延後的再執行也會遞增它，限流後才真正打 LLM 的那次 miss 會漏記。
4. **寫庫失敗不重打 LLM（WK-4 補強）**：LLM 成功、`parseResult` 通過後，先 `SET ai-result:<jobId> <result> EX 3600` 再寫 `diagnoses`；`diagnoses` 寫入失敗時經 `fail("persist_failed", …, retryable: true)` 送出（最終 attempt 才送 `ai/error`），重試時在第 1 點的 (i) 命中暫存、只重做寫庫。寫庫成功後 `DEL ai-result:<jobId>`。TTL 1 h 對齊 `removeOnComplete`。快取寫入（`ai-cache:<sig>`）維持在 `diagnoses` 之後，保留「快取有值就代表已落庫」的既有不變量（`processor.ts:335-336` 的註解）。
5. **先落地後宣告**維持 2.1.0 的順序：trigger → `updateProgress(100)` → `ai/done` → return。

| 方案（針對第 4 點） | 不選的理由 |
| --- | --- |
| **A（選）** per-job 結果暫存 `ai-result:<jobId>` | 代價：每個成功 job 多一次 SET／DEL；Redis 記憶體在 `maxmemory 256mb noeviction` 下，暫存存活至多 1 h、單筆數 KB，demo 規模可忽略 |
| B 只加 `persist_failed` 錯誤碼、接受重打 | Mongo 拒絕寫入（validator、磁碟滿）或在 LLM 呼叫期間重啟時，每個 job 打 3 次 LLM 並全數計費（`CHANGELOG.md` `[2.1.0]` 已向使用者揭露的成本問題不會消失） |
| C 改成先寫快取、再寫 `diagnoses` | 重試會命中以簽章為鍵的快取並回 `cached:true`，無從分辨「別人的結果」與「自己還沒落庫的結果」，`diagnoses` 永遠缺這筆——這正是現行順序要避免的（`processor.ts:335-336`） |

來源：第三輪報告 §3.2（AR-4：`findByJobId`、trigger 冪等、hit／miss 去重；WK-4 補強：`persist_failed`）；查詢順序、索引、`SET NX` 與 `ai-result:<jobId>` 暫存為 ADR-003 代理裁決第 5 條（待覆核）。

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

### D8. `GET /diagnoses/:jobId?socketId=` 的授權與 rebind

**授權模型**：沒有使用者身分（ADR-002 §6.3），jobId（UUID v4，122 bits 亂數，前端 `crypto.randomUUID` 產生）即 bearer capability：知道 jobId 且持有一條在線、已授權的 WS 連線，就能讀這個 job 的結果。這與 POST 的冪等規則同一模型（POST 以 jobId 重送拿到同一個 job）。

**處理流程（定案；整理時修正了草稿「第 4 點 rebind 規則」與「第 5 點先綁定後查詢」的先後矛盾——草稿在查詢前就對「原綁定在線」回 409，會讓已完成任務在 10 s 完成寬限內被擋，違反「已完成任何已授權連線可讀」）**：

1. `jobId`、`socketId` 皆以 `z.uuid()` 驗證，不符 400（只回 issue 路徑與代碼，比照 POST）。
2. `socketId` 不是在線且已授權的連線 → 409（訊息與 POST 相同）。
3. **先綁定（暫定）**，在任何 await 之前於 `JobRoutingRegistry` 完成（與 POST「綁定必須在任何 await 之前建立」同理，`jobs.service.ts:133-135`），否則查詢回 active 之後、綁定建立之前若剛好 `completed`，那則事件會找不到對象：
   - 綁定不存在（api 重啟後 Map 清空，或已被孤兒回收）→ 暫定建立，指向本次 socketId；
   - 綁定存在、已標記終態（`completed` 或 `failed` 後的 10 s 寬限中，D12）→ 不動，直接視為終態；
   - 綁定存在且原 clientId 已離線（`gateway.isOnline` 為 false）→ 暫定改綁到本次 socketId，記下原綁定以便撤回；
   - 綁定存在且等於本次 socketId → 不動；
   - 綁定存在、原 clientId 仍在線且不等於本次 socketId → **不動、記為「衝突」**，等查詢結果再決定。
4. 查詢 `Job.fromId`：
   - **completed** → 驗 `returnvalue` → 200 `{ status:"completed", result, cached }`；撤回步驟 3 的暫定建立或改綁（**不 rebind**，之後不會再有事件）；衝突者也照常回結果。
   - **failed** → 200 `{ status:"failed", error: failedReason }`；同樣撤回暫定動作、衝突者照常回。
   - **waiting／delayed／active／prioritized** → 衝突者 **409「此診斷仍綁定在另一條連線」**；其餘保留步驟 3 的綁定，200 `{ status:"waiting"|"active", progress?, attempt?, execution?, rebound:true }`。
   - job 不存在（`removeOnComplete` 1 h／`removeOnFail` 24 h 已清）→ Mongo `diagnoses.findOne({ jobId })` → 有則 200 completed（`cached:false`），無則 **404**；兩者都撤回暫定動作。快取命中的 job 不寫 `diagnoses`，1 h 後查不到、回 404——接受（D12）。
5. 撤回只針對本次請求自己做的暫定動作，不刪除別人建立的綁定。
6. 回應 schema 為 `DiagnosisLookupResponseSchema`（以 `status` 區分的 discriminated union）與 query schema `DiagnosisLookupQuerySchema`，放 `http.ts`；query 與成功回應 MUST 以 Zod 定義（本 ADR 與 spec 的要求，不待憲章修訂）。憲章 Principle III 現行條文只列舉 POST，本 ADR **建議**以 `/speckit-constitution` 補成「`POST /diagnoses` 與 `GET /diagnoses/:jobId`」（PATCH 1.6.0 → 1.6.1 的措辭修正）；修訂憲章屬「改流程規則本身」的單向門，**不在使用者離席期間執行**，實際修訂待使用者確認。

| 方案 | 不選的理由 |
| --- | --- |
| **A（選）** GET＋socketId 閘門＋bearer jobId＋「原綁定離線才 rebind」 | 代價：任何已授權連線只要知道 jobId 就讀得到結果；jobId 會出現在 nginx access log 的路徑裡（ADR-002 §6.3 提醒過 query string 進 log），能讀 log 的人可讀結果、可在原連線斷線後接手進行中的 job。demo 的結果是 mock 遙測的診斷，不含機密 |
| B GET 只回給「與原綁定相同的 socketId」 | 重連一定拿到新 clientId（Gateway 每次連線 `randomUUID()`），這條規則讓 rebind 永遠不可能，GET 只剩「同一條連線查自己」，解不了重連問題 |
| C POST 回傳一次性 rebind token（HMAC(jobId)），GET 帶 token | 能把「讀結果」從 jobId 分離出來，但 api 要多管一把簽章金鑰（多實例時要共享）、契約多一個欄位、web 要保存 token；沒有使用者身分的前提下，token 與 jobId 一樣存在同一個前端記憶體裡，換不到實質安全 |
| D 不用 HTTP，改 WS 控制訊息 `job/resume { jobIds }` | 不經 nginx 限流、沿用 WS 授權，但要新增第 13 個 channel（client→server）、Gateway 多一種控制訊息與入站限速分類，結果也要經 WS 下發；HTTP 版本可以用 curl 直接驗收，e2e 與排查都簡單 |

來源：第三輪報告 §5.3（`JobRoutingRegistry` 隨 012-lite 抽出）、§5.4（閘門、`Job.fromId`→Mongo→404、原綁定離線才 rebind）、§5.6（jobId 即 bearer capability）；狀態分支、先綁定後查詢與回應形狀為 ADR-003 代理裁決第 3 條（待覆核）；憲章修訂建議為代理裁決第 9 條（實際修訂待使用者）。

### D9. nginx 對 GET 的限流

`apps/web/nginx.conf:86-90` 的 `location /diagnoses` 是前綴匹配，GET `/diagnoses/<uuid>` 會共用 POST 的 `limit_req zone=diag`（10 r/m、burst 5）。web 重連時最多 5 台同時 GET、2 s 未送達與 watchdog 也各會 GET 一次，加上使用者接著按「重試」的 POST，會在同一個桶裡互搶，使用者看到「診斷請求過於頻繁」。

**定案**：新增 `limit_req_zone $binary_remote_addr zone=diag_read:1m rate=60r/m;` 與 `location ~ ^/diagnoses/[0-9a-fA-F-]{36}$ { limit_req zone=diag_read burst=10 nodelay; limit_req_status 429; … }`（regex location 優先於前綴 location；location 比對不含 query string，`?socketId=` 不影響），POST 維持原桶。新 location 沿用 `/diagnoses` 的 `proxy_pass http://$api_upstream;` 寫法，且**不寫 `add_header`**，才會繼承 server 層的安全 header（`nginx.conf:44-45` 的繼承規則）。理由：讀取是冪等、成本低（一次 Redis HGETALL、最多一次 Mongo `findOne`），60 r/m 足以涵蓋 5 台重連＋退路；仍保留上限，避免被拿來掃 jobId（UUID v4 也掃不出來）。Docker Desktop 下全體共用一桶的既有限制不變（ADR-002 §6.5）。

| 方案 | 不選的理由 |
| --- | --- |
| **A（選）** GET 獨立 location 與限流區 | — |
| B 共用 POST 的桶 | 見上：重連後重試拿 429 |
| C GET 不限流 | nginx 是 GET 唯一的流量上限（api 端無 HTTP 限流），不限等於讓單一來源可無上限打 Redis／Mongo |

來源：ADR-003 代理裁決第 8 條（待覆核；報告未提 nginx 前綴匹配的問題）。

### D10. web 的收斂規則

- **三種到達順序收斂到同一狀態**：(1) `ai/done` → `completed+result`；(2) `completed+result` → `ai/done`；(3) `completed`（無 result）→ 2 s → GET → （遲到的 `ai/done`）。三者都在第一個結果到達時轉 completed，`result`、`cached` 相同，之後的忽略；耗時只結算一次、螢幕閱讀器公告只一次。
- **onReconnect 要等授權成功才 GET**：App 在 `system/connected` 就呼叫 `onReconnect`（`App.vue:273-277`），但有設 `WS_AUTH_SECRET` 時新連線要等 `machine/subscribed` 才算已授權（`useHighFrequencyWs.ts:50-53`），太早 GET 會被 409、任務被誤判中斷。定案：`onReconnect` 只記下「哪些 active 任務需要續接」並把它們標為「重新連線中」（仍是 active，不轉失敗），`onAuthResult(true)` 時才逐台 GET；GET 回 completed／failed 照轉，active／waiting 留在 active 並重設 watchdog；404、409、網路錯誤與 429 轉失敗，文案依 spec 的 UI 接點表（404：「連線中斷期間的診斷結果已無法取回，請重試」；409：「這個診斷正由另一個視窗接收，請在該視窗查看或重試」；其他：「連線中斷，請重試」）。（整理時修正：草稿此處把四種回應一律寫成「連線中斷，請重試」，與接點表 #7 不一致，以接點表為準。）
- **2 s 未送達先 GET 一次**：`completed` 不帶 result（舊版 api／returnvalue 驗證失敗）時，2 s 寬限到期先 GET；GET 回 completed 就完成，否則才轉現行的「結果未送達」失敗。
- **attempt** 改由 `job/status.attempt` 推進；`ai/token` 的 attempt 判斷保留（換輪清空邏輯不變）。`MAX_ATTEMPTS`（`CopilotDrawer.vue:134`）收進 contracts 屬 010-lite，本 feature 不動。

來源：第三輪報告 §5.4（`completed` 帶 result 即收尾、`onReconnect` 先 GET、Attempt 改用 `job/status.attempt`）；授權後才 GET、2 s 退路與失敗文案為 ADR-003 代理裁決第 10、11 條（待覆核）。

### D11. 逾時語意「結果未知」

45 s watchdog 觸發時先 GET 一次：completed → 完成（照常公告）；仍在進行 → 維持 active、重設 watchdog（後端還在跑，只是 45 s 沒送事件，表示 keepalive 失效，記一則 console 警告）；其他 → 轉失敗，文案改為「超過 45 秒沒有收到進度，結果未知，請重試」（取代「診斷逾時或無回應，請重試」）。理由：012-lite 之後 worker 活著就有 keepalive，watchdog 只會在「worker 死了且沒人重派」或「整條即時通道壞了」時觸發，兩種情況後端都可能其實已經完成；不查一次就宣告失敗，會讓使用者對一個已完成的診斷按重試。

watchdog 維持牆上時鐘（ADR-002 §6.5.1「45 s watchdog 仍用牆上時鐘」列留在 backlog）：觸發後先 GET，時鐘往前跳造成的誤觸會得到「仍在進行」而不轉失敗，改單調時鐘的收益因此更小。

來源：第三輪報告 §5.6（逾時語意為「結果未知」）；GET 一次、文案與不改單調時鐘為 ADR-003 代理裁決第 7 條（待覆核）。

### D12. 其餘小決定

- **快取命中的 job 1 h 後 GET 回 404**：快取命中不寫 `diagnoses`（避免同一份結果複製多筆，`processor.ts:254-256`），`returnvalue` 隨 `removeOnComplete` 1 h 消失。接受：重連續接的時間尺度是秒到分鐘，1 h 後的 GET 只會來自手動查詢。若要涵蓋，可把 `result` 寫進該筆 trigger，代價是 `diagnosisTriggers` 變大（30 天 TTL）。
- **POST 的 jobId 冪等延伸到 1 h 之後**（API-16）：job 被 `removeOnComplete` 清掉後，同 jobId 的 POST 會重新入列；012-lite 之後 processor 開頭的 `findByJobId` 會直接回舊結果，不打 LLM——語意上正是「同 jobId＝同一個請求」，不需另外改 POST。
- **失敗終態**：`failed` 仍只帶 `failedReason` 原文，具體錯誤碼要等 010-lite 的 `AiErrorCode`；`maxStalledCount` 用盡時的 `failedReason` 是英文 `job stalled more than allowable limit`，web `humanizeError` 對 < 120 字的英文原文會照顯（`copilot-reducer.ts:110`），012-lite 補一條對映（文案見 D13）。
- **失敗終態的 relay 寬限**（ADR-002 §6.5.1「review03 新增：失敗終態沒有 relay 寬限」列，由 012-lite 收掉）：`failed` 終態套用與 `completed` 相同的 10 s 綁定寬限，由 `JobRoutingRegistry` 的同一段終態寬限程式處理（2.1.0 的 `markCompleted`／`COMPLETED_BINDING_GRACE_MS` 一般化為兩種終態共用）。理由：`ai/error` 走 Pub/Sub、`failed` 走 QueueEvents，跨連線的先後與 `ai/done`／`completed` 一樣沒有保證；`failed` 先到時綁定即刪，worker 送的具體錯誤碼（`persist_failed`、`provider_error` 等）送不到原連線，畫面只看到 api 補送的籠統 `ai/error(worker_failed)`——012-lite 新增的 `persist_failed` 文案就會被這條吞掉。寬限內同 jobId 的 POST 回 409，與綁定已刪時 `enqueueOnce` 查到既有 job 的 409 相同（`jobs.service.ts:116-123`），對 POST 沒有新行為；寬限內的 GET 依 D8 視為終態。

來源：前三點為 ADR-003 補充，隨定稿採用（不在代理裁決條目內，待覆核）；失敗終態寬限為 ADR-003 代理裁決第 12 條（待覆核）。

### D13. 驗收方法與 UI 接點

- **e2e 的 Redis 停頓方式**：`docker compose pause redis` 50 s 後 `unpause`，斷言該 jobId 的 `diagnosisTriggers` 恰 1 筆、LLM 呼叫恰 1 次、hit／miss 合計恰 1 次、最終 `cached` 為 false。理由：它凍結整個 Redis 行程（含 lock 續租與 stalled 檢查的回應），對應的是真實世界的主機／VM 停頓；harness 的 `compose()` 已能直接呼叫，不需新工具。`redis-cli CLIENT PAUSE` 只擋客戶端指令、Redis 本身照常運作，與 key 到期及 Lua 腳本的互動依模式（`WRITE`／`ALL`）而異，要另外驗證才能確定重現的是同一種故障。
- **UI 文案**：採 spec 的「與 013 UI 的接點」表。原始串流標題以「是否以 `job/status`／GET 收尾」判斷，收尾即標「原始串流（不完整）」，不比對 `seq` 與結果；同簽章失敗標記命中時沿用既有錯誤分類文案、不加後綴；卡片的診斷 chip 不新增種類，重派、取回、重連續接都屬「診斷中」，只在面板內用說明行交代。「重新派送」說明行只在 `reason: "stalled"` 時出現（見 D7）；`execution` 因重試或限流延後遞增時只清空串流、不顯示這行。`maxStalledCount` 用盡（`failedReason` 為英文 `job stalled more than allowable limit`，D12）時，web `humanizeError` 對映為「後端處理程序多次中斷，診斷已停止，請重試」，不照顯英文原文。畫面不出現「worker」「stalled」字樣；「停滯」保留給機台資料 10 秒未更新，不拿來形容診斷任務。

來源：e2e 停頓方式為 ADR-003 代理裁決第 6 條（待覆核）；UI 文案為代理裁決第 10 條、「重新派送」只看 `reason` 為第 13 條（待覆核）。

---

## 4. 接受的代價（Trade-offs）

| 代價 | 如何承擔 |
| --- | --- |
| lock 15 s 讓 Redis 卡頓或 worker 事件迴圈卡住超過 15 s 就觸發 stalled 重派，雙重執行比現在常見 | D6 冪等讓重複執行對外結果一致；`maxStalledCount` 2 留一次額度給真的崩潰 |
| Redis 停頓**超過 `AI_DEDUPE_LOCK_SECONDS`（45 s）且正好發生在 LLM 串流中**時，第二次執行可能在第一次寫入快取前取得 `ai-lock`、再打一次 LLM | 罕見（要同時滿足停頓 > 45 s 與停頓落在 LLM 呼叫期間）；記為殘餘風險，不為它加第二把鎖（D3 方案 B 的理由） |
| Pub/Sub 斷線**且** worker 在串流中被 SIGKILL 時，畫面最長無事件約 55 s，會觸發「結果未知」 | 複合故障，接受、不加機制（代理裁決第 14 條）；觸發後先 GET，重派完成後仍可由重試或 GET 取回（D2 殘餘風險註） |
| `failed` 後綁定保留 10 s，寬限內同 jobId 的 POST 回 409 | 與綁定已刪時查到既有 job 的 409 相同，對 POST 沒有新行為；換到的是具體錯誤碼能送到原連線（D12） |
| `ai/done` 會重複、仍可能遺失；自寫 WS client 要以 jobId 去重 | 契約描述明寫（D3）；`CHANGELOG.md` 相容性注意列出 |
| `ai-fail` 讓同簽章的其他請求在 10 s 內直接拿到同一個錯誤，不給它們自己再試的機會 | 只發生在供應商剛失敗的 10 s 內；錯誤碼與持鎖者相同，畫面文案可讀；省下的是 N × 3 次計費呼叫 |
| GET 讓任何已授權連線憑 jobId 讀結果；jobId 會進 nginx access log | 沒有使用者身分的前提下無從更細；log 的保存與存取屬部署面（ADR-002 §6.3 生產路徑：握手驗身分後改以使用者為授權主體） |
| Redis 寫入量增加：lock 續租每 7.5 s（原 15 s）、stalled 檢查每 5 s（原 30 s）、keepalive 每 10 s、`ai-metric`／`ai-result`／`ai-fail` 三種新鍵 | demo 規模（concurrency 個位數、一分鐘數次診斷）可忽略；新鍵都有 TTL，不受 `noeviction` 影響長期記憶體 |
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

- [ ] **ADR-002 §6.2「生產路徑：改用 Redis Streams」**：改寫為「已拒絕（2026-10-21，ADR-003）：結果改以 BullMQ `returnvalue`＋`job/status.result`＋`GET /diagnoses/:jobId` 取回；token 串流維持 at-most-once，重連後直接顯示結果、不續播動畫」；「已變更」註記的「Streams 降為備選」收斂為「已由 ADR-003 定案拒絕」；「更正」段的「目前沒有任何結果讀取端點」標已落地。
- [ ] **ADR-002 §3 第 5 列（Streaming 可靠性）**：後段加「已變更（012-lite）：已有讀取端點與 rebind，完成以 `returnvalue` 為權威；token 串流仍 at-most-once」。
- [ ] **ADR-002 §6.5「結果讀取與完成語意」列**：現況改為「已落地（012-lite，ADR-003）」並一句摘要（`returnvalue` 權威、GET＋rebind、`stalled` 監聽帶 `reason`、keepalive 10 s、lock 15／5／2）；92 秒實測改為過去式；升級路徑改指 ADR-003 §5。
- [ ] **ADR-002 §6.5「api 行程內單實例狀態」列**：升級路徑「`jobRooms` 的 owner 先移到獨立 `JobRoutingRegistry`」改為「已移（012-lite），外置見 ADR-003 §5」。
- [ ] **ADR-002 §6.5.1 WK-4／AR-F4 列**：標「已落地（012-lite）」：processor 開頭以 jobId 查 `ai-result:<jobId>`／`diagnoses`、`persist_failed` 經 `fail()` 送出、trigger 冪等；`cached:true` 誤標子項一併修掉。
- [ ] **ADR-002 §6.5.1「review03 新增：失敗終態沒有 relay 寬限」列**：標「已落地（012-lite，ADR-003 D12）」：`failed` 終態套用與 `completed` 相同的 10 s 綁定寬限；原「使用者 2026-10-18 裁決接受」改為過去式保留。
- [ ] **ADR-002 §6.5.1 末尾**：補一列「review03 roadmap 012-lite：已落地」，列 AR-4、AR-S7、WK-13、WK-4 補強、AR-5 根治（含失敗終態寬限）、WK-20、WEB-20（attempt 部分）、DOC-29，指向 ADR-003 與 `CHANGELOG.md`（現況這幾項沒有獨立列，只出現在 `CHANGELOG.md` `[2.1.0]` 與指南 §15.6 裁決 15）。
- [ ] **ADR-002 §6.1 單實例狀態第 4 項**：由「`jobRooms`（`AiStreamRelayService`：jobId → 接收者綁定）」改為「`JobRoutingRegistry`（jobId → 接收者綁定、完成寬限、rebind；012-lite 自 `AiStreamRelayService` 抽出）」。
- [x] **指南 §15.5「Redis Streams token 回放」候選方向**：段末加「已變更（2026-10-21，ADR-003）：已拒絕」註記，指向本 ADR 與 §15.7（與 §15.7 藍圖同批加入）。（2026-10-21 立案時已加。）
- [x] **指南新增 §15.7 012-lite 藍圖（DOC-16）**：立案前加入。（2026-10-21 立案時已加。）
- [ ] **指南 §15.7 落地回補**（merge 時完成）：§15.7 狀態改「已落地」；§15.6 的「e2e 實測發現（留給 012-lite）」條加「已落地（012-lite）」註記。
- [ ] **README「已知限制」**（README:888 起；注意這四條在「已知限制」，不在「已宣告的取捨」）：「重連不 rebind」改為「重連以 jobId 續接（GET＋rebind），原連線仍在線時不改綁」；「診斷結果目前沒有讀取端點」改為「快取命中的結果 1 小時後無法以 GET 取回」；「worker 崩潰後的重派有長時間靜默」改為「設計上界約 35 秒無事件，超過 45 秒才標『結果未知』」；「AI token 串流為 at-most-once」保留但改寫為「重連後直接顯示結果、不續播」；「第三輪審查的現況」條把 AR-4、AR-S7、WK-13、WK-4 補強、AR-5 根治從「仍未修」移到「已修（012-lite）」。
- [ ] **README 資料表**：`diagnoses`（README:468）的「目前只寫不讀」改為「api 經 `GET /diagnoses/:jobId` 讀取（`returnvalue` 過期後的第二來源）」；`diagnosisTriggers` 補「`jobId` unique，每個 jobId 一筆」；Redis 職責清單補 `ai-fail:*`／`ai-result:*`／`ai-metric:*`。
- [ ] **README 契約版本字串**：1.3.0 → 1.4.0（README:19、289、400、544、842 等；`docs-contract-version.test.ts` 會比對）；nginx 限流敘述補 GET 的 60 r/m 獨立桶；BullMQ 參數具名常數的說明。
- [ ] **`apps/web/PRODUCT.md` 已知產品限制（:77）**：改為「AI token 串流 at-most-once（重連後不續播動畫，直接顯示結果）、快取命中的結果 1 小時後無法以 GET 取回、Mock 頻率控制無後端作用」（Mock 那條保留）；失敗段（:54）「只在後端完成後約 10 秒內、而且中間沒有重連時才救得回來」改寫為新規則（2 s 退路先 GET）；新增術語（重新派送、取回、結果未知）補進 PRODUCT.md。
- [ ] **`tests/e2e/README.md` 場景 3**：「反映的現況語意」改寫為新語意（relay 監聽 `stalled` 並送 `reason`、最長無事件間隔斷言 < 45 s、attempt／execution 由 `job/status` 帶）；「注意」段補 GET 走獨立限流桶、新增的故障場景與耗時。
- [ ] **`asyncapi.yaml` 與 `CHANGELOG.md`**：`info.version` 1.4.0；`job/status` 描述（DOC-29 的 "optionally carrying the final result" 改為實際行為）、`ai/done` 描述（D3）；`CHANGELOG.md` 契約小節記 1.4.0，相容性注意記「`ai/done` 可重複可遺失」「BullMQ `progress` 改為物件」「lock 參數」，並把 `[2.1.0]` 帶著發布的 012-lite 項標為已修。
- [ ] **憲章 Principle III**（**待使用者**）：建議 `/speckit-constitution` PATCH（1.6.0 → 1.6.1）補列 `GET /diagnoses/:jobId`；離席期間不執行，由使用者確認後才修訂。merge 前若仍未確認，在 spec 與本 ADR 保留「建議修訂、待使用者」的註記，GET 的 Zod 定義照做。
- [ ] **repo `CLAUDE.md` 開頭的現況段**：立案時改為「進行中：012-lite」，落地後改為最近一次完成。

---

## 7. 代理裁決清單（2026-10-21，使用者離席期間，待覆核）

使用者離席期間授權對 012-lite 的技術決策採建議項，逐題記錄如下（第 1～11 條為首批，第 12～14 條為整理定稿時發現的矛盾與缺口，經協調者同日補裁；第 9 條同日改寫為「只建議、不在離席期間修訂」）。**第 1 條與第三輪報告的建議不同**，覆核時請優先看。覆核後若有推翻，於本節記為推翻紀錄（原提案／裁決），並移除檔頭的「待覆核」註。

**1. BullMQ lock／stalled／maxStalled 與 keepalive 間隔**（D4）
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
- 裁決：GET 獨立 regex location `^/diagnoses/[0-9a-fA-F-]{36}$`＋`diag_read` 60 r/m、burst 10 nodelay；POST 維持 10 r/m、burst 5。
- 理由：共用 POST 的桶時，5 台重連 GET 加上退路 GET 就把 burst 用完，使用者接著按重試拿 429；不限流則 GET 成為可無上限打 Redis／Mongo 的入口（api 端沒有 HTTP 限流）。
- 替代方案：共用 POST 的桶；GET 不限流。

**9. 憲章 Principle III 補列 GET**（D8 第 6 點）
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

### 7.1 整理時發現、不在首批 11 條內的待覆核點

- D2：keepalive 計時器被 `ai/token` 重設，與「涵蓋串流期間」的理由矛盾；複合故障下最長無事件約 55 s。→ 已由第 14 條裁決接受。
- D12：「失敗終態沒有 relay 寬限」原本未處理，ADR-002 §6.5.1 該列的追蹤位置要改。→ 已由第 12 條裁決納入 012-lite。
- 接點表 #11：以 `execution > 1` 顯示「重新派送」會誤標重試與限流延後。→ 已由第 13 條裁決改為只看 `reason`。
- D8／D10：GET 的 409 先後矛盾、404／409 文案與接點表不一致，整理時已修正（協調者同意採此修法）。
- D12：快取命中 1 h 後 GET 404、POST 冪等延伸到 1 h 後，兩點為草稿補充、隨定稿採用，仍待覆核。

---

## 8. demo 時可直接講的取捨說明（60–90 秒）

> 這個系統的 AI 結果原本只靠一則 Redis Pub/Sub 訊息送到畫面，Pub/Sub 是 at-most-once，訂閱斷一下結果就沒了——後端明明成功，畫面卻顯示失敗。第三輪審查用 `CLIENT KILL TYPE pubsub` 重現了這件事。
>
> 我沒有去自己實作 Redis Streams。BullMQ 的 QueueEvents 本身就是一條 Redis Stream，`completed` 事件本來就帶 job 的回傳值，只是我們一直沒用。所以我讓 worker 把結果當 `returnvalue` 回傳，api 驗證過 schema 後放進 `job/status`，Pub/Sub 的 `ai/done` 降成「早一點到的通知」，到不了也沒關係；斷線重連就用 `GET /diagnoses/:jobId` 把結果拿回來，同時把進行中的任務改綁到新連線。
>
> 另一半是「重複執行」：我把 BullMQ 的鎖從 30 秒縮到 15 秒、stalled 檢查從 30 秒縮到 5 秒，worker 活著時每 10 秒至少送一次進度，崩潰後 25 秒內一定會被重新派送，畫面最長 35 秒沒有事件，低於前端 45 秒的逾時；代價是 Redis 卡一下就可能同一個 job 跑兩次，所以 jobId 必須冪等——再跑一次會拿到同一個結果、不會多寫一筆紀錄、也不會再打一次 LLM。供應商出狀況時，同一個問題的其他請求看到失敗標記就不再重打，省下的是乘以重試次數的 API 費用。
