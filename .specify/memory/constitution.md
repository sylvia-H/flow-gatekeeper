<!--
SYNC IMPACT REPORT
==================
Version change: 1.4.0 → 1.4.1
Rationale: 釐清 Principle III 的「型別來源分層」——需 runtime 驗證的 payload（如
DiagnosisResult、AI 結果）MUST 用 Zod + z.infer；純做型別分派的傳輸／控制訊息（WebSocket
envelope、ping/pong、system/connected、machine/subscribed、system/unauthorized 等
discriminated union）MAY 直接以 TS 型別定義，仍以 packages/contracts 為單一來源且 MUST NOT
另寫平行定義。此為消除 002 analyze 發現的字面衝突（C1：events.ts 控制／事件型別為手寫 TS、
非 z.infer 衍生），並對齊 001 既已採用、002 延續的實作（僅 DiagnosisResult 用 Zod）。屬釐清、
非語意變更（未移除或放寬既有 MUST，僅界定其適用範圍），依版本政策以 PATCH（1.4.1）處理。

Modified principles:
- III. 契約優先與全棧型別安全 — 新增「型別來源分層」澄清段；既有 MUST 不變

Templates requiring updates:
- ✅ .specify/templates/plan-template.md（Constitution Check gate 為泛用，自動對齊）
- ✅ .specify/templates/spec-template.md（無 constitution 專屬內容）
- ✅ .specify/templates/tasks-template.md（無 constitution 專屬內容）
- ℹ️ CLAUDE.md「Zod schema 為單一來源，type 由 z.infer 推導」為高層摘要，經本次釐清後仍成立
  （適用於需驗證的 payload），無需修改

Follow-up TODOs: none

----- Prior amendment (1.3.0 → 1.4.0) -----
Version change: 1.3.0 → 1.4.0
Rationale: 新增「merge 回 develop MUST 用 --no-ff」規則——禁止 fast-forward 併入，
強制產生明確的 merge commit，使每個 feature 在 git 歷史中有可辨識的收尾點（起因：
001 實際 merge 時誤用 fast-forward，使 16 個 commit 被攤平進 develop、無從一眼看出
feature 邊界，已撤銷重來）。屬對既有 Principle I「merge MUST 回 develop」的實質擴充
（新增此前未規定的合併機制要求），依版本政策以 MINOR（1.4.0）處理。具體指令與 merge
commit 訊息格式置於 CLAUDE.md，本憲章僅立治理層原則並指向之。

Modified principles:
- I. 規格驅動開發 — 新增一句：merge 回 develop MUST 為 `--no-ff`、MUST NOT
  fast-forward；操作細節指向 CLAUDE.md

Templates requiring updates:
- ✅ .specify/templates/plan-template.md (Constitution Check gate 為泛用，自動同步)
- ✅ .specify/templates/spec-template.md (無 constitution 專屬內容)
- ✅ .specify/templates/tasks-template.md (無 constitution 專屬內容)
- ✅ CLAUDE.md (已新增「Merge 回 develop 的方式：MUST --no-ff」章節與執行步驟)

Follow-up TODOs: none

----- Prior amendment (1.2.1 → 1.3.0) -----
Rationale: 新增「Phase 化可追溯遞交」工作流程指引——`implement` 階段以 tasks.md 的
phase 為遞交節奏單位，每完成一 phase 即勾選並建立標記該 phase 的 commit；大 phase 可依
主要開發大項拆成更細的多個 commit（不設死的數字上限，依大項自然拆分、避免過細），目標
是讓 git 歷史能還原開發順序與過程。
- 開發工作流程與品質門檻 — 新增「Phase 化可追溯遞交」條目（治理層），細節指向 CLAUDE.md

----- Prior amendment (1.2.0 → 1.2.1) -----
Rationale: Housekeeping consolidation — 移除滲入憲章的 operational 細節、把與
CLAUDE.md 逐字重複的環境/commit 慣例改為指標、並將「可重播 Demo」由 Core Principle
降格為品質門檻的驗收條件。因 1.2.0 為本輪 session 才生、尚無下游依賴，且本次屬
「拿掉重複/釐清層級」而非實質移除架構規則，故依專案當下狀態以 PATCH（1.2.1）處理；
待有 code 依賴後，原則層級的移除將正式按 MAJOR 走。
- V. AI 診斷紀律 — Cache 條目移除簽章欄位清單與 cache/lock key 命名等實作細節，
  改述為「signature 反映嚴重度/promptVersion/model 並去重」，細節指向指南 §8.7
- VIII. 可重播 Demo（Demo-First）— 由 Core Principle 降格；「可重播 demo/seed」併入
  「開發工作流程與品質門檻」當驗收條件，「首屏為監控台」回歸 design-spec
-->


# flow-gatekeeper Constitution

flow-gatekeeper 是一個致敬 Argo CD 的即時流程監控與 AI 診斷 side project，採用 GitHub
Spec Kit（SDD）開發。本憲章定義不可妥協的工程原則；`CLAUDE.md` 與各 reference
文件不得與本憲章衝突，衝突時以本憲章為準。

