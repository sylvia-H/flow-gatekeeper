# Phase 1 Data Model: 即時 Gateway、遙測產生器與 MongoDB 歷史層

> ⚠️ **已變更（2026-09-27 盤點）**：下列原敘述已被 v1.0.0 之後的修復／升級改變；內文保留為歷史，現況以指南 §15.6「v1.0.0 之後的現況摘要」為準（`docs/Flow-Gatekeeper-SDD-完整實作指南.md`）。
>
> - A1：`insertMany(ordered:false)` 由 Gateway 每 tick fire-and-forget → 有上限 buffer（5000）每秒批次、單一 in-flight、溢位丟最舊並計數、錯誤 log 節流。
> - A1：TTL「demo 可設 3600」→ demo `TELEMETRY_TTL_SECONDS` 為 86400；既存 collection 以 `collMod` 更新 TTL。
> - A2：errorlogs「不設 TTL」→ 已補 TTL index（30 天）；errorlog 寫入走獨立佇列，區分可重試／終局失敗。
> - B：`isAlive` 旗標＋應用層 `ping`→`pong` → 伺服器探活改帶 nonce 的協定層 ping；生命週期另有授權寬限（`WS_AUTH_GRACE_MS`）、違規計數（10 次 `1008`）、背壓高水位 `WS_SEND_HIGH_WATER_BYTES`（略過高頻流推送（遙測批次與 `ai/token`），控制訊息與 `job/status`／`ai/done`／`ai/error` 照送；連續 3 tick 超標 terminate）與連線上限。
> - C：「`machine/data`（單筆）型別維持 001」→ 契約 `machine/data` 現即為裸陣列、以 `isTelemetryPoint` 守衛；C 表所列控制訊息皆已 Zod 化。

涵蓋三類資料：(A) MongoDB 持久化集合、(B) Gateway 記憶體內連線/訂閱狀態、(C) 新增的
WebSocket 控制訊息（入契約）。型別來源一律為 `@flow-gatekeeper/contracts`，本文件不另立
平行定義（憲章 III）。

## A. MongoDB Collections

### A1. `telemetry`（time-series）

| 屬性 | 說明 |
|------|------|
| 類型 | time-series collection |
| `timestamp` | timeField（`Date`，由 `TelemetryPoint.timestamp` ISO 字串轉入） |
| `metadata` | metaField，`{ machineId }` |
| 文件內容 | 展開 `TelemetryPoint`（machineId、telemetry.{temperature,vibration,throughput,errorRate}、state） |
| granularity | `seconds` |
| TTL | `expireAfterSeconds = TELEMETRY_TTL_SECONDS`（預設 604800；demo 可設 3600） |
| 寫入範圍 | **全部示範機台、每 tick 全量**（與訂閱無關，FR-009） |
| 寫入方式 | `insertMany(ordered:false)`，由 Gateway fire-and-forget 呼叫（FR-010） |

**Validation/規則**：每筆需含 `machineId`、`timestamp`、`telemetry`、`state`；`state ∈
{healthy,warning,critical}`（沿用契約 `MachineState`）。

### A2. `errorlogs`

| 屬性 | 說明 |
|------|------|
| index | `{ machineId: 1, timestamp: -1 }` |
| 寫入時機 | 機台狀態**轉入** warning 或 critical 時，每次轉換寫一筆（FR-011 去重） |
| 文件欄位 | `machineId`、`state`（warning/critical）、`message`（`<prev> -> <state>`）、`telemetry`（當下量測）、`timestamp` |
| TTL | 本 feature **不設 TTL**（異常事件長期保留，供事後審查；即使原始遙測逾期仍可追溯轉換史）。`.env.example` 的 `ERRORLOG_TTL_SECONDS` 於 002 **不接線**，保留供未來啟用 |

**規則**：同一機台連續維持同一異常狀態 MUST NOT 重複寫；healthy→healthy、warning→warning
等「非轉入異常」不寫。判定邏輯見 `lib/errorlog-transition.ts`（純函式，可單測）。

### A3. `maintenanceRecords`

| 屬性 | 說明 |
|------|------|
| index | `{ machineId: 1, performedAt: -1 }` |
| 來源 | seed 腳本（`apps/api/src/scripts/seed.ts`），可重播 |
| 文件欄位 | `machineId`、`performedAt`（`Date`）、`summary`（文字） |

**規則**：seed 先 `deleteMany({})` 再 `insertMany([...])`，確保可重播且結果決定性（FR-013）。

## B. Gateway 記憶體狀態（連線生命週期）

| 結構 | 型別 | 說明 |
|------|------|------|
| `clients` | `Map<ClientId, WebSocket>` | clientId（`randomUUID()`）→ socket |
| `subscriptions` | `Map<ClientId, Set<string>>` | 連線當前訂閱的 machineIds（**取代式**，FR-002） |
| `isAlive` | 每 socket 旗標 | 心跳探活用；`pong` 置 true，掃描週期置 false 後 `ping()`（R3） |

**生命週期/狀態轉換**：
- connect → 配 `clientId`，`clients`/`subscriptions` 建項，推 `system/connected`。
- `machine/subscribe`（授權通過）→ 以新集合**取代** `subscriptions[clientId]`，回 `machine/subscribed`；
  授權失敗 → 回 `system/unauthorized`，不建立訂閱（FR-003）。
- `ping` → 回 `pong`。
- 每 tick → 對每個訂閱者送「其訂閱機台的 `TelemetryPoint[]`」（FR-004）。
- close **或** 心跳探活逾時 → 從 `clients`/`subscriptions` 移除（FR-008，含半死連線）。

**邊界**：`clientId` 僅存記憶體，連線重連後更換、需重新訂閱（spec Assumptions 已載明）。

## C. 新增控制訊息（擴充 `packages/contracts` + `asyncapi.yaml`）

> contract-first：先入契約再實作（R1）。型別新增於 `events.ts`，AsyncAPI 補對應通道/訊息。

| 方向 | type | payload | 用途 |
|------|------|---------|------|
| client→server | `ping` | `{ type:'ping' }` | 應用層心跳請求 |
| client→server | `machine/subscribe` | `{ type, token, machineIds[] }`（001 已有） | 訂閱（取代式） |
| server→client | `system/connected` | `{ type:'system/connected', clientId }` | 連線確認 + 派發 clientId |
| server→client | `machine/subscribed` | `{ type:'machine/subscribed', machineIds[] }` | 訂閱成功回執 |
| server→client | `pong` | `{ type:'pong', ts:number }` | 應用層心跳回應 |
| server→client | `system/unauthorized` | `{ type:'system/unauthorized' }` | 授權失敗 |
| server→client | `TelemetryPoint[]` | `TelemetryPoint` 陣列（001 已有單筆型別） | 高頻遙測推送（**陣列**，前端直接展開進 buffer） |

**一致性規則**：`machine/data`（單筆 `TelemetryPoint`）型別維持 001；推送 envelope 為其
**陣列**。控制訊息 type 字串為唯一辨識鍵（與 telemetry 陣列以「是否帶 `type`」區分）。
