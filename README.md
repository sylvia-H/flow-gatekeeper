<div align="center">

# flow-gatekeeper

**即時流程監控 × 串流式 AI 診斷面板 — 一個致敬 Argo CD 的高頻 WebSocket 工程展示**

以 buffer + `requestAnimationFrame` 每幀批次提交壓制高頻遙測、以獨立 worker + BullMQ + Redis 削峰 AI 診斷，
並把「背壓比值」與「逐字串流的 AI 推理」直接畫在同一個畫面上。

<br/>

![Vue 3.5](https://img.shields.io/badge/Vue-3.5-42b883?logo=vuedotjs&logoColor=white)
![NestJS 10](https://img.shields.io/badge/NestJS-10-e0234e?logo=nestjs&logoColor=white)
![TypeScript strict](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)
![Native ws](https://img.shields.io/badge/realtime-native%20ws-000000?logo=socketdotio&logoColor=white)
![BullMQ](https://img.shields.io/badge/queue-BullMQ%20%2B%20Redis-dc382d?logo=redis&logoColor=white)
![MongoDB 7](https://img.shields.io/badge/MongoDB-7%20time--series-47a248?logo=mongodb&logoColor=white)
![Zod contracts](https://img.shields.io/badge/contracts-Zod%20single%20source-3e67b1)
![pnpm workspace](https://img.shields.io/badge/monorepo-pnpm%20workspace-f69220?logo=pnpm&logoColor=white)

</div>

---

## 目錄

- [這是什麼](#這是什麼)
- [30 秒亮點](#30-秒亮點)
- [功能逐項展示（實機截圖）](#功能逐項展示實機截圖)
- [技術亮點深入](#技術亮點深入)
- [系統架構與資料流](#系統架構與資料流)
- [技術棧](#技術棧)
- [功能導覽（依 feature 逐一交付）](#功能導覽依-feature-逐一交付)
- [Monorepo 結構](#monorepo-結構)
- [快速開始](#快速開始)
- [環境變數](#環境變數)
- [測試與品質門檻](#測試與品質門檻)
- [開發方法論：Spec-Driven Development](#開發方法論spec-driven-development)
- [關鍵架構決策（ADR）](#關鍵架構決策adr)
- [已知限制](#已知限制)

---

## 這是什麼

**flow-gatekeeper** 是一個模擬工廠機台艦隊（fleet）的即時監控台：5 台示範機台以 10–50ms 的節拍持續吐出遙測（溫度、振動、吞吐、錯誤率），前端即時渲染每台的健康狀態；當某台轉為 warning／critical 時，操作者可以**就地對那台機台觸發一次 AI 診斷**，並在同一畫面的 Copilot 面板中，看著 AI 的推理**逐字串流**出現，最後收斂成一份結構化診斷（嚴重度、可能原因、佐證、建議動作）。

它的定位不是「把即時通訊接起來」而已，而是刻意親手實作即時／分散式系統裡**較難、較有展示價值的那幾塊**：前端高頻背壓、跨進程串流 relay、佇列削峰、cache-aside 去重、契約優先的全棧型別安全。整個專案以 [GitHub Spec Kit](https://github.com/github/spec-kit)（Spec-Driven Development）逐 feature 開發，工程原則以 `memory/constitution.md`（專案憲章）為準。

> 這是一個作品集 / demo 展示用途的 side project，重點在於**工程紀律的可驗證性**——每個賣點都有對應的量化驗收（SC）與可重播 demo。

---

## 30 秒亮點

| 亮點 | 一句話 | 佐證 |
| --- | --- | --- |
| ⚡ **高頻 WebSocket 背壓** | telemetry 先進 buffer、`requestAnimationFrame` 每幀批次提交，**不逐筆寫 reactive state** | 畫面上直接顯示 `收到訊息數 : 渲染批次數` 比值（50ms 節拍約 11:1，節拍越快比值越高） |
| 🔌 **原生 `ws`，不用 Socket.IO** | 前端 `new WebSocket()`／後端 `ws` 掛在 NestJS，完全掌控 wire format | 決策取捨見 [ADR-001](docs/adr-001-native-websocket.md) |
| 🧵 **跨進程 AI 串流 relay** | worker 不直接 emit WS；AI token 走 Redis Pub/Sub → Gateway 轉發到對應連線 | 單一 WebSocket 連線同時承載遙測與診斷串流 |
| 🚦 **佇列削峰 + 韌性** | BullMQ + Redis：rate limit（`AI_RPM`）、`attempts` 重試、指數退避、worker 崩潰不拖垮 API | 20 筆並發診斷不超過每分鐘 LLM 上限 |
| 💰 **Cache-aside + dedupe lock** | 相同機台／狀態簽章直接回快取、`ai-lock:<sig>` 讓同情境只打一次 LLM | 第二次同類診斷秒回並標 `Cached` |
| ✅ **Schema 驗證的 AI 輸出** | AI 回傳必經 `DiagnosisResultSchema.parse()`，失敗走 `ai/error`，不把未驗證物件當結果 | Zod 為單一真實來源，型別由 `z.infer` 推導 |
| 📐 **契約優先的全棧型別安全** | web／api／worker 三端共用 `packages/contracts` 同一份事件／結果型別 | strict TypeScript、`asyncapi.yaml` 契約 lint |
| 🤖 **每機台狀態機的 Copilot Drawer** | `Map<machineId, CopilotJobState>`：多台可並存診斷，切換選取即還原各自呈現 | idle／active／streaming／completed／failed 五態 |

---

## 功能逐項展示（實機截圖）

> 以下皆為**實際執行中的 app 截圖**（前端 Vue + 後端 NestJS Gateway + 獨立 worker + Gemini 全棧跑起來後擷取），逐一對應每個可操作的功能。視覺規格單一來源另見 [`apps/web/design/`](apps/web/design/)（design-spec 與 refs）。

### 1. 即時 fleet 監控 + 背壓量化

打開應用**第一屏即是可操作的監控台**（非 landing page），自動連上 `/ws` 並訂閱 5 台示範機台，持續呈現每台的狀態燈、溫度／振動／吞吐／錯誤率與最後更新時間。頂部工具列的 **BackpressureBadge** 即時顯示 `收到訊息數 · 渲染批次數 · 比值`（此例 `3,005 msgs · 280 frames · 11:1`）——把「收很多、只批次渲染少數幾次」的削峰效果直接畫在畫面上，不用開 DevTools。數值以等寬字呈現、不因寬度變化抖動。右側為桌機常駐的 AI Copilot 面板（未選機台時為空狀態提示）。

![即時 fleet 監控台與背壓比值 11:1](docs/screenshots/monitoring-live.png)

### 2. 機台狀態呈現：healthy / warning / critical

每張卡片固定 footprint，狀態只改狀態燈、邊框與遙測顏色，**不造成 layout shift**；狀態**不只靠顏色**（狀態燈帶 `aria-label`，如 `Status: Critical`）。下圖 `press-02` 進入 critical（紅色狀態燈、紅色卡片 tint、Temp `94.2°`、Vibration `2.36`、Errors `16.0%`），其餘機台維持 healthy——遙測由 mock producer 以決定性規律產生，內含週期性 warning/critical 尖峰，確保 demo 可重播。

![機台 healthy 與 critical 狀態同屏呈現](docs/screenshots/monitoring-states.png)

### 3. 機台選取（驅動診斷對象）

點選卡片或左側清單即設定 `selectedMachineId`（同時至多一台），以 accent 高亮呈現選取；這個選取就是 Diagnose 的作用對象。下圖選取了 `Mixer 01`（清單項與卡片皆高亮）。

![選取 Mixer 01 機台](docs/screenshots/monitoring-selected.png)

### 4. 斷線自動重連 + stale 標示

即時通道中斷時，頂部轉為 **Reconnecting** 並以指數退避 + 抖動自動重連；期間**不清空**最後已知資料，而是把過舊的機台打上 **STALE** 標記（降低視覺權重）讓操作者知道哪些數值不再新鮮。恢復後自動重新訂閱並繼續推送。

![斷線重連中、機台標示為 STALE](docs/screenshots/monitoring-reconnecting-stale.png)

### 5. 觸發診斷 + 逐字串流

對選取機台按 **Diagnose**：前端帶著目前的 `socketId`（即 WS `clientId`）呼叫 `POST /diagnoses`，drawer **立即進入 active**（不等任何 AI 內容），進度先以 indeterminate 呈現；接著 worker 的 AI 推理 **逐段 append 出現並帶串流游標**，不必等整段生成完。此時右側 Copilot 面板明確標示對應機台（`mixer-01`）與任務識別。

![Copilot drawer 進入 active、AI 推理逐字串流](docs/screenshots/copilot-streaming.png)

### 6. 結構化診斷結果（五區塊）

`ai/done` 抵達後，drawer 原地渲染**通過 `DiagnosisResultSchema` 驗證**的結構化結果，欄位一致無錯位：**Summary + 嚴重度徽章**（ok／warning／critical）、**Likely Causes**、**Evidence**（來源標記 telemetry／errorlog／maintenance 的佐證片段）、**Suggested Actions**（含 `priority` 與可選 `command`）。進度條走到 100%，先前串流原文收合可回看。

![完成的結構化診斷結果：summary、causes、evidence、actions](docs/screenshots/copilot-completed.png)

### 7. 快取命中標示（Cache before API）

對同一機台、同一狀態簽章再次診斷時，後端 cache-aside 直接回既有結果、**不再呼叫 LLM**，drawer 顯示 **Cached** 標記、進度直接 100%。這是 003「Cache before API / dedupe lock」在前端的可視化證據——demo 中可直接展示「第二次同樣診斷秒回且標為 cached」。

![診斷結果標示 Cached badge](docs/screenshots/copilot-cached.png)

### 8. 失敗與重試

當診斷因 worker 停擺、AI 錯誤或連線中斷導致綁定失效時，drawer 進入 **Failed**，顯示**可讀的錯誤訊息**（非原始堆疊，如「連線中斷，請重試」）與一個 **Retry** 動作；按 Retry 對同機台重新發起診斷、回到 active 流程（若簽章相同命中快取則照常標 Cached）。

![診斷失敗狀態與 Retry 按鈕](docs/screenshots/copilot-failed.png)

### 9. 響應式 / 手機 bottom-sheet

四個基準 viewport（1366×768／1440×900／768×1024／390×844）皆不溢出、不重疊、不遮住頂部狀態列。手機尺寸下卡片退化為**單欄清單**，Copilot 由右側常駐面板改為**底部 bottom-sheet**（可上滑展開、可關閉、含 Escape）。

![手機 390×844 bottom-sheet Copilot](docs/screenshots/responsive-mobile.png)

---

## 技術亮點深入

### ⚡ 1. 高頻遙測的前端背壓（本專案核心賣點）

遙測以 10–50ms 級湧入（5 台 × 每 tick 一筆）。若每筆都寫 reactive state，Vue 會被逼著逐筆重繪，畫面必卡。做法是：

```
WebSocket.onmessage ──▶ 只 push 進 buffer（不碰 reactive state）
                              │
        requestAnimationFrame ─┘ 每一幀 flush 一次 buffer ──▶ 批次提交到 store
```

- `useHighFrequencyWs` 的 `onmessage` **只**把訊息推進 buffer，絕不直接寫 reactive state（憲章硬規則 #1）。
- 每一幀（rAF）才把累積的 buffer 一次性提交，把「收 N 筆、只渲染 M 次」的削峰效果做出來。
- buffer 設**上限**（超過丟最舊、保最新），避免分頁切到背景時逐幀暫停、記憶體無限成長。
- store 維護 `receivedMessages` 與 `renderedBatches` 兩個計數，**把背壓從抽象說法變成畫面上看得見的比值**——這是整個決策最直接的證據。

### 🔌 2. 即時通道統一用原生 WebSocket

前端 `new WebSocket()`、後端 `ws` 套件掛在 NestJS HTTP server（path `/ws`）。刻意**不用 Socket.IO**：高頻場景需要 wire format 的完全控制（直接推裸 JSON 陣列、少一層封包開銷），也避免函式庫內部緩衝與自己的 rAF 批次策略打架、讓「背壓由誰負責」變模糊。代價（reconnect、heartbeat、訂閱表、jobId 對應）全部手刻並列入驗收。完整取捨見 **[ADR-001](docs/adr-001-native-websocket.md)**。

- **指數退避 + 抖動**重連（非使用者主動關閉才重連）。
- 應用層 `ping`/`pong` heartbeat + 逾時主動 `close` 觸發重連。
- 伺服器端主動探活，回收「半死」連線（網路硬中斷）。

### 🧵 3. 跨進程 AI 串流：Redis Pub/Sub relay

worker 是獨立 process、沒有前端連線，**不得直接 emit WebSocket**（憲章硬規則 #3）。因此：

```
worker ──publish── ai-stream:<jobId> (Redis Pub/Sub) ──▶ Gateway 訂閱 ai-stream:*
                                                              │
                                        依 Map<jobId, clientId> 轉發 ai/token/done/error
                                                              ▼
                                               對應的那一條前端 WebSocket 連線
```

- job **生命週期**（`job/status`）走 BullMQ QueueEvents；AI **token 串流**走 Redis Pub/Sub——**兩條流分開**，不混為一談（憲章原則 IV）。
- 診斷事件與遙測**共用同一條前端 WebSocket 連線**：004 的 `useHighFrequencyWs` 以 `onDiagnosisEvent` 回呼分流，`ai/token` 直接 append（人可讀低頻），**MUST NOT 混入遙測 buffer**，遙測的 rAF 批次背壓因此不被破壞。

### 🚦 4. 佇列削峰與失敗韌性（BullMQ + Redis）

- `POST /diagnoses` 只負責入列並立即回 jobId，**耗時工作全在獨立 worker**——API process 不做 long-running 診斷。
- BullMQ limiter：每分鐘實際 LLM 呼叫 ≤ `AI_RPM`（預設 8）；`concurrency`（預設 2）與 rate limit 是獨立維度。
- `attempts`（預設 3）+ 指數退避；單次 AI streaming 設 **30 秒**應用層逾時，逾時轉 `ai/error` 走重試。
- worker 崩潰／停擺時，API 與即時通道**不崩潰**；worker 恢復後積壓任務可被消化。

### 💰 5. Cache-aside + dedupe lock（成本守門）

- worker 呼叫 LLM **前**先以「機台／當前嚴重度／近期錯誤類型／prompt 版本／模型」組出的簽章查 Redis 快取（`Cache before API`，憲章硬規則 #5）。
- 命中直接回傳並標 `cached: true`，**不呼叫 LLM、不重複寫入 `diagnoses`**（只記一筆輕量觸發稽核）。
- 同簽章以 `ai-lock:<sig>`（具過期時間）去重：同情境同時湧入多筆，**只有一筆真正打 LLM**，其餘共用其結果；持鎖者逾時／崩潰不會讓後續永久卡死。

### ✅ 6. Schema 驗證的 AI 輸出 + LLM provider 抽象

- LLM 包在 `AiProvider` interface 後面（憲章硬規則 #4）：主邏輯只依賴 interface，換 provider 只改 adapter（目前為 Gemini `gemini-2.5-flash`）。
- AI 回傳**必經** `DiagnosisResultSchema.parse()`（憲章硬規則 #6）；失敗走 `ai/error`，絕不把未驗證物件當結果。
- 診斷結果的結構、即時事件的型別，全部以 `packages/contracts` 的 **Zod schema 為單一來源**，型別由 `z.infer` 推導——不讓「驗證」與「型別」各寫一份而分歧。

### 📐 7. 契約優先的全棧型別安全

- `packages/contracts` 定義 6 條即時通道事件（`machine/subscribe`、`machine/data`、`job/status`、`ai/token`、`ai/done`、`ai/error`）與 `DiagnosisResultSchema`、佇列常數與 `DiagnosisJobPayload`。
- web／api／worker 三端**共用同一份**契約，新增 event/payload 一律**先改契約再改各端**；`asyncapi.yaml` 以 Spectral 做契約 lint。
- 全棧 strict TypeScript（`noUncheckedIndexedAccess`），避免 `any` 擴散。

### 🤖 8. 每機台狀態機的 Copilot Drawer

- `copilot.store` 以 `Map<machineId, CopilotJobState>` 維護**每台各自**的診斷狀態機，多台可並存進行；drawer 同一時間只呈現目前選取機台的那一份，切換選取即還原該台的呈現。
- 進度**純事件驅動**：progress 完全以 `job/status` 攜帶值為準（前端不合成假值），未帶值時 indeterminate。worker 把里程碑綁**真實處理階段**：`0` job active → `20` 組完 context → `40` 取鎖即將呼叫 LLM → `60` 首個 token → `80` 串流結束且 schema 解析成功 → `100` 寫庫/快取並發 `ai/done`。
- 重連（新 `clientId`）即把該台進行中任務**標中斷 + 提供 Retry**（不用逾時偵測）；過期／亂序的舊 job 串流片段一律忽略，不覆蓋目前任務。

---

## 系統架構與資料流

```
                    ┌──────────────────────────── apps/web (Vue 3 + Pinia) ────────────────────────────┐
                    │  monitoring domain            ai-copilot domain                                   │
                    │  ┌────────────────────┐       ┌──────────────────────────┐                        │
                    │  │ useHighFrequencyWs │       │ copilot.store             │                        │
                    │  │  buffer + rAF flush│──────▶│ Map<machineId, JobState>  │                        │
                    │  │  onDiagnosisEvent ─┼──────▶│ copilotReducer (純函式)   │                        │
                    │  └─────────┬──────────┘       └──────────────────────────┘                        │
                    └────────────┼───────────────────────────────┬──────────────────────────────────────┘
             native ws  /ws  ▲   │ machine/data, job/status,      │  POST /diagnoses (socketId=clientId)
             (單一連線)       │   │ ai/token, ai/done, ai/error    ▼
    ┌───────────────────────┼───┴────────────────────────────────────────── apps/api (NestJS) ──────────┐
    │  MonitoringGateway (ws) │ ── mock telemetry producer (10–50ms) ──┐   DiagnosesController            │
    │   ├ 訂閱表 clientId→Set<machineId>   ├ 訂閱過濾（只推訂閱者）      │        │ enqueue                 │
    │   ├ heartbeat / 離線回收             └ 每 tick 全量落地 ──────────┼──┐     ▼                         │
    │   └ AiStreamRelay: 訂閱 ai-stream:*，Map<jobId,clientId> 轉發 ◀───┼──┼── BullMQ Queue (Redis)        │
    └──────────────────────────────────────────────────────────────────┼──┼──────────┬───────────────────┘
                                                                        │  │          │ consume
                     ┌──────── Redis ────────┐          ┌─────── MongoDB 7 ───────┐   ▼
                     │ BullMQ queue          │          │ telemetry (time-series, │  ┌──── apps/worker (獨立 process) ────┐
                     │ ai-cache:<sig>        │◀────────▶│   TTL 7d)               │  │ 1. 讀 Mongo 組 context            │
                     │ ai-lock:<sig> dedupe  │  cache   │ errorlogs (狀態轉換)    │◀─┤ 2. 查 ai-cache（命中即回）        │
                     │ Pub/Sub ai-stream:*   │◀─────────┤ maintenanceRecords(seed)│  │ 3. 取 ai-lock 去重                │
                     └───────────────────────┘  publish │ diagnoses / triggers    │◀─┤ 4. AiProvider streaming (Gemini)  │
                          token │ done │ error           └─────────────────────────┘  │ 5. DiagnosisResultSchema.parse()  │
                                │                                                     │ 6. 寫 Mongo + 快取 + 發 ai/done    │
                                └──────── publish 每個 token ─────────────────────────┤    （每 token publish 到 Pub/Sub） │
                                                                                      └────────────────────────────────────┘
```

**兩條流刻意分開**：機台生命週期 / job 狀態走 BullMQ QueueEvents，AI token 串流走 Redis Pub/Sub。前端則只有**一條** WebSocket 連線同時承載兩者，靠 composable 分流。

---

## 技術棧

| 層 | 選型 |
| --- | --- |
| **前端** | Vue 3.5（SFC, `<script setup>`）、Pinia、Tailwind CSS 3、lucide-vue-next、Vite 5 |
| **API / Gateway** | NestJS 10、原生 `ws`（掛 HTTP server，path `/ws`）、`@nestjs/bullmq` |
| **Worker** | 獨立 Node ESM process、BullMQ、`@google/generative-ai`（Gemini，包在 `AiProvider` 後） |
| **即時通道** | 原生 WebSocket（前後端）+ Redis Pub/Sub 跨進程 relay |
| **佇列 / 快取** | Redis 7（BullMQ queue、cache-aside、dedupe lock、Pub/Sub） |
| **資料庫** | MongoDB 7（telemetry time-series + TTL、errorlogs、maintenanceRecords、diagnoses） |
| **契約** | `packages/contracts`（Zod 單一來源，`z.infer` 推導型別）+ `asyncapi.yaml` |
| **語言 / 工具鏈** | strict TypeScript 5.6、pnpm workspace、ESLint 9、Vitest、Spectral（contract lint） |
| **本機 infra** | Docker Compose（Redis 7 + MongoDB 7） |

---

## 功能導覽（依 feature 逐一交付）

專案以 Spec Kit 逐 feature 開發，每條 feature 都有完整的 `spec / plan / tasks / checklist` 與量化驗收（`specs/00x-*/`）。

| # | Feature | 交付重點 |
| --- | --- | --- |
| **001** | [Monorepo 基礎、共用契約、本機 infra](specs/001-foundation-contracts/spec.md) | pnpm workspace 骨架、`packages/contracts`（6 條通道事件 + `DiagnosisResultSchema`）、Docker Compose、祕密衛生與 CI 四道檢查 |
| **002** | [即時 Gateway、遙測產生器、MongoDB 歷史層](specs/002-gateway-telemetry/spec.md) | WebSocket Gateway（連線／訂閱／心跳／離線回收）、mock producer（10–50ms、healthy/warning/critical 週期尖峰）、訂閱過濾、time-series 落地 + TTL、errorlogs（狀態轉換去重）、維修紀錄 seed |
| **003** | [診斷任務佇列、AI 串流、Redis 快取](specs/003-bullmq-ai-streaming/spec.md) | `POST /diagnoses`、BullMQ（limiter/attempts/backoff）、獨立 worker、cache-aside + dedupe lock、`AiProvider` streaming、Pub/Sub relay、`DiagnosisResultSchema` 驗證、diagnoses 持久化 + 觸發稽核 |
| **004** | [前端高頻 WebSocket 監控台](specs/004-frontend-ws-gatekeeper/spec.md) | monitoring domain、`useHighFrequencyWs`（buffer + rAF 批次）、BackpressureBadge、機台卡片六態、指數退避重連、stale 標示、`selectedMachineId`、四 viewport 響應式 |
| **005** | [AI Copilot Drawer](specs/005-ai-copilot-drawer/spec.md) | `ai-copilot` domain、`Map<machineId>` 狀態機、逐段串流 + 游標、結構化結果五區塊、`Cached` badge、同機台去重、Retry、桌機常駐 / 手機 bottom-sheet、worker 進度里程碑細化 |

---

## Monorepo 結構

```
flow-gatekeeper/
├── apps/
│   ├── api/           # NestJS：WebSocket Gateway、mock producer、POST /diagnoses、Pub/Sub relay、seed
│   │   └── .env.example   # ← api 專屬 env 範本（複製成 apps/api/.env）
│   ├── worker/        # 獨立 process：BullMQ consumer、cache/dedupe、AiProvider(Gemini) streaming
│   │   └── .env.example   # ← worker 專屬 env 範本（GEMINI_API_KEY 只在這；複製成 apps/worker/.env）
│   └── web/           # Vue 3 + Pinia：monitoring / ai-copilot domains、design-spec token（不需 .env）
│       └── design/    # design-spec.md + refs/*.png（視覺單一來源）
├── packages/
│   ├── contracts/     # Zod schema 單一來源（events / DiagnosisResult / job payload）→ z.infer 型別
│   └── shared/        # 跨端共用工具
├── specs/             # 001–005 每條 feature 的 spec / plan / tasks / checklist
├── docs/              # ADR、SDD 完整實作指南、design-spec
├── scripts/           # dev-up.ps1（一鍵起全棧）、demo-reset.ps1（清 AI 快取）
├── asyncapi.yaml      # 即時通道契約（Spectral lint）
├── docker-compose.yml # Redis 7 + MongoDB 7
├── .env.example       # 環境設定「總覽指引」（非載入檔；指向各 app 的 .env.example）
└── memory/            # 專案憲章 constitution.md（工程原則單一來源）
```

---

## 快速開始

> 環境為 **Windows / PowerShell**；套件管理用 **pnpm workspace**。

### 前置需求

- Node.js 20 LTS+
- pnpm 9+
- Docker Desktop（跑 Redis 7 + MongoDB 7）
- 一組 Gemini API key（`GEMINI_API_KEY`）——僅診斷會用到，監控台不需要

### 步驟

```powershell
# 1) 安裝所有 workspace
pnpm install

# 2) 準備環境變數 —— env 是「每個 app 各一份」，不是根目錄一份（根 .env 不會被讀取）
Copy-Item apps/api/.env.example    apps/api/.env
Copy-Item apps/worker/.env.example apps/worker/.env
#   → 編輯 apps/worker/.env，填入 GEMINI_API_KEY（僅 worker 需要；api/web 不需要）
#   → 本機 live 驗收把 apps/api/.env 的 WS_AUTH_SECRET 留空，前端才能以空 token 訂閱
#   → apps/web 不需要 .env（走 vite dev proxy，前端不持有祕密）

# 3) 起本機 infra（Redis + MongoDB）
docker compose up -d

# 4) 一鍵起全棧：seed → api → worker → web（各開一個 PowerShell 視窗，方便分開看 log）
./scripts/dev-up.ps1
#   已 seed 過可加 -SkipSeed

# 5) 開瀏覽器
#   web → http://localhost:5173   （api → http://localhost:3000，ws 在 /ws）
```

Demo 前若想「清 AI 快取讓首次診斷看得到逐字串流」，另外單獨執行 `./scripts/demo-reset.ps1`（與啟動分開、職責清楚）。

### 全域檢查（契約 lint + typecheck + lint + test）

```powershell
pnpm check
```

---

## 環境變數

env **分散在各 app**（執行期不讀根目錄 `.env`）：`apps/api/.env` 由 `apps/api/src/main.ts` 明確載入本層檔、`apps/worker/.env` 由 worker 以 `dotenv/config`（cwd）載入本層檔、`apps/web` 不需 env。各處以其 `.env.example` 為準：

| 變數 | 所在 app | 預設 | 說明 |
| --- | --- | --- | --- |
| `API_PORT` | api | `3000` | API / Gateway 埠（web 埠 5173 由 vite 決定） |
| `REDIS_HOST` / `REDIS_PORT` | api · worker | `127.0.0.1` / `6379` | BullMQ / cache / Pub/Sub（連線分離） |
| `MONGO_URL` / `MONGO_DB` | api · worker | `mongodb://127.0.0.1:27017/flow-gatekeeper` | 歷史層與診斷持久化 |
| `WS_AUTH_SECRET` | api | *(空)* | 即時通道訂閱授權；**本機 live 驗收留空** → 前端免 token 訂閱 |
| `WS_HEARTBEAT_MS` | api | `15000` | 伺服器端心跳探活間隔 |
| `MOCK_TELEMETRY_INTERVAL_MS` | api | `50` | 遙測產生節拍（拉到 5ms 可放大背壓比值 ≥10:1） |
| `TELEMETRY_TTL_SECONDS` | api | `604800` | 時序遙測保存期（7 天，可調小做 demo） |
| `GEMINI_API_KEY` / `GEMINI_MODEL` | **worker** | — / `gemini-2.5-flash` | LLM provider（包在 `AiProvider` 後）；**只有 worker 需要** |
| `AI_RPM` | worker | `8` | 每分鐘 LLM 呼叫上限（BullMQ limiter） |
| `AI_CACHE_TTL_SECONDS` | worker | `600` | 診斷快取有效期 |
| `AI_DEDUPE_LOCK_SECONDS` | worker | `45` | 同簽章去重鎖有效期 |
| `AI_TIMEOUT_MS` | worker | `30000` | 單次 AI streaming 應用層逾時 |

> **祕密衛生**（憲章硬規則 #7）：只提交各處的 `.env.example`；`.env`、API key、token **絕不**進版控（`.gitignore` 已忽略所有 `.env`、放行 `.env.example`）。`GEMINI_API_KEY` 只存在於 `apps/worker/.env`。

---

## 測試與品質門檻

- **契約 lint**：`pnpm contract:lint`（Spectral 對 `asyncapi.yaml`）。
- **型別檢查**：全棧 strict TypeScript，`pnpm typecheck`。
- **單元測試**：Vitest；核心決定性邏輯優先（純函式／reducer），例如 `copilotReducer` 狀態轉移、`isStaleJobEvent` 過期片段判定、快取簽章決定性、訂閱過濾與 errorlog 去重、進度條純函式不變量。
- **一鍵全檢**：`pnpm check` = 契約 lint → typecheck → lint → test。
- 每條 feature 的 spec 都帶**量化 Success Criteria（SC）**與**可重播 demo**，讓每個賣點都能被獨立驗收。

---

## 開發方法論：Spec-Driven Development

本專案全程以 [GitHub Spec Kit](https://github.com/github/spec-kit) 開發，工程原則以 `memory/constitution.md`（專案憲章）為單一來源。每條 feature 從 `develop` 開 branch，走完整流程：

```
specify → clarify → plan → checklist → tasks → analyze → implement → 驗收 → merge(--no-ff) 回 develop
```

- `/speckit.implement` 期間以 tasks.md 的 **phase 為遞交單位**逐 phase commit，commit 標題標記 phase，讓 git 歷史能還原開發順序。
- merge 回 `develop` 一律 `--no-ff`，保留每個 feature 的收尾點。
- Conventional Commits 前綴 + **中文描述**。

`docs/Flow-Gatekeeper-SDD-完整實作指南.md` 為期望產出的 reference；正式流程仍走 Spec Kit。

---

## 關鍵架構決策（ADR）

- **[ADR-001：即時通道採用原生 WebSocket，而非 Socket.IO](docs/adr-001-native-websocket.md)** — 為什麼刻意放棄 Socket.IO 的自動重連／心跳／rooms／Redis adapter，換取 wire format 的完全掌控，好讓「rAF 背壓由誰負責」說得清楚、效能可歸因。內含 demo 時可直接講的 60–90 秒取捨說明。

---

## 已知限制

- **重連不 rebind**：Gateway 每次連線派新 `clientId`，「任務 → 連線」綁定以記憶體 Map 實作；重連會使進行中任務綁定失效——前端把它收尾為「中斷 + Retry」，不做跨重連續傳（正式做法可改存 Redis）。
- **單實例**：目前不跨多 server 水平擴展；要擴展時用既有的 Redis Pub/Sub 自行廣播（見 ADR-001 §6）。
- **REST 診斷入口開發階段免授權**：`POST /diagnoses` 於 dev 開放；即時通道訂閱仍走 `WS_AUTH_SECRET`。正式環境的 REST 認證不在範圍。
- **示範機台固定為 5 台**：`mixer-01`、`press-02`、`pack-03`、`oven-04`、`sorter-05`；遙測由 mock producer 以決定性規律產生（含週期性 warning/critical 尖峰），以滿足可重播驗收。

---

<div align="center">
<sub>flow-gatekeeper · Spec-Driven Development · 工程紀律優先、每個賣點都可驗收</sub>
</div>
