# Phase 1 Data Model: 診斷任務佇列、AI 串流診斷與 Redis 快取

> ⚠️ **已變更（2026-09-27 盤點）**：下列原敘述已被 v1.0.0 之後的修復／升級改變；內文保留為歷史，現況以指南 §15.6「v1.0.0 之後的現況摘要」為準（`docs/Flow-Gatekeeper-SDD-完整實作指南.md`）。
>
> - §1.1：`DiagnosisJobPayload.promptVersion` → 已移除，worker 自管 `PROMPT_VERSION`（見 `packages/contracts/src/jobs.ts` 註解）。
> - §1.1：`jobId` 由 api `randomUUID` → 由前端產生並作 idempotency key。
> - §2：`ai-lock:<sig>` `finally` DEL → `randomUUID` 鎖值＋Lua compare-and-del；另新增 `ai-rpm:<分鐘>` 固定窗限流 key（取代 BullMQ limiter）。
> - §2：簽章輸入含 payload 的 `promptVersion` → 改含 provider id＋model＋worker 的 `PROMPT_VERSION`。
> - §3.2 寫入 → 先 insert `diagnoses`（`jobId` unique）再 set cache，cache 讀回 `safeParse`；`diagnosisTriggers` TTL 30 天。
> - §5／§6：失敗即 `ai/error` → 非最終嘗試不送 `ai/error`，`ai/*` 皆帶 `attempt`；最終失敗由 api 補送 `ai/error(worker_failed)`；另有 `no_context`、輸出截斷視為不可重試 `schema_invalid`。
> - §1.1「依型別來源分層以 TS 定義（憲章 III）」：憲章 1.5.0 Principle III 已改為「WS message 與 `POST /diagnoses` MUST Zod；非 WS／HTTP 的跨 process 型別（BullMQ job data）SHOULD Zod 並在消費端 `safeParse`」→ 現況 `DiagnosisJobPayload` 仍為手寫 TS 型別，列 roadmap 010-lite（第二輪報告 CT-8）；該小標在憲章中保留、內容已改，本檔引用仍有效。

本檔描述 003 涉及的資料形狀：契約型別（api↔worker）、Redis 暫態鍵、MongoDB 集合，以及 job 狀態
轉換。契約型別以 `packages/contracts` 為單一來源；WS 事件（`ai/*`、`job/status`）沿用 001 既有
定義，不重複。

---

## 1. 契約型別（`packages/contracts`）

### 1.1 新增：`jobs.ts`

```ts
export const DIAGNOSIS_QUEUE = 'diagnosis';

export type DiagnosisJobPayload = {
  jobId: string;        // randomUUID，同時作為 BullMQ jobId 與 ai-stream channel 尾綴
  machineId: string;    // 目標機台（沿用 002 的 5 台示範機台識別）
  requestedBy: string;  // 發起者（預設 'demo-user'）
  requestedAt: string;  // ISO 8601
  windowMinutes: number;// context 讀取窗口（預設 5）
  promptVersion: string;// 進 cache 簽章（預設 'diagnosis-v1'）
};
```

- `index.ts` 補 `export * from './jobs.js'`（與 `schemas.js`、`events.js` 並列）。
- 屬 api↔worker 傳輸型別，依型別來源分層以 TS 定義（憲章 III）；無 runtime 驗證需求。

### 1.2 沿用（不重複定義，`events.ts` / `schemas.ts` 既有）

- `JobStatus`（`type:'job/status'`，`status: waiting|active|completed|failed`，`progress?`、`result?`、`error?`）
- `AiToken`（`type:'ai/token'`，`seq`、`text`）、`AiDone`（`cached`、`result`）、`AiError`（`code`、`message`）
- `AiStreamEvent = AiToken | AiDone | AiError`
- `DiagnosisResult` / `DiagnosisResultSchema`（Zod，唯一結果來源；`severity: ok|warning|critical`）

---

## 2. Redis 暫態鍵（憲章 VII：僅暫態，不作歷史來源）

| 用途 | 鍵 / 通道 | 生命週期 | 連線 |
|------|-----------|----------|------|
| Job queue | BullMQ `diagnosis` | `removeOnComplete {age:3600,count:1000}` / `removeOnFail {age:86400,count:5000}` | queue（BullMQ 自管） |
| Cache（結果） | `ai-cache:<sig>` | `EX AI_CACHE_TTL_SECONDS`（預設 600s） | cache |
| Dedupe lock | `ai-lock:<sig>` | `EX AI_DEDUPE_LOCK_SECONDS NX`（預設 45s）；`finally` DEL | cache |
| Token 串流 | Pub/Sub `ai-stream:<jobId>` | 即時、不留存 | pub（發布）/ subscriber（訂閱） |

- `<sig>` = `buildDiagnosisSignature({machineId,state,topErrorCodes(sorted),promptVersion,model})` 的
  sha256 前 24 hex（純函式，決定性；見 `cache/signature.ts`）。
