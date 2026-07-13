# Tasks: Worker Process Supervision（worker 生產化與 process 監督）

**Input**: Design documents from `/specs/007-worker-process-supervision/`

**Prerequisites**: plan.md、spec.md（5 user stories）、research.md（D1–D9）、data-model.md（E1–E4）、contracts/supervision-runtime.md、quickstart.md（場景 1–6）

**Tests**: 憲章「測試門檻」要求純函式單元測試（fatal 訊息格式化、chaos 解析、heartbeat 新鮮度）——已納入對應 story；非全面 TDD。

**Organization**: 依 user story 分 phase；US4 為純驗證型 story（防護能力由 Docker 內建承接，見 research D4）。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 可平行（不同檔案、無未完成依賴）
- **[Story]**: 對應 spec.md 的 US1–US5
- 每個任務附確切檔案路徑

## Path Conventions

pnpm monorepo（`apps/{api,worker,web}`、`packages/{contracts,shared}`）；本 feature 變更集中於 `apps/worker/` 與 repo 根層（`docker-compose.yml`、`.dockerignore`、`README.md`），依 plan.md Project Structure。

---

## Phase 1: Setup（共用基礎）

**Purpose**: 建置脈絡的共用前置——`.dockerignore` 是 Dockerfile 的先決（build context 為 repo root），也是憲章 VI 的守門（`.env` 不得進 image）。

- [X] T001 建立根目錄 `.dockerignore`：排除 `**/node_modules`、`.git`、`**/.env`（僅允許 `.env.example`）、`**/dist`、`apps/web`、`docs`、`specs`、`.codegraph` 等非建置必需內容（research D2、憲章 VI）

---

## Phase 2: Foundational（阻斷性前置）

本 feature 無跨 story 的阻斷性基礎工作——監督能力由 Docker/compose 承接（零新增依賴），各 story 的 lib 模組（fatal/chaos/heartbeat）分屬各自 phase 以維持獨立可測。Setup 完成即可進入 user stories。

---

## Phase 3: User Story 1 - 受監督的可部署執行形態（Priority: P1）🎯 MVP

**Goal**: worker 有可部署的容器形態：單一指令建置＋啟動（profile 附加式），端到端行為與直跑一致，優雅關閉照舊；開發模式零影響。**本 phase 不改任何行為語意**（handler 翻轉在 US2）。

**Independent Test**: quickstart 場景 1（端到端一致）、場景 2（優雅關閉 ExitCode 0）、場景 6（dev 零影響）。

### Implementation for User Story 1

- [X] T002 [US1] 建立 `apps/worker/Dockerfile` 多階段建置：builder（`node:22-alpine` + corepack pnpm → `pnpm install --frozen-lockfile` → build `contracts`/`shared`/`worker` → `pnpm deploy --filter worker --prod`）→ runtime（僅 COPY 裁剪產物、`CMD ["node","dist/main.js"]`）（research D1/D2）
- [X] T003 [US1] `docker-compose.yml` 新增 worker service：`profiles: ["supervised"]`、`build`（context repo root）、`depends_on: [redis, mongo]`、`restart: on-failure:5`、`init: true`（tini 為 PID 1、node 為子行程——同 namespace 對 PID 1 送 SIGSTOP 會被核心忽略，US5 活鎖演練需凍結 node 子行程）、`stop_grace_period: 45s`、`env_file: apps/worker/.env`、`environment` 覆蓋 `REDIS_HOST=redis`／`MONGO_URL=mongodb://mongo:27017/flow-gatekeeper`（healthcheck 區塊留待 US5 的 T023）（data-model E1、contracts §2）
- [X] T004 [P] [US1] `README.md` 新增「雙模式」章節：開發／受監督模式的使用情境、切換指令表（contracts §6）、兩模式不併行運行的注意事項（避免雙 consumer 搶 job）、dev 模式致命錯誤差異的預告（FR-010）
- [X] T005 [US1] 建置與雙指令驗證：`docker compose --profile supervised up -d --build` 成功啟動且 log 出現 `worker ready`；`docker compose up -d`（無 profile）維持只起 redis/mongo（SC-008 機制面）
- [X] T006 [US1] 依 `specs/007-worker-process-supervision/quickstart.md` 場景 1、2、6 驗收：端到端一致（串流／快取／錯誤語意）、優雅關閉（ExitCode 0、45s 內收尾）、dev 流程零影響（`scripts/dev-up.ps1` 照常）。注意：本階段 healthcheck 尚未加入（T023），`docker ps` 只顯示 `Up`——`Up (healthy)` 待 US5 交付後才出現
  - **驗收證據（2026-07-08/09）**：場景 1 ✅——受監督 worker 端到端消化（`job active → LLM call → job completed`）；ai/token 串流經 `ai-stream:*` 訂閱實收（單筆 job tokens=12、內容為結構化診斷 JSON、`ai/done cached:false`）；同簽章重觸發 `cache hit` 不重打 LLM（另見：狀態改變→簽章不同→正確重算；TTL 600s 過期→正確重算）。場景 2 ✅——`stop worker` → `received SIGTERM` → ExitCode 0、秒級收尾、未重啟。場景 6 ✅——無 profile 指令只起 redis/mongo；seed／api `start:dev`／worker `start:dev`（tsx watch → `worker ready`）照常，`dev-up.ps1` 零改動。備註：驗收期間發現「host 端背景行程的 Redis 訂閱連線會被靜默斷線」為本機環境怪癖（前景行程正常），與 app 無關

