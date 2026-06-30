# Phase 1 Data Model: Foundation & Contracts

本 feature 的「資料模型」即共用通訊契約的型別結構。契約以 `packages/contracts` 的 Zod
schema 為單一真實來源（憲章 III），AsyncAPI（`asyncapi.yaml`）為對應的通訊文件。型別精確
定義見實作指南 §6.8/§6.9，本檔聚焦結構、欄位、驗證規則與範圍邊界，不重貼完整 code。

> 範圍提醒：本 feature 只交付「契約結構 + 可驗證性」，不交付執行期行為。佇列/任務 payload
> 契約留待 003；MongoDB collection 留待 002。

## 實體一覽

| 實體 | 來源型別 | 定義方式 | 驗證需求（本 feature） |
|------|----------|----------|------------------------|
| DiagnosisResult | `DiagnosisResultSchema` | **Zod**（單一來源）→ `z.infer` 推導型別 | 對結構錯誤資料 `.parse()` MUST 丟錯（FR-007、FR-014） |
| TelemetryPoint | `TelemetryPoint` | TS type（執行期由 ws gateway 產生，002+） | 三端可 import 並 typecheck（FR-006） |
| MachineSubscribe | `MachineSubscribe` | TS type | 同上 |
| JobStatus | `JobStatus` | TS type（引用 `DiagnosisResult`） | 同上 |
| AiToken / AiDone / AiError | `AiStreamEvent` union | TS type（`AiDone` 引用 `DiagnosisResult`） | 同上 |

## DiagnosisResult（Zod 單一來源 — 核心交付）

`DiagnosisResultSchema` 定義於 `packages/contracts/src/schemas.ts`，型別
`export type DiagnosisResult = z.infer<typeof DiagnosisResultSchema>`。

| 欄位 | 型別 | 必填 | 規則 |
|------|------|:---:|------|
| `summary` | string | ✓ | 診斷摘要 |
| `severity` | enum `ok` \| `warning` \| `critical` | ✓ | 診斷嚴重度（注意：與機台 `state` 的列舉不同名空間） |
| `likelyCauses` | string[] | ✓ | 可能原因 |
| `suggestedActions` | object[] | ✓ | 每項 `{ label: string, priority: low\|medium\|high, command?: string }` |
| `evidence` | object[] | ✓ | 每項 `{ source: telemetry\|errorlog\|maintenance, id?: string, excerpt: string }` |

**驗證規則**：缺必填欄位、enum 值不合法、巢狀結構錯誤 → `DiagnosisResultSchema.parse()`
MUST 丟出 `ZodError`。這正是 FR-014 smoke/單元測試覆蓋的對象。

## 即時通道事件型別（6 條，定義於 `events.ts`）

| 事件 | `type` const | 主要欄位 | 引用 |
|------|--------------|----------|------|
| machine/subscribe | `machine/subscribe` | `token: string`, `machineIds: string[]` | — |
| machine/data | `machine/data` | `machineId`, `timestamp(date-time)`, `telemetry{temperature,vibration,throughput,errorRate}`, `state: healthy\|warning\|critical` | TelemetryPoint |
| job/status | `job/status` | `jobId`, `machineId`, `status: waiting\|active\|completed\|failed`, `progress?`, `result?`, `error?` | DiagnosisResult |
| ai/token | `ai/token` | `jobId`, `seq: number`, `text: string` | — |
| ai/done | `ai/done` | `jobId`, `cached: boolean`, `result` | DiagnosisResult |
| ai/error | `ai/error` | `jobId`, `code: string`, `message: string` | — |

**型別來源紀律**：`DiagnosisResult` MUST NOT 在 `events.ts` 手寫，而是從 `schemas.ts`
re-export（`AiDone.result` / `JobStatus.result` 皆引用同一份）。這確保執行期驗證與靜態
型別共用單一來源（憲章 III、FR-005）。

## 列舉一致性備註

- 機台健康狀態 `MachineState`：`healthy | warning | critical`（用於 TelemetryPoint.state）。
- 診斷嚴重度 `severity`：`ok | warning | critical`（用於 DiagnosisResult）。
- 兩者 **刻意不同**（前者無 `ok`、後者無 `healthy`），契約與文件 MUST 保持此區分，
  AsyncAPI `schemas.TelemetryPoint.state` 與 `schemas.DiagnosisResult.severity` 已對齊。

## 環境設定形狀（非型別實體，但屬契約面）

`.env.example` 記錄設定鍵的形狀（資料服務位址/埠、WS、AI provider、資料生命週期 TTL），
**不含真實值**。版本控制只追蹤 `.env.example`（FR-009、SC-005）。鍵清單見指南 §6.4。

## 狀態轉移

本 feature 無執行期狀態機。`JobStatus.status`（waiting→active→completed/failed）的轉移
語意屬 Feature 003 的 worker/job lifecycle，本 feature 僅定義其型別列舉。