- 連線分離：worker 的 `queue` / `pub` / `cache` 與 api 的 `subscriber`（psubscribe）／`queueEvents`
  （job 生命週期，blocking）各自 `ioredis` 連線，皆與 producer 分離；subscriber／queueEvents 用
  `maxRetriesPerRequest: null`（憲章 IV、research D3）。

---

## 3. MongoDB 集合

### 3.1 讀取（002 既有，組 context）

- `telemetry`（time-series）：以 `$match {'metadata.machineId', timestamp>=since}` + `$group` 取
  avg/max（temperature/vibration/errorRate）與 count；另取 `latest`（最近 1 筆）供 `latestState`。
- `errorlogs`：`find {machineId, timestamp>=since}` sort desc limit 5，供 `topErrorCodes`。
- `maintenanceRecords`：`find {machineId}` sort `performedAt` desc limit 3。
- `since = now - windowMinutes*60_000`。

### 3.2 寫入（本 feature 新增）

**`diagnoses`（診斷結果，僅 cache miss 實際產生時寫）**

| 欄位 | 型別 | 說明 |
|------|------|------|
| machineId | string | 目標機台 |
| jobId | string | 對應 job |
| cached | boolean | 此結果是否來自快取（compute path 恆 `false`） |
| result | DiagnosisResult | 通過 `DiagnosisResultSchema.parse()` 的結果 |
| createdAt | Date | 產生時間 |

**`diagnosisTriggers`（觸發稽核，每次觸發含 cache hit 都寫）** — 對應 spec Q1 / research D6

| 欄位 | 型別 | 說明 |
|------|------|------|
| machineId | string | 目標機台 |
| jobId | string | 對應 job |
| requestedBy | string | 發起者 |
| cached | boolean | 本次是否命中快取 |
| createdAt | Date | 觸發時間 |

- index：`diagnoses` `{ machineId:1, createdAt:-1 }`；`diagnosisTriggers` `{ machineId:1, createdAt:-1 }`。
- 由 **worker** 寫入（唯一知道 hit/miss 者）。cache hit MUST NOT 重複寫 `diagnoses`（FR-013）。

---

## 4. 執行期狀態（記憶體，api 端）

**`jobId → { clientId, machineId, boundAt }` 綁定 Map**（`AiStreamRelayService` 與 job-status relay 共用）

- 建 job 時 `bindJobToClient(jobId, socketId, machineId)`。**`socketId` 即 WS `system/connected` 給的 `clientId`（同一值，REST 邊界沿用指南 §8.4 的 `socketId` 命名，內部視為 `clientId`）**。
- token/status 轉發時查 `clientId`；查不到（如純後端 smoke 或已重連）則略過推送，job 仍完成。
- **清理單一 owner 為 job-status relay**：僅在 QueueEvents `completed`/`failed`（job 最終終態，晚於 `ai/done`）後 `delete(jobId)`；AI 串流 relay 收到 `ai/done`/`ai/error` **只轉發、不刪綁定**，否則會早於終態 `job/status` 清掉對象、害 `completed` 送不出（F1）。另以 `boundAt` 定期掃描回收孤兒綁定（安全期如 10 分鐘），避免 QueueEvents 異常時 Map 洩漏（FR-002）。

---

## 5. Job 狀態轉換（→ `job/status` 事件）

```text
        enqueue                 worker 取用            處理完成
[client] ──POST /diagnoses──▶ waiting ──QueueEvents:active──▶ active ──completed──▶ [done]
                                 │                              │
                                 │                              ├─ progress(5/20/100) ─▶ active(progress)
                                 │                              │
                                 └───────── failed ◀────────────┘  attempts 用盡 / 逾時 / parse 失敗
                                                (exponential backoff 重試中仍為 waiting/active)
```

- `waiting`：api enqueue 後即回（HTTP 回 `{jobId, machineId, status:'waiting'}`）。
- `active` / `progress`：worker `updateProgress(5→20→100)`；QueueEvents 轉 `job/status`。
- `completed`：結果已 `ai/done` 送出、`diagnoses` 已寫（或 cache hit 直接 done）。
- `failed`：`attempts`（3）用盡、AI 逾時（30s）或 `DiagnosisResultSchema.parse()` 失敗 → 併發 `ai/error`。

---

## 6. AI 串流事件序列（→ Redis Pub/Sub `ai-stream:<jobId>` → Gateway）

- **cache hit**：`ai/done { jobId, cached:true, result }`（無 `ai/token`）。
- **cache miss（成功）**：`ai/token { jobId, seq:0.. , text }` × N → `ai/done { jobId, cached:false, result }`。
- **失敗**：`ai/error { jobId, code, message }`（parse 失敗 `code:'schema_invalid'`；逾時／其他
  `code:'worker_failed'` 等）。
- Gateway `psubscribe('ai-stream:*')`：依 `jobId` 查綁定 `clientId` → `gateway.send(clientId, event)`；
  收到 `ai/done`/`ai/error` **只轉發、不刪綁定**（綁定清理由 job-status relay 在 `completed`/`failed`
  時單一負責，見 §4／F1）。