**Checkpoint**: 受監督形態可獨立交付——行為與直跑一致、可優雅停啟、dev 不受影響。

---

## Phase 4: User Story 2 - 致命錯誤後系統自我復原 let it crash（Priority: P1）

**Goal**: 翻轉崩潰語意——致命錯誤記 log 後立即 `exit(1)`，監督者自動重啟乾淨行程，in-flight／佇列 job 最終被重新消化。**依賴 US1（監督者就位才可合併此翻轉，spec「兩半」論）**。

**Independent Test**: 行程非正常終止（本 phase 以 `docker kill` 模擬）→ 自動重啟＋job 重派；完整「致命注入」重演於 US3 交付旗標後以 quickstart 場景 3 補齊。

### Implementation for User Story 2

- [X] T007 [P] [US2] 建立 `apps/worker/src/lib/fatal.ts`：`formatFatal(kind, value)` 純函式（格式 `<kind>（致命，worker 將結束交由監督者重啟）：<detail>`；Error 取 `stack ?? message`、非 Error 一律 `String(value)`）＋ `fatal()` helper（log error → `process.exit(1)`）（contracts §5、research D7）
- [X] T008 [P] [US2] 建立 `apps/worker/src/lib/fatal.test.ts`：Error（有 stack）／Error（無 stack 取 message）／非 Error 值（字串、數字、undefined）的格式化決定性（憲章測試門檻）
- [X] T009 [US2] 修改 `apps/worker/src/main.ts`：`unhandledRejection`／`uncaughtException` handler 改為呼叫 `fatal()`；**移除**「暫時策略（log + 續跑）」的整段註解但書，改為指向新語意與 supervision 契約；優雅關閉路徑（SIGTERM/SIGINT → close → `exit(0)`）不動；順帶核對既有 `bootstrap().catch`（`bootstrap failed: <detail>` → `exit(1)`）已符 FR-003 的 bootstrap 致命語意——不套 `formatFatal`、沿用既有格式（contracts §5）（FR-003、FR-011、research D7）
- [X] T010 [P] [US2] 收斂 `docs/Flow-Gatekeeper-SDD-完整實作指南.md` 中「log + 續跑為暫時策略」的但書描述（§13 由來段落保留歷史敘述、但現況描述更新為已翻轉）（FR-011）
- [X] T011 [US2] 重啟與重派驗證：受監督模式下以 `docker kill <worker>` 模擬行程非正常終止 → Docker 自動重啟、log 判讀「終止 → ready」先後；崩潰當下 in-flight job 於 lock 過期＋stalled 掃描後被重新消化或走 `ai/error` 終態（quickstart 場景 3 步驟 4–5 的語意；research D9）
  - **驗收證據（2026-07-09）與修正**：①重要發現——`docker kill`（容器級）屬**手動停止操作**，Docker 對手動 stop/kill 不套用 restart policy（實測 exited、RestartCount=0、不重啟）；正確的「行程非正常死亡」模擬是殺**容器內** node 行程：`docker exec <worker> sh -c 'kill -KILL $(pgrep -f "dist/main.js")'`（tini 以子行程退出碼收場→容器自行退出→on-failure 生效）。②自動重啟 ✅：容器內 SIGKILL node → RestartCount=1、數秒內 `bootstrapped → worker ready`（timestamps 可判讀先後）。③in-flight 重派 ✅：處理中（LLM call 已記）被 kill 的 job，worker 回來後 ~60s 由 stalled 掃描重派，同一 jobId `job active → LLM call → job completed`，未卡死

