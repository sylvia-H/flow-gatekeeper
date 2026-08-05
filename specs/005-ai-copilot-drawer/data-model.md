# Phase 1 Data Model — AI Copilot Drawer

前端呈現狀態（記憶體，非持久化）。持久化實體（diagnoses、triggers）屬 003，不在此。型別以 `packages/contracts` 為單一來源，本檔僅描述**前端衍生的呈現狀態**，不新增通訊契約。

## 實體：`CopilotJobState`（每台一份）

某機台當前的診斷任務呈現狀態機。容器為 `Map<machineId, CopilotJobState>`（見 [contracts/copilot-store.md](./contracts/copilot-store.md)）。

| 欄位 | 型別 | 說明 |
|------|------|------|
| `status` | `'idle' \| 'active' \| 'completed' \| 'failed'` | 狀態機標籤（discriminated union 的判別欄） |
| `machineId` | `string` | 對應機台（key 冗餘保存，便於呈現「此結果屬哪台」） |
| `jobId` | `string \| undefined` | 目前任務 id（`active`/`completed`/由 `waiting` 起有值；`idle` 無）。過期片段以此比對忽略 |
| `progress` | `number \| null` | 最新 `job/status.progress`；`null`=indeterminate（事件未帶值） |
| `streamText` | `string` | 累積的 `ai/token` 文字（`completed` 後保留、預設收合） |
| `cached` | `boolean` | `ai/done.cached`；`completed` 時決定是否顯示 Cached badge |
| `result` | `DiagnosisResult \| undefined` | `completed` 的結構化結果（型別來源 `DiagnosisResultSchema`） |
| `error` | `string \| undefined` | `failed` 的可讀錯誤訊息（非原始堆疊） |

> 型別以 discriminated union 表達更精確（`idle` 無 `result`／`error`；`completed` 必有 `result`）。實作參考（單一來源仍為 contracts 的事件/結果型別）：

```ts
import type { DiagnosisResult } from "@flow-gatekeeper/contracts";

export type CopilotJobState =
  | { status: "idle"; machineId: string }
  | { status: "active"; machineId: string; jobId: string; progress: number | null; streamText: string }
  | { status: "completed"; machineId: string; jobId: string; cached: boolean; streamText: string; result: DiagnosisResult }
  | { status: "failed"; machineId: string; jobId?: string; streamText: string; error: string };
```

## 狀態轉移（`copilotReducer(state, event)`）

輸入事件型別取自 `packages/contracts`：`JobStatus`、`AiToken`、`AiDone`、`AiError`（見 [contracts/consumed-events.md](./contracts/consumed-events.md)）。轉移以「該台目前 `jobId`」為過期判準（FR-011）。

| 目前 status | 事件 | 條件 | 新 status／效果 |
|-------------|------|------|------------------|
| idle | `diagnose()`（本地動作，非事件） | 有 clientId 且非 active | active（`jobId`=POST 回傳 jobId，`progress`=null，`streamText`=""） |
| active | `job/status waiting/active` | `jobId` 相符 | active，更新 `progress`（未帶則維持 null=indeterminate） |
| active | `ai/token` | `jobId` 相符 | active，`streamText += text`（依**到達序** append；單一有序 ws 保證 `seq` 順序，見 research R6） |
| active | `ai/done` | `jobId` 相符 | completed（`result`、`cached`，保留 `streamText`） |
| active | `ai/error` 或 `job/status failed` | `jobId` 相符 | failed（`error`=可讀訊息，保留 `streamText`） |
| active | 重連（新 clientId，本地訊號） | 該台 active | failed（`error`="連線中斷，請重試"） |
| any | 任一診斷事件 | `jobId` **不符**目前 `activeJobId` | 忽略（過期/被取代片段，FR-011） |
| completed/failed | `diagnose()`/`retry()` | 同機台 | active（新 jobId，重置 `progress`/`streamText`） |
| active | `diagnose()` 重複送出 | 同機台 active | 拒絕（去重，FR-008；UI 禁用送出） |

### 不變量

- 同一 machineId 至多一個 `active` 任務（`jobId` 唯一）；重複送出被去重（FR-008）。
- 不同 machineId 的狀態互相獨立，可同時 `active`（FR-010）。
- `completed`/`failed` 皆保留 `streamText`（供收合回看，FR-006）。
- 過期 jobId 事件恆被忽略，不覆蓋當前呈現（FR-011）。
- `progress` 僅由事件寫入；前端不合成（FR-004）。

## 衍生／呈現

- **當前呈現**：drawer 顯示 `map.get(selectedMachineId) ?? { status:'idle' }`（未選取→空狀態提示，FR-014）。
- **Diagnose 可用性**：`selectedMachineId` 為 null → disabled；該台 `status==='active'` → disabled（去重，FR-008）。
- **Cached badge**：`status==='completed' && cached`（FR-009）。
- **progressLabel**：`progress===null` → indeterminate 描述；否則 `${progress}%`（無障礙 `aria-valuenow`，FR-004）。

## Worker 端（FR-018，非前端資料模型）

worker `main.ts` 於單次診斷以 `job.updateProgress` 回報里程碑 `0/20/40/60/80/100`（綁真實階段，見 [research.md](./research.md) R5）。此為既有 `DiagnosisJobPayload` 處理的副作用，不新增資料結構、不改 `job/status` 契約。
