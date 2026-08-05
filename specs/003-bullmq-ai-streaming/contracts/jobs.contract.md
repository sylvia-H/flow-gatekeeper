# Contract: 診斷 Job 與 REST 入口（003 擴充）

依憲章 II/III（contract-first），job 佇列常數與 payload 型別 MUST 先落入
`packages/contracts/src/jobs.ts`（TS 型別單一來源），再於 `apps/api`（產 job）與 `apps/worker`
（消化）實作。本檔為規格，實作以契約檔為準。

## 沿用（不重複定義）

- WS 事件 `job/status`、`ai/token`、`ai/done`、`ai/error` 與 `DiagnosisResult` 沿用 001
  `packages/contracts/src/events.ts` / `schemas.ts`。
- `asyncapi.yaml` 已描述上述 WS 通道；`DiagnosisJobPayload` 屬 api↔worker 的 **BullMQ job 內部
  payload、非 WS 訊息**，不進 asyncapi。

## 新增型別（`packages/contracts/src/jobs.ts`）

```ts
export const DIAGNOSIS_QUEUE = 'diagnosis';

export type DiagnosisJobPayload = {
  jobId: string;
  machineId: string;
  requestedBy: string;
  requestedAt: string;   // ISO 8601
  windowMinutes: number; // 預設 5
  promptVersion: string; // 預設 'diagnosis-v1'
};
```

- `index.ts`：`export * from './jobs.js'`（與 schemas/events 並列，三者皆保留，worker 才 import 得到）。
- 型別來源分層：`DiagnosisJobPayload` 為傳輸型別，MAY 以 TS 定義；MUST NOT 在 api/worker 各寫平行定義。

## REST 入口：`POST /diagnoses`

**Request body**

```jsonc
{
  "machineId": "press-02",   // 必填：目標機台
  "requestedBy": "demo",     // 選填：預設 'demo-user'
  "socketId": "<clientId>"   // 發起連線的 clientId（system/connected 給的）；純後端 smoke 可填任意字串
}
```

**Response（200）**

```jsonc
{ "jobId": "<uuid>", "machineId": "press-02", "status": "waiting" }
```

**授權**：開發階段 **免授權**（FR-021、spec Q3）；WS 訂閱仍需 `WS_AUTH_SECRET`。正式環境 REST 認證
不在本 feature 範圍。

**行為**：controller 委派 `JobsService.createDiagnosis(machineId, requestedBy, socketId)`：
1. `jobId = randomUUID()`；
2. `relay.bindJobToClient(jobId, socketId, machineId)`（記憶體 Map）；
3. `queue.add('diagnose-machine', payload, { jobId, attempts:3, backoff:{type:'exponential',delay:5000}, removeOnComplete:{age:3600,count:1000}, removeOnFail:{age:86400,count:5000} })`；
4. 回 `{ jobId, machineId, status:'waiting' }`。

## Queue / Worker 設定（api 產、worker 消化）

- Queue name：`DIAGNOSIS_QUEUE`（api 與 worker MUST 一致）。
- Worker：`concurrency: 2`、`limiter: { max: AI_RPM(預設8), duration: 60_000 }`（limiter 放 worker 建立處）。
- Job options：`attempts: 3`、`backoff exponential delay 5000`。
