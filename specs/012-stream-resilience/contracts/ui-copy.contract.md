# Contract：AI 診斷面板的韌性文案與呈現（非通訊契約）

本檔是 spec FR-035～FR-038 文案表的落地對照：每句文案的觸發條件、所在元件、承載它的狀態欄位（data-model §6）與單元測試的
斷言點。視覺一律依 `apps/web/PRODUCT.md`、`apps/web/DESIGN.md`；不新增色值、chip 種類或動畫。

## 1. 文案常數

文案以具名常數放在 `apps/web/src/domains/ai-copilot/lib/copilot-reducer.ts`（與既有 `UNDELIVERED_ERROR` 同處），元件與 store 只引用常數。

| 常數 | 文案 | 觸發 | 位置 |
| --- | --- | --- | --- |
| `STALLED_NOTICE(n)` | 後端處理程序中斷，任務已重新排入佇列（第 N 次執行） | active 且 `stalledNotice` 存在（只由 `reason:"stalled"` 設起） | `CopilotDrawer.vue` 進行中區塊、步驟列下 |
| `RESUMING_NOTICE` | 已重新連線，正在取回診斷狀態… | active 且 `resume === "pending"`（與上一行同時成立時只顯示這行） | 同上 |
| `RECOVERED_META` | 重新連線後取回 | completed 且 `source === "lookup"` | `CopilotDrawer.vue` 完成 meta（中性小字） |
| `STREAM_LABEL_INCOMPLETE` | 原始串流（不完整） | completed 且 `streamIncomplete` | `StreamDisclosure` 的 `label` |
| `WATCHDOG_UNKNOWN_ERROR` | 超過 45 秒沒有收到進度，結果未知，請重試 | 45 s 無進展 → GET 回 404、409、503、429、網路錯誤或格式不符（回 failed 時改用 `humanizeError(error)`；取代「診斷逾時或無回應，請重試」，舊字串與其測試斷言移除） | failed `error` |
| `LOOKUP_EXPIRED_ERROR` | 連線中斷期間的診斷結果已無法取回，請重試 | 續接 GET 404 | failed `error` |
| `LOOKUP_ELSEWHERE_ERROR` | 這個診斷正由另一個視窗接收，請在該視窗查看或重試 | 續接 GET 409 且 `code === "job_bound_elsewhere"` | failed `error` |
| `LOOKUP_DISCONNECTED_ERROR` | 連線中斷，請重試 | 續接 GET 網路錯誤、逾時、429、503、409 `socket_unauthorized`、回應格式不符 | failed `error` |
| `PERSIST_FAILED_ERROR` | 診斷結果無法寫入資料庫，請稍後重試 | `ai/error.code === "persist_failed"`，或任何失敗原因字串含 `persist_failed` | `humanizeError` |
| `STALLED_LIMIT_ERROR` | 後端處理程序多次中斷，診斷已停止，請重試 | 失敗原因含 `job stalled more than allowable limit` | `humanizeError` |
| `UNDELIVERED_ERROR`（既有） | 診斷已在後端完成，但結果未送達畫面，請重試 | 2 s 寬限到期 → GET 回 completed、failed 以外的結果（回 failed 時改用 `humanizeError(error)`，不標 `undelivered`） | failed `error`（`reason:"undelivered"`） |

`humanizeError` 新增的兩條判斷 MUST 排在既有關鍵字判斷之前（`persist_failed` 的固定句不含既有關鍵字，但順序在前可避免日後改句時誤落到其他分類）。

## 2. 原始串流標題

| 狀態 | 標題 |
| --- | --- |
| active | 原始串流 |
| completed，`streamIncomplete === false`（以 `ai/done` 收尾且執行期間未重連） | 原始串流 |
| completed，`streamIncomplete === true`（以 `job/status`／GET 收尾，或執行期間經歷過重連） | 原始串流（不完整） |
| failed `undelivered` | 原始串流 |
| failed 其他 | 原始串流（中斷前） |

判斷只看收尾來源與重連旗標，不比對 `seq` 或結果（FR-038，寧可多標不漏標）。

## 3. GET 的三種用途與失敗對映（store `lookup(…, purpose)`）

| purpose | 觸發 | completed | failed | waiting／active | 404 | 409 `job_bound_elsewhere` | 其他失敗 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `resume` | `onAuthorized` 消化 `pendingResume` | 完成（`source:"lookup"`） | 失敗（`humanizeError(error)`） | 留在 active、清 `resume`、重設 watchdog、記 `boundSocketIds` | `LOOKUP_EXPIRED_ERROR` | `LOOKUP_ELSEWHERE_ERROR` | `LOOKUP_DISCONNECTED_ERROR` |
| `undelivered` | `completed` 無 result 後 2 s | 完成 | 失敗（`humanizeError(error)`，不可救回） | `UNDELIVERED_ERROR`（research P21） | `UNDELIVERED_ERROR` | `UNDELIVERED_ERROR` | `UNDELIVERED_ERROR` |
| `watchdog` | 45 s 無進展 | 完成（照常公告） | 失敗（`humanizeError(error)`） | 留在 active、重設 watchdog、`console.warn` | `WATCHDOG_UNKNOWN_ERROR` | `WATCHDOG_UNKNOWN_ERROR` | `WATCHDOG_UNKNOWN_ERROR` |

- 「其他失敗」欄涵蓋 409 `socket_unauthorized`、429、503、網路錯誤、逾時與回應格式不符（spec FR-005、FR-016、FR-022；analyze 階段核對 2026-10-21）。

- 所有 GET 帶 `socketId = lastClientId`、`previousSocketId = boundSocketIds.get(jobId)`；沒有 `lastClientId` 時直接走該 purpose 的「其他失敗」欄。
- GET 回應抵達時，若該台已不是同一 jobId 的 active（`undelivered` 時另允許可救回的未送達失敗），丟棄回應。
- 同一 jobId 同時只有一個 GET（`lookupInFlight`）。

## 4. 不變的呈現規則

- 卡片診斷 chip 不新增種類：重派、取回、重連續接期間都顯示「診斷中 N%」（FR-037）。
- 面板 chip 維持「進行中」；job meta `<dl>` 維持「佇列」「嘗試」兩項，「嘗試 N / 3」由 `state.attempt` 推進（`job/status.attempt` 或 `ai/token.attempt`）。
- 螢幕閱讀器公告只在 active → completed／failed 的那一次轉移觸發（`CopilotDrawer.vue` 既有 watch），`ai/done` 重複不再公告。
- 結果整塊直接出現、不走逐字動畫（既有完成態行為）；GET 收尾的耗時照常顯示，但不成為「上一次」對比基準（data-model §6.4）。
- 畫面不出現「worker」「stalled」字樣；「停滯」只用於機台資料 10 秒未更新（FR-036）。新術語「重新排入佇列」（內部稱重新派送）「取回」「結果未知」補進 `apps/web/PRODUCT.md`。

## 5. 測試鉤子

沿用既有元件測試的查詢方式（文字與 role）；新增說明行加 `data-testid="copilot-progress-note"`，完成 meta 小字加
`data-testid="copilot-recovered-meta"`，供 `CopilotDrawer.test.ts` 斷言出現與否，不作為樣式選擇器。
