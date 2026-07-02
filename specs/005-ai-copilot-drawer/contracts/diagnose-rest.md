# Contract — Diagnose Trigger (REST)

觸發診斷的既有 HTTP 入口（003，[apps/api/src/modules/jobs/jobs.controller.ts](../../../apps/api/src/modules/jobs/jobs.controller.ts)）。005 **消費**，不改 API。

## `POST /diagnoses`

**Request body**

```ts
type CreateDiagnosisBody = {
  machineId: string;    // 必填；目前 selectedMachineId
  socketId: string;     // 必填；= 004 對外最新 clientId（WS clientId）。缺則後端回 400
  requestedBy?: string; // 可選；操作者識別（dev 可省）
};
```

**Response（200，初始狀態）**

```ts
type CreateDiagnosisResult = { jobId: string; machineId: string; status: "waiting" };
```

**錯誤**

- 缺 `machineId` 或 `socketId` → `400`（後端安全拒絕、不建任務）。005 前端在無 `clientId`（尚未連線）時 MUST NOT 送出，並提示先待連線。

## 前端使用（`diagnose-api.ts`）

- 以原生 `fetch` 打**同源** `/diagnoses`（dev 由 `vite.config` proxy 轉 `:3000`，見 research R2）。
- 送出前置條件：`clientId !== null`（有連線）且 `selectedMachineId !== null` 且該台非 `active`（去重，FR-008）。
- 成功後以回傳 `jobId` 在 `copilot.store` 為該台建立 `active` 狀態（本地即時，SC-001，不等 WS 事件）。
- 後續 `job/status`／`ai/*`（帶同一 `jobId`）經 WebSocket 回送、由 store 依 `jobId` 比對套用。

## dev proxy（`vite.config.ts`）

於既有 `/ws` proxy 旁新增：

```ts
"/diagnoses": { target: "http://localhost:3000", changeOrigin: true },
```

- 同源、免 CORS、不硬編後端位址、不打包祕密（憲章 VI）。正式部署的反代設定不在本 feature。