## Core Principles

### I. 規格驅動開發（Spec-Driven Development）

開發主支為 `develop`。每個正式 feature MUST 從 `develop` 開新 branch，並走完整
Spec Kit 流程：`specify → clarify → plan → checklist → tasks → analyze →
implement → 驗收 → merge`，merge MUST 回 `develop`，完成後再從 `develop` 開下一條
feature branch。開發步驟 MUST 依 `docs/Flow-Gatekeeper-SDD-完整實作指南.md`；指南中的
完整 code 區塊是「期望產出 / reference」，正式產出仍 MUST 經由 Spec Kit 流程生成。

Merge 回 `develop` MUST 以明確的 merge commit 完成（`--no-ff`），MUST NOT 以
fast-forward 方式併入，使每個 feature 的收尾點在 git 歷史中可清楚辨識。具體指令與
commit 訊息格式以 `CLAUDE.md` 為準。

同一 branch MUST NOT 混入多個大型 feature。MUST NOT 同時手貼完整 code 又執行
`/speckit.implement`（兩者會互相覆蓋）。

**理由**：SDD 讓規格、計畫、任務與實作可追溯且一致；繞過流程會讓 reference code
與真實產出分歧，破壞可審查性與可維護性。

### II. 單一真實來源（Single Source of Truth）

不得憑空發明。各面向 MUST 依其指定來源：

- **視覺**：一律依 `apps/web/design/design-spec.md` 與 `apps/web/design/refs/*.png`。
  顏色、圓角、陰影、間距 MUST 使用具名 token，MUST NOT 在元件內散落 hex。致敬
  Argo CD 的拓樸/狀態語言，但 MUST NOT 使用其官方 logo、商標，或直接照抄其官方
  UI layout 與品牌配色。
- **通訊契約**：一律依 `packages/contracts` 與 `asyncapi.yaml`。
- **架構決策**：重大技術取捨 MUST 記錄於 `docs/adr-*.md`，並以該記錄為準。

**理由**：分散且重複的事實來源會在整合階段產生不可預測的分歧；集中於指定來源讓變更
有單一改動點與單一審查依據。沿用官方品牌資產則會帶來不必要的 IP 風險。

### III. 契約優先與全棧型別安全（Contract-First & Type Safety）

`packages/contracts` 是通訊契約的唯一來源，新增 event/payload MUST 先改契約，再改
API/worker/web，MUST NOT 在各端另寫平行型別定義。

**型別來源分層**：需要 runtime 驗證的 payload（如 `DiagnosisResult`、AI 結果）MUST 以 Zod
schema 定義並由 `z.infer` 推導型別（呼應 Principle V 的 `DiagnosisResultSchema.parse()`）；
純做型別分派的傳輸／控制訊息（WebSocket envelope、`ping`/`pong`、`system/connected`、
`machine/subscribed`、`system/unauthorized` 等 discriminated union）MAY 直接以 TypeScript
型別定義，惟仍 MUST 以 `packages/contracts` 為單一來源、MUST NOT 另寫平行定義。

全棧 MUST 使用 strict TypeScript，並避免 `any` 擴散。

**理由**：契約先行確保三端（API、worker、web）對齊同一份結構；由 schema 推導型別讓
編譯期即可捕捉契約破壞。

### IV. 即時通道架構紀律（Real-time Channel Discipline）

- 即時通道 MUST 使用原生 `ws`：前端為 `new WebSocket()`，後端為 `ws` 套件掛在
  NestJS HTTP server（path `/ws`）。MUST NOT 使用 Socket.IO（協定不相容，混用會在
  整合階段壞掉，理由見 `docs/adr-001-native-websocket.md`）。
- 高頻事件 MUST NOT 逐筆寫入 reactive state：WebSocket telemetry MUST 先進 buffer，
  再用 `requestAnimationFrame` 每幀批次提交。
- **Worker isolation**：耗時工作、AI API 呼叫、retry/backoff、rate limit MUST 在
  worker process 執行；API process MUST NOT 執行 long-running task。
- Worker MUST NOT 直接 emit WebSocket；worker 是獨立 process，AI token MUST 走
  Redis Pub/Sub（`ai-stream:<jobId>`）→ Gateway 轉發。
- **雙通道分流**：job lifecycle MUST 走 BullMQ QueueEvents，AI token streaming MUST
  走 Redis Pub/Sub，兩者 MUST NOT 混為同一條流。
- **Redis connection 分離**：BullMQ queue、publisher、subscriber、cache 的 Redis
  connection MUST 分開；subscriber connection MUST NOT 拿去執行一般 command。

**理由**：原生 ws 是已記錄的架構決策；逐筆 reactive 更新會在高頻下拖垮前端；耗時工作
留在 API process 會阻塞即時服務；worker 直接 emit 會跨越 process 邊界並破壞 Gateway
的單一轉發點；job 狀態與 token 混流會讓背壓與責任歸屬難以釐清；共用 Redis connection
（尤其 subscriber）會在 Pub/Sub 與一般 command 間互相卡住。

