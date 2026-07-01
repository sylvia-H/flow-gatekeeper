# Implementation Plan: 診斷任務佇列、AI 串流診斷與 Redis 快取

**Branch**: `003-bullmq-ai-streaming` | **Date**: 2026-07-01 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/003-bullmq-ai-streaming/spec.md`

## Summary

在 002 已能持續產生／落地遙測、異常與維修歷史之上，讓系統第一次能「就某台機台的近期脈絡產出可追溯的 AI 診斷」。`apps/api` 新增 `POST /diagnoses` 建立診斷 job（BullMQ，Redis 為後端，含 limiter／attempts／指數退避），並把觸發的 `jobId` 綁到發起連線的 `clientId`；診斷這類耗時、需呼叫 LLM、會 retry/backoff 的工作全部在**獨立的 `apps/worker` process** 執行。Worker 先以能反映「機台／當前狀態／近期錯誤類型／promptVersion／model」的簽章查 Redis cache，命中直接回 `ai/done`（`cached:true`）；未命中才透過 `AiProvider` interface 以串流取得診斷，每個 token 發布到 Redis Pub/Sub `ai-stream:<jobId>`。Gateway 訂閱 `ai-stream:*`，把 `ai/token`／`ai/done`／`ai/error` 轉發給綁定連線；job 生命週期則走 BullMQ QueueEvents 組成 `job/status` 後同樣經 `gateway.send()` 推回。最終診斷經 `DiagnosisResultSchema.parse()` 驗證後寫入 MongoDB `diagnoses`（僅未命中而實際產生時），每次觸發（含命中）另寫一筆輕量 `diagnosisTriggers` 稽核。

技術取捨並非本 plan 自由決定，而是憲章（`.specify/memory/constitution.md` Principle IV/V）與實作指南（`docs/Flow-Gatekeeper-SDD-完整實作指南.md` §8）已固定的既有約束。本 feature 是 002 保留的 `send(clientId, payload)` 銜接點的實際兌現方；前端完整整合（按下「診斷」帶 `socketId`、rAF 批次接收）留待 Feature 004。

## Technical Context

**Language/Version**: TypeScript 5.6（strict），Node 24（本機與 CI 對齊），ESM（`"type": "module"`）

**Primary Dependencies**:
- **apps/api**（新增）：`@nestjs/bullmq` + `bullmq`（`registerQueue(DIAGNOSIS_QUEUE)` 產 job、QueueEvents 監聽生命週期）、`ioredis`（psubscribe `ai-stream:*` 的 subscriber 連線，**專用不跑一般 command**）。沿用既有 `@nestjs/*`、`ws`、`mongodb`、`@flow-gatekeeper/contracts`。
- **apps/worker**（新增）：`bullmq`（已在骨架 deps）、`ioredis`（已在骨架 deps；queue/pub/cache 連線分離）、`mongodb`（讀 context、寫 diagnoses/audit）、`@google/generative-ai`（Gemini provider）、`dotenv`（載入 `.env`）。
- **packages/contracts**（擴充）：新增 `jobs.ts`（`DIAGNOSIS_QUEUE`、`DiagnosisJobPayload`），`index.ts` re-export。`ai/token`、`ai/done`、`ai/error`、`job/status` 型別 001 已定義，**不重複定義**。

**Storage**:
- **Redis 7**（`docker compose`）：BullMQ queue（`diagnosis`）、cache（`ai-cache:<sig>`）、dedupe lock（`ai-lock:<sig>`）、Pub/Sub（`ai-stream:<jobId>`）。連線 MUST 分離（queue／pub／sub／cache 各一）。
- **MongoDB 7**：讀 002 既有 `telemetry`（彙總）／`errorlogs`／`maintenanceRecords` 組 context；寫 `diagnoses`（僅未命中而實際產生）與 `diagnosisTriggers`（每次觸發輕量稽核，含命中）。歷史 MUST 落地 Mongo，Redis 僅暫態（憲章 VII）。

**Testing**: Vitest。至少一支實際（非 no-op）純函式單元測試（FR-018），覆蓋「cache 簽章對相同輸入決定性、對不同 state/錯誤類型會改變」與「串流文字抽 JSON 後對壞資料丟錯」其一或兩者。這兩段抽成 worker 的 `cache/signature.ts` 與 `lib/parse-result.ts` 純函式，不需連 Redis／Mongo／LLM 即可測。

**Target Platform**: 開發者本機（Windows / PowerShell 為主），執行期 Node 24。手動驗收：`pnpm --filter worker smoke:gemini` 先確認 LLM 可用；`docker compose up -d` + `api start:dev` + `worker start:dev`，以 `Invoke-RestMethod`／`curl` POST `/diagnoses`（純後端 smoke `socketId` 可填任意字串）。前端 rAF 端到端整合留待 004。

**Project Type**: pnpm monorepo — 本 feature 動 `apps/api`（jobs module + AI relay）、`apps/worker`（BullMQ 處理主體）、`packages/contracts`（jobs 契約）。`apps/web` 不在範圍。

**Performance Goals**:
- 速率保護：worker limiter `max = AI_RPM`（預設 8）／`duration = 60_000`；連續 20 個 request 於一分鐘內實際 LLM 呼叫 ≤ `AI_RPM`（SC-003）。
- 回應性：首個 token ≤ 5 秒（SC-001）；單次診斷（cache miss）在 **AI 逾時 + 開銷（≤ 35 秒）** 內完成——單次 AI streaming 呼叫設 **30 秒**應用層逾時（FR-020，`AI_TIMEOUT_MS`），SC-001 的整體上限刻意寬於此逾時以避免邊界誤判。
- Cache hit 直接回、0 次 LLM 呼叫（SC-002）；同簽章並發 dedupe → 恰好 1 次 LLM 呼叫（SC-004）。

**Constraints**（皆為憲章／指南既定，非本 plan 決定）:
- Worker isolation：耗時工作、LLM 呼叫、retry/backoff、rate limit MUST 在 worker process；API MUST NOT 跑 long-running（憲章 IV）。
- Worker MUST NOT 直接 emit ws；token 走 Redis Pub/Sub → Gateway 轉發（憲章 IV）。
- 雙通道分流：job lifecycle 走 BullMQ QueueEvents、token 走 Pub/Sub，MUST NOT 混流（憲章 IV）。
- Redis connection 分離：queue／pub／sub／cache 各自連線，subscriber MUST NOT 跑一般 command（憲章 IV）。
- Cache before API：先查 cache 再打 LLM；簽章含 state/promptVersion/model 並以 `ai-lock:<sig>` 去重（憲章 V、指南 §8.7）。
- AI 回傳 MUST `DiagnosisResultSchema.parse()`，失敗走 `ai/error`（憲章 V）。
- Secrets：`GEMINI_API_KEY` 只放本機 `.env`，只提交 `.env.example`（憲章 VI）。
- strict TS、無 `any` 擴散；LLM provider 包在 `AiProvider` interface 後（憲章 V）。

**Scale/Scope**: 5 台固定示範機台（沿用 002）；worker concurrency 2；新增 1 個 jobs module（controller/service/module）、1 個 AI stream relay、1 個 job-status relay、worker 端的 provider/prompt/context/signature/parse/redis 模組與 smoke 腳本；擴充 contracts 的 jobs 契約與 `.env.example` 的 `AI_TIMEOUT_MS`。

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| 原則 | 與本 feature 的關係 | 狀態 |
|------|--------------------|------|
| I. 規格驅動開發 | 走完整 Spec Kit 流程，於 `003-bullmq-ai-streaming` branch（從 `develop`）；不手貼 code 又跑 implement；merge 回 develop 用 `--no-ff` | ✅ PASS |
| II. 單一真實來源 | job 契約（`DIAGNOSIS_QUEUE`／`DiagnosisJobPayload`）**先入 `packages/contracts`** 再於 api/worker 實作；ai/*、job/status 沿用 001 契約與 `asyncapi.yaml`，不另立平行定義 | ✅ PASS（含契約擴充任務） |
| III. 契約優先與全棧型別安全 | 新增 payload 先改契約；`DiagnosisResult` 維持 Zod（`DiagnosisResultSchema.parse()`）；job payload 屬傳輸型別 MAY 用 TS（型別來源分層）；strict TS、無 `any` | ✅ PASS |
| IV. 即時通道架構紀律 | **本 feature 的核心**：worker isolation、worker 不 emit ws → Redis Pub/Sub `ai-stream:<jobId>` → Gateway 轉發；job lifecycle 走 QueueEvents、token 走 Pub/Sub（雙通道分流）；queue/pub/sub/cache 連線分離 | ✅ PASS |
| V. AI 診斷紀律 | **本 feature 的核心**：`AiProvider` interface 隔離（Gemini adapter）；cache before API（簽章含 state/promptVersion/model）+ `ai-lock:<sig>` 去重；`DiagnosisResultSchema.parse()`，失敗走 `ai/error` | ✅ PASS |
| VI. 祕密與設定衛生 | 沿用既有 `.env.example`（`GEMINI_API_KEY` 空值範例）；本 feature 僅新增 `AI_TIMEOUT_MS` 範例，不提交任何 key | ✅ PASS |
| VII. 資料可追溯性 | context 讀自 Mongo（002 落地）；`diagnoses`（結果）與 `diagnosisTriggers`（觸發稽核）落地 Mongo；Redis 僅 queue/cache/lock/PubSub 暫態 | ✅ PASS |
| 測試門檻 | 至少一支實際單元測試（簽章決定性／parse 對壞 JSON 丟錯）；其餘 package 維持 `--passWithNoTests` | ✅ PASS |
| 可重播驗收 | `smoke:gemini` 驗證 LLM 可用；POST `/diagnoses` 觸發完整流程；同簽章第二次回 `cached:true` 為決定性可重播段（不依賴 LLM 隨機性） | ✅ PASS |
| Phase 化遞交 | implement 以 tasks.md 的 phase 為遞交單位，逐 phase 勾選並 commit | ✅ PASS（流程約束） |

**Gate 結論**：無違規，無需 Complexity Tracking。本 feature 兌現 002 明確劃歸的銜接點（`send()`），並落實憲章 IV/V 的即時通道與 AI 診斷紀律；job 契約以「先入契約」處理，符合 contract-first。「任務→連線」以記憶體 Map 綁定（重連失效）屬指南 §8.4 記載的 side-project demo 取捨，已於 spec 列為已知限制，非繞過原則。

## Project Structure

### Documentation (this feature)

```text
specs/003-bullmq-ai-streaming/
├── plan.md              # This file
├── research.md          # Phase 0 output（技術決策）
├── data-model.md        # Phase 1 output（job/context/signature/result/audit/事件）
├── quickstart.md        # Phase 1 output（可重播驗收腳本）
├── contracts/           # Phase 1 output
│   ├── jobs.contract.md          # DIAGNOSIS_QUEUE / DiagnosisJobPayload / POST /diagnoses
│   └── ai-relay.contract.md      # Redis Pub/Sub ai-stream:<jobId> 與 Gateway 轉發、job/status relay
├── checklists/
│   └── requirements.md  # /speckit-specify 既有產物
└── tasks.md             # /speckit-tasks 產物（非本指令建立）
```

### Source Code (repository root)

```text
flow-gatekeeper/
├── .env.example                        # ★ 新增 AI_TIMEOUT_MS（其餘 GEMINI_*/AI_*/REDIS_* 既有）
├── packages/contracts/src/
│   ├── jobs.ts                         # ★ 新增：DIAGNOSIS_QUEUE、DiagnosisJobPayload
│   └── index.ts                        # ★ 擴充：export * from './jobs.js'
├── apps/api/
│   ├── package.json                    # ★ 新增 @nestjs/bullmq / bullmq / ioredis
│   └── src/
│       ├── app.module.ts               # ★ 匯入 JobsModule；providers 加 AI relay
│       ├── modules/
│       │   ├── config/config.service.ts   # ★ 擴充：redisHost/redisPort（其餘既有）
│       │   ├── jobs/
│       │   │   ├── jobs.module.ts      # ★ BullmqModule.registerQueue(DIAGNOSIS_QUEUE)
│       │   │   ├── jobs.controller.ts  # ★ POST /diagnoses（開發階段免授權，FR-021）
│       │   │   └── jobs.service.ts     # ★ enqueue + relay.bindJobToClient
│       │   └── websocket/
│       │       ├── monitoring.gateway.ts   # 沿用 002 的 send()（不改介面）
│       │       ├── ai-stream-relay.service.ts  # ★ psubscribe ai-stream:* → gateway.send
│       │       └── job-status-relay.service.ts # ★ QueueEvents → job/status → gateway.send
│       └── (main.ts / tsconfig 沿用；main 已 attach gateway)
└── apps/worker/
    ├── package.json                    # ★ 新增 mongodb / @google/generative-ai / dotenv；script start:dev、smoke:gemini
    └── src/
        ├── main.ts                     # ★ 改寫：BullMQ Worker（queue/pub/cache 分離）+ Mongo + provider
        ├── redis.ts                    # ★ createRedisConnection（連線分離工廠）
        ├── ai/
        │   ├── provider.ts             # ★ AiProvider interface（憲章 V）
        │   ├── gemini-provider.ts      # ★ GeminiProvider implements AiProvider（含 30s 逾時）
        │   ├── prompt.ts               # ★ buildPrompt
        │   └── smoke-gemini.ts         # ★ 連通性 smoke（FR-017）
        ├── context/context-builder.ts  # ★ 讀 Mongo 近期 telemetry/errorlogs/maintenance
        ├── cache/
        │   ├── signature.ts            # ★ 純函式：buildDiagnosisSignature（可單測，FR-018）
        │   └── signature.test.ts       # ★ 決定性/敏感度測試
        └── lib/
            ├── parse-result.ts         # ★ 純函式：抽 JSON + DiagnosisResultSchema.parse（可單測）
            └── parse-result.test.ts    # ★ 壞 JSON 丟錯測試
```

**Structure Decision**: 沿用 monorepo 佈局。**責任切分明確**：`apps/api` 只負責建立 job 與**轉發**（不呼叫 LLM、不做 cache）；`apps/worker` 承擔所有耗時工作與 AI/cache/context/持久化。Gateway 的 `send()` 維持 002 介面不變，AI relay 與 job-status relay 皆為新 provider，透過 DI 注入 `MonitoringGateway`。**把 cache 簽章與串流結果解析抽成 worker 的純函式**（`cache/signature.ts`、`lib/parse-result.ts`），讓 FR-018 單測不需啟動 Redis/Mongo/LLM。Redis 連線以 `redis.ts` 工廠產出並在 main 分成 queue/pub/cache 三條（api 端另有 subscriber 一條），落實憲章 IV 的連線分離。

## Complexity Tracking

> 無 Constitution Check 違規，本節不適用。
