# Contract: 結構化日誌欄位約定

**Feature**: 009-Observability-Baseline｜**滿足**: FR-001、FR-002、FR-003、FR-004
**單一來源**: `packages/shared/src/logging/`（子路徑 export `@flow-gatekeeper/shared/logging`）

---

## 1. 共通欄位（每筆必有）

| 欄位 | 來源 | 說明 |
| --- | --- | --- |
| `level` | pino | 30=info、40=warn、50=error |
| `time` | pino | epoch millis |
| `service` | 根 logger binding | `"api"` \| `"worker"` |
| `context` | child logger binding | 來源脈絡，見 §3 |
| `msg` | 呼叫點 | 人類可讀訊息 |

## 2. 關聯鍵（選配，有值必帶）

| 欄位 | 何時帶 |
| --- | --- |
| `jobId` | 任何與某次診斷相關的事件（api 收件、queue 派送、worker 處理、結果回傳） |
| `machineId` | 任何與某台機台相關的事件 |
| `clientId` | 任何與某條 ws 連線相關的事件 |

**規則**：
1. 命名 MUST 與 `packages/contracts` 逐字一致（camelCase）。禁止 `job_id`／`jobID`／`job`。
2. 有結構化欄位就 **MUST NOT** 再把同一個值串進 `msg`。
   - ❌ `logger.info({ jobId }, \`job active: ${jobId}\`)`
   - ✅ `logger.info({ jobId, machineId }, "job active")`
3. 長流程 SHOULD 用 child logger 綁定一次，避免每個呼叫點重複傳
   （`const jl = logger.child({ jobId, machineId })`）。

## 3. `context` 取值

| service | context | 對應 |
| --- | --- | --- |
| api | `MonitoringGateway`／`HistoryService`／`JobStatusRelayService`／`AiStreamRelayService`／`JobsService`／`api` | Nest `Logger` 既有 context，由 adapter 原樣帶入 |
| api | `health` | `/healthz` 相關 |
| api / worker | `metrics` | 週期指標摘要（**專屬 level**，見 §5） |
| worker | `bootstrap`／`processor`／`heartbeat`／`chaos`／`shutdown` | worker 各階段 |

## 4. 等級語意

| level | 用於 |
| --- | --- |
| `error` | 已影響結果的失敗（job 最終失敗、schema 驗證失敗、持久化失敗） |
| `warn` | 可自癒或已降級處理的異常（重試中、publish 失敗、心跳逾時回收、chaos 警告） |
| `info` | 正常生命週期事件（啟動、連線、job 各階段、關閉） |
| `debug` | 預設不輸出的細節 |

**根等級**：`LOG_LEVEL`（預設 `info`）。非法值回退至 `info` 並以 `warn` 記錄一次。

## 5. 指標摘要的等級獨立

`context: "metrics"` 的 child logger level 由 `METRICS_LOG_LEVEL`（預設 `info`）**獨立釘定**，
**不受 `LOG_LEVEL` 影響**。

理由：`LOG_LEVEL=warn` 是為了壓低雜訊，但週期指標摘要正是壓低雜訊後**最該保留**的東西。
pino 的 child logger 可設定比 parent 更寬鬆的 level，正好承接此需求（spec Edge Case、SC-005）。

## 6. 呈現模式

| 環境 | 預設 | 覆寫 |
| --- | --- | --- |
| `NODE_ENV !== "production"` | pretty（`pino-pretty`） | `LOG_PRETTY=false` |
| `NODE_ENV === "production"` | 純 JSON（NDJSON） | `LOG_PRETTY=true` |

`pino-pretty` MUST 為 **devDependency** 且僅在 pretty 模式動態載入，不得進入 production image。

## 7. FR-004 的唯一例外：worker 致命路徑

`apps/worker/src/lib/fatal.ts` **維持同步 `writeSync(fd 2)` 純文字輸出**，不改走 pino。

理由（research R1a）：
- 容器內 stderr 是 pipe，非同步寫入在 `process.exit(1)` 後**會遺失**——致命訊息遺失即
  007「let it crash」的可診斷性歸零。
- 該格式已是 007 的運維層契約
  （`specs/007-worker-process-supervision/contracts/supervision-runtime.md`），變更即破壞既有契約。

**落地要求**：`fatal.ts` MUST 補一行註解指向本節，使「為何這裡不是結構化日誌」在程式中自明，
避免後續 review 誤判為漏改。

## 8. 一次性 CLI 腳本不納入

`apps/api/src/scripts/seed.ts`、`apps/worker/src/ai/smoke-gemini.ts` 維持人類可讀 CLI 輸出。
SC-001 的標的是長駐服務行程的運行期日誌；一次性工具的終端回饋轉 NDJSON 只會降低可用性
（research R1b）。

## 9. FR-009：高頻路徑禁止逐筆日誌

`publishTelemetry()`（每 50ms）與 `persistBatch()` 的**正常路徑 MUST NOT 產生任何日誌**。
只有錯誤路徑（如 `persistBatch failed`）可記 `error`。
指標一律以記憶體累加器累積，週期結算時才輸出一則（contracts/metrics-summary.md §7）。
