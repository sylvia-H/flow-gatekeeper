# Contract — Copilot Store (Frontend Public Interface)

`apps/web/src/domains/ai-copilot/stores/copilot.store.ts` 對外介面。狀態機轉移邏輯抽為純函式 `copilotReducer`（可單元測試，research R9）；store 為薄殼負責副作用（fetch、訂閱 WS 回呼）。

## State

```ts
// key: machineId
jobs: Map<string, CopilotJobState>   // 見 data-model.md
```

## Getters

| Getter | 回傳 | 用途 |
|--------|------|------|
| `stateFor(machineId)` | `CopilotJobState` | 取某台狀態（無則 `{status:'idle'}`）；drawer 依 `selectedMachineId` 呼叫 |
| `canDiagnose(machineId, hasClient)` | `boolean` | `machineId` 非空、`hasClient` 為真、該台非 `active`（FR-008/FR-014） |

## Actions

| Action | 簽章 | 行為 |
|--------|------|------|
| `diagnose` | `(machineId, socketId, requestedBy?) => Promise<void>` | 前置檢查（去重/有連線）→ `POST /diagnoses` → 以回傳 `jobId` 建該台 `active`（SC-001）。失敗（如 400/網路）→ 該台 `failed` 附可讀訊息 |
| `retry` | `(machineId, socketId) => Promise<void>` | 僅在該台 `failed`/`completed` 時允許；等同對同機台重新 `diagnose`（新 jobId，重置 progress/streamText，FR-007） |
| `applyEvent` | `(event: JobStatus \| AiToken \| AiDone \| AiError) => void` | 委派 `copilotReducer`：依 `event.machineId`/`jobId` 找對應台、過期則忽略（FR-011）、否則轉移 |
| `onReconnect` | `(newClientId) => void` | 由 004 `onConnected` 呼叫；若 clientId 變更且某台 `active` → 該台標 `failed`（中斷，FR-012/R7） |

## 與 004 的接線（App.vue）

```ts
// 既有 useHighFrequencyWs options 增加：
onDiagnosisEvent: copilot.applyEvent,          // 分流診斷事件（research R1）
onConnected: (clientId) => {
  monitoring.setClientId(clientId);            // 004 既有
  copilot.onReconnect(clientId);               // 005：重連中斷收尾（FR-012）
  handle.send({ type:"machine/subscribe", token:"", machineIds:[...KNOWN_MACHINE_IDS] }); // 004 既有
},
```

- **單一連線**：診斷事件與遙測共用 004 的 WebSocket；診斷事件不進遙測 buffer（憲章 IV、FR-017）。
- **socketId 來源**：`diagnose` 的 `socketId` 取 `monitoring.clientId`（004 對外保存的最新值）。

## 純函式（`lib/copilot-reducer.ts`，測試目標）

| 函式 | 簽章 | 說明 |
|------|------|------|
| `copilotReducer` | `(state: CopilotJobState, event) => CopilotJobState` | 決定性狀態轉移（見 data-model 轉移表） |
| `isStaleJobEvent` | `(state, event) => boolean` | `event.jobId !== state.jobId` → true（忽略） |
| `progressLabel` | `(progress: number \| null) => string` | `null`→indeterminate 描述；否則 `${progress}%`（FR-004 無障礙） |