**Checkpoint**: 崩潰語意已翻轉且監督閉環成立；佇列不會因 worker 死亡永久卡死。

---

## Phase 5: User Story 3 - 可重現的故障演練機制（Priority: P2）

**Goal**: `WORKER_CHAOS`（uncaught|rejection）×`WORKER_CHAOS_AT`（startup|job）環境旗標，預設關閉、零影響、不改 code 不重建即可演練 US2 路徑。**同時補齊 US2 的完整致命注入驗收**。

**Independent Test**: quickstart 場景 3——未設定時行為正常；兩型態×兩時點可分別注入；連演 3 次一致；移除後恢復正常。

### Implementation for User Story 3

- [X] T012 [P] [US3] 建立 `apps/worker/src/lib/chaos.ts`：`parseChaosConfig(env)` 純函式（合法值解析、非法值 → warn＋視為關閉、`WORKER_CHAOS_AT` 預設 `startup`）＋ `armChaos(config, worker)`（`startup`：bootstrap 後約 2s 拋；`job`：BullMQ `active` 事件＋`setImmediate` 拋出以脫離 processor try/catch；`rejection` 型態以浮空 `Promise.reject` 觸發）（research D6、data-model E3）
- [X] T013 [P] [US3] 建立 `apps/worker/src/lib/chaos.test.ts`：合法組合、非法值（→ 關閉）、未設定（→ 關閉）、時點預設值的解析決定性（憲章測試門檻）
- [X] T014 [US3] 修改 `apps/worker/src/main.ts`：bootstrap 內解析 chaos 設定並 `armChaos`（傳入 Worker 實例掛 `active` 事件）；未設定時零程式路徑差異（FR-008）
- [X] T015 [P] [US3] `apps/worker/.env.example` 新增 `WORKER_CHAOS`／`WORKER_CHAOS_AT` 說明區塊（合法值、預設關閉、**僅供故障演練**、demo 前務必移除）（contracts §2、憲章 VI 僅提交 example）
- [X] T016 [US3] 依 quickstart 場景 3 完整驗收：`uncaught@job` 觸發「致命 → 重啟 → 恢復」（SC-002 ≤60s）、in-flight 重派（SC-003）、換 `rejection` 重演、**連續 3 次結果一致（SC-006）**、移除旗標後恢復完全正常——全程不改 code、不重建；加驗場景 3b（停止指令×致命重疊，FR-009／US2 場景 4：寬限期內終止、非 137、不重啟）與場景 6 選做（dev 模式致命差異實測，US2 場景 5）
  - **驗收證據（2026-07-09/10，全程只改 env、未改 code、未重建）**：①`uncaught@job` ✅——job active 後毫秒級拋出，log 逐字符合契約格式；SC-002：致命 09:34:17.79 → `worker ready` 09:34:22.37（**4.6s**，遠低於 60s）。②SC-006 ✅——同設定觀察到 6 輪「致命 → 重啟 → ready」，每輪 2.4–4.6s，結果一致。③`rejection@startup` ✅——已武裝後約 2s 拋 `unhandledRejection（致命…）`；並自然演示崩潰迴圈煞停（RestartCount=5 → exited，US4 正式驗收留待 T017）。④SC-003 ✅——演練 job 全數收束：或被重派重新消化，或走既有錯誤語意終態（`job stalled more than allowable limit` → failed；佇列最終 wait 0／active 0，無一卡死）。⑤場景 3b ✅（3 輪）——核心不變量成立：行程即刻終止（遠低於 45s 寬限）、**非 137**、容器不卡住、stop 後維持停止不重啟；實測補充第三種合法 ExitCode `143`（SIGTERM 落在致命觸發重啟後的新行程啟動早期窗口），已回填 quickstart 場景 3b。⑥移除旗標 ✅——無「已武裝」log、零影響恢復正常。⑦dev 模式選做 ✅——host `WORKER_CHAOS=uncaught` 直跑：已武裝 → 2s 致命 → 行程結束，`tsx watch` 停在等待檔案變更、不自動重啟，與 README 描述一致。⚠ 過程中發現 `apps/worker/.env` 的 `GEMINI_API_KEY` 行遺失（時序證據指向非本次工具寫入所致，但無法完全排除），已補回空白佔位行，**值需使用者自行補回**（T027 總驗收前必須就緒）

