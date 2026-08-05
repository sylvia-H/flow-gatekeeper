---
description: "Task list for feature 001 — Monorepo 基礎、共用契約、本機 Infra 與環境設定"
---

# Tasks: Monorepo 基礎、共用契約、本機 Infra 與環境設定

**Input**: Design documents from `/specs/001-foundation-contracts/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md)

**Tests**: 本 feature 的 spec 明確要求至少一支實際測試（FR-014：契約結構驗證／entry module 乾淨 import）。故下列含**指定的**測試任務，非全面 TDD。

**Organization**: 任務依三個 User Story（P1/P2/P3）分組，各 story 可獨立實作與驗收。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 可平行（不同檔案、無未完成相依）
- **[Story]**: US1 / US2 / US3，對應 spec 的 User Story
- 每個任務含明確檔案路徑

## Path Conventions

pnpm monorepo（plan.md「Project Structure」）：repo root 放工作區設定與 infra；
`packages/{contracts,shared}`、`apps/{api,worker,web}`。所有路徑相對 repo root。

---

## Phase 1: Setup（共用工作區骨幹）

**Purpose**: monorepo 初始化——所有 story 都依賴的工作區設定與工具鏈。

- [X] T001 建立 `pnpm-workspace.yaml`（packages: `apps/*`, `packages/*`）
- [X] T002 建立 root `package.json`：scripts（`lint`/`typecheck`/`test`/`build`/`contract:lint`/`check`）、devDeps（`typescript`、`@stoplight/spectral-cli`、`eslint`、`vitest`）、`packageManager: pnpm@9`、`type: module`
- [X] T003 [P] 建立 `tsconfig.base.json`（strict TS、ESM、`noImplicitAny`，供各 workspace extends）
- [X] T004 [P] 建立 root `eslint.config.js`（TypeScript flat config，落實「避免 `any` 擴散」紀律）
- [X] T005 [P] 建立基礎 `.gitignore`（`node_modules`、`dist`、`build`、`coverage`、logs、editor/OS；祕密規則於 US3 補上）

---

## Phase 2: Foundational（阻擋性前置——5 個 workspace 骨架）

**Purpose**: 讓 5 個 workspace 存在、可安裝、可 typecheck。這是所有 user story 的共同前提。

**⚠️ CRITICAL**: 此階段完成前，任何 user story 都無法開始。

> **所有 workspace 的 `package.json` MUST 定義 `lint`、`typecheck`、`test` 三個 script**（`test` 用 `vitest run --passWithNoTests`），否則 `pnpm -r <script>` 只會在有該 script 的 workspace fan-out，使 CI 的 lint/test 涵蓋出現靜默缺口（對齊 FR-010/FR-011/SC-006）。

- [X] T006 [P] 建立 `packages/contracts` 骨架：`package.json`（`@flow-gatekeeper/contracts`、dep `zod`、scripts `lint`/`typecheck`/`test`，`test: vitest run --passWithNoTests`）、`tsconfig.json`（extends base）、佔位 `src/index.ts`
- [X] T007 [P] 建立 `packages/shared` 骨架：`package.json`（scripts `lint`/`typecheck`/`test`）、`tsconfig.json`、`src/index.ts`
- [X] T008 [P] 建立 `apps/api` 骨架：`package.json`（NestJS 最小依賴；scripts `lint`/`typecheck`/`test`/`build`）、`tsconfig.json`、可乾淨 import 的 `src/main.ts`
- [X] T009 [P] 建立 `apps/worker` 骨架：`package.json`（BullMQ 最小依賴；scripts `lint`/`typecheck`/`test`/`build`）、`tsconfig.json`、`src/main.ts`
- [X] T010 [P] 建立 `apps/web` 骨架：`package.json`（Vue 3 + Vite + Pinia + Tailwind 最小依賴；scripts `lint`/`typecheck`/`test`/`build`）、`tsconfig.json`、`vite.config.ts`、`src/main.ts`
- [X] T011 執行 `pnpm install` 產生 `pnpm-lock.yaml`，確認 5 個 workspace 全部解析成功（依賴 T006–T010）

**Checkpoint**: 工作區可安裝——user story 可開始。

---

## Phase 3: User Story 1 - 一鍵啟動可驗證的工作區與基礎設施 (Priority: P1) 🎯 MVP

**Goal**: clone 後最少步驟即可安裝、啟動本機資料服務，並確認 5 個 workspace typecheck 全通過、Redis/MongoDB 可連線。

**Independent Test**: 乾淨環境執行安裝＋啟動資料服務後，工作區 typecheck 全數通過、Redis 與 MongoDB 皆可連線（spec US1 Independent Test）。

- [X] T012 [US1] 建立 repo root `docker-compose.yml`（`redis:7-alpine` + `mongo:7`，ports、named volumes，依 quickstart §5）
- [X] T013 [US1] 執行 `pnpm typecheck` 確認 5 個 workspace 全通過（strict、0 個 `any` 洩漏）— SC-002
- [X] T014 [US1] 執行 `pnpm build` 確認 api/worker/web 三骨架可編譯產出（不要求啟動）— FR-013／SC-007
- [X] T015 [P] [US1] 新增 entry-module smoke 測試，斷言各 app entry 可乾淨 import：`apps/api/src/main.test.ts`、`apps/worker/src/main.test.ts`、`apps/web/src/main.test.ts` — FR-014
- [X] T016 [US1] 驗證 infra 可連線：`docker compose up -d` → `docker compose ps` healthy（有工具則 `redis-cli ping`／`mongosh ping`）— US1 AS2/AS3

**Checkpoint**: 工作區可驗證、infra 可連線——MVP 達成，可獨立展示。

---

## Phase 4: User Story 2 - 三端共用單一通訊契約 (Priority: P2)

**Goal**: 以 Zod 為單一來源的契約建立完成，web/api/worker 三端可 import 同一份事件/結果型別，AsyncAPI 通過契約 lint，schema 能擋下結構錯誤資料。

**Independent Test**: 三端各寫一支匯入契約的最小檔並 typecheck 通過；`spectral lint asyncapi.yaml` 0 違規；`DiagnosisResultSchema.parse()` 對壞資料丟錯（spec US2 Independent Test）。

- [X] T017 [P] [US2] 實作 `packages/contracts/src/schemas.ts`：`DiagnosisResultSchema`（Zod），型別 `export type DiagnosisResult = z.infer<...>` — FR-005／FR-007
- [X] T018 [P] [US2] 實作 `packages/contracts/src/events.ts`：6 條通道事件型別（TelemetryPoint/MachineSubscribe/JobStatus/AiToken/AiDone/AiError），`DiagnosisResult` 由 schemas re-export，MUST NOT 手寫平行型別 — FR-004
- [X] T019 [US2] 改寫 `packages/contracts/src/index.ts` re-export `./schemas` 與 `./events`（依賴 T017、T018）
- [X] T020 [P] [US2] 建立 repo root `asyncapi.yaml`：6 channels + `components.schemas` 的 `TelemetryPoint`（`state: healthy|warning|critical`）與 `DiagnosisResult`（`severity: ok|warning|critical`）— FR-008
- [X] T021 [P] [US2] 建立 `.spectral.yaml`（`extends: [spectral:asyncapi]`）
- [X] T022 [US2] 在三端各加一支契約匯入驗證檔，import `TelemetryPoint` 與 `DiagnosisResult` 並通過 typecheck：`apps/api/src/contracts.check.ts`、`apps/worker/src/contracts.check.ts`、`apps/web/src/contracts.check.ts`。**這些檔為長期保留的型別佐證**（被 `typecheck` 涵蓋），MUST 不被 `build` 打包進產出（透過 `*.check.ts` 命名於各 app build 設定排除），避免 build/lint 雜訊 — FR-006／SC-003
- [X] T023 [US2] 實作 `packages/contracts/src/schemas.test.ts`（Vitest）：`DiagnosisResultSchema.parse()` 對「缺必填／enum 非法／巢狀結構錯誤」丟 `ZodError` — FR-014／FR-007
- [X] T024 [US2] 執行 `pnpm contract:lint`，確認 `asyncapi.yaml` 0 違規 — SC-004

**Checkpoint**: 契約單一來源就緒、三端共用、文件 lint 過、schema 可驗證。

---

## Phase 5: User Story 3 - 品質與祕密防護門檻可運作 (Priority: P3)

**Goal**: 祕密與設定分離（只追蹤範例檔），CI 於 push/PR 跑契約 lint／typecheck／lint／測試四道檢查，無測試的 workspace 不使 CI 失敗。

**Independent Test**: 放一份本機設定檔確認不被追蹤；CI 觸發一次，四道檢查皆執行且回報（spec US3 Independent Test）。

- [X] T025 [P] [US3] 建立 repo root `.env.example`（資料服務／WS／AI provider／資料生命週期等設定鍵，依 guide §6.4，無真實值）— FR-009
- [X] T026 [US3] 於 `.gitignore` 補祕密規則：`.env`、`.env.*`、`!.env.example` — FR-009／SC-005
- [X] T027 [P] [US3] 建立 `.github/workflows/ci.yml`：`on: [push, pull_request]`，步驟 `pnpm install --frozen-lockfile` → `contract:lint` → `typecheck` → `lint` → `test` — FR-010
- [X] T028 [US3] 確認每個 workspace 的 `test` script 使用 `vitest run --passWithNoTests`，使空測試 package 不讓 CI 紅燈 — FR-011
- [X] T029 [US3] 驗證祕密衛生：`Copy-Item .env.example apps/api/.env` 後 `git status --short` 確認 `.env` 未被追蹤、僅 `.env.example` 在版控 — SC-005

**Checkpoint**: 三個 user story 皆可獨立驗收。

---

## Phase 6: Polish & Cross-Cutting

**Purpose**: 跨 story 的收尾與驗收。

- [X] T030 [P] 本機執行 `pnpm check`（contract:lint + typecheck + lint + test）作為 CI 預演
- [X] T031 依 [quickstart.md](./quickstart.md) 端到端跑完 7 段驗收序列（對齊 SC-001…007）
- [X] T032 [P] 對照 [checklists/foundation.md](./checklists/foundation.md) 做 merge 前需求自檢

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: 無相依，可立即開始。
- **Foundational (Phase 2)**: 依賴 Setup；**阻擋所有 user story**。
- **User Stories (Phase 3–5)**: 皆依賴 Foundational 完成。
  - US1 為 MVP；US2、US3 在骨架就緒後可並進，但建議按 P1 → P2 → P3。
- **Polish (Phase 6)**: 依賴所有目標 story 完成。

### User Story Dependencies

- **US1 (P1)**: Foundational 後即可，獨立可測（infra + typecheck/build）。
- **US2 (P2)**: Foundational 後即可；其契約匯入驗證（T022）用到 app 骨架（Phase 2 已備）。與 US1 無耦合。
- **US3 (P3)**: Foundational 後即可；CI 跑的四道檢查涵蓋 US1/US2 產物，但任務本身（secrets/CI 設定）獨立可測。

### Within Each User Story

- US2：schemas/events（T017/T018）→ index 匯整（T019）→ 三端匯入（T022）→ 契約測試（T023）→ lint（T024）。
- 一般序：定義 → 匯整 → 消費 → 驗證。

### Parallel Opportunities

- Setup：T003/T004/T005 可並行。
- Foundational：T006–T010 五個骨架可並行（不同資料夾）。
- US2：T017/T018（contracts 內不同檔）、T020/T021（asyncapi 與 spectral）可並行。
- US3：T025/T027 可並行。
- 多人時，Foundational 完成後 US1/US2/US3 可分人並進。

---

## Parallel Example: Foundational（Phase 2）

```text
# 五個 workspace 骨架可同時建立：
Task: 建立 packages/contracts 骨架（T006）
Task: 建立 packages/shared 骨架（T007）
Task: 建立 apps/api 骨架（T008）
Task: 建立 apps/worker 骨架（T009）
Task: 建立 apps/web 骨架（T010）
```

## Parallel Example: User Story 2

```text
# 契約定義與通訊文件可並行：
Task: 實作 packages/contracts/src/schemas.ts（T017）
Task: 實作 packages/contracts/src/events.ts（T018）
Task: 建立 asyncapi.yaml（T020）
Task: 建立 .spectral.yaml（T021）
```

---

## Implementation Strategy

### MVP First（User Story 1）

1. 完成 Phase 1 Setup。
2. 完成 Phase 2 Foundational（阻擋性，務必先過）。
3. 完成 Phase 3 US1。
4. **STOP & VALIDATE**：乾淨環境 install → typecheck 全過 → docker infra 可連線。
5. 可獨立展示（bootstrap demo）。

### Incremental Delivery

1. Setup + Foundational → 工作區就緒。
2. US1 → 獨立驗收（MVP）。
3. US2 → 契約三端共用、lint、schema 驗證。
4. US3 → 祕密衛生 + CI 四道門檻。
5. 每個 story 增值且不破壞前者。

---

## Notes

- [P] = 不同檔案、無相依，可並行。
- [Story] 標籤對應 spec User Story，供追溯。
- 測試任務僅限 spec 明確要求者（FR-014）：US1 entry smoke（T015）、US2 契約結構驗證（T023）。
- app 僅交付可 build + typecheck 骨架，MUST NOT 以「能啟動」為驗收（FR-013）。
- 僅在使用者要求時 commit；在 `develop` 上先開 feature branch（已在 `001-foundation-contracts`）。
- 各 checkpoint 可停下獨立驗收。
