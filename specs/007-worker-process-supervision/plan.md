# Implementation Plan: Worker Process Supervision（worker 生產化與 process 監督）

**Branch**: `007-worker-process-supervision` | **Date**: 2026-07-08 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/007-worker-process-supervision/spec.md`

## Summary

把 worker 從「host 上 `tsx watch`、致命錯誤 log + 續跑」翻轉為「受監督的容器化執行形態 + let it crash」：

- 新增 `apps/worker/Dockerfile`（多階段建置，處理 pnpm workspace 依賴裁剪）與 `docker-compose.yml` 的 worker service（`profiles: [supervised]`、`restart: on-failure:5`、`init: true`、healthcheck 讀 Redis heartbeat key）。
- `apps/worker/src/main.ts` 的 `uncaughtException`／`unhandledRejection` handler 翻轉為 `fatal(kind, value)`：記「致命、交由監督者重啟」log 後**立即 `process.exit(1)`**（不嘗試收尾）；優雅關閉（SIGTERM/SIGINT → `exit(0)`）路徑不動，exit code 即監督語意（`on-failure` 只重啟非零退出）。
- 新增 `WORKER_CHAOS`（`uncaught`|`rejection`）×`WORKER_CHAOS_AT`（`startup`|`job`）故障注入旗標，預設關閉，供可重現演練與日後故障演練 demo。
- 新增 heartbeat（每 10s 寫 `worker:heartbeat`、TTL 30s）＋ compose healthcheck（30s×3）補「活著但卡住」盲點；健康判定僅示警、不自動重啟。
- in-flight job 重派**沿用並驗證** BullMQ 既有 stalled/attempts 機制，不調整 job 級參數；崩潰迴圈防護**沿用並驗證** Docker 內建重啟退避與 `on-failure` 上限，不自行實作。
- 開發模式（`tsx watch`、`scripts/dev-up.ps1`）零改動，文件寫明雙模式切換（compose profiles）與 dev 模式致命錯誤不自動重啟的已知差異。

技術取捨依 [ADR-002](../../docs/adr-002-productionization-scope.md)（容器化路線既定）；五項 clarify 定案見 [spec.md Clarifications](./spec.md#clarifications)；細部決策見 [research.md](./research.md)。

## Technical Context

**Language/Version**: TypeScript 5.6（strict，全棧既有）；Node.js 22（host dev 為 v22.21.1；容器基底 `node:22-alpine`，見 research D1）

**Primary Dependencies**: BullMQ 5、ioredis 5、mongodb 6、`@google/generative-ai`（皆既有、不動）。**零新增 npm 依賴**——監督能力（重啟、退避、上限、healthcheck 排程）由 Docker Engine / docker compose 承接（ADR-002）

**Storage**: Redis 7（既有 queue/cache/lock/Pub-Sub ＋ 新增 `worker:heartbeat` key）；MongoDB 7（不變）

**Testing**: vitest 純函式單元測試（chaos 旗標解析、fatal 訊息格式化、heartbeat 新鮮度判定）＋ [quickstart.md](./quickstart.md) 可重播驗收場景（憲章「測試門檻」與「可重播驗收」）

**Target Platform**: 受監督模式＝Docker Desktop on Windows（linux 容器）；開發模式＝Windows host 直跑（PowerShell + `tsx watch`），兩模式並存

**Project Type**: pnpm monorepo 後端 worker 服務的容器化與監督（單一服務、無新 API/UI 面）

**Performance Goals**: SC-002 致命→恢復消化 ≤ 60s；SC-005 「活著但卡住」≤ 2min 反映為不健康（設計值約 90s）；SC-004 達重試上限後 10min 內零新重啟

**Constraints**: `restart: on-failure:5`（Docker 內建指數退避）；`init: true`（tini 為 PID 1、node 為子行程——同 namespace 對 PID 1 送 SIGSTOP 會被核心忽略，US5 活鎖演練需凍結 node 子行程）；heartbeat 週期 10s／TTL 30s；healthcheck `interval: 30s`／`timeout: 5s`／`retries: 3`／`start_period: 30s`；`stop_grace_period: 45s`（涵蓋 `worker.close()` 最長收尾 ≈ AI_TIMEOUT_MS 30s + 緩衝）；dev 流程零改動（SC-008）；`.env` 絕不進 image（憲章 VI）

**Scale/Scope**: 單 worker 實例（`concurrency: 2`、`AI_RPM=8`）、單機 demo；多實例（heartbeat key 命名、水平擴展）明確不在範圍（ADR-002 §6）

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| # | 原則 | 判定 | 說明 |
|---|------|------|------|
| I | 規格驅動開發 | ✅ PASS | 於 `007-worker-process-supervision` branch 走完整 Spec Kit 流程；merge 回 `develop` 時 `--no-ff` |
| II | 單一真實來源 | ✅ PASS | 不觸視覺層；監督者選型、生產化分期依 ADR-002 既定決策，不另立平行論述；本 plan 引用而不重議 |
| III | 契約優先與型別安全 | ✅ PASS | `packages/contracts` **零變更**——heartbeat key、exit code、env 旗標屬 process/運維層契約，非跨端通訊 payload，以 [contracts/supervision-runtime.md](./contracts/supervision-runtime.md) 文件化；新增 code 全 strict TS、無 `any` |
| IV | 即時通道紀律 | ✅ PASS | 不動 ws/Pub-Sub/雙通道結構；worker 照舊不直接 emit ws；heartbeat 用既有 `cache` 一般 command 連線（不佔 subscriber） |
| V | AI 診斷紀律 | ✅ PASS | AiProvider／cache／schema 驗證路徑零變更；崩潰迴圈退避上限反而保護 LLM 額度 |
| VI | 祕密與設定衛生 | ✅ PASS | 根目錄 `.dockerignore` 排除 `**/.env`、`.git`；image 不烘入任何祕密；祕密於執行時經 compose `env_file` 注入；只提交 `.env.example`（新增 chaos 旗標說明） |
| VII | 資料可追溯性 | ✅ PASS | 不動 Mongo 持久化語意；heartbeat 屬暫態訊號，本就該放 Redis（TTL 即語意） |
| — | 測試門檻（品質門檻） | ✅ PASS | 純函式 vitest：chaos 解析決定性、fatal 訊息格式化（Error/非 Error/stack）、heartbeat 新鮮度判定 |
| — | 可重播驗收（品質門檻） | ✅ PASS | `WORKER_CHAOS` 旗標＋quickstart 場景使「致命→重啟→恢復」可不改 code 連續重演（SC-006） |

**Post-Phase-1 re-check**: 設計產物（data-model、contracts、quickstart）未引入新違反；`packages/contracts` 維持零變更。✅ PASS

## Project Structure

### Documentation (this feature)

```text
specs/007-worker-process-supervision/
├── plan.md              # 本檔（/speckit-plan 輸出）
├── research.md          # Phase 0 輸出（D1–D9 決策）
├── data-model.md        # Phase 1 輸出（實體、狀態轉移）
├── quickstart.md        # Phase 1 輸出（US1–US5 可重播驗收場景）
├── contracts/
│   └── supervision-runtime.md   # Phase 1 輸出（運維層契約：env/exit code/heartbeat/健康狀態）
├── checklists/
│   ├── requirements.md  # spec 品質檢查（已 16/16）
│   └── supervision.md   # /speckit-checklist 輸出（29 項需求品質檢查，T028 覆核結案）
└── tasks.md             # Phase 2 輸出（/speckit-tasks 產生，非本命令）
```

### Source Code (repository root)

```text
apps/worker/
├── Dockerfile                # 新增：多階段建置（builder → pnpm deploy 裁剪 → runtime）
├── .env.example              # 修改：新增 WORKER_CHAOS / WORKER_CHAOS_AT 說明（預設關閉、僅供演練）
└── src/
    ├── main.ts               # 修改：handler 翻轉為 fatal exit(1)；啟動 heartbeat 迴圈與 chaos 注入；
    │                         #       移除「暫時策略（log+續跑）」註解但書（FR-011）
    ├── healthcheck.ts        # 新增：compose healthcheck 進入點（讀 heartbeat key，exit 0/1）
    └── lib/
        ├── fatal.ts          # 新增：formatFatal(kind, value) 純函式 + fatal() helper（log → exit(1)）
        ├── fatal.test.ts     # 新增：Error/非 Error/stack 格式化
        ├── chaos.ts          # 新增：parseChaosConfig(env) 純函式 + armChaos()（startup/job 兩時點注入）
        ├── chaos.test.ts     # 新增：合法/非法/未設定值解析決定性
        ├── heartbeat.ts      # 新增：startHeartbeat()/stopHeartbeat() + isHeartbeatFresh(pttl) 純函式
        └── heartbeat.test.ts # 新增：新鮮度判定邊界