**Checkpoint**: 演練機制正式交付；US2 的致命路徑驗收至此完整。

---

## Phase 6: User Story 4 - 崩潰迴圈防護可觀察（Priority: P2）

**Goal**: 驗證 Docker 內建退避與 `on-failure:5` 上限行為並使其可判讀——**純驗證＋文件 story，無新實作**（research D4：不造輪子）。依賴 US3 的 `startup` 注入時點。

**Independent Test**: quickstart 場景 4——啟動即崩潰 → 重啟間隔遞增 → 達 5 次停止 → 10 分鐘無新重啟。

### Implementation for User Story 4

- [X] T017 [US4] 依 quickstart 場景 4 驗收：設 `WORKER_CHAOS=uncaught`＋`WORKER_CHAOS_AT=startup` → 以 `docker events`（filter `event=die`——restart policy 的自動重啟只發 `die`/`start` 事件、不發 `restart` 事件）／`docker logs --timestamps` 觀察重啟間隔逐次遞增（FR-006）；`docker inspect` 判讀 `RestartCount=5`、`State.Status=exited`；其後 10 分鐘無新重啟（SC-004）；期間 log 無密集 LLM/DB 連打（US4 場景 3）
  - **驗收證據（2026-07-13）**：①退避遞增 ✅——以 `die → 下一次 start` 間距量測**純退避延遲**（比 die-to-die 更精確，排除 bootstrap 時間抖動）：0.334 → 0.350 → 0.519 → 0.970 → 1.755s，吻合 Docker 100ms 起翻倍＋約 0.2s 容器啟動開銷。②達上限停止 ✅——`RestartCount=5`、`Status=exited`、`ExitCode=1`，迴圈自啟動至煞停共 27s。③10 分鐘無新重啟 ✅——窗口結束時 RestartCount 仍為 5、`docker events` 查詢窗口內 start 事件 **0 筆**。④外部資源零連打 ✅——迴圈期間 log 無任何 `LLM call`／`job active`（startup 注入在消化 job 前拋出）。備註：本版 docker 的 `docker events --format` 欄位為 `{{.Action}}`（`{{.Status}}` 會報錯）
- [X] T018 [P] [US4] `README.md` 雙模式章節補「崩潰迴圈防護」小節：達上限停止的判讀方式（`docker ps -a`／`inspect` 指令）與**復原手段**（排除故障後 `docker compose --profile supervised up -d worker` 重新拉起）（FR-006 可判讀性；checklist CHK004）

**Checkpoint**: 崩潰迴圈防護行為已驗證且運維者可判讀、可復原。

---

## Phase 7: User Story 5 - 「活著但卡住」可被察覺（Priority: P3）

**Goal**: heartbeat（10s 週期／TTL 30s）＋ compose healthcheck（30s×3）補活鎖盲點；健康判定僅示警、不自動重啟。依賴 US1 的容器形態。

**Independent Test**: quickstart 場景 5——正常 healthy；`kill -STOP` 模擬活鎖 → 約 90s 內轉 unhealthy（SC-005 ≤2min）；`kill -CONT` 恢復 healthy；全程不自動重啟。

