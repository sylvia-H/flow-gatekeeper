# Contract：`GET /diagnoses/:jobId`（結果讀取與 rebind）

依憲章 III，query 與成功回應 MUST 以 Zod 定義於 `packages/contracts/src/http.ts`（spec FR-032；憲章 Principle III 補列此端點為
**建議**、待使用者以 `/speckit-constitution` 決定，FR-041）。錯誤 body 依例外 (b) 不另定 schema，語意記於 `asyncapi.yaml`
`info.description` 與 `CHANGELOG.md`。設計理由見 ADR-003 D8、D9，落地細節見 research R4、data-model §2。

## 1. 請求

```text
GET /diagnoses/{jobId}?socketId={uuid}[&previousSocketId={uuid}]
```

```ts
export const DiagnosisLookupParamsSchema = z.object({ jobId: z.uuid() });
export const DiagnosisLookupQuerySchema = z.object({
  /** 發起查詢的 WS clientId；必須在線且已授權（與 POST 同一道閘門）。 */
  socketId: z.uuid(),
  /** 呼叫端分頁上一次成功綁定此任務的 socketId；只用於改綁判斷（代理裁決第 17 條）。 */
  previousSocketId: z.uuid().optional(),
});
```

- 重複的 query key（`?socketId=a&socketId=b`）會被 express 解析成陣列 → 400。
- 未列出的 query key 忽略。

## 2. 授權模型

jobId（UUID v4）即 bearer capability：持有一條在線、已授權的 WS 連線且知道 jobId，就能讀該 job；已完成（含由 Mongo 取回）
的結果對任何已授權連線可讀，原綁定仍在線也一樣。進行中的 job 只在「無綁定／原連線離線／原連線等於 `previousSocketId`」時
改綁到本連線（ADR-003 D8、FR-009～FR-011）。

## 3. 處理順序（MUST）

1. 驗 params、query → 不符 400。
2. `socketId` 非在線且已授權 → 409（`code: "socket_unauthorized"`）。
3. **在任何 await 之前** `registry.claimForLookup(...)`（data-model §2.3）。
4. `Job.fromId(queue, jobId)` 與 `getState()`（producer command 連線；上限 5 s）。
5. 依 state 回應並處置 claim（data-model §2.4）；BullMQ 查無 job、state 不在 §4 列舉內（例如 `unknown`，視同查無 job），或
   `returnvalue` 不合法 → Mongo `diagnoses.findOne({ jobId })`（`maxTimeMS` 3 s）→ 合法結果 200 completed（`cached:false`），否則 404。
6. 任何回應前，非保留的 claim 一律 `revertClaim`（只撤回本次請求自己的動作）。
7. **回 `rebound: true` 前核對 owner**（實作交叉審查補，2026-10-21；data-model §2.4、ADR-003 D8 第 4 點）：查到進行中、claim 為
   `created`／`rebound`／`unchanged` 時，回 200 之前 MUST 確認 registry 目前的 owner 仍是本次 `socketId`；BullMQ 查詢期間綁定已被
   另一個 GET（例如以 `previousSocketId`）改綁走時，回 409 `job_bound_elsewhere`（與衝突相同）。

## 4. 成功回應（200，`DiagnosisLookupResponseSchema`）

```jsonc
// 已完成（BullMQ returnvalue 或 Mongo）
{ "status": "completed", "jobId": "…", "result": { /* DiagnosisResult */ }, "cached": false }
// 已失敗
{ "status": "failed", "jobId": "…", "error": "persist_failed: diagnosis record could not be written" }
// 進行中（已改綁或本來就綁在本連線）
{ "status": "active", "jobId": "…", "progress": 60, "attempt": 1, "execution": 2, "rebound": true }
{ "status": "waiting", "jobId": "…", "rebound": true }
```

- `waiting` 涵蓋 BullMQ 的 waiting／delayed／prioritized／waiting-children。
- `progress`：`job.progress` 為 `DiagnosisJobProgress` 時取 `value`、為 number 時直接用，否則省略；`attempt`＝`attemptsMade + 1`、
  `execution`＝`attemptsStarted`（≥ 1 才帶）。
- `rebound` 恆為 `true`：表示之後的 `job/status`／`ai/*` 會送到本次 `socketId`（research P22）。
- `result` 不論來源皆已通過 `DiagnosisResultSchema`；不回未驗證物件（憲章 V）。

## 5. 錯誤回應

