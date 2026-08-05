# Implementation Plan: Monorepo 基礎、共用契約、本機 Infra 與環境設定

**Branch**: `001-foundation-contracts` | **Date**: 2026-06-30 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-foundation-contracts/spec.md`

## Summary

建立 flow-gatekeeper 的工程地基：一個 pnpm workspace monorepo，內含三個可編譯的最小
app 骨架（web/api/worker）、一份以 Zod 為單一來源的共用通訊契約（`packages/contracts`）、
對應的 AsyncAPI 通訊文件、本機資料服務（Redis 7 + MongoDB 7 via docker compose）、祕密
衛生（`.env.example` only）與 CI 四道檢查（contract lint / typecheck / lint / test）。

技術取捨並非本 plan 自由決定，而是憲章（`.specify/memory/constitution.md`）與實作指南
（`docs/Flow-Gatekeeper-SDD-完整實作指南.md` §6）已固定的既有約束。本 feature 僅交付
**可 build + typecheck 的骨架**，MUST NOT 要求執行期啟動或連線（執行期行為留待 002/003）；
工具鏈「build 過卻啟動炸」的風險改以一支實際 smoke/單元測試覆蓋（見 FR-014）。

## Technical Context

**Language/Version**: TypeScript 5.6（strict），Node 20 LTS+，ESM（`"type": "module"`）

**Primary Dependencies**: pnpm 9 workspace、Zod 3.24（契約單一來源）、NestJS（api 骨架）、
原生 `ws`（即時通道，非 Socket.IO）、BullMQ（worker 骨架）、Vue 3 + Vite + Pinia + Tailwind
（web 骨架）、Vitest（測試）、`@stoplight/spectral-cli` 6.15（AsyncAPI contract lint）

**Storage**: 本機 infra 為 Redis 7 + MongoDB 7（docker compose）。本 feature 僅提供
docker-compose 與 env；MongoDB collection 建立留待 Feature 002（FR-012）。

**Testing**: Vitest（`vitest run --passWithNoTests`；至少一支實際測試，見 FR-014）

**Target Platform**: 開發者本機（Windows / PowerShell 為主），CI 於 GitHub Actions
（ubuntu-latest）

**Project Type**: pnpm monorepo — `apps/{web,api,worker}` + `packages/{contracts,shared}`

**Performance Goals**: 非執行期 feature。唯一可量化目標為 bootstrap 體驗：clone → 可驗證
工作區 ≤ 10 分鐘且 ≤ 3 主要指令（SC-001）。高頻 telemetry 的 rAF batching 等執行期效能
門檻屬 002/004，本 feature 不涉及。

**Constraints**: strict TS、無 `any` 擴散；契約型別 MUST 由 `z.infer` 推導，MUST NOT 手寫
平行型別；即時通道協定固定原生 `ws`（path `/ws`）；佇列常數與任務 payload 契約留待 003
（FR-004）。

**Scale/Scope**: 5 個 workspace（3 app 骨架 + 2 package）、6 條 WebSocket 通道事件型別 +
`DiagnosisResultSchema`、1 份 docker-compose、1 份 CI workflow。

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| 原則 | 與本 feature 的關係 | 狀態 |
|------|--------------------|------|
| I. 規格驅動開發 | 本 feature 走完整 Spec Kit 流程，於 `001-foundation-contracts` branch（從 `develop`）；不手貼 code 又跑 implement | ✅ PASS |
| II. 單一真實來源 | 契約依 `packages/contracts` + `asyncapi.yaml`；視覺 token 與品牌限制屬 web 執行期，本 feature 只立骨架，不散落 hex | ✅ PASS |
| III. 契約優先與全棧型別安全 | Zod schema 為唯一來源，`DiagnosisResult` 由 `z.infer` 推導；strict TS，無 `any` 擴散 | ✅ PASS（本 feature 的核心交付） |
| IV. 即時通道架構紀律 | api 用原生 `ws` 掛 NestJS HTTP server（path `/ws`）骨架；worker 為獨立 process 骨架；本 feature 不實作 emit/buffer/Pub-Sub 行為（留待 002/003），但骨架選型不得牴觸 | ✅ PASS（骨架不違反，行為留待後續） |
| V. AI 診斷紀律 | `DiagnosisResultSchema` 建立並可 `.parse()` 驗證壞資料；`AiProvider` interface 與 cache/lock 屬 003，本 feature 不涉及 | ✅ PASS（契約就緒，行為留待 003） |
| VI. 祕密與設定衛生 | 只提交 `.env.example`；`.gitignore` 忽略 `.env`/`.env.*`（保留 `!.env.example`） | ✅ PASS |
| VII. 資料可追溯性 | 本 feature 只立 MongoDB infra 與 env，collection/持久化邏輯留待 002；無「歷史只放 Redis」風險 | ✅ PASS（N/A 行為層） |
| 測試門檻 | 至少一支實際單元測試（schema 對壞 JSON 丟錯），空測試 package 用 `--passWithNoTests` | ✅ PASS |
| 可重播驗收 | 本 foundation feature 的可重播 demo 即 SC-001 確定性 bootstrap 序列；seed/mock producer 自 002 起 | ✅ PASS（spec Assumptions 已界定） |

**Gate 結論**：無違規，無需 Complexity Tracking。所有「未實作」項目皆為憲章與 spec 明確
劃歸後續 feature 的範圍切割，非繞過原則。

## Project Structure

### Documentation (this feature)

```text
specs/001-foundation-contracts/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output（通訊契約規格）
│   ├── README.md
│   ├── events.contract.md
│   └── diagnosis-result.contract.md
├── checklists/
│   └── requirements.md  # /speckit-checklist 既有產物
└── tasks.md             # /speckit-tasks 產物（非本指令建立）
```

### Source Code (repository root)

```text
flow-gatekeeper/
├── pnpm-workspace.yaml          # packages: apps/*, packages/*
├── package.json                 # root scripts: lint/typecheck/test/build/contract:lint/check
├── tsconfig.base.json           # strict TS 共用設定
├── docker-compose.yml           # Redis 7 + MongoDB 7
├── asyncapi.yaml                # 6 通道通訊文件（Spectral lint 對象）
├── .spectral.yaml               # extends spectral:asyncapi
├── .gitignore                   # 忽略 .env / .env.*（保留 .env.example）
├── .env.example                 # 設定形狀（無真實憑證）
├── .github/workflows/ci.yml     # contract:lint → typecheck → lint → test
├── packages/
│   ├── contracts/               # ★ 本 feature 核心：Zod schema 單一來源
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── schemas.ts       # DiagnosisResultSchema（Zod）+ z.infer 型別
│   │       ├── events.ts        # 6 通道事件型別（TelemetryPoint/MachineSubscribe/...）
│   │       ├── index.ts         # re-export
│   │       └── schemas.test.ts  # FR-014 實際測試：壞 JSON → parse 丟錯
│   └── shared/                  # 共用工具骨架（最小可編譯）
│       ├── package.json
│       ├── tsconfig.json
│       └── src/index.ts
└── apps/
    ├── api/                     # NestJS + ws gateway 骨架（build/typecheck only）
    │   ├── package.json
    │   ├── tsconfig.json
    │   └── src/main.ts          # entry module 可乾淨 import（smoke 對象）
    ├── worker/                  # BullMQ 獨立 process 骨架
    │   ├── package.json
    │   ├── tsconfig.json
    │   └── src/main.ts
    └── web/                     # Vue 3 + Vite 骨架
        ├── package.json
        ├── tsconfig.json
        ├── vite.config.ts
        └── src/main.ts          # import 契約型別以證明三端可共用
```

**Structure Decision**: 採 pnpm monorepo（憲章「技術約束與環境」固定佈局）。
`packages/contracts` 是本 feature 的重心，被三個 app 與 `packages/shared` 共用；app 在
本階段僅為可 build + typecheck 的骨架，各自含一個 entry module 供 smoke import 驗證。
工作區指令一律以 root `package.json` 的 `pnpm -r <script>` fan-out，避免引入 turbo 等
額外 orchestration（見 research.md）。

## Complexity Tracking

> 無 Constitution Check 違規，本節不適用。