### V. AI 診斷紀律（AI Diagnosis Discipline）

- LLM provider MUST 包在 `AiProvider` interface 後面；worker 主邏輯只依賴 interface，
  換 provider 只改 adapter。
- Cache before API：可重複的診斷 MUST 先查 Redis cache 再呼叫 LLM；cache signature
  MUST 反映嚴重度（如當前 `state`）、`promptVersion` 與 `model`，並 MUST 對同一簽章
  去重，避免重複消耗 LLM 額度。（簽章組成與 cache/lock key 命名等實作細節見指南 §8.7）
- AI 回傳 MUST 經 `DiagnosisResultSchema.parse()` 驗證；失敗走 `ai/error`，
  MUST NOT 把未驗證物件當作結果使用。

**理由**：interface 隔離讓 provider 可替換；cache 與 lock 控制成本與重複呼叫；schema
驗證確保下游永遠拿到結構正確的結果。

### VI. 祕密與設定衛生（Secrets & Config Hygiene）

只 MUST 提交 `.env.example`。MUST NOT 提交 `.env`、API key、token 或任何憑證。

**理由**：祕密一旦進入 git 歷史即難以撤回；以範例檔記錄設定形狀，憑證留在本機與部署
環境。

### VII. 資料可追溯性（Data Traceability）

telemetry、error logs、diagnoses、maintenance records MUST 可追溯並持久化於
MongoDB。這些歷史資料 MUST NOT 只存在 Redis；Redis 僅供 queue、cache、Pub/Sub、
lock 等暫態用途。

**理由**：歷史資料是 AI 診斷組 context 的來源，也是驗收與事後審查的依據；只放在 Redis
會隨 TTL 過期或重啟而遺失，破壞可追溯性與診斷品質。

## 技術約束與環境

執行環境（Windows / PowerShell）、套件管理（pnpm workspace）、monorepo 佈局
（`apps/{api,worker,web}`、`packages/{contracts,shared}`）與本機 infra
（`docker compose`：Redis 7 + MongoDB 7）等操作層約束，以 `CLAUDE.md` 為準，本憲章
不重述。技術選型的不變量已分散於上列各原則（如 strict TS、原生 ws、MongoDB 持久化）。

## 開發工作流程與品質門檻

- **Commit 與分支慣例**（Conventional Commits 前綴、前綴後中文描述、commit 時機、
  從 `develop` 開 feature branch、merge 回 `develop` 等操作細節）以 `CLAUDE.md` 為準，
  本憲章不重述；分支主規則見 Principle I。
- **Phase 化可追溯遞交**：`implement` 階段 MUST 以 `tasks.md` 的 phase 為遞交節奏單位——
  每完成一個 phase，MUST 先勾選該 phase 的任務，再就該 phase 成果建立**標記該 phase 的
  commit（一至數個）**，使實作進度與 tasks/spec 在 git 歷史中逐 phase 可追溯、可還原開發
  順序。commit 訊息格式、type 分類與顆粒度拆分原則（依開發大項拆分、避免過細）等操作層
  內容以 `CLAUDE.md` 為準。
- 每個 feature 在進入 `implement` 前 MUST 通過 `analyze` 的跨工件一致性檢查；
  在 merge 前 MUST 完成驗收。
- **測試門檻**：每個 feature MUST 至少提供純函式單元測試作為驗收佐證（例如 signature
  的決定性、telemetry batching 的批次關係、schema 對壞 JSON 會丟錯）。空測試的 CI
  處理等操作細節見指南 §6.10。
- **可重播驗收**：每個 feature MUST 保留可重播的 demo 或 seed/mock producer，讓驗收
  與展示可重現。（產品視覺層面，如「首屏為可操作監控台、不做 landing page」，依
  `apps/web/design/design-spec.md`。）
- Plan 階段的 Constitution Check MUST 對照本憲章；任何違反 MUST 在 plan 的
  Complexity Tracking 中記錄理由，否則 MUST 改為合規方案。

## Governance

本憲章凌駕其他實作慣例；當任何文件、code 或流程與本憲章衝突時，以本憲章為準。

- **修訂程序**：對原則的新增、移除或重大重定義 MUST 透過更新本檔進行，並在頂部 Sync
  Impact Report 記錄變更與版本異動；相依模板（plan/spec/tasks）MUST 同步檢查。
- **版本政策**（語意化版本）：
  - **MAJOR**：移除或不相容地重定義既有原則 / 治理規則。
  - **MINOR**：新增原則或實質擴充指引。
  - **PATCH**：釐清、措辭與錯字等非語意修正。
- **合規審查**：所有 PR / review MUST 驗證是否符合本憲章；複雜度 MUST 有正當理由。
  日常開發的操作層指引以 `CLAUDE.md` 為輔，但其內容 MUST NOT 與本憲章相牴觸。

**Version**: 1.4.1 | **Ratified**: 2026-06-30 | **Last Amended**: 2026-06-30
