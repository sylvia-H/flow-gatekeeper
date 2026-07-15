# Implementation Plan: Full-Stack Containerization & One-Command Demo（整棧容器化與一鍵 Demo）

**Branch**: `008-fullstack-containerization` | **Date**: 2026-07-15 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/008-fullstack-containerization/spec.md`

## Summary

把 007 只做在 worker 上的「受監督容器形態」推到三端，並讓展示者以單一指令、單一入口走完 demo 劇本：

- 新增 `apps/api/Dockerfile`、`apps/web/Dockerfile`（＋`apps/web/nginx.conf`），形狀沿用 007 已實證的多階段 + `pnpm deploy --prod` 建置鏈（research D3）。
- `docker-compose.yml` 新增 `web`／`api`／`seed` 三個 service，並把 worker 的 `profiles: ["supervised"]` 更名為 `["demo"]`——單一 `demo` 分組涵蓋三端，`supervised` 退場（research D8、FR-008）。
- **入口拓樸**：web 容器（nginx）是唯一對外的埠（`8080:80`），同時提供靜態產物與 `/ws`、`/diagnoses` 的同源反向代理至 api；api **不宣告 `ports`**。upstream 以 `resolver` + 變數式 `proxy_pass` 延後解析，避免 nginx 把 IP 快取成失效位址而使崩潰重連失敗（research D1）。前端原始碼零改動——它本來就走同源相對路徑（research D1／D2）。
  **實作期例外**：US1（Phase 3）交付時 web 容器尚不存在，其一致性比對須以 host dev 前端連上（vite proxy target 寫死 `localhost:3000`），故 api 於 Phase 3 暫時宣告 `ports: ["3000:3000"]`，並在 T012 交付 web 容器時移除。終態仍是「api 無 `ports`」（contracts §2、release-gate CHK054）。
- **api 優雅關閉（FR-004、FR-014 的唯一例外）**：`bootstrap()` 補 `enableShutdownHooks()` + 顯式 SIGTERM handler → `app.close()` → `exit(0)`。查證確認 api 現況**完全沒有訊號處理**，四個既有 `onModuleDestroy` 從未被觸發——這是既有缺口，非容器化才生（research D5）。
- **api 健康探針**：新增 `dist/healthcheck.js`，以 `/ws` 握手收到 `system/connected` 為準（已查證 Gateway 無條件送出、不需 token）；不新增任何 HTTP 端點（`/healthz` 屬 009，research D6）。
- **seed 一次性服務**：復用 api 映像的第三進入點 `node dist/scripts/seed.js`，`restart: "no"`；api 以 `service_completed_successfully` 為啟動條件。因 `depends_on` 只在啟動編排時求值，api 崩潰重啟**不會**重跑 seed（research D7、FR-012）。
- **`.dockerignore` 必須重寫**：現行版本為 worker 單一映像調校，排除了 `apps/api/src`、`apps/web/src`、`apps/web/index.html`——三映像共用同一份 context，不改則 api／web 建置必失敗。祕密防線（`**/.env`）一字不動（research D4）。
- 祕密缺漏沿用現行語意、不新增檢查；驗收 MUST 實測空金鑰路徑（research D11、FR-017）。
- 開發模式零改動：`docker compose up -d` 仍只起 infra，`dev-up.ps1`／`demo-reset.ps1` 皆不動（research D9）。

技術取捨依 [ADR-002](../../docs/adr-002-productionization-scope.md)（容器化路線、生產化分期既定）；六項 clarify 定案見 [spec.md Clarifications](./spec.md#clarifications)；細部決策見 [research.md](./research.md)（D1–D12）。

## Technical Context

**Language/Version**: TypeScript 5.6（strict，全棧既有）；Node.js 22（容器基底 `node:22-alpine`，沿用 007 research D1）

**Primary Dependencies**: NestJS 10、原生 `ws` 8、ioredis 5、mongodb 6、BullMQ 5、Vue 3 + Vite 5（皆既有、不動）。**零新增 npm 依賴**——反向代理由 `nginx:alpine` 承接，監督能力由 docker compose 承接（ADR-002 不造輪子）

**Storage**: Redis 7、MongoDB 7（皆不變；`redis-data`／`mongo-data` volume 為 FR-013 `down -v` 重設的標的）

**Testing**: vitest 純函式單元測試（healthcheck 的握手判定、`humanizeError` 的文案與映射）＋ [quickstart.md](./quickstart.md) 可重播驗收場景（憲章「測試門檻」與「可重播驗收」）。**api 優雅關閉的退出碼不寫純函式測試**——其結果恆為 0，包一層純函式只是儀式；改以 quickstart 場景 1d 實測 ExitCode 與收尾耗時驗收（見 tasks.md 開頭「Tests」段）

**Target Platform**: 全棧 demo 模式＝Docker Desktop on Windows（linux 容器）；開發模式＝Windows host 直跑（PowerShell + `tsx watch`／`nest start --watch`／`vite`），兩模式並存且互不干擾

**Project Type**: pnpm monorepo 三端（web/api/worker）的容器化與單一入口編排；無新 API 面、無新 UI 面、`packages/contracts` 零變更

**Performance Goals**: SC-003 Gateway 強制終結後前端 ≤ 30s 重新連上（**MUST 在 demo 拓樸下實測**——經 nginx 的路徑，非只驗 dev 前端直連）；SC-005 api 收尾實測 ≤ 3s（15s 寬限期上限的 1/5）；SC-001 從 clone + 填祕密到見遙測＝1 道指令 + 1 個位址

**Constraints**: 入口 `8080:80`（api 不對外暴露埠——Phase 3 的暫時 `3000:3000` 於 T012 移除）；api `restart: on-failure:5`、`stop_grace_period: 15s`（收尾實測 MUST ≤ 3s）、`init: true`；worker 維持 `on-failure:5`／`45s`（不動）；seed `restart: "no"`；healthcheck 沿用 007 參數（`30s`／`5s`／`3`／`start_period 30s`）；`.env` 絕不進 image（憲章 VI）；FR-014——除關閉路徑外零執行語意變更

**Scale/Scope**: 單機、單實例（單一 Gateway、單一 worker）；多實例、負載平衡、TLS、registry 發布、CI/CD 明確不在範圍（ADR-002 §6／§7）

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| # | 原則 | 判定 | 說明 |
|---|------|------|------|
| I | 規格驅動開發 | ✅ PASS | 於 `008-fullstack-containerization` branch 走完整 Spec Kit 流程；merge 回 `develop` 時 `--no-ff` |
| II | 單一真實來源 | ✅ PASS | 不觸視覺層（web 映像只是把既有 `vite build` 產物換個伺服器送出）；監督者選型與分期依 ADR-002 既定決策，本 plan 引用而不重議；`supervised` → `demo` 更名依 FR-016 回補 README、worker Dockerfile 檔頭與指南 §14／§16，不重寫歷史（§13 為 007 決策背景、無分組名字面，不動） |
| III | 契約優先與型別安全 | ✅ PASS | `packages/contracts` **零變更**——入口拓樸、profile 名、exit code、健康判定屬部署／運維層契約，非跨端通訊 payload，以 [contracts/deployment-runtime.md](./contracts/deployment-runtime.md) 文件化；新增 code（api 關閉路徑、healthcheck）全 strict TS、無 `any` |
| IV | 即時通道紀律 | ✅ PASS | 仍是原生 `ws`、path `/ws`（nginx 僅轉發，不改協定——`proxy_http_version 1.1` + Upgrade 標頭確保穿透）；worker 照舊不直接 emit ws、AI token 仍走 Redis Pub/Sub → Gateway；telemetry 的 rAF 批次提交路徑一行未動 |
| V | AI 診斷紀律 | ✅ PASS | AiProvider／cache-before-API／dedupe lock／`DiagnosisResultSchema.parse()` 路徑零變更。FR-017 的兩項前端改動（無條件的文案改寫、條件性的比對條件補齊）只動 `humanizeError` 這個**呈現層純函式**與其測試，不碰診斷流程、觸發時機或事件流 |
| VI | 祕密與設定衛生 | ✅ PASS | `.dockerignore` 重寫只放行源碼目錄，`**/.env` 排除與 `!**/.env.example` 放行一字不動；三端祕密皆於執行時經 `env_file` 注入；不引入根目錄 `.env`（research D12）；只提交 `.env.example` |
| VII | 資料可追溯性 | ✅ PASS | Mongo 持久化語意不變；seed 沿用既有 `deleteMany` → `insertMany`，不改寫；`down -v` 是展示者刻意的重設動作，非執行期行為 |
| — | 測試門檻（品質門檻） | ✅ PASS | 純函式 vitest：healthcheck 握手判定（收到 `system/connected` vs 其他 envelope vs 畸形字串，T005／T006）、`humanizeError` 文案斷言（T016a 無條件）與映射補齊（T016b 條件性）。api 關閉路徑改以 quickstart 場景 1d 實測驗收（退出碼恆為 0，純函式測試無鑑別力）——憲章要求「至少提供純函式單元測試作為驗收佐證」，由 T006 滿足 |
| — | 可重播驗收（品質門檻） | ✅ PASS | seed 一次性服務使示範資料每次啟動決定性重建；`down -v` → `up` 使全劇本可重跑（SC-005）；quickstart 場景涵蓋 US1–US4 |

**Post-Phase-1 re-check**: 設計產物（data-model、contracts、quickstart）未引入新違反；`packages/contracts` 維持零變更；FR-014 的唯一例外（api 關閉路徑）範圍未擴張，FR-017 的條件性映射補齊已在 spec 明文界定為「不構成例外」。✅ PASS

**無 Complexity Tracking 項目**——本 feature 未違反任何原則，故該節從缺。

## Project Structure

### Documentation (this feature)

```text
specs/008-fullstack-containerization/
├── plan.md              # 本檔（/speckit-plan 輸出）
├── research.md          # Phase 0 輸出（D1–D12 決策）
├── data-model.md        # Phase 1 輸出（服務拓樸、啟動狀態轉移）
├── quickstart.md        # Phase 1 輸出（US1–US4 可重播驗收場景）
├── contracts/
│   └── deployment-runtime.md   # Phase 1 輸出（部署層契約：profile/埠/exit code/健康判定/啟動條件）
├── checklists/
│   ├── requirements.md  # spec 起草期通用品質檢查（已 16/16）
│   └── release-gate.md  # merge 前正式門檻（54 項；T024 的覆核依據）
└── tasks.md             # Phase 2 輸出（/speckit-tasks 產生，非本命令）
```

### Source Code (repository root)

```text
apps/api/
├── Dockerfile                     # 新增：多階段（builder → pnpm deploy --prod → node:22-alpine runtime）
└── src/
    ├── main.ts                    # 修改：bootstrap() 補 enableShutdownHooks() + SIGTERM/SIGINT handler（FR-004）
    ├── healthcheck.ts             # 新增：映像第二進入點——/ws 握手探針（FR-011）
    └── scripts/seed.ts            # 不改：容器內改以 node dist/scripts/seed.js 執行（執行方式差異，非語意變更）