### Implementation for User Story 5

- [X] T019 [P] [US5] 建立 `apps/worker/src/lib/heartbeat.ts`：`startHeartbeat(redis)`（`setInterval` 每 10s `SET worker:heartbeat <ISO ts> EX 30`，掛既有 `cache` 連線）／`stopHeartbeat()`＋`isHeartbeatFresh(pttl)` 純函式（research D5、data-model E2）
- [X] T020 [P] [US5] 建立 `apps/worker/src/lib/heartbeat.test.ts`：`isHeartbeatFresh` 邊界（PTTL 正值／0／-1／-2）（憲章測試門檻）
- [X] T021 [P] [US5] 建立 `apps/worker/src/healthcheck.ts`：獨立進入點（**不** import main，避免 bootstrap 副作用）——建短命 Redis 連線讀 `PTTL worker:heartbeat` → fresh 則 exit 0、否則 exit 1，含連線逾時保護（contracts §3）
- [X] T022 [US5] 修改 `apps/worker/src/main.ts`：worker `ready` 後啟動 heartbeat；`shutdown()` 中清除 heartbeat timer（優雅關閉不留 timer；致命路徑不清、key 靠 TTL 過期）（data-model E2 生命週期）
- [X] T023 [US5] `docker-compose.yml` worker service 補 healthcheck 區塊：`test: ["CMD","node","dist/healthcheck.js"]`、`interval: 30s`、`timeout: 5s`、`retries: 3`、`start_period: 30s`（contracts §4）
- [X] T024 [US5] 依 quickstart 場景 5 驗收：healthy → `docker exec <worker> sh -c 'kill -STOP $(pgrep -f dist/main.js)'` 凍結 node 子行程（不可對 PID 1 送 STOP——同 namespace 會被核心忽略；已由 T003 的 `init: true` 使 node 非 PID 1）→ 自 STOP 時點起算典型約 90s、最壞約 120s（≤2min）轉 `running (unhealthy)`（SC-005）→ `sh -c 'kill -CONT $(pgrep -f dist/main.js)'` 恢復 healthy；確認全程不自動重啟、可與「行程死亡」情境判別（US5 場景 3）
  - **驗收證據（2026-07-13）**：啟動後 heartbeat key 即存活（PTTL 22.5s）→ start_period 內轉 `Up (healthy)`（啟動後 21s）→ `kill -STOP` 凍結 node 子行程（PTTL 降至 -2、11s 後仍 -2＝訊號確實停止）→ **自 STOP 起約 98s** 轉 `running unhealthy`（SC-005 ≤2min ✅），期間 `RestartCount=0`（示警定位、不自動重啟；`running`+`unhealthy` 與「行程死亡→exited」可判別）→ `kill -CONT` 後 heartbeat 立即恢復（PTTL 25.6s）、40s 內回 `healthy`，全程零重啟

**Checkpoint**: 監督完整性補齊——行程死亡（US2/US4）與活鎖（US5）皆可察覺。

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: 全案品質門檻、文件一致性與總驗收。

- [ ] T025 [P] 全套品質門檻：`pnpm check`（contract lint＋typecheck＋lint＋test）全綠；確認新測試（fatal/chaos/heartbeat）均納入 `pnpm --filter worker test`
- [ ] T026 [P] 文件終檢：`README.md`、`docs/Flow-Gatekeeper-SDD-完整實作指南.md`、`apps/worker/.env.example`、contracts/supervision-runtime.md 與最終實作行為逐項一致（FR-010/FR-011；無殘留「暫時策略」措辭）
- [ ] T027 SC-001–SC-008 總驗收：依 quickstart「SC 對照」表逐項確認（含 SC-007 半開連線觀測：`docker compose stop` 後以 redis `CLIENT LIST`／mongo `serverStatus.connections` 對照關閉前後）
- [ ] T028 覆核 `specs/007-worker-process-supervision/checklists/supervision.md` 29 項並勾選；發現的需求缺口回填 spec/plan 後再結案

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: 無依賴，立即可做
- **Foundational (Phase 2)**: 無任務（見上）
- **US1 (Phase 3)**: 依賴 T001（.dockerignore 為 build 先決）
- **US2 (Phase 4)**: **依賴 US1 完成**——監督者未就位前不得合併 handler 翻轉（spec「兩半」論、指南 §13.7 前提）
- **US3 (Phase 5)**: 依賴 US2（旗標注入的就是 fatal 路徑）；T016 同時補齊 US2 的完整注入驗收
- **US4 (Phase 6)**: 依賴 US3（需 `startup` 注入時點）與 US1（restart 設定）
- **US5 (Phase 7)**: 僅依賴 US1（容器形態）——可與 US2–US4 平行
- **Polish (Phase 8)**: 依賴所有 story 完成

