# Contract：診斷 job 生命週期與完成語意（asyncapi 1.4.0）

依憲章 III（契約先行），本檔列出的 schema MUST 先落入 `packages/contracts`、`asyncapi.yaml` 同步，再改 api／worker／web。
本檔為規格，實作以契約檔為準。設計理由見 ADR-003 D1、D3、D7、D12。

## 1. WS `job/status`（`packages/contracts/src/job-status.ts`）

```ts
export const JobStatusSchema = z.object({
  type: z.literal("job/status"),
  jobId: z.string(),
  machineId: z.string(),
  status: z.enum(["waiting", "active", "completed", "failed"]),
  progress: z.number().min(0).max(100).optional(),
  result: DiagnosisResultSchema.optional(),
  error: z.string().optional(),
  // 1.4.0 新增（全部 optional，舊 client 照常運作）
  attempt: z.number().int().min(1).optional(),   // = attemptsMade + 1，與 ai/* 的 attempt 同義
  execution: z.number().int().min(1).optional(), // = attemptsStarted；重試、stalled 重派、限流延後都會遞增
  reason: z.string().optional(),                 // 開放字串；已知值 "stalled"
  cached: z.boolean().optional(),                // status=completed 且帶 result 時 api 一律帶上
});
```

| 欄位 | 何時出現 | 消費端語意 |
| --- | --- | --- |
| `result` | `status: completed` 且 `returnvalue` 通過 `DiagnosisJobReturnValueSchema` | **權威完成**：收到即轉已完成 |
| `cached` | 與 `result` 同時 | 「快取」chip、耗時分類、公告字樣；缺值時消費端當 `false` |
| `attempt` | `active`（progress 物件）、`completed`（api 已知時） | 「嘗試 N / 3」；遞增時清串流（換輪） |
| `execution` | 同上 | 遞增時清串流；**不等於** worker 中斷 |
| `reason` | `waiting` 且由 BullMQ `stalled` 事件觸發時為 `"stalled"` | 只有 `"stalled"` 才顯示「重新排入佇列」說明；未知值忽略 |

`reason` 用開放字串而非 enum：web 以 Zod 驗整則 `job/status`，封閉 enum 時 api 日後加一個新值，舊 web 會把整則（含
`completed`＋`result`）丟掉（D7）。

## 2. relay 對映（`apps/api/src/modules/websocket/job-status-relay.service.ts`）

| BullMQ QueueEvents | 送出的 `job/status` | 綁定處置 |
| --- | --- | --- |
| `waiting` | `waiting` | 不變 |
| `active` | `active` | 不變 |
| `progress`，`data` 通過 `DiagnosisJobProgressSchema` | `active`＋`progress: value`、`attempt`、`execution` | `noteProgress` |
| `progress`，`data` 為 number（舊 worker） | `active`＋`progress` | 不變 |
| `progress`，其他 | `active`（不帶 progress） | 不變 |
| `delayed` | `waiting`（延後期間每 15 s 補送，不變） | 不變 |
| `stalled`（**新監聽**） | `waiting`＋`reason: "stalled"`；warn 日誌 | 不變 |
| `completed`，`returnvalue` 合法 | `completed`＋`result`、`cached`、（已知時）`attempt`、`execution` | `markTerminal("completed")`，10 s 後刪 |
| `completed`，`returnvalue` 缺／不合法 | `completed`（不帶 result）；warn（只記 issue 路徑與代碼） | 同上 |
| `failed` | 先 `ai/error(worker_failed, message=failedReason)`，再 `failed`＋`error` | **`markTerminal("failed")`，10 s 後刪**（1.4.0 前為立即刪） |

綁定的 `machineId` 為 `null`（GET 暫定建立、尚未補上）時，上表的 `job/status` 先不送、記 `deferred`（research P1）。

## 3. WS `ai/done`（schema 不變，描述改寫）

asyncapi `channels.ai/done.subscribe.description` 改為（ADR-003 D3 原文）：