apps/web/
├── Dockerfile                     # 新增：builder（vite build）→ nginx:alpine runtime
├── nginx.conf                     # 新增：靜態伺服 + SPA fallback + /ws、/diagnoses 反向代理（含 ws 升級標頭）
└── src/domains/ai-copilot/lib/
    ├── copilot-reducer.ts         # 修改：(a) 無條件——金鑰文案移除「請聯繫管理員」、改為指名設定項與範本（FR-017 的 MUST NOT）；
    │                              #       (b) 條件性——僅在空金鑰實測落入通用文案時補比對條件（research D11）
    └── copilot-reducer.test.ts    # 修改：同步 (a) 的文案斷言；(b) 若執行則補一則對應測試

apps/worker/
├── src/                           # 不改任何 code
├── Dockerfile                     # 修改：僅檔頭註解第 4 行 --profile supervised → demo（FR-016 回補；建置指令一行不動）
└── .env.example                   # 修改：僅 GEMINI_API_KEY 註解——載明留空時的症狀與成因（FR-017 明文要求「設定範本」）

docker-compose.yml                 # 修改：worker profile supervised → demo（＋補 image:）；新增 web/api/seed 三個 service
.dockerignore                      # 修改：移除 api/web 源碼排除（三映像共用 context）；祕密防線不動
.claude/settings.json              # 修改：17 條 --profile supervised 允許清單改 demo（工具設定，非真實來源；隨 T002 同 commit）
scripts/
├── dev-up.ps1                     # 不改（開發模式入口，FR-007/FR-015）
└── demo-reset.ps1                 # 不改（只清 ai-cache/ai-lock，與 down -v 為不同粒度，research D9）
README.md                          # 修改：雙軌啟動說明 + 全部就緒判讀（FR-011）+ 不應混跑與埠佔用（Edge cases）+ supervised → demo 回補（FR-015/FR-016）
docs/Flow-Gatekeeper-SDD-完整實作指南.md   # 修改：§14 現況落地（FR-016）、§16 啟動說明雙軌化 + 劇本入口（FR-015）
                                   #（§13 不動——通篇為 007 決策背景，無分組名字面，依「不重寫歷史」保留）
