# Phase 0 Research: Foundation & Contracts

本 feature 的技術選型多數已由憲章與實作指南（§6）固定，故 Technical Context 無
NEEDS CLARIFICATION。本檔僅記錄 `/speckit-clarify` 階段標為 **Deferred（plan-level）**
的三個執行細節之決策，以及對「已固定選型」的引用確認。

## 1. CI 平台

- **Decision**：GitHub Actions（`ubuntu-latest`），單一 `check` job，步驟為
  `pnpm install --frozen-lockfile` → `contract:lint` → `typecheck` → `lint` → `test`。
- **Rationale**：repo 託管於 GitHub；指南 §6.10 已給定對應 workflow；四道檢查對齊
  FR-010 與 SC-006。`on: [push, pull_request]` 滿足「push / PR 皆觸發」。
- **Alternatives considered**：本機 git hook（無法滿足 PR 門檻、不可重現）、其他 CI
  服務（與託管平台不一致，徒增設定）。

## 2. 通訊契約 lint 工具

- **Decision**：`@stoplight/spectral-cli` 6.15，`.spectral.yaml` `extends: spectral:asyncapi`，
  以 root script `contract:lint = spectral lint asyncapi.yaml` 執行。
- **Rationale**：AsyncAPI 2.6 的事實標準 linter；指南 §6.10 已採用；可在 CI 與本機一致
  執行，滿足 FR-008 / SC-004（0 違規）。
- **Alternatives considered**：AsyncAPI 官方 CLI validate（規則較弱、可組態性低）、
  自寫 schema 驗證（重造輪子，違反單一真實來源精神）。

## 3. 工作區指令編排（task orchestration）

- **Decision**：用 pnpm 內建 `pnpm -r <script>` 遞迴 fan-out（root `package.json` 的
  `lint`/`typecheck`/`test`/`build`），不引入 turbo/nx。
- **Rationale**：5 個 workspace、無複雜建置相依圖，pnpm recursive 已足夠；契合憲章
  「複雜度 MUST 有正當理由」。引入 turbo 在此規模屬過度設計。
- **Alternatives considered**：Turborepo（快取/拓樸排程，本階段無收益）、nx（更重的
  平台綁定）。後續若建置時間成為瓶頸，可在獨立 ADR 中重新評估。

## 4. 已固定選型（引用確認，非本 plan 決策）

| 項目 | 來源 | 決策 |
|------|------|------|
| 契約單一來源 | 憲章 III、指南 §6.9 | Zod schema 定義，型別由 `z.infer` 推導；MUST NOT 手寫平行型別 |
| 即時通道 | 憲章 IV、ADR-001 | 原生 `ws` 掛 NestJS HTTP server（path `/ws`）；MUST NOT Socket.IO |
| Worker 隔離 | 憲章 IV | 獨立 Node process（BullMQ）；本 feature 僅骨架 |
| 本機 infra | 憲章「技術約束與環境」、指南 §6.5 | Redis 7 + MongoDB 7 via docker compose |
| 祕密衛生 | 憲章 VI、指南 §6.3 | 只提交 `.env.example`；`.gitignore` 忽略 `.env`/`.env.*` |
| 套件管理/佈局 | CLAUDE.md、指南 §6.6 | pnpm workspace；`apps/{web,api,worker}` + `packages/{contracts,shared}` |
| 測試框架 | 指南 §6.10 | Vitest；空測試 package 用 `--passWithNoTests` |

## 5. 範圍切割確認（本 feature MUST NOT 含）

- 佇列常數（`DIAGNOSIS_QUEUE`）與 `DiagnosisJobPayload` 任務契約 → Feature 003（FR-004）。
- MongoDB collection 建立與持久化邏輯 → Feature 002（FR-012）。
- app 執行期行為（gateway emit、telemetry rAF batching、AI streaming、cache/lock）
  → 002 / 003 / 004（FR-013）。

**Output**：無未解 NEEDS CLARIFICATION。可進入 Phase 1。