> Server forwards the validated final diagnosis result for a job, flagging whether it was served from cache. `ai/done` is a
> best-effort notification. It MAY be delivered more than once for the same jobId (re-execution after a stalled lock or a retry
> always carries the same result) and MAY be lost (Redis Pub/Sub is at-most-once). The authoritative completion is `job/status`
> with `status: completed` and `result`; consumers MUST treat the first completion they receive for a jobId as final and ignore
> later ones. When WS_AUTH_SECRET is set, it is sent only to authorized connections (those that passed the machine/subscribe token check).

`channels.job/status.subscribe.description` 改為（取代 "optionally carrying the final result"，DOC-29）：

> Server emits lifecycle status updates for a diagnosis job. A `completed` status carries the validated `result` and `cached`
> whenever the worker's return value passes validation; this is the authoritative completion signal. `attempt`/`execution`
> accompany progress updates; `reason: stalled` marks a re-dispatch after the worker lost its lock. When WS_AUTH_SECRET is set, it
> is sent only to authorized connections.

## 4. WS `ai/error.code` 已知值（schema 仍 `string`，asyncapi 加 `description`）

| code | 來源 | 可重試 | 1.4.0 |
| --- | --- | --- | --- |
| `ai_timeout` | worker：串流逾時 | 是 | 既有 |
| `provider_error` | worker：供應商錯誤（`AiProviderError.code` 可能更細） | 依錯誤 | 既有 |
| `schema_invalid` | worker：結果不合 schema、safety、max_tokens | 視情況 | 既有 |
| `no_context` | worker：空脈絡 | 否 | 既有 |
| `persist_failed` | worker：`diagnoses` 寫入失敗（`message` 固定為 `persist_failed: diagnosis record could not be written`） | 是 | **新增** |
| `worker_failed` | api：最終失敗安全網（`message` 為 `failedReason`） | — | 既有 |

同簽章失敗標記（`ai-fail:<sig>`）命中時送出的 code 與持鎖者相同，沒有額外標示（FR-029）。

## 5. api↔worker 傳輸型別（`packages/contracts/src/jobs.ts`，不進 asyncapi）

```ts
export const DiagnosisJobReturnValueSchema = z.object({
  result: DiagnosisResultSchema,
  cached: z.boolean(),
});
export const DiagnosisJobProgressSchema = z.object({
  value: z.number().int().min(0).max(100),
  attempt: z.number().int().min(1),
  execution: z.number().int().min(1),
});
export type DiagnosisJobReturnValue = z.infer<typeof DiagnosisJobReturnValueSchema>;
export type DiagnosisJobProgress = z.infer<typeof DiagnosisJobProgressSchema>;
```

- worker：processor 型別 `(job, token?) => Promise<DiagnosisJobReturnValue>`；`new Worker<DiagnosisJobPayload, DiagnosisJobReturnValue>`；
  所有 `updateProgress` 送 `DiagnosisJobProgress`。
- api：relay 與 GET 讀回時一律 `safeParse`（Redis 中的資料任何能寫 Redis 的一方都寫得進去；憲章 III runtime 驗證、V）。

## 6. 版本與測試

- `asyncapi.yaml` `info.version: 1.4.0`；`components.messages.JobStatus.payload` 補 `attempt`（integer, minimum 1）、`execution`
  （integer, minimum 1）、`reason`（string）、`cached`（boolean），四者不列入 `required`。
- `asyncapi-drift.test.ts`：`JobStatus` 已在 `MESSAGE_SCHEMAS`，YAML 與 Zod 任一邊沒改就紅；新增一支斷言「`JobStatus.reason`
  不是 enum」，防止日後被收成封閉列舉。
- `docs-contract-version.test.ts`：README、指南、CHANGELOG 的 `info.version` 現況宣稱同步到 1.4.0。
- `CHANGELOG.md` 契約小節記 1.4.0（見 [diagnosis-lookup.contract.md](./diagnosis-lookup.contract.md) §7 的 HTTP 部分）；
  相容性注意記「`ai/done` 可重複、可遺失，自寫 client 須以 jobId 去重」「BullMQ job 的 `progress` 改為物件」「BullMQ lock
  參數 15／5／2」「升級順序先 api 後 worker」（research R12）。