```

**Structure Decision**: 沿用既有 pnpm monorepo 佈局（`apps/{api,worker,web}` + `packages/{contracts,shared}`），不新增套件、不新增目錄層級。每個 app 的容器化產物（`Dockerfile`、`nginx.conf`）與該 app 源碼同層——與 007 已建立的 `apps/worker/Dockerfile` 慣例一致；編排維持**單一** `docker-compose.yml`（FR-008：不產生第二份平行的執行模型定義）。

## 實作順序與風險集中點

依 spec 的 P1–P4 優先級交付，但有兩處順序上的硬相依：

1. **`.dockerignore` 必須最先改**（research D4）。它不屬於任何 User Story，卻是 api／web 映像能否建置的前提——不先改，US1 的第一個任務就會失敗，且失敗訊息（找不到源碼）不會直接指向 `.dockerignore`，容易誤判為 Dockerfile 寫錯。
2. **api 優雅關閉（FR-004）須早於 US1 的停止驗收**。沒有它，`down` 會等滿 15s 才 SIGKILL，SC-005 的 ≤ 3s 門檻必不達標。
3. **US1 的驗收拓樸須在 T008 就位、T012 收口**。Phase 3 尚無 web 容器，而 vite dev proxy 的 target 寫死 `localhost:3000`——api 不暫時發佈該埠，US1 的一致性比對根本無從進行（T009 會直接卡住）。故 T008 暫時宣告 `ports: ["3000:3000"]`、T012 移除。**這對相依必須成對執行**：只做前者會殘留一個違反 FR-006 的對外埠。

風險最集中的三點，實作時優先驗證：

- **`/ws` 穿透 nginx**（FR-006／SC-002）：漏掉 `proxy_http_version 1.1` 或 Upgrade 標頭會讓握手退化為一般 HTTP 而失敗。這是整個入口拓樸的單點——先用最小設定把握手打通，再補其餘。
- **nginx 的 upstream 解析**（SC-003／research D1）：字面 hostname 的 `proxy_pass` 會讓 nginx 啟動時解析一次並永久快取，api 重啟換 IP 後即持續轉發到失效位址——症狀與「重啟上限耗盡」同形，極難診斷。以 `resolver` + 變數式 `proxy_pass` 消除，並由場景 2f 實測。
- **空金鑰的實際文案**（FR-017／research D11）：無法由程式碼推斷，只能實測；tasks 須為「補映射」預留條件性任務（T016b），否則驗收當天才發現沒人排它。**注意 T016a（文案移除「請聯繫管理員」）是無條件的**——它由 FR-017 的 MUST NOT 驅動，不因實測命中而免除。

## 待 `/speckit-tasks` 展開時的注意事項

- `nginx:alpine` 的 healthcheck 探測工具需實測確認（busybox `wget` 應在，但未證；research D1 已列退路）。
- api 與 seed 共用同一 `image:` 名稱時，**兩者都要寫 `build:`**——seed 只寫 `image:` 會讓 compose 去 pull 一個不存在的遠端映像（research D7）。
- 重啟上限耗盡的判讀指令（`docker compose ps` / `logs api`）須寫進 quickstart 的**場景 1e**（research D10；`1c` 是崩潰自動重啟，勿與 spec 的 acceptance scenario 編號混用）——這是 clarify 階段被我列為候選、最終未問的一題，已在 research 明文記錄處置，不讓它無聲消失。
