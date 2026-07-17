# Tasks: Full-Stack Containerization & One-Command Demo（整棧容器化與一鍵 Demo）

**Input**: Design documents from `/specs/008-fullstack-containerization/`

**Prerequisites**: plan.md、spec.md（4 user stories）、research.md（D1–D12）、data-model.md、contracts/deployment-runtime.md、quickstart.md（場景 1–4）

**Tests**: 憲章「測試門檻」要求純函式單元測試作為驗收佐證——本 feature 的純函式面很窄（多數產出是編排設定與 Dockerfile），故測試集中在 **health probe 的訊息判定**（T005／T006，門檻的主要承載者）；`humanizeError` 另有兩則異動——**無條件**的文案斷言更新（T016a）與**條件性**的映射補齊測試（T016b，依 T015 實測結果）。api 優雅關閉的退出碼**不硬湊純函式測試**（其結果恆為 0，包一層純函式只是儀式），改以 quickstart 場景 1d 實測 ExitCode 與收尾耗時（≤ 3s）驗收。非全面 TDD。

**Organization**: 依 user story 分 phase。US3／US4 為**純驗證型 story**（能力由 compose profiles 與 `down -v` 內建承接，research D9），無新實作。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1–US4)
- Include exact file paths in descriptions

## Path Conventions

pnpm monorepo：`apps/{api,worker,web}`、`packages/{contracts,shared}`；編排為 repo root 單一 `docker-compose.yml`（FR-008）。`packages/contracts` 本 feature **零變更**。

---

## Phase 1: Setup（共用基礎）

**Purpose**: 建置脈絡的共用前置。**這是全案第一個必做項**——三個映像共用同一份 build context，現行 `.dockerignore` 是為 007 的 worker 單一映像調校的，不改則 api／web 映像必然建置失敗，且錯誤訊息（找不到源碼）不會指向 `.dockerignore`（research D4、plan「實作順序」）。

- [X] T001 重寫 `.dockerignore`：移除 `apps/api/src`、`apps/api/test`、`apps/web/src`、`apps/web/public`、`apps/web/design`、`apps/web/index.html` 六條排除；**祕密防線 `**/.env`、`**/.env.*`、`!**/.env.example` 一字不動**（憲章 VI／SC-006 的機制基礎）；`**/node_modules`、`**/dist`、`.git` 等 context 縮減項維持；改寫頂部註解，消除「與 worker 映像無關的內容」這句已與現況矛盾的敘述

**Checkpoint**: `docker compose --profile demo build` 的 context 已能涵蓋三端源碼（此時尚無 api/web Dockerfile，僅為後續解除阻斷）。

---

## Phase 2: Foundational（阻斷性前置）

**Purpose**: 分組更名——US1 的 api service 要掛 `demo` 分組，故此項須先於所有 user story。**破壞性變更**：007 交付的 `--profile supervised` 指令自此失效（contracts §1）。

- [X] T002 `docker-compose.yml` 的 worker service：`profiles: ["supervised"]` → `["demo"]`，並更新其上方註解中的指令範例（`--profile supervised` → `--profile demo`）；**同時補 `image: flow-gatekeeper-worker:local`**——worker 現況未宣告 `image:`，映像名由 compose 自動生成為 `<專案名>-worker`（專案名預設取目錄名，亦可被 `COMPOSE_PROJECT_NAME` 覆蓋），該名稱不穩定且與 T008／T012 明確宣告的 `flow-gatekeeper-api:local`／`flow-gatekeeper-web:local` 不同形，會使 T022 的祕密衛生驗收（quickstart「祕密衛生驗收」節逐一 `docker run` 三個映像）指令失效。**此為 compose 層宣告，不觸碰 `apps/worker/` 任何 code**（T025 的「worker 源碼零變更」仍成立）
  **同一任務內同步更新 `.claude/settings.json`**：該檔有 **17 條**權限允許清單條目寫死 `docker compose --profile supervised …`（第 16／17／19／24／26／68／76／78／85／87／88／90／91／92／98／100／106 行，計 17 行；以 `Select-String "profile supervised"` 覆核，勿憑數字停手），更名後全部失效，使 Phase 3–6 的每道 demo 指令重新跳權限詢問。**此為工具設定、非專案真實來源**（FR-016 不涵蓋它，故不列入 T020 的回補範圍），但 MUST 與 compose 的更名在**同一個 commit 內**生效——否則中間會出現「compose 已改名、允許清單還沒改」的空窗

**Checkpoint**: `docker compose --profile demo up -d worker` 可起 worker；`docker compose up -d`（不帶分組）仍只起 redis／mongo——SC-004 的機制基礎已就位。

---

## Phase 3: User Story 1 - Gateway 的受監督可部署形態（Priority: P1）🎯 MVP

**Goal**: api（Gateway）具備可部署的受監督容器形態——單一指令啟動、行為與 host 直跑逐項一致、崩潰自動重啟、停止時在寬限期內優雅收尾且不被重啟。**單獨交付即已補上「後果最重的行程無監督」這個缺口**（spec US1「Why this priority」）。

