# Contract — Consumed Diagnosis Events (WebSocket)

005 **消費**既有契約，不新增 event/payload。單一來源：`packages/contracts/src/events.ts` 與 `schemas.ts`（憲章 III）。以下為 005 依賴的既有型別，僅供參照——**MUST NOT** 在 web 端另寫平行定義，一律 `import type` 自 `@flow-gatekeeper/contracts`。

事件經 **004 同一條** WebSocket（Gateway `/ws`）回送，由 `useHighFrequencyWs` 的 `onDiagnosisEvent` 分流交 `copilot.store`（見 research R1）。

## `job/status`（`JobStatus`）

```ts
type JobStatus = {
  type: "job/status";
  jobId: string;
  machineId: string;
  status: "waiting" | "active" | "completed" | "failed";
  progress?: number;   // optional；005 前端純以此為準，未帶則 indeterminate（FR-004）
  result?: DiagnosisResult;
  error?: string;
};
```

- 005 用途：驅動 active/completed/failed 轉移與進度呈現。`progress` 由 worker 綁真實階段回報 `0/20/40/60/80/100`（FR-018；**值**變更，型別不變）。

## `ai/token`（`AiToken`）

```ts
type AiToken = { type: "ai/token"; jobId: string; seq: number; text: string };
```

- 005 用途：依 `seq` 保序 append 至該台 `streamText`（FR-005）。

## `ai/done`（`AiDone`）

```ts
type AiDone = { type: "ai/done"; jobId: string; cached: boolean; result: DiagnosisResult };
```

- 005 用途：轉 completed，渲染結構化結果；`cached` 決定 Cached badge（FR-006/FR-009）。

## `ai/error`（`AiError`）

```ts
type AiError = { type: "ai/error"; jobId: string; code: string; message: string };
```

- 005 用途：轉 failed，顯示 `message`（可讀）＋Retry（FR-007）。

## `DiagnosisResult`（`schemas.ts`，Zod 單一來源）

```ts
const DiagnosisResultSchema = z.object({
  summary: z.string(),
  severity: z.enum(["ok", "warning", "critical"]),
  likelyCauses: z.array(z.string()),
  suggestedActions: z.array(z.object({
    label: z.string(), priority: z.enum(["low","medium","high"]), command: z.string().optional(),
  })),
  evidence: z.array(z.object({
    source: z.enum(["telemetry","errorlog","maintenance"]), id: z.string().optional(), excerpt: z.string(),
  })),
});
type DiagnosisResult = z.infer<typeof DiagnosisResultSchema>;
```

- 005 用途：`DiagnosisResultView` 依此渲染 5 區塊（FR-006）。後端已 `parse()` 驗證（憲章 V），前端消費**已驗證**結果，不放寬、不手寫平行型別。

## 過期片段規則

任一事件的 `jobId` 若不等於該 machine 目前 `activeJobId`，MUST 忽略（FR-011）。判定為純函式 `isStaleJobEvent`（見 data-model 與 copilot-store contract）。