### User Story Dependencies

```text
Setup(T001) → US1(T002–T006) ─┬→ US2(T007–T011) → US3(T012–T016) → US4(T017–T018) ─┐
                              └→ US5(T019–T024) ────────────────────────────────────┴→ Polish(T025–T028)
```

注意：US2/US3/US5 各自會改 `apps/worker/src/main.ts`（T009/T014/T022），US1/US5 各自會改 `docker-compose.yml`（T003/T023）——跨 story 循序執行即無衝突；[P] 標記僅限同 phase 內不同檔案。

### Parallel Opportunities

- **US1**: T004（README）與 T002/T003（Dockerfile/compose）平行
- **US2**: T007＋T008（fatal.ts／fatal.test.ts）平行；T010（指南）與 T009（main.ts）平行
- **US3**: T012＋T013＋T015（chaos.ts／chaos.test.ts／.env.example）平行
- **US5**: T019＋T020＋T021（heartbeat.ts／test／healthcheck.ts）平行
- **跨 story**: US5 全 phase 可與 US2–US4 平行（不同關注點，main.ts 部分循序即可）
- **Polish**: T025＋T026 平行

## Parallel Example: User Story 5

```text
# 三個新檔可同時進行：
Task: "建立 apps/worker/src/lib/heartbeat.ts（startHeartbeat/stopHeartbeat + isHeartbeatFresh）"
Task: "建立 apps/worker/src/lib/heartbeat.test.ts（新鮮度邊界）"
Task: "建立 apps/worker/src/healthcheck.ts（獨立進入點）"
# 之後循序：T022（main.ts 接線）→ T023（compose healthcheck）→ T024（驗收）
```

---

## Implementation Strategy

### MVP First（US1 Only）

1. Phase 1（T001）→ Phase 3（US1）
2. **STOP and VALIDATE**：quickstart 場景 1/2/6——受監督形態本身零行為變更、可獨立交付
3. 但注意：**US1 單獨交付時 handler 仍是「log＋續跑」**，行為翻轉的價值要到 US2 才實現

### Incremental Delivery

1. Setup + US1 → 可部署形態（MVP，無行為變更）
2. US2 → 崩潰語意翻轉（本 feature 的存在理由；`docker kill` 級驗證）
3. US3 → 演練機制＋US2 完整注入驗收（SC-002/003/006 落定）
4. US4 → 崩潰迴圈驗證＋復原文件（SC-004 落定）
5. US5 → 活鎖偵測（SC-005 落定）——如需可提早與 US2 平行
6. Polish → 全案門檻與總驗收

### 遞交節奏（憲章「Phase 化可追溯遞交」）

依 CLAUDE.md：每完成一個 phase 先勾選 tasks 再 commit，標題格式 `<type>(007): [Phase <n>: <名稱>] <中文描述>`；US1 可拆「Dockerfile／compose＋驗證」與「README」兩個 commit，其餘 phase 預期單 commit。

---

## Notes

- [P] tasks＝不同檔案且無未完成依賴
- 每個 user story 獨立可測；US2 的完整注入驗收刻意後置到 US3（T016），因注入手段本身是 US3 的交付物
- 演練後務必移除 `WORKER_CHAOS` 設定再繼續其他 phase（旗標留著會汙染後續驗收）
- 絕不提交 `apps/worker/.env`（憲章 VI）；chaos 旗標只寫進 `.env.example` 說明