**Independent Test**: quickstart 場景 1a–1g——以 `docker compose --profile demo up -d --build api worker`（**指名服務**，此時 web／seed 尚未建立）起容器化 Gateway，用**現行本機前端**（`pnpm --filter web dev` → `http://localhost:5173`）經 T008 的**暫時 3000 發佈**連上，走一輪遙測／背壓／診斷 streaming／快取命中；`docker kill` 後確認自動重啟且前端可重連；`stop` 後確認 ExitCode 0 且不重啟。示範資料以既有的 `pnpm --filter api seed` 備妥（Phase 3 尚無 seed service；host 端本就需具備 Node／pnpm 才能跑 dev 前端，故無額外前置）——這也讓「與 host 直跑逐項一致」的比對建立在**同一份 seed 資料**上。

### Implementation for User Story 1

- [X] T003 [P] [US1] 新增 `apps/api/Dockerfile`：多階段建置，形狀沿用 [apps/worker/Dockerfile](../../apps/worker/Dockerfile)——`node:22-alpine` builder → `corepack enable` → 先複製 manifests 裝依賴（layer cache）→ 複製 `packages/contracts`、`packages/shared`、`apps/api` 源碼 → 依序 build contracts／shared／api → `pnpm deploy --filter @flow-gatekeeper/api --prod /out` → runtime 階段 `COPY --from=builder /out .`、`USER node`、`CMD ["node", "dist/main.js"]`（research D3）
- [X] T004 [US1] 修改 `apps/api/src/main.ts` 的 `bootstrap()`：補 `app.enableShutdownHooks()`，並註冊 `SIGTERM`／`SIGINT` handler → `await app.close()` → `process.exit(0)`；收尾拋錯時記 log 後**仍以 0 退出**（收尾失敗不是崩潰，非零會被監督者誤判而重啟一個正要停止的服務，contracts §3）。形狀對齊 [apps/worker/src/main.ts](../../apps/worker/src/main.ts#L245-L258)。**範圍紀律**：MUST 僅觸碰關閉路徑，MUST NOT 改動四個既有 `onModuleDestroy` 的內容——本任務只是讓它們第一次真的被執行（FR-004／FR-014、research D5）
- [X] T005 [P] [US1] 新增 `apps/api/src/lib/health-probe.ts`：匯出純函式判定一則 ws 原始訊息是否為 `system/connected`（型別依 `packages/contracts` 既有的 `SystemConnected`，MUST NOT 另寫平行定義，憲章 III）
- [X] T006 [P] [US1] 新增 `apps/api/src/lib/health-probe.test.ts`：涵蓋 `system/connected` 命中、其他 envelope 型別不命中、非 JSON／畸形字串不拋錯（憲章「測試門檻」）
- [X] T007 [US1] 新增 `apps/api/src/healthcheck.ts`（映像第二進入點 → `dist/healthcheck.js`）：以 `ws` 連 `ws://127.0.0.1:${API_PORT ?? 3000}/ws`，收到通過 T005 判定的訊息即 `exit(0)`，逾時／連線錯誤 `exit(1)`。**不需持有 token**——`system/connected` 於連線當下無條件送出，`WS_AUTH_SECRET` 只在 `machine/subscribe` 時檢查（research D6、contracts §5）
- [X] T008 [US1] `docker-compose.yml` 新增 api service：`profiles: ["demo"]`、`build`（context `.`、dockerfile `apps/api/Dockerfile`）、`image: flow-gatekeeper-api:local`、`restart: on-failure:5`、`stop_grace_period: 15s`、`init: true`、`env_file: apps/api/.env`、`environment` 覆蓋 `REDIS_HOST: redis` 與 `MONGO_URL: mongodb://mongo:27017/flow-gatekeeper`、`depends_on: [redis, mongo]`、`healthcheck: ["CMD", "node", "dist/healthcheck.js"]`（`interval 30s`／`timeout 5s`／`retries 3`／`start_period 30s`）。**`15s` MUST NOT 照抄 worker 的 `45s`**（後者為涵蓋 `AI_TIMEOUT_MS` 的 LLM 收尾而算，api 不呼叫 LLM，contracts §4）
  **US1 專用的暫時 `ports: ["3000:3000"]`**：本 phase 尚無 web 容器，US1 的一致性比對須以 host 端 dev 前端連上容器化 Gateway，而 [apps/web/vite.config.ts](../../apps/web/vite.config.ts#L11) 的 proxy target 寫死 `http://localhost:3000`——api 不發佈埠則 host 上無行程在聽、握手必然失敗。此宣告 MUST 附註解標明為 US1 專用，且 **MUST 於 T012 移除**（FR-006：全棧模式下 Gateway MUST NOT 另行對外暴露連接埠）。Phase 3 尚非全棧模式（無 web 入口），故此暫時發佈不構成 FR-006 違反；殘留則構成違反，由 release-gate CHK054 把關
- [ ] T009 [US1] 驗收 quickstart 場景 1a–1g 並記錄結果：一致性比對（遙測／背壓同量級／訂閱過濾／心跳／**認證語意**）、診斷 streaming 與快取命中、**in-process kill**（`docker exec … pkill -KILL -f "dist/main.js"`，非 `docker kill <容器>`——後者為手動停止、不觸發 restart，research D13）自動重啟且前端 ≤30s 重連（SC-003）、`stop` 的 ExitCode 0 且收尾耗時 **≤ 3s**（SC-005 的明文門檻；超過即屬缺陷，MUST NOT 藉調大寬限期或門檻讓驗收通過）、重啟上限耗盡的判讀（`docker compose ps` / `docker inspect` 的 `RestartCount`）、資料層未就緒不卡死、**認證語意實測（場景 1g）**——FR-001 要求逐項一致的六項中，前五項在預設設定下自然被走到，唯獨**認證**不會：[apps/api/.env.example](../../apps/api/.env.example) 的 `WS_AUTH_SECRET` 預設留空，而 Gateway 只在「有設密鑰時」才驗證，故照 quickstart 的預設值跑一輪，容器化後的授權路徑一次都不會被執行。MUST 暫時設定 `WS_AUTH_SECRET` 重起 api 容器實測一次（未帶 token → 拒絕；帶對 token → 可訂閱），驗畢還原留空。**MUST NOT 以「dev 模式已測過」略過**——本任務要證的正是「容器化後該路徑仍一致」

**Checkpoint**: Gateway 已受監督且可部署——崩潰可自癒、停止可優雅收尾。US1 可獨立交付。

---

## Phase 4: User Story 2 - 一鍵起全棧、單一入口走完 demo（Priority: P2）

**Goal**: 展示者以單一指令起完整系統、開單一入口位址走完 demo 劇本，過程不需 Node／pnpm／多終端機。**依賴 US1**（沒有 api 容器就沒有全棧）。

**Independent Test**: quickstart 場景 2a–2f——乾淨環境一鍵啟動、`http://localhost:8080` 見四個賣點、示範資料自動備妥且重複啟動不堆積、非預設埠實測、金鑰留空的行為、demo 拓樸下的崩潰重連與資料保全。

### Implementation for User Story 2

- [X] T010 [P] [US2] 新增 `apps/web/nginx.conf`：靜態伺服 `vite build` 產物 + SPA fallback（`try_files $uri $uri/ /index.html`）+ `/ws` 與 `/diagnoses` 反向代理至 api。**`/ws` MUST 帶 WebSocket 升級標頭**——`proxy_http_version 1.1`、`proxy_set_header Upgrade $http_upgrade`、`proxy_set_header Connection "upgrade"`，並設 `proxy_read_timeout 3600s`（移除與 dev 模式不一致的隱形計時器，research D1）。**這是入口拓樸的單點故障處：先用最小設定把握手打通，再補其餘**（plan「風險集中點」）。
  **upstream MUST 以變數式 `proxy_pass` 搭配 `resolver` 宣告**——`resolver 127.0.0.11 valid=10s ipv6=off;`（Docker 內建 DNS）＋ `set $api_upstream api:3000;` ＋ `proxy_pass http://$api_upstream;`。理由：`proxy_pass http://api:3000;` 這種**字面 hostname 寫法會讓 nginx 在啟動時解析一次並永久快取**，api 容器崩潰重啟後若取得不同 IP，nginx 會持續轉發到失效位址，症狀是「web 入口載入正常、通道永遠連不上」——**直接讓 SC-003 失敗，且與重啟上限耗盡的症狀同形、極難診斷**（research D1「upstream 解析」）。`proxy_pass` 後**不接 URI 路徑**（`http://$api_upstream;` 而非 `http://$api_upstream/;`），以保留原始請求 URI 不被改寫。由 T014 的場景 2f 實測驗證
- [X] T011 [P] [US2] 新增 `apps/web/Dockerfile`：builder 階段同 T003 形狀（build contracts／shared／web）→ runtime 階段 `nginx:alpine`，`COPY --from=builder /repo/apps/web/dist /usr/share/nginx/html` 與 `apps/web/nginx.conf`。**web 產物為純靜態檔，不需 node runtime 與 `pnpm deploy` 裁剪**（research D3）
- [X] T012 [US2] `docker-compose.yml` 新增 web service：`profiles: ["demo"]`、`build`、`image: flow-gatekeeper-web:local`、`ports: ["8080:80"]`（**唯一對外入口**，避開 dev 的 5173／3000，research D2）、`restart: on-failure:5`、`depends_on: [api]`、`healthcheck`（HTTP 探測入口位址）。**實測確認 `nginx:alpine` 的探測工具存在**——預期 busybox `wget`（`wget -q --spider http://127.0.0.1/`）；若不存在改用 `nc -z` 或 nginx `stub_status`（research D1 待驗證項）。
  **同時 MUST 移除 T008 的 US1 專用暫時 `ports: ["3000:3000"]`**（含其註解）——web 容器一旦存在，`8080` 即為唯一對外入口，api 的暫時發佈同時失去理由並違反 FR-006。移除後 US1 的一致性比對改由 8080 入口涵蓋（quickstart 場景 2b）。此為 FR-006 的收口點，MUST NOT 遺留（release-gate CHK054）
- [X] T013 [US2] `docker-compose.yml` 新增 seed service：`profiles: ["demo"]`、**與 api 同 `build:` 與同 `image: flow-gatekeeper-api:local`**（只寫 `image:` 會讓 compose 去 pull 不存在的遠端映像，research D7）、`command: ["node", "dist/scripts/seed.js"]`、`restart: "no"`、`env_file: apps/api/.env`、`environment` 覆蓋 `MONGO_URL`、`depends_on: [mongo]`；並為 api service 補 `depends_on: seed: { condition: service_completed_successfully }`。**`apps/api/src/scripts/seed.ts` 一行不改**——容器內改以建置產物執行是執行方式差異，非語意變更（FR-012）
- [ ] T014 [US2] 驗收 quickstart 場景 2a–2d **與 2f** 並記錄結果：一鍵啟動（SC-001：1 指令／1 位址／不需語言執行環境）、**「全部就緒」的複合訊號判讀**（FR-011：`docker compose ps -a`（`-a` 不可省，否則已 exited 的 seed 不會列出）對照 seed `exited(0)` → api `healthy` → web `healthy` → worker `healthy` 四項全成立；此為 FR-011「讓展示者能辨識可開始 demo 的時點」的使用者面，MUST NOT 只驗 healthcheck 機制存在）、四個賣點在單一入口下重現（SC-002）、**靜態伺服的一致性**（FR-002：重整後 Network 面板無 404、與 dev 模式逐區塊視覺比對、未知路徑回 index.html 而非 nginx 404——四個賣點「可見」驗不到這一層）、seed 自動備妥且重複啟動不堆積、**非預設入口埠實測**（改 `ports` 為 9090:80 後前端仍能連上；MUST 實測不得推論）；**場景 2f——在 demo 拓樸下重做一次崩潰重啟**：`docker kill` api 後確認經 `8080` 入口的通道 ≤30s 自行重連（SC-003）、無持續 502（nginx upstream 解析復原）、示範資料未被重置且 seed 未重跑（US2 場景 5／CHK044）。**MUST NOT 以場景 1c 的結果代替**——1c 的路徑是 dev 前端直連 api，不經 nginx，而 SC-003 要保證的是展示者在 demo 當下看到的行為（該路徑穿過反向代理，是 1c 完全沒驗到的一段）
- [ ] T015 [US2] 驗收 quickstart 場景 2e（FR-017）：**真的把 `apps/worker/.env` 的 `GEMINI_API_KEY` 留空**跑一次完整路徑，記錄畫面實際文案。確認全棧照常啟動、遙測與背壓正常（2/4 賣點可見）、診斷失敗且訊息**指名金鑰**。**MUST NOT 以無效金鑰的結果推斷**——空金鑰與無效金鑰的供應商回應未必相同（research D11）
- [X] T016a [US2] **無條件任務**（不依賴 T015 結果）：改寫 [copilot-reducer.ts:77](../../apps/web/src/domains/ai-copilot/lib/copilot-reducer.ts#L77) 金鑰條目的**文案**——現行「AI 服務金鑰無效或未授權，**請聯繫管理員**。」直接違反 FR-017 的 **MUST NOT「假設使用者另有管理員可聯繫」**（demo 的評估者自己就是管理員，叫他聯繫管理員等於什麼都沒說）。改為指名應填的設定項與其所在範本，使自助使用者可行動（FR-017 的 SHOULD），例如「AI 服務金鑰無效或未授權——請確認 `apps/worker/.env` 的 `GEMINI_API_KEY` 已填入有效金鑰（範本見 `apps/worker/.env.example`）。」；同步更新 [copilot-reducer.test.ts:146](../../apps/web/src/domains/ai-copilot/lib/copilot-reducer.test.ts#L146) 既有斷言的預期字串。**範圍紀律**：僅改**呈現層文案字串**與其測試斷言，MUST NOT 動比對條件（`hay.includes(...)` 那串）、觸發時機、重試次數或事件流——文案不是執行語意，故不觸及 FR-014
- [X] T016b [US2] **條件性任務**（僅在 T015 實測落入通用文案「診斷失敗，請重試。」時執行）：於 [copilot-reducer.ts:76](../../apps/web/src/domains/ai-copilot/lib/copilot-reducer.ts#L76) 的金鑰條目**比對條件**補上實測到的錯誤字串（讓空金鑰的供應商回應也能命中該條目），並於 `copilot-reducer.test.ts` 補一則對應測試。**此屬既有映射的覆蓋缺口修復，非 FR-014 例外**（spec FR-014「不構成例外者」）；MUST NOT 藉此擴張為新的檢查機制。若 T015 已命中金鑰條目，本任務標記為「不需執行」並記錄實測文案。**與 T016a 的分工**：T016a 改的是命中後「說什麼」（無條件），T016b 改的是「能不能命中」（依實測）
  > **實測結果（008 implement，已執行）**：空金鑰下 Gemini 回 `[403 Forbidden] Method doesn't allow unregistered callers … Please use API Key or other form of API consumer identity …`。此句**不落入通用文案**，而是因含 `Error **fetch**ing` 誤命中**網路分支**（回「無法連線 AI 服務」）——結果與起草時的預測（落入「診斷失敗」）不同，但同樣**沒指名金鑰**、同樣違反 FR-017，故修法一致：於金鑰條目補 `hay.includes("unregistered")`（該 token 為缺金鑰/身分的精確特徵，且金鑰分支在網路分支之前檢查）。已補對應單元測試（用實測原文）。**MUST NOT 以無效金鑰結果推斷**這條的必要性已由實測坐實。

**Checkpoint**: 一鍵 demo 成立——單一指令、單一入口、四個賣點可重現。

---

## Phase 5: User Story 3 - 開發模式零影響（Priority: P3）

**Goal**: 開發者日常迴圈完全不受影響。**純驗證型 story**——零回歸由 compose profiles 的機制保證，非靠紀律（research D8），故無新實作。

**Independent Test**: quickstart 場景 3。

- [ ] T017 [US3] 驗收 quickstart 場景 3 並記錄結果：`docker compose up -d`（不帶分組）後 `docker compose ps` **只有 redis／mongo**（SC-004：服務清單與本 feature 之前完全相同）；`./scripts/dev-up.ps1` 後改一行前端與一行後端 code，確認熱重載行為與本 feature 之前一致、步驟數不變；從 demo 模式切回開發模式**不需額外清理步驟**。**同時確認 T004 的已知副作用**——開發模式 Ctrl-C 現在會走優雅關閉，須確認對 dev 迴圈無可觀察影響（research D5）

**Checkpoint**: 開發體驗零回歸已驗證。

---

## Phase 6: User Story 4 - 乾淨收場與可重播（Priority: P4）

**Goal**: 單一指令停止全棧、可重設回初始狀態並重跑劇本。**純驗證型 story**——能力由 compose `down`／`down -v` 內建承接，`demo-reset.ps1` 不改（research D9），故無新實作。

**Independent Test**: quickstart 場景 4a–4b。

- [ ] T018 [US4] 驗收 quickstart 場景 4a–4b 並記錄結果：`down` 後所有服務在各自寬限期內結束、`netstat` 確認 **0 個殘留行程佔用 8080**（SC-005）；`down -v` → `up` 後 volume 清空、seed 重跑、系統回到初始狀態、**同一份劇本可重跑並得到同等結果**；確認 `demo-reset.ps1`（只清 `ai-cache:*`／`ai-lock:*`）在 demo 模式下仍可用且與 `down -v` 粒度不同

**Checkpoint**: demo 可反覆演練（憲章「可重播驗收」門檻）。

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: 跨 Feature 回補、文件雙軌化、全案品質門檻與總驗收。

- [ ] T019 [P] 更新 **`README.md` 與設定範本**（FR-015／FR-011／FR-017）：
  1. **`README.md` 啟動說明改雙軌**（FR-015）：開發模式（`docker compose up -d` → `./scripts/dev-up.ps1`，web 5173／api 3000）vs 一鍵 demo（`docker compose --profile demo up -d --build` → `http://localhost:8080`），**各自成段標示用途、指令與前置需求**；demo 段須列明前置為「容器執行環境 + repo + 複製兩份範本並填 `GEMINI_API_KEY`」（research D12）、預告首次建置需數分鐘、並載明金鑰未填時的症狀與成因（FR-017）。
  2. **README demo 段須含「全部就緒」的判讀方式**（FR-011）：`docker compose ps -a`（`-a` 不可省——seed 完成後即 exited，預設不列出）對照四項複合訊號（seed `exited(0)` → api `healthy` → web `healthy` → worker `healthy`），並註明 api 的 `start_period` 30s 內顯示 `starting` 屬正常。**這是 FR-011 明文要求的使用者面**——「讓展示者能辨識可開始 demo 的時點，而非只能靠肉眼猜測」；healthcheck 只提供機制，不提供辨識，判讀方式不寫進 README 則該義務無人承接。
  3. **README demo 段須載明兩則 Edge case 的處置**（spec Edge Cases「同時啟動兩種模式」「連接埠被佔用」——前者明文要求「**文件需說明不應混跑**」，後者要求「啟動失敗需可診斷，且不得污染既有的開發模式流程」。**analyze 發現此兩則原無任何任務承接**——quickstart 場景 3 雖有一句提醒，但展示者只讀 README（SC-007），看不到 quickstart）：
     - **不應混跑**：開發模式與 demo 模式 MUST NOT 同時啟動——`redis`／`mongo` 為兩模式共用，資料層會互相干擾（`8080` 與 `5173`／`3000` 雖不互撞，但那不是安全的理由）。切換時先 `docker compose --profile demo down` 再走另一軌。
     - **埠被佔用**：`8080`（或 `6379`／`27017`）已被 host 上其他行程佔用時，compose 會以 **bind 失敗訊息指名該埠**中止，改 `docker-compose.yml` 的 `ports` 一行即可（可攜性由同源相對路徑保證，見 2d）。**MUST NOT 為此新增任何前置檢查機制**——診斷資訊由 compose 原生錯誤承接即已足夠（ADR-002 不造輪子）；此為 release-gate CHK037 的判定依據
  4. **更新 `apps/worker/.env.example` 的 `GEMINI_API_KEY` 註解**（FR-017 明文：「`README.md` **與設定範本** MUST 載明此症狀與其成因」）：現行只寫「留空則診斷會走 ai/error」——那是技術語，不是展示者看得懂的症狀。改為載明**症狀**（全棧照常啟動、遙測與背壓正常，僅 AI 診斷失敗且畫面訊息指名金鑰）與**成因**（本專案刻意不擋啟動，讓沒有 Gemini 帳號的評估者仍看得到 2/4 賣點）。**MUST NOT 改變該檔的任何變數值或形狀**——僅動註解
- [ ] T020 [P] `supervised` → `demo` 更名回補（FR-016）：`README.md`（受監督模式指令一帶，**431／432／448 行**）與 **[apps/worker/Dockerfile:4](../../apps/worker/Dockerfile#L4)** 的檔頭註解（`docker compose --profile supervised up -d --build`——該句敘述的是「**現在**怎麼建置這個映像」，屬**現況描述**而非歷史敘述，更名後即為殘留的錯誤指令）。**MUST NOT 重寫歷史**——007 的決策背景保留原敘述，僅更新現況描述（必要時標註「已更名為 `demo`，現況見 §14」）。
  **全域搜尋已於 analyze 階段執行完畢**（release-gate CHK048），`supervised` 字面的全部出處與處置如下，回補時逐一核對即可：

  | 出處 | 處置 | 由誰 |
  |---|---|---|
  | `docker-compose.yml`（第 20 行 profile 宣告 + 第 18 行註解） | 更名 | T002 |
  | `.claude/settings.json`（**17 條**允許清單） | 更名（工具設定，非真實來源） | T002 |
  | `README.md`（431／432／448） | 更名 | 本任務 |
  | `apps/worker/Dockerfile:4`（檔頭註解） | 更名 | 本任務 |
  | 指南 §14（第 2904 行殘留 `--profile full`）、§16（啟動說明） | 更新現況／雙軌化 | **T021** |
  | 指南 §13 | **不動**（見下） | — |
  | `specs/007-*/`（plan／research／tasks／quickstart／contracts） | **不動** | — |

  **指南 §13 為何不動（analyze 修正）**：起草時列為更名標的，但全域搜尋確認**指南全檔 0 處** `supervised`——§13 通篇是 007 的決策背景與待決問題（第 2793 行仍寫「compose profile？獨立 script？」），分組名是 007 實作期才定的，從未寫回 §13。**無標的可更名**，且它正是 FR-016 明文保護的「決策背景」。**MUST NOT 為了讓本任務有事可做而在 §13 補寫現況敘述**——指南的現況面由 §14／§16 承接（T021）。spec FR-016 與 research D8 的列舉已同步校正。
  **`specs/007-*` 為何不動**：那是 007 當時的決策紀錄與已結案工件，屬 FR-016 明文保護的「歷史」——改它就是重寫歷史。`ADR-002`、`asyncapi.yaml`、`.env.example` 經搜尋**未出現** `supervised`，無需回補
- [ ] T021 [P] 更新 `docs/Flow-Gatekeeper-SDD-完整實作指南.md` 的 **§14 與 §16** 兩章（FR-016／FR-015）：

  1. **§14 → 現況已落地**（FR-016）。**MUST 於 008 實作完成、驗收通過後才寫**——本章要翻成「現況」，而現況在 T003–T018 跑完前並不存在（CHK043／CHK044／CHK054 三項 `[須實作後判定]` 未定案前，任何「已落地」敘述都是憑空發明，違反憲章 II）。逐項處置如下（**analyze 覆核指南全文所得，MUST 逐條核對，勿只改點名的那兩行**）：

     | 位置 | 現行內容 | 處置 |
     |---|---|---|
     | 第 2882 行 | 「狀態：**方向藍圖（尚未 `/speckit.specify`）**」 | 改為「已落地」＋指向 `specs/008-fullstack-containerization/`（形狀對齊 §13 第 2692 行的 007 標記） |
     | 第 2900–2901 行 | api service「…、**port 映射**」 | **與 FR-006 正面矛盾**——終態為 api **不宣告 `ports`**，瀏覽器只面對 web 的 `8080`。MUST 改寫 |
     | 第 2902 行 | web「伺服方式見 14.3 clarify」 | 已定案：`nginx:alpine`（靜態 + 同源反代），改為現況 |
     | 第 2904 行 | `docker compose --profile **full** up -d`（命名見 clarify） | 更正為 `--profile demo`——`full` 是起草期暫定名、**從未存在過**，留著即為指向不存在分組的錯誤指令 |
     | 第 2905–2906 行 | 「瀏覽器端用 host port，**WS/API URL 的注入方式**要一致且文件化」 | 同源相對路徑後**無位址可注入**，前提已消失。改為現況（前端產物不內嵌後端絕對位址，FR-009） |
     | 第 2916–2925 行（§14.3） | 四題「待 clarify」 | **四題全已答**（1. nginx／2. 無需注入（見 CHK052）／3. 單一 `demo` 分組、worker 在內／4. 一次性 seed 服務）。MUST 逐題標註定案結果與出處，**第 2 題須明文標記「已失去適用前提」**（release-gate CHK052） |
     | 第 2927–2933 行（§14.4） | 驗收（初步），含 `--profile <name>`、`localhost:<port>` 佔位 | 以實際值收斂（`--profile demo`、`http://localhost:8080`），或標註實際驗收以 spec SC-001–SC-007 為準 |

     **MUST NOT 重寫歷史**：§14.1「為什麼要有這個 feature」與「明確不做」屬決策背景，保留原敘述（必要時改過去式）。
  2. **§16「本機啟動與端到端 Demo」→ 啟動說明雙軌化**（**FR-015 明文：「`README.md` 與實作指南的啟動說明 MUST 更新為雙軌」**；analyze 發現此章原本無任何任務承接）：
     - §16 開頭（第 3006 行）的預告「**Feature 008 完成後，本章會補上「一鍵 demo」路徑**」是該章自陳的義務，本任務即為其兌現點——MUST 改為現況敘述，不再是預告。**§14.2 第 2907 行更把它列為 008 的「要做」項**（「文件更新：README 與本指南 §16 的啟動說明改為雙軌」）——義務是指南自己記下的，008 的 tasks 起草時漏接，由 analyze 補回。
     - 現行 §16.1「第一次啟動」的四終端機流程屬**開發模式**，MUST 明確標示為該軌並保留（FR-007／FR-015：既有開發模式入口不動）；另起一軌寫一鍵 demo（`docker compose --profile demo up -d --build` → `http://localhost:8080`），用途、指令、前置需求各自成段（SC-007）。
     - **§16.2 demo 劇本第 1 步「開 `http://localhost:5173`」MUST 標明兩軌入口**（dev `5173`／demo `8080`）——**SC-002 正是以本節的「4 個賣點」為驗收標的**，劇本若只寫 dev 位址，SC-002 要求的「4 個賣點 100% 可在單一入口位址下重現」在指南層無據可依。
     - 劇本第 11 步「暫停 worker」等操作在 demo 模式下的等價指令（`docker compose --profile demo stop worker`）SHOULD 一併標註。
     - **若 §16 補入「Gateway 崩潰自癒」的故障演練橋段**（§16 開頭已預告 007／009 的「死而復生」敘事），其崩潰指令 MUST 用 **in-process kill**（`docker exec flow-gatekeeper-api-1 pkill -KILL -f "dist/main.js"`），MUST NOT 用 `docker kill <容器>`——後者是手動停止、不觸發 restart policy（research D13，implement 期實測）。
     - **MUST NOT 重寫 §16 的既有 dev 流程或劇本步驟語意**——只做「標明是哪一軌」與「補上另一軌」，劇本的 11 個步驟本身不動（FR-014）。

  **與 T020 的分工**：T020 只處理 `supervised` 字面的更名（README／worker Dockerfile 檔頭），**指南全檔一律由本任務處理**——經 analyze 校正後兩者已無共同檔案，故 `[P]` 成立
- [ ] T022 祕密衛生驗收（SC-006／憲章 VI）：以 quickstart「祕密衛生驗收」節的指令確認 **api／worker／web 三個映像**內祕密數皆為 0；`git status --porcelain` 確認設定範本以外的祕密檔案未進版控
- [ ] T023 文件驗收（SC-007）：請一位未跑過本專案的人**只讀 `README.md`**，確認能在不詢問任何人的前提下正確選出模式並完成啟動；確認全案無殘留 `supervised` 分組的現況敘述
- [ ] T024 覆核 [checklists/release-gate.md](./checklists/release-gate.md) 全部 54 項並逐項勾選；**含三項 [須實作後判定]**（CHK043 `nginx:alpine` 探測工具、CHK044 `depends_on` 不因 restart 重新求值、CHK054 api 的暫時 `ports` 已移除）。任一項未過即不得 merge，或須就地明文記錄接受理由
- [ ] T025 全案品質門檻：`pnpm check`（contract lint + typecheck + lint + test）全綠；確認 `packages/contracts` **零變更**（憲章 III）、**`apps/worker/` 源碼與建置行為零變更**——worker 在本 feature 的異動僅限三處，皆不觸碰其執行語意或監督參數：
  1. `docker-compose.yml` 的分組名 `supervised` → `demo`（T002，編排層）；
  2. `docker-compose.yml` 新增 `image: flow-gatekeeper-worker:local`（T002，編排層）；
  3. `apps/worker/Dockerfile:4` 的**檔頭註解**更名（T020，FR-016 回補）——**只動註解、不動任何建置指令**，映像產物逐 byte 相同；
  4. `apps/worker/Dockerfile:26` 的**行內註解**更正（T001 實作期補）——原文「api/web 源碼已被 `.dockerignore` 排除、不進 context」在 T001 執行後即為**假敘述**（三映像共用 context，api/web 源碼自此在場）。改為「只複製 worker 建置鏈需要的源碼（api/web 源碼自 008 起也在 context 中，本映像不取用）」。**只動註解**，`COPY` 指令一字未改，映像產物逐 byte 相同（已實測 worker 映像照常建置）。
  **判定準則**：`git diff` 的 `apps/worker/` 若出現註解以外的任何變更（`src/`、建置階段、`CMD`、healthcheck），即為違反本門檻
- [ ] T026 勾選本檔與 [checklists/requirements.md](./checklists/requirements.md)，確認 tasks／checklist／spec 三者一致，準備 merge 回 `develop`（`--no-ff`，憲章 I）

---

## Dependencies & Execution Order

### Phase Dependencies

```text
Phase 1 (Setup: .dockerignore)          ← 全案第一個必做項，阻斷 T003/T011
    ↓
Phase 2 (Foundational: profile 更名)     ← 阻斷 T008/T012/T013
    ↓
Phase 3 (US1: Gateway 受監督) 🎯 MVP     ← 可獨立交付
    ↓
Phase 4 (US2: 一鍵全棧)                  ← 依賴 US1（沒有 api 容器就沒有全棧）
    ↓
Phase 5 (US3: dev 零影響)                ← 依賴 T004（須確認關閉路徑副作用）
    ↓
Phase 6 (US4: 乾淨收場)                  ← 依賴 US2（須有全棧才能驗停止/重設）
    ↓
Phase 7 (Polish)                        ← 依賴全部
```

### User Story Dependencies

- **US1（P1）**：只依賴 Setup + Foundational。**單獨交付即補上核心缺口**（Gateway 無監督）。
- **US2（P2）**：依賴 US1。
- **US3（P3）**：技術上隨時可驗，但排在 US2 後可一併確認「兩模式不互相干擾」（spec US3 場景 3）。
- **US4（P4）**：依賴 US2。

### 順序上的硬相依（plan「實作順序與風險集中點」）

1. **T001（`.dockerignore`）MUST 最先**——不改則 T003／T011 的映像建置必然失敗，且錯誤訊息不會指向 `.dockerignore`，容易誤判為 Dockerfile 寫錯。
2. **T004（優雅關閉）MUST 早於 T009 的停止驗收**——沒有它，`stop` 會等滿 15s 才 SIGKILL，SC-005 必不達標。
3. **T016b 條件性依賴 T015 的實測結果**——不得跳過 T015 直接推斷。**T016a 無此相依**（它由 FR-017 的 MUST NOT 驅動，與實測結果無關），MUST NOT 因 T015 命中金鑰條目就連帶跳過 T016a。
4. **T008 的暫時 `ports: ["3000:3000"]` 與 T012 的移除 MUST 成對**——前者是 T009 能否進行的前提（無它則 host dev 前端連不上容器化 Gateway，US1 驗收直接卡住）；後者是 FR-006 的收口（web 容器存在後，8080 為唯一對外入口）。只做前者會**殘留一個違反 FR-006 的對外埠**，且因 demo 照跑不誤而不會被任何驗收自然攔下——故由 release-gate CHK054 明文把關。
5. **T010 的 `resolver` + 變數式 `proxy_pass` MUST 早於 T014 的場景 2f**——字面 hostname 的 `proxy_pass` 會使 api 重啟後的重連在 nginx 層失敗（SC-003），而其症狀與「重啟上限耗盡」同形，先做設定可免去一輪誤判。

### Parallel Opportunities

- **T003 ∥ T005 ∥ T006**（US1）：Dockerfile、純函式、測試三者不同檔、互不相依。
- **T010 ∥ T011**（US2）：nginx.conf 與 Dockerfile 可並行起草，但 T011 的驗證需 T010 就位。
- **T019 ∥ T020 ∥ T021**（Polish）：README 雙軌、更名回補、指南 §14／§16 三者可並行——**T021 是唯一動指南的任務**（analyze 校正後 T020 已不涉指南），故 T021 與另兩者無檔案交集。**唯一的衝突點仍是 T019 與 T020 同動 `README.md`**，保守做法為 T019 → T020 串行。
- **T004 與 T008 不可並行**——T008 的 `stop_grace_period` 驗收前提是 T004 已就位。

---

## Implementation Strategy

**MVP = Phase 1 + Phase 2 + Phase 3（US1）**。此時 Gateway 已受監督、可部署、可自癒，「後果最重的行程無人看管」這個 ADR-002 §5.1 點名的缺口即已補上——即使 US2 不交付，價值已成立。

**漸進交付**：每個 phase 完成後即 commit（憲章「Phase 化可追溯遞交」）。Phase 3／4 更動範圍較大，SHOULD 依主要開發大項拆成數個 commit（例如 Phase 3 可拆「api 映像」「優雅關閉」「健康探針」「compose api service」），使 git 歷史能還原建置順序。

**風險前置**：Phase 4 的 T010（nginx `/ws` 穿透 + upstream 延後解析）是整個入口拓樸的單點——建議一進 Phase 4 就先把握手打通再補其餘設定，不要等到 T014 驗收才發現。

**收口提醒**：Phase 3 為 US1 驗收暫時發佈的 api `3000` 埠，**MUST 在 T012 隨 web 容器交付一併移除**（硬相依 4）。這是全案唯一一處「刻意先違反終態、稍後收回」的安排——把它留到 Polish 才想起來就太晚了，因為屆時 demo 已能正常運作，沒有任何症狀會提醒你它還在。
