# Contract: Gateway 控制訊息（002 擴充）

本 feature 在 001 既有的 6 條通道之外，**新增傳輸/控制層訊息**。依憲章 II/III（contract-first），
這些訊息 MUST 先落入 `packages/contracts/src/events.ts`（TS 型別單一來源）與 `asyncapi.yaml`
（通訊文件，Spectral lint 對象），再於 `apps/api` 實作。本檔為規格，實作以契約檔為準。

## 沿用 001（不重複定義）

- `TelemetryPoint`（`type:'machine/data'`）、`MachineSubscribe`（`type:'machine/subscribe'`）、
  `JobStatus`、`AiToken`、`AiDone`、`AiError`、`DiagnosisResult` 等維持 001 既有定義。
- **推送 envelope**：伺服器推送遙測時送 **`TelemetryPoint[]`（陣列）**，非單筆物件。

## 新增型別（`packages/contracts/src/events.ts`）

```ts
// client → server
export type Ping = { type: 'ping' };

// server → client（控制/握手）
export type SystemConnected = { type: 'system/connected'; clientId: string };
export type MachineSubscribed = { type: 'machine/subscribed'; machineIds: string[] };
export type Pong = { type: 'pong'; ts: number };
export type SystemUnauthorized = { type: 'system/unauthorized' };

// 便於 Gateway/前端 narrow 的聯集
export type ClientControlMessage = Ping | MachineSubscribe;
export type ServerControlMessage =
  | SystemConnected
  | MachineSubscribed
  | Pong
  | SystemUnauthorized;
```

`index.ts` 沿用 `export * from './events.js'` 即可帶出新型別。

## 行為契約（規範性）

| # | Given | When | Then |
|---|-------|------|------|
| C1 | 新連線 | server 接受 connection | 送 `SystemConnected`（含新 `clientId`） |
| C2 | 已連線 | client 送 `MachineSubscribe`（token 有效） | 以 `machineIds` **取代**訂閱集合，回 `MachineSubscribed` |
| C3 | 已連線 | client 送 `MachineSubscribe`（token 無效） | 回 `SystemUnauthorized`，**不**建立/變更訂閱 |
| C4 | 已連線 | client 送 `Ping` | 回 `Pong`（帶 `ts`） |
| C5 | 已訂閱集合 A | 每個遙測 tick | 僅推送 A 內機台的 `TelemetryPoint[]`；A 為空則不推 |
| C6 | 任意連線 | 收到無法解析/未知 type 的訊息 | 安全忽略，不影響既有連線與訂閱 |
| C7 | server 心跳掃描 | 某連線逾 `WS_HEARTBEAT_MS` 未回應 protocol pong | `terminate()` 並清理其訂閱與連線狀態 |

## AsyncAPI（`asyncapi.yaml`）擴充

新增通道/訊息（沿用 2.6.0 結構，與既有 6 通道並列），至少涵蓋：
`system/connected`、`machine/subscribed`、`pong`（server→client，`subscribe`）與
`ping`（client→server，`publish`）、`system/unauthorized`（server→client）。MUST 可通過
`pnpm contract:lint`（`spectral:asyncapi`）。

> 註：`machine/data` 在文件層維持單筆 schema；「推送為陣列」屬傳輸 envelope 約定，於本契約檔
> 與 `data-model.md` C 節載明，前端 hook 依約定展開。
