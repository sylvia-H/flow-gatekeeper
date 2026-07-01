# Contract: AI 串流轉發與 Job 狀態轉發（003）

規範 worker 與 Gateway 之間、以 Redis 為介面的**雙通道**（憲章 IV：token 走 Pub/Sub、job 生命
週期走 QueueEvents，兩者 MUST NOT 混流），以及 Gateway 對發起連線的轉發。事件型別沿用 001
`events.ts`（`ai/token`、`ai/done`、`ai/error`、`job/status`），本檔只規範**傳輸與轉發行為**。

## 通道 A：AI token 串流（Redis Pub/Sub）

- **Publisher（worker）**：每段 token `pub.publish('ai-stream:<jobId>', JSON.stringify(event))`。
  - `ai/token`：`{ type:'ai/token', jobId, seq, text }`，`seq` 由 0 遞增。
  - `ai/done`：`{ type:'ai/done', jobId, cached, result }`（cache hit `cached:true` 且無先前 token）。
  - `ai/error`：`{ type:'ai/error', jobId, code, message }`。
- **Subscriber（api，專用連線）**：`psubscribe('ai-stream:*')`；`pmessage` → 由 channel 去尾綴取
  `jobId` → 查綁定 `clientId` → `gateway.send(clientId, event)`。
- **清理**：本通道 **只轉發、不刪綁定**。因 worker 先 publish `ai/done`、才由 BullMQ 標 `completed`，
  若此處在 `ai/done` 就刪綁定，通道 B 的終態 `job/status:completed` 會查不到對象而遺失（F1）。綁定
  清理由通道 B（job-status relay）在 `completed`/`failed` 單一負責。
- **worker MUST NOT 直接 emit ws**（憲章 IV）；轉發唯一經 Gateway。

## 通道 B：Job 生命週期（BullMQ QueueEvents）

- **Source（api）**：`QueueEvents(DIAGNOSIS_QUEUE)` 監聽 `waiting`/`active`/`completed`/`failed`/`progress`；
  MUST 使用**獨立 blocking 連線**（`ioredis` `maxRetriesPerRequest: null`），與 producer 連線分離（F4）。
- **轉換**：組 `JobStatus { type:'job/status', jobId, machineId, status, progress?, result?, error? }`
  （`machineId` 由綁定 Map 取得）。
- **轉發**：`gateway.send(clientId, jobStatus)`。
- **綁定清理單一 owner**：僅本通道在 `completed`/`failed`（最終終態，晚於 `ai/done`）後 `delete(jobId)`，
  清理冪等；另以 `boundAt` 定期回收孤兒綁定（安全期如 10 分鐘）。
- **MUST NOT** 把 job 狀態塞進 `ai-stream:<jobId>`（分流原則）。

## Gateway 介面（沿用 002，不改）

- `MonitoringGateway.send(clientId: string, payload: unknown): void`——對單一連線推 JSON；
  `readyState !== OPEN` 時安全略過。兩個 relay service 透過 DI 注入 `MonitoringGateway` 使用。

## 連線分離（憲章 IV）

| 角色 | 連線 | 限制 |
|------|------|------|
| BullMQ queue（api 產 job / worker 消化） | queueConnection | `maxRetriesPerRequest: null` |
| Publisher（worker） | pub | 一般 command |
| Cache / lock（worker） | cache | 一般 command |
| Subscriber（api `psubscribe`） | subscriber | **MUST NOT 跑一般 command** |
| QueueEvents（api job 生命週期） | queueEventsConnection | blocking，`maxRetriesPerRequest: null`，與 producer 分離 |

## 錯誤與終態

- AI 逾時（`AI_TIMEOUT_MS`，預設 30000）或 provider 錯 → worker throw → BullMQ 重試（`attempts` 3）；
  用盡後 `failed` handler `publish ai/error`（`code:'worker_failed'`）。
- `DiagnosisResultSchema.parse()` 失敗 → `ai/error`（`code:'schema_invalid'`），MUST NOT 寫 `diagnoses`。
- 每次觸發（含 cache hit）由 worker 寫一筆 `diagnosisTriggers` 稽核；完整結果僅 cache miss 寫 `diagnoses`。
