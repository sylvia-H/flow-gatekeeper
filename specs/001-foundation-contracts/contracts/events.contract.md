# Contract: 即時通道事件型別（6 條）

**來源**：`packages/contracts/src/events.ts`（型別）+ `asyncapi.yaml`（文件）
**參考 code**：實作指南 §6.8（AsyncAPI）、§6.9（events.ts）

## 通道與訊息

每筆訊息皆為帶 `type` 判別欄位的 JSON 物件（discriminated union 友善）。

| 通道 | 方向 | `type` | 必填欄位 | 可選欄位 |
|------|------|--------|----------|----------|
| machine/subscribe | client → server | `machine/subscribe` | `token: string`, `machineIds: string[]` | — |
| machine/data | server → client | `machine/data` | `machineId`, `timestamp(date-time)`, `telemetry`, `state` | — |
| job/status | server → client | `job/status` | `jobId`, `machineId`, `status` | `progress?`, `result?`, `error?` |
| ai/token | server → client | `ai/token` | `jobId`, `seq: int`, `text` | — |
| ai/done | server → client | `ai/done` | `jobId`, `cached: bool`, `result` | — |
| ai/error | server → client | `ai/error` | `jobId`, `code`, `message` | — |

### telemetry 子物件（machine/data）

`telemetry: { temperature: number, vibration: number, throughput: number, errorRate: number }`，
`state: 'healthy' | 'warning' | 'critical'`。

### union 匯出

`export type AiStreamEvent = AiToken | AiDone | AiError;`

## 型別來源紀律

- `JobStatus.result` 與 `AiDone.result` 的型別 MUST 為從 `schemas.ts` re-export 的
  `DiagnosisResult`（`z.infer`），MUST NOT 在此手寫等價 type（憲章 III、FR-005）。

## 文件對應（asyncapi.yaml）

- 6 通道皆於 `channels:` 宣告，訊息於 `components.messages`，`TelemetryPoint` 與
  `DiagnosisResult` 於 `components.schemas`。
- `state` 列舉 `[healthy, warning, critical]` 與 `severity` 列舉 `[ok, warning, critical]`
  MUST 與 TS/Zod 對齊。

## 驗收

- **AS（US2-1）**：api 匯入 telemetry 與診斷結果型別 → 編譯通過、型別與來源一致。
- **AS（US2-3）**：對 `asyncapi.yaml` 執行 `spectral lint` → 0 違規。
- 三端各放一支最小 import 檔並 typecheck（SC-003）。
