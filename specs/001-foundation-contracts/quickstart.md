# Quickstart & Validation: Foundation & Contracts (001)

驗證本 feature 的地基是否就緒。對應 spec 的三個 User Story 與 SC-001…007。實作細節（檔案
內容、code）見 [plan.md](./plan.md)、[data-model.md](./data-model.md)、[contracts/](./contracts/)
與實作指南 §6；本檔只給可執行的驗收序列與期望結果。

## 前置

- Node 20 LTS+、pnpm 9、容器執行環境（Docker Desktop 或等價物）。
- 作業系統 Windows / PowerShell（指令以 PowerShell 為主；POSIX 等價見指南 §6）。

## SC-001 的「3 個主要指令步驟」（canonical bootstrap）

SC-001 所稱「不超過 3 個主要指令步驟」明確定義為下列**三步**——從 clone 到「工作區
typecheck 全通過 + 兩個資料服務可連線」的最短可重播序列。其餘 lint/build/secrets 檢查屬
驗收細項，不計入這三個主要步驟。

| 步驟 | 指令 | 達成 |
|:---:|------|------|
| ① 安裝 | `pnpm install` | 5 個 workspace 解析並安裝 |
| ② 啟動 infra | `docker compose up -d` | Redis 7 + MongoDB 7 進入可連線狀態 |
| ③ 驗證 | `pnpm typecheck` | 5 個 workspace strict typecheck 全通過 |

> 連線健康確認（`docker compose ps` / `redis-cli ping` / `mongosh ping`）視為步驟 ② 的
> 附屬檢查，不另計為一個主要步驟。以下分節是針對各 SC 的逐項展開。

## 1. 安裝與型別檢查（US1 / US2 — SC-001, SC-002, SC-003）

```powershell
pnpm install
pnpm typecheck
```

**期望**：5 個 workspace（web/api/worker/contracts/shared）安裝成功；strict typecheck 全
通過、0 個被忽略的 `any` 型別錯誤。三端各自 import 契約的最小檔皆編譯通過。

## 2. 契約 lint（US2 — SC-004）

```powershell
pnpm contract:lint
```

**期望**：`spectral lint asyncapi.yaml` 0 違規。

## 3. 契約驗證測試（US2 — SC-007, FR-014）

```powershell
pnpm test
```

**期望**：`packages/contracts` 的實際測試通過——`DiagnosisResultSchema.parse()` 對結構
錯誤資料丟 `ZodError`；其餘暫無測試的 package 以 `--passWithNoTests` 收場，不使流程失敗。

## 4. App 骨架 build（US1 — SC-007, FR-013）

```powershell
pnpm build
```

**期望**：三個 app（api/worker/web）build + typecheck 通過。**不**要求啟動或連線；工具鏈
啟動期破壞由 smoke import 測試攔截，而非執行期驗收。

## 5. 本機資料服務（US1 — Acceptance 2/3）

```powershell
docker compose up -d
docker compose ps
```

**期望**：Redis 與 MongoDB container 進入 healthy/可連線狀態。若本機有工具可進一步：

```powershell
redis-cli -h 127.0.0.1 -p 6379 ping
mongosh "mongodb://127.0.0.1:27017/flow-gatekeeper" --eval "db.runCommand({ ping: 1 })"
```

缺 `redis-cli` / `mongosh` 時，以 `docker compose ps` 的 container 狀態確認即可（Edge Case）。
未啟動容器執行環境時，`docker compose up` MUST 給出可理解的失敗訊息。

## 6. 祕密衛生（US3 — SC-005, FR-009）

```powershell
Copy-Item .env.example apps/api/.env
git status --short
```

**期望**：`.env` 不出現在 git status（被 `.gitignore` 忽略）；版本控制只追蹤
`.env.example`。

## 7. CI 四道檢查（US3 — SC-006）

push 或開 PR 後，GitHub Actions `check` job 依序執行
`contract:lint → typecheck → lint → test`。

**期望**：四道檢查皆有結果回報；無測試的 workspace 不造成 CI 紅燈。本機可用
`pnpm check` 一次跑完同序列預演。

## 驗收對照

| 驗收 | 指令 | Spec 對應 |
|------|------|-----------|
| 安裝 + typecheck | `pnpm install && pnpm typecheck` | SC-001, SC-002, SC-003 |
| 契約 lint | `pnpm contract:lint` | SC-004 |
| 契約測試 | `pnpm test` | SC-007, FR-014 |
| app build | `pnpm build` | SC-007, FR-013 |
| infra | `docker compose up -d && docker compose ps` | US1 AS2/AS3 |
| 祕密衛生 | `git status --short` | SC-005 |
| CI | push / PR | SC-006 |