| 狀態碼 | 觸發 | body（Nest `HttpException`） |
| --- | --- | --- |
| 400 | params 或 query 不符 schema | `{ statusCode: 400, error: "Bad Request", message: "request 不符合 GET /diagnoses/:jobId 契約", issues: [{ path, code }] }`（不回顯輸入） |
| 404 | BullMQ 與 Mongo 皆無合法結果 | `{ statusCode: 404, error: "Not Found", message: "查無此診斷（可能已過期）" }` |
| 409 | `socketId` 不在線或未授權 | `{ statusCode: 409, error: "Conflict", code: "socket_unauthorized", message: "WebSocket 連線不存在或未授權，請重新連線後再發起診斷" }`（message 與 POST 相同） |
| 409 | 進行中且原綁定在線、不是本連線、不等於 `previousSocketId` | `{ statusCode: 409, error: "Conflict", code: "job_bound_elsewhere", message: "此診斷仍綁定在另一條連線" }` |
| 429 | nginx `diag_read` 超限 | nginx 錯誤頁（非 JSON） |
| 503 | Redis／Mongo 不可用，或 BullMQ 查詢超過 5 s、Mongo 查詢超過 3 s（合計上限 8 s；spec FR-010） | `{ statusCode: 503, error: "Service Unavailable", message: "診斷狀態暫時無法查詢，請稍後再試" }` |

`code` 欄位只出現在 GET 的 409（research P2）；POST 的 409 body 不變。

## 6. nginx（`apps/web/nginx.conf`）

```nginx
limit_req_zone $binary_remote_addr zone=diag_read:1m rate=60r/m;

location ~ ^/diagnoses/[0-9a-fA-F-]{36}$ {
    limit_req zone=diag_read burst=10 nodelay;
    limit_req_status 429;
    proxy_pass http://$api_upstream;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
}
```

- 放在 `location /diagnoses` 之前（regex 優先於前綴匹配）；不寫 `add_header`（繼承 server 層安全 header）。
- POST 維持 `diag` 10 r/m、burst 5。Docker Desktop 下 `$binary_remote_addr` 全體共用一桶的既有限制不變（ADR-002 §6.5）。

## 7. 日誌（依 `specs/009-observability-baseline/contracts/log-fields.md`）

| 事件 | 等級 | 欄位 |
| --- | --- | --- |
| rebind（含 `previousSocketId` 路徑、api 重啟後建立） | info | `jobId`、`fromClientId`、`toClientId`、`viaPreviousSocketId` |
| 衝突 409（`job_bound_elsewhere`） | info | `jobId`、`clientId` |
| `socket_unauthorized` 409 | warn（沿用 POST 的 30 s 全域節流） | `jobId`、`suppressed` |
| `returnvalue` 不合法退到 Mongo | warn | `jobId`、`issues` |
| Redis／Mongo 失敗 → 503 | warn | `jobId`、`err` |

## 8. web 用戶端（`apps/web/src/domains/ai-copilot/lib/diagnose-api.ts`）

- `getDiagnosis(jobId, socketId, previousSocketId?)`：同源 `fetch`、逾時 15 s（`DIAGNOSE_REQUEST_TIMEOUT_MS`）；回應以
  `DiagnosisLookupResponseSchema.safeParse` 並比對 `jobId`；任何失敗都拋 `DiagnoseLookupError { kind, status?, code? }`（實作時補
  `kind`，2026-10-21）：
  - `kind: "http"`：非 2xx；`status` 必有，409 時 `code` 為 body 的 `socket_unauthorized`／`job_bound_elsewhere`（讀不到或不在已知集合則 undefined）。
  - `kind: "network"`：fetch reject（離線、DNS、連線被拒）。
  - `kind: "timeout"`：超過 `DIAGNOSE_REQUEST_TIMEOUT_MS`。
  - `kind: "invalid"`：2xx 但回應不合 `DiagnosisLookupResponseSchema`，或 `jobId` 與查詢的不一致（research P3）。
  - 錯誤只帶分類、不帶使用者文案：同一個失敗在續接、2 s 未送達、45 s watchdog 三種用途下顯示不同句子，由 store 依用途對映。
- 呼叫時機與文案對映見 [ui-copy.contract.md](./ui-copy.contract.md) §3。

## 9. CHANGELOG 契約小節（1.4.0，HTTP 部分）

- 新增 `GET /diagnoses/:jobId?socketId=[&previousSocketId=]`：200 completed／failed／waiting／active、400、404、409（`code`
  兩種）、429（nginx 獨立 60 r/m 桶）、503。
- jobId 即存取憑證：任何已授權連線知道 jobId 即可讀已完成的結果；jobId 會出現在 nginx access log 的路徑。
  （2026-10-21 補，spec FR-034）`previousSocketId` 在 query 裡、會進同一份 access log：能讀 log 的人可在原連線**仍在線**時以它
  改綁進行中的任務；與 jobId 同一模型、同一曝險面，接受（plan 風險 3）。
- 快取命中的結果 1 小時後（`removeOnComplete`）GET 回 404；LLM 路徑的結果由 Mongo 取回。