docker-compose.yml            # 修改：新增 worker service（profiles: [supervised]、restart: on-failure:5、
                              #       init: true、healthcheck、stop_grace_period: 45s、env_file + environment 覆蓋）
.dockerignore                 # 新增（build context 為 repo root）：node_modules、.git、**/.env、dist、web 資產等
README.md                     # 修改：雙模式（開發/受監督）使用情境、切換指令、dev 模式致命差異（FR-010）
docs/Flow-Gatekeeper-SDD-完整實作指南.md  # 修改：§13 相關「暫時策略」但書收斂為已落地（FR-011）
scripts/dev-up.ps1            # 不動（SC-008 驗收其零影響）
packages/{contracts,shared}   # 不動（Constitution III：本 feature 無跨端 payload 變更）
```

**Structure Decision**: 沿用既有 monorepo 佈局，變更集中於 `apps/worker`＋根層兩檔（compose、.dockerignore）。監督相關新 code 收在 `apps/worker/src/lib/`（與既有 `lib/parse-result.ts` 同層慣例），healthcheck 為獨立進入點（不 import `main.ts`，避免 bootstrap 副作用）；`tsconfig.build.json` 既有的 `*.test.ts` 排除規則自然涵蓋新測試檔。

## Complexity Tracking

無憲章違反，本節免填。
