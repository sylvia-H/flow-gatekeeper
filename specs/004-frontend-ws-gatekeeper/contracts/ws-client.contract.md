# Contract — 前端 WebSocket Client（消費既有契約）

**單一真實來源**：`packages/contracts/src/events.ts`（型別）與 `asyncapi.yaml`。本 feature **不新增**任何 event/payload；以下描述前端 client 對既有協定的**消費方式**（連線、訂閱、分流、批次），供 `useHighFrequencyWs` 實作對照。

## 連線

- 端點：同源 `` `${wsProto}://${location.host}/ws` ``（dev 由 Vite proxy 轉發到 `http://localhost:3000`，`ws:true`）。
- 傳輸：瀏覽器原生 `WebSocket`（憲章 IV，MUST NOT Socket.IO）。

## 客戶端 → 伺服器（`ClientControlMessage`）

| type | payload | 何時送 |
|------|---------|--------|
| `machine/subscribe` | `{ type, token: '', machineIds: string[] }` | 收到 `system/connected` 後，訂閱 5 台示範機台。dev `token` 送空字串（見 spec Clarifications / research R3）。 |
| `ping` | `{ type: 'ping' }` | 每 `heartbeatMs`（預設 15000）送一次；送出後起 `pongTimer`，逾時未回 `pong` 即 `ws.close()` 觸發重連。 |

## 伺服器 → 客戶端

前端 `onmessage` 依內容**分流**（憲章 IV：控制訊息 MUST NOT 混入 telemetry buffer）：

| 內容 | 判別 | 處理 |
|------|------|------|
| **遙測批次** | `Array.isArray(parsed)` → `TelemetryPoint[]` | 逐筆 `push` 進 buffer；由 rAF pump 批次交給 `applyTelemetryBatch`。 |
| `system/connected` | `{ type, clientId }` | `store.setClientId(clientId)`；隨即送 `machine/subscribe`。 |
| `pong` | `{ type:'pong', ts }` | 清 `pongTimer`（心跳確認）。 |
| `machine/subscribed` | `{ type, machineIds }` | 確認回執，可忽略或記錄。 |
| `system/unauthorized` | `{ type }` | 訂閱被拒（dev 一般不會出現，因不設祕密）；不呈現該機台資料，可提示。 |
| `job/status`·`ai/token`·`ai/done`·`ai/error` | `{ type: 'ai/*' \| 'job/status' }` | **本 feature 不消費**（屬 005）；composable 保留「其餘 type 視為事件」的擴充點，004 先忽略或不訂閱診斷。 |

> 遙測 payload 形狀（`TelemetryPoint`）：`{ type:'machine/data', machineId, timestamp, telemetry:{ temperature, vibration, throughput, errorRate }, state:'healthy'|'warning'|'critical' }`——以 `events.ts` 為準，本檔不複製其定義。

## 連線韌性行為（對應 FR-012~016）

- **heartbeat**：週期 ping；`pong` 逾時 → close。
- **reconnect**：`onclose` 且非 `manualClose` → 以 `nextBackoffDelay(attempt)`（指數退避＋抖動，cap 30s）重試；`onopen` 重置 `attempt`。
- **manual close / unmount**：設 `manualClose=true`，取消 rAF、清 heartbeat/pong/reconnect timer、`ws.close()`。
- **狀態回報**：`onStatus('connected'|'reconnecting'|'disconnected')` → `store.setConnectionStatus`。
