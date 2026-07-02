# flow-gatekeeper SDD 完整實作指南
### 以 GitHub Spec Kit 手把手打造高併發即時觀測與 AI 診斷系統

> 一個致敬 **Argo CD** 的工業級 Side Project，集中呈現 **BullMQ 分散式佇列削峰**、**中高階 WebSocket 效能優化**、**AI 雙通道串流（streaming）** 三項核心技能。
> 目標是讓你可以從零開始安裝 Spec Kit、初始化 repo、建立 `.env`、逐 feature branch 開發，最後完成一個致敬 Argo CD 但不複製品牌資產的 side project。

---

## 0. 你會完成什麼

flow-gatekeeper 是一個即時流程監控與 AI 診斷面板：

1. 前端以 Vue 3 顯示機台/流程拓樸圖。
2. WebSocket 持續接收 10-50ms 級 telemetry。
3. 前端用 `requestAnimationFrame` 對高頻訊息做 gatekeeper batching，避免 reactive state 被逐筆訊息沖垮。
4. 後端 NestJS Gateway 負責 WebSocket、訂閱、心跳、job status 轉發。
5. BullMQ 將 AI 診斷任務排入 Redis queue。
6. Worker 獨立 process 消化 job、讀 MongoDB context、查 Redis cache、呼叫 LLM。
7. AI token streaming 透過 Redis Pub/Sub 回到 Gateway，再推給前端 Copilot drawer。
8. MongoDB 保存 telemetry、error logs、maintenance records、diagnoses。
9. Claude Design 產出視覺參考與 design tokens，前端按規格落地。

### 0.1 履歷亮點

| 模組 | 展示技能 | 面試可以怎麼講 |
| --- | --- | --- |
| `useHighFrequencyWs` | rAF batching、WebSocket reconnect、heartbeat、UI 背壓 | 我不是每筆 WebSocket 都寫 reactive state，而是每幀批次提交，所以高頻資料也能維持穩定渲染。 |
| NestJS Gateway | 原生 ws、client subscription、QueueEvents relay | Gateway 只負責即時通訊與協調，不把耗時 AI 任務塞在 request/event path。 |
| BullMQ Worker | queue、limiter、attempts、backoff、graceful shutdown | AI API 有 RPM 限制，所以我用 queue 削峰，worker 獨立 process 消化工作。 |
| Redis Pub/Sub | worker/gateway 跨進程 streaming | Worker 沒有 WebSocket connection，因此 token 先 publish 到 Redis，再由 Gateway 轉發。 |
| Redis cache-aside | prompt signature、TTL、dedupe lock | 重複診斷可直接命中 cache，不消耗 LLM RPM。 |
| MongoDB | time-series、document、TTL、schema validation | telemetry 與診斷結果資料型態不同，所以採分層儲存。 |
| Spec Kit / SDD | constitution、spec、clarify、plan、tasks、implement | 我用規格驅動而不是 vibe coding，每個 feature 有清楚驗收條件。 |
| Claude Design | 設計 token、截圖、實作交接 | 設計不是只看截圖，而是固化成 token 與 component states 給 coding agent 使用。 |

---

## 1. 架構決策先講清楚

### 1.1 不要把 Spec Kit 當成貼 prompt 的工具

Spec Kit 的價值是把規格、計畫、任務、驗收與實作串成流程。每個 feature 都應該：

```text
建立 branch
  -> /speckit.specify
  -> /speckit.clarify
  -> /speckit.plan
  -> /speckit.checklist
  -> /speckit.tasks
  -> /speckit.analyze
  -> /speckit.implement
  -> 手動/自動驗收
  -> commit / merge
```

本指南把專案切成 5 個 feature，再穿插 CI 與 Claude Design 階段。

> **如何使用本指南的程式碼區塊**
> 文件內的 `asyncapi.yaml`、`contracts`、service、hook 等完整 code，定位是 **「期望產出 / reference 附錄」**，不是要你手貼進 repo 後就跳過 Spec Kit。
> 正式流程仍走 `/speckit.specify -> clarify -> plan -> tasks -> implement`，讓 agent 生成實作，再拿本指南的 reference 對齊（檔名、契約、行為、驗收條件）。
> 如果你又手貼完整 code、又跑 `/speckit.implement`，兩邊會互相覆蓋，也正好變成你想避免的半 vibe coding。把這些區塊當「驗收的標準答案」即可。

### 1.2 Streaming 與 job status 是兩條流

不要把 AI token 與 BullMQ job lifecycle 混成同一件事：

| 流 | 來源 | 目的 | 傳輸 |
| --- | --- | --- | --- |
| job status | BullMQ `QueueEvents` / Worker | 顯示 active/completed/failed/progress | Gateway -> WebSocket |
| AI token | Worker streaming callback | 顯示逐 token 診斷文字 | Worker -> Redis Pub/Sub -> Gateway -> WebSocket |

這個設計解決一個常見卡點：Worker 是獨立 process，沒有前端 WebSocket connection。

### 1.3 LLM 供應商要隔離

本指南用 Gemini Flash 當範例，但實作要把 provider 包在 `AiProvider` interface。之後要換 Claude API，只需要替換 worker 裡 provider adapter，其餘 BullMQ、cache、Pub/Sub、WebSocket 都不用改。

### 1.4 Argo CD 是致敬，不是複製

可以借用：

- 拓樸圖思維
- sync/status 語言
- resource node cards
- right drawer / operation panel
- healthy/warning/critical 的狀態辨識

不要使用：

- Argo CD 官方 logo
- 官方商標素材
- 直接照抄 UI layout 或品牌配色

### 1.5 即時通道一律用原生 WebSocket，不要用 Socket.IO

前端 `useHighFrequencyWs` 用的是瀏覽器原生 `new WebSocket(url)`。後端 Gateway 必須也用**原生 ws**（`ws` 套件，掛在 NestJS 的 HTTP server 上），**不要用 Socket.IO**——Socket.IO 有自己的握手與封包格式，原生 `WebSocket` client 連不上去，整條 telemetry/streaming 都會在整合階段壞掉。

協定約定（前後端共用）：

- 訊息一律是 JSON。控制訊息是帶 `type` 的物件（`ping`/`pong`、`machine/subscribe`、`system/connected`）。
- telemetry 推送是 **一個 `TelemetryPoint` 陣列**（前端 hook 直接展開進 buffer）。
- 不要依賴 Socket.IO 的 named event 或 room；client 識別、訂閱表、jobId 對應都由 Gateway 自己用 `Map` 管理。

> 這個取捨的完整理由（Socket.IO 幫你藏了什麼、為何刻意自管、何時該改回去、面試講稿）見 `docs/adr-001-native-websocket.md`。

---

## 2. 系統架構

```text
┌──────────────────────────────────────────────────────────────────────┐
│ Vue 3 Web                                                             │
│                                                                      │
│  Monitoring domain                    AI Copilot domain              │
│  ┌───────────────────────┐            ┌──────────────────────────┐   │
│  │ useHighFrequencyWs    │            │ CopilotDrawer             │   │
│  │ buffer + rAF batching │            │ job progress + tokens     │   │
│  └───────────┬───────────┘            └──────────────┬───────────┘   │
└──────────────│────────────────────────────────────────│───────────────┘
               │ WebSocket: telemetry                   │ WebSocket: job/ai
               ▼                                        ▼
┌──────────────────────────────────────────────────────────────────────┐
│ NestJS API / Gateway                                                  │
│                                                                      │
│  MonitoringGateway                                                    │
│  - subscribe/unsubscribe machine ids                                  │
│  - heartbeat / reconnect support                                      │
│  - relay QueueEvents                                                  │
│  - psubscribe ai-stream:* and forward tokens                          │
│                                                                      │
│  JobsController / JobsService                                         │
│  - create diagnosis job                                               │
│  - query job status                                                   │
└──────────────┬───────────────────────────────┬───────────────────────┘
               │ enqueue job                    │ write/read
               ▼                                ▼
┌──────────────────────────────┐      ┌────────────────────────────────┐
│ Redis                         │      │ MongoDB                         │
│ - BullMQ queue                │      │ - telemetry time-series         │
│ - Pub/Sub ai-stream:<jobId>   │      │ - errorlogs                     │
│ - ai-cache:<signature>        │      │ - maintenanceRecords            │
│ - ai-lock:<signature>         │      │ - diagnoses                     │
└──────────────┬───────────────┘      └───────────────▲────────────────┘
               │ consume                              │ context/result
               ▼                                      │
┌──────────────────────────────────────────────────────┴───────────────┐
│ Worker process                                                        │
│ - BullMQ processor                                                    │
│ - Redis cache-aside                                                   │
│ - MongoDB context builder                                             │
│ - LLM provider streaming                                              │
│ - publish token/done/error to Redis Pub/Sub                           │
└──────────────────────────────────────────────────────────────────────┘
```

### 2.1 推薦 monorepo 結構

```text
flow-gatekeeper/
  .github/workflows/ci.yml
  .specify/
  memory/constitution.md
  specs/
  asyncapi.yaml
  docker-compose.yml
  pnpm-workspace.yaml
  package.json
  .gitignore
  .env.example
  .spectral.yaml
  apps/
    api/
      src/
        modules/
          config/
          websocket/
          jobs/
          history/
          telemetry/
        main.ts
    worker/
      src/
        ai/
        cache/
        context/
        processors/
        main.ts
    web/
      src/
        domains/
          monitoring/
          ai-copilot/
        shared/
      design/
        design-spec.md
        refs/
  packages/
    contracts/
      src/
        events.ts
        schemas.ts
        index.ts
    shared/
      src/
```

### 2.2 Process 責任邊界

- `apps/api`：HTTP、WebSocket、queue producer、QueueEvents relay、Redis Pub/Sub subscriber。
- `apps/worker`：BullMQ processor、LLM 呼叫、MongoDB context、cache-aside。
- `apps/web`：監控台、WebSocket client、Pinia stores、Copilot UI。
- `packages/contracts`：所有 event/payload/result schema。
- `packages/shared`：跨 runtime 的純工具與 domain types。

---

## 3. Part 0：環境前置作業

### 3.1 需要安裝的工具

| 工具 | 建議版本 | 用途 | 確認指令 |
| --- | --- | --- | --- |
| Git | 最新穩定版 | branch、commit、Spec Kit feature flow | `git -v` |
| Node.js | 24 LTS（20 LTS+ 亦可；CI 以 Node 24 驗證） | web/api/worker runtime | `node -v` |
| pnpm | 9+ | monorepo workspace | `pnpm -v` |
| Docker Desktop | 最新穩定版 | Redis + MongoDB | `docker -v` |
| uv | 最新穩定版 | 安裝 Spec Kit CLI | `uv --version` |
| Claude Code | 最新可用版 | Spec Kit coding agent | `claude --version` |
| mongosh | 可選 | 手動驗證 MongoDB | `mongosh --version` |
| redis-cli | 可選 | 手動驗證 Redis | `redis-cli --version` |

### 3.2 安裝 uv

macOS / Linux：

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
uv --version
```

Windows PowerShell：

```powershell
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
uv --version
```

如果 Windows 安裝後找不到 `uv`，重開 terminal，或確認 uv 安裝路徑已加到 PATH。

### 3.3 安裝 Node.js 與 pnpm

```bash
node -v
npm -v
npm i -g pnpm
pnpm -v
```

建議使用 Node 24 LTS（CI 亦以 Node 24 驗證）。若你用 nvm/nvs/fnm，先切好版本再初始化專案。

### 3.4 Docker Desktop 檢查

```bash
docker -v
docker compose version
```

Windows 請確認 Docker Desktop 已啟動，且 WSL2 backend 可用。

### 3.5 Gemini API key

到 Google AI Studio 建立 API key。先不急著填，Feature 003 才會真的用到。  
免費層額度與模型可用性會變動，`AI_RPM=8` 是保守預設，實作時以你專案 console 顯示為準。

---

## 4. Part 1：安裝 GitHub Spec Kit 並初始化專案

> 官方安裝方式以 `github/spec-kit` repo 為準。建議用 release tag 鎖版本；如果你只是要快速開始，也可直接安裝 main branch。

### 4.1 安裝 Specify CLI

建議方式：鎖定 release tag。

```bash
uv tool install specify-cli --from git+https://github.com/github/spec-kit.git@vX.Y.Z
```

快速方式：使用 repo 最新版本。

```bash
uv tool install specify-cli --from git+https://github.com/github/spec-kit.git
```

一次性執行、不永久安裝：

```bash
uvx --from git+https://github.com/github/spec-kit.git specify init flow-gatekeeper --integration claude
```

確認：

```bash
specify --help
specify version
specify check
```

### 4.2 初始化專案

如果你要建立新 repo：

```bash
specify init flow-gatekeeper --integration claude
cd flow-gatekeeper
git init
git add -A
git commit -m "chore: initialize spec kit workspace"
```

如果你已在空資料夾內：

```bash
specify init . --integration claude
git init
git add -A
git commit -m "chore: initialize spec kit workspace"
```

Windows 如果需要 PowerShell script：

```bash
specify init flow-gatekeeper --integration claude --script ps
```

### 4.3 認識 slash command

Spec Kit 初始化後，Claude Code 應能使用：

```text
/speckit.constitution
/speckit.specify
/speckit.clarify
/speckit.plan
/speckit.checklist
/speckit.tasks
/speckit.analyze
/speckit.implement
/speckit.converge
```

每個正式 feature 都建議走完整流程。小型補丁可省略部分步驟，但本 side project 是要展示 SDD 能力，所以請保留完整紀錄。

### 4.4 feature branch 命名

分支命名（**示意，不要照抄連續執行**）：

```text
001-foundation-contracts
002-realtime-gateway-history
003-bullmq-ai-streaming
004-frontend-ws-gatekeeper
005-copilot-ui-design
```

每條 feature branch 都要**從 `develop` 開**，做完 merge 回 `develop` 再開下一條：

```bash
git checkout main
git checkout -b 001-foundation-contracts
# ...完成 / merge 後...
git checkout main
git checkout -b 002-realtime-gateway-history
```

不要像 `git checkout -b 001 ... && git checkout -b 002 ...` 連續執行——那會把 002 疊在 001 上、003 疊在 002 上，變成堆疊分支。Spec Kit 會依分支與 spec 資料夾協作；不要在同一個 branch 混多個大 feature。

---

## 5. Part 2：建立專案憲法

在 Claude Code 執行：

```text
/speckit.constitution
```

貼上：

```text
flow-gatekeeper 是一個致敬 Argo CD 的即時流程監控與 AI 診斷 side project。工程原則如下：

1. Contract-first：WebSocket event、BullMQ payload、AI streaming event 必須先定義於 AsyncAPI 或 Zod schema，再被 API、worker、web 共用。
2. High-frequency UI safety：任何高頻事件不得直接逐筆寫入 Vue reactive state，必須先 buffer，再用 requestAnimationFrame 或節流策略批次提交。
3. Worker isolation：耗時工作、AI API、retry/backoff、rate limit 都在 worker process；API process 不做 long-running task。
4. Dual-channel streaming：job lifecycle 走 BullMQ QueueEvents；AI token streaming 走 Redis Pub/Sub，再由 Gateway 推送 WebSocket。
5. Cache before API：可重複診斷的 AI prompt 必須先查 Redis cache；cache hit 直接回傳 cached result。
6. MongoDB as history：telemetry、error logs、diagnoses、maintenance records 必須可追溯，不能只存在 Redis。
7. Strict TypeScript：web、api、worker、contracts 都使用 strict TS，避免 any 擴散。
8. Secrets hygiene：repo 只提交 .env.example；不得提交 .env、API key、token。
9. Demo first：每個 feature 要保留可重播的 demo 或 seed/mock producer，方便面試展示。
10. Design handoff：Claude Design 的結果必須固化成 refs 截圖與 design-spec tokens，coding agent 不得憑空發明視覺。

技術棧：
- Vue 3 + Vite + TypeScript + Pinia + Tailwind
- NestJS + @nestjs/websockets + @nestjs/bullmq
- BullMQ + Redis
- MongoDB
- Gemini Flash 或可替換 LLM provider
- pnpm monorepo
```

驗收：

```bash
Get-ChildItem memory
Get-Content -Encoding UTF8 memory/constitution.md
git add -A
git commit -m "docs: add flow-gatekeeper engineering constitution"
```

---

## 6. Feature 001：Monorepo、Contracts、Infra、Env

Branch：

```bash
git checkout -b 001-foundation-contracts
```

### 6.1 `/speckit.specify` prompt

```text
建立 flow-gatekeeper 的 monorepo 基礎、即時通訊契約、環境設定與本機 infra。

範圍：
- pnpm workspace。
- apps/web：Vue 3 + Vite + TypeScript + Pinia + Tailwind。
- apps/api：NestJS API + WebSocket Gateway 骨架。
- apps/worker：BullMQ worker 獨立 process 骨架。
- packages/contracts：共用 event/payload/result schema。
- docker-compose.yml：Redis 7 + MongoDB 7。
- .gitignore 與 .env.example。
- asyncapi.yaml：定義 machine/data、machine/subscribe、job/status、ai/token、ai/done、ai/error。
- CI：lint、typecheck、Spectral contract lint。

成功條件：
- docker compose up -d 後 Redis 與 MongoDB 可連線。
- web/api/worker/contracts 都能 pnpm install 與 typecheck。
- .env 不會被 git 追蹤。
- contracts 可被 API、worker、web import。
```

### 6.2 `/speckit.plan` 技術要點

請讓 agent 明確採用：

```text
- package manager：pnpm workspace。
- contracts：**用 Zod 定義 schema 當單一真實來源，TypeScript type 由 `z.infer` 推導**（contract-first，避免型別與執行期驗證各寫一份）；AsyncAPI 作為通訊文件；後續可加 codegen。
- API：NestJS。
- WebSocket：**原生 `ws`（掛在 NestJS HTTP server，path `/ws`），不要用 Socket.IO**（見 1.5）。
- worker：獨立 Node process，使用 BullMQ Worker；LLM provider 包在 `AiProvider` interface 後面（見 1.3）。
- Redis：BullMQ、Pub/Sub、cache 共用 Redis instance，但 connection 要分開。
- MongoDB：Feature 002 建立 collections；Feature 001 只放 docker-compose 與 env。
- CI：GitHub Actions 執行 pnpm install、lint、typecheck、spectral lint asyncapi.yaml。
```

### 6.3 建立 `.gitignore`

```gitignore
# secrets
.env
.env.*
!.env.example

# dependencies
node_modules/
.pnpm-store/

# build outputs
dist/
build/
coverage/

# local logs
*.log
npm-debug.log*
pnpm-debug.log*

# editor / OS
.DS_Store
Thumbs.db
.idea/
.vscode/
```

### 6.4 建立 `.env.example`

```dotenv
# ---- API / Web ----
API_PORT=3000
WEB_PORT=5173
NODE_ENV=development

# ---- Redis: BullMQ / cache / PubSub ----
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
REDIS_PASSWORD=

# ---- MongoDB ----
MONGO_URL=mongodb://127.0.0.1:27017/flow-gatekeeper
MONGO_DB=flow-gatekeeper

# ---- WebSocket ----
WS_AUTH_SECRET=replace_me_dev_only
WS_HEARTBEAT_MS=15000

# ---- Telemetry mock ----
MOCK_TELEMETRY_INTERVAL_MS=50

# ---- AI provider ----
GEMINI_API_KEY=
GEMINI_MODEL=gemini-2.5-flash
AI_RPM=8
AI_CACHE_TTL_SECONDS=600
AI_DEDUPE_LOCK_SECONDS=45

# ---- Data lifecycle ----
TELEMETRY_TTL_SECONDS=604800
ERRORLOG_TTL_SECONDS=2592000
```

建立本機 `.env`：

```bash
cp .env.example apps/api/.env
cp .env.example apps/worker/.env
```

Windows PowerShell：

```powershell
Copy-Item .env.example apps/api/.env
Copy-Item .env.example apps/worker/.env
```

確認 `.env` 沒被追蹤：

```bash
git status --short
```

### 6.5 `docker-compose.yml`

```yaml
services:
  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    command: redis-server --appendonly yes
    volumes:
      - redis-data:/data

  mongo:
    image: mongo:7
    ports:
      - "27017:27017"
    volumes:
      - mongo-data:/data/db

volumes:
  redis-data: {}
  mongo-data: {}
```

啟動與驗證：

```bash
docker compose up -d
docker compose ps
redis-cli -h 127.0.0.1 -p 6379 ping
mongosh "mongodb://127.0.0.1:27017/flow-gatekeeper" --eval "db.runCommand({ ping: 1 })"
```

如果沒有 `redis-cli` 或 `mongosh`，可先用 `docker compose ps` 確認 container healthy，後面由 app 連線驗證。

### 6.6 `pnpm-workspace.yaml`

```yaml
packages:
  - "apps/*"
  - "packages/*"
```

### 6.7 root `package.json`

```json
{
  "name": "flow-gatekeeper",
  "private": true,
  "type": "module",
  "scripts": {
    "lint": "pnpm -r lint",
    "typecheck": "pnpm -r typecheck",
    "test": "pnpm -r test",
    "build": "pnpm -r build",
    "contract:lint": "spectral lint asyncapi.yaml",
    "check": "pnpm contract:lint && pnpm typecheck && pnpm lint && pnpm test"
  },
  "devDependencies": {
    "@stoplight/spectral-cli": "^6.15.0",
    "typescript": "^5.6.0"
  },
  "packageManager": "pnpm@9.0.0"
}
```

### 6.8 `asyncapi.yaml`

```yaml
asyncapi: 2.6.0
info:
  title: flow-gatekeeper Realtime Events
  version: 0.1.0
  description: WebSocket events for telemetry, diagnosis jobs, and AI streaming.

servers:
  local:
    url: ws://localhost:3000/ws
    protocol: ws

channels:
  machine/subscribe:
    publish:
      summary: Client subscribes to machine telemetry.
      message:
        $ref: "#/components/messages/MachineSubscribe"

  machine/data:
    subscribe:
      summary: Server pushes high-frequency machine telemetry.
      message:
        $ref: "#/components/messages/MachineData"

  job/status:
    subscribe:
      summary: Server pushes diagnosis job status.
      message:
        $ref: "#/components/messages/JobStatus"

  ai/token:
    subscribe:
      summary: Server pushes streamed AI token chunks.
      message:
        $ref: "#/components/messages/AiToken"

  ai/done:
    subscribe:
      summary: Server pushes final AI diagnosis.
      message:
        $ref: "#/components/messages/AiDone"

  ai/error:
    subscribe:
      summary: Server pushes AI provider or worker errors.
      message:
        $ref: "#/components/messages/AiError"

components:
  messages:
    MachineSubscribe:
      payload:
        type: object
        required: [type, token, machineIds]
        properties:
          type:
            const: machine/subscribe
          token:
            type: string
          machineIds:
            type: array
            items:
              type: string

    MachineData:
      payload:
        $ref: "#/components/schemas/TelemetryPoint"

    JobStatus:
      payload:
        type: object
        required: [type, jobId, machineId, status]
        properties:
          type:
            const: job/status
          jobId:
            type: string
          machineId:
            type: string
          status:
            enum: [waiting, active, completed, failed]
          progress:
            type: number
            minimum: 0
            maximum: 100
          result:
            $ref: "#/components/schemas/DiagnosisResult"
          error:
            type: string

    AiToken:
      payload:
        type: object
        required: [type, jobId, seq, text]
        properties:
          type:
            const: ai/token
          jobId:
            type: string
          seq:
            type: integer
          text:
            type: string

    AiDone:
      payload:
        type: object
        required: [type, jobId, cached, result]
        properties:
          type:
            const: ai/done
          jobId:
            type: string
          cached:
            type: boolean
          result:
            $ref: "#/components/schemas/DiagnosisResult"

    AiError:
      payload:
        type: object
        required: [type, jobId, code, message]
        properties:
          type:
            const: ai/error
          jobId:
            type: string
          code:
            type: string
          message:
            type: string

  schemas:
    TelemetryPoint:
      type: object
      required: [type, machineId, timestamp, telemetry, state]
      properties:
        type:
          const: machine/data
        machineId:
          type: string
        timestamp:
          type: string
          format: date-time
        telemetry:
          type: object
          required: [temperature, vibration, throughput, errorRate]
          properties:
            temperature:
              type: number
            vibration:
              type: number
            throughput:
              type: number
            errorRate:
              type: number
        state:
          enum: [healthy, warning, critical]

    DiagnosisResult:
      type: object
      required: [summary, severity, likelyCauses, suggestedActions, evidence]
      properties:
        summary:
          type: string
        severity:
          enum: [ok, warning, critical]
        likelyCauses:
          type: array
          items:
            type: string
        suggestedActions:
          type: array
          items:
            type: object
            required: [label, priority]
            properties:
              label:
                type: string
              priority:
                enum: [low, medium, high]
              command:
                type: string
        evidence:
          type: array
          items:
            type: object
            required: [source, excerpt]
            properties:
              source:
                enum: [telemetry, errorlog, maintenance]
              id:
                type: string
              excerpt:
                type: string
```

### 6.9 `packages/contracts`

`packages/contracts/package.json`：

```json
{
  "name": "@flow-gatekeeper/contracts",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "lint": "eslint src --ext .ts"
  },
  "dependencies": {
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "typescript": "^5.6.0"
  }
}
```

`packages/contracts/src/events.ts`：

```ts
import type { DiagnosisResult } from './schemas.js';

export type { DiagnosisResult };

export type MachineState = 'healthy' | 'warning' | 'critical';

export type TelemetryPoint = {
  type: 'machine/data';
  machineId: string;
  timestamp: string;
  telemetry: {
    temperature: number;
    vibration: number;
    throughput: number;
    errorRate: number;
  };
  state: MachineState;
};

export type MachineSubscribe = {
  type: 'machine/subscribe';
  token: string;
  machineIds: string[];
};

export type JobStatus = {
  type: 'job/status';
  jobId: string;
  machineId: string;
  status: 'waiting' | 'active' | 'completed' | 'failed';
  progress?: number;
  result?: DiagnosisResult;
  error?: string;
};

export type AiToken = {
  type: 'ai/token';
  jobId: string;
  seq: number;
  text: string;
};

export type AiDone = {
  type: 'ai/done';
  jobId: string;
  cached: boolean;
  result: DiagnosisResult;
};

export type AiError = {
  type: 'ai/error';
  jobId: string;
  code: string;
  message: string;
};

export type AiStreamEvent = AiToken | AiDone | AiError;
```

> `DiagnosisResult` 不在這裡手寫 type，而是在 `schemas.ts` 用 Zod 定義、再 `z.infer` 推導，這樣執行期驗證與型別共用同一份來源（constitution 第 1 條 contract-first）。

`packages/contracts/src/schemas.ts`：

```ts
import { z } from 'zod';

export const DiagnosisResultSchema = z.object({
  summary: z.string(),
  severity: z.enum(['ok', 'warning', 'critical']),
  likelyCauses: z.array(z.string()),
  suggestedActions: z.array(
    z.object({
      label: z.string(),
      priority: z.enum(['low', 'medium', 'high']),
      command: z.string().optional(),
    }),
  ),
  evidence: z.array(
    z.object({
      source: z.enum(['telemetry', 'errorlog', 'maintenance']),
      id: z.string().optional(),
      excerpt: z.string(),
    }),
  ),
});

export type DiagnosisResult = z.infer<typeof DiagnosisResultSchema>;
```

> worker 拿到 LLM 回傳後，必須用 `DiagnosisResultSchema.parse()` 驗證再寫庫/回傳；parse 失敗就走 `ai/error`，不要把未驗證的物件當結果（見 8.10）。同樣模式可套用到 telemetry/event payload。

`packages/contracts/src/index.ts`：

```ts
export * from './schemas.js';
export * from './events.js';
```

### 6.10 Spectral 與 CI

`.spectral.yaml`：

```yaml
extends:
  - spectral:asyncapi
```

`.github/workflows/ci.yml`：

```yaml
name: ci

on:
  push:
  pull_request:

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 9
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm contract:lint
      - run: pnpm typecheck
      - run: pnpm lint
      - run: pnpm test
```

> 標榜 SDD 卻沒測試會站不住腳。每個 feature 至少補幾個 **純函式單元測試**當驗收佐證，例如：
>
> - `buildDiagnosisSignature` 的決定性（同輸入同輸出、欄位順序不影響、含 `promptVersion`/`model`）。
> - telemetry batching：`receivedMessages` 與 `renderedBatches` 的關係（rAF 批次成立）。
> - `DiagnosisResultSchema` 對壞 JSON 會丟錯。
>
> 用 Vitest 即可；package 若暫無測試，`test` script 先設成 `vitest run --passWithNoTests`，避免 CI 因空測試失敗。

### 6.11 Feature 001 驗收

```bash
pnpm install
pnpm contract:lint
pnpm typecheck
docker compose up -d
docker compose ps
git status --short
```

通過條件：

- `asyncapi.yaml` 可被 Spectral lint。
- `.env` 不出現在 `git status`。
- Redis/MongoDB container 正常。
- `@flow-gatekeeper/contracts` 可 build/typecheck。

commit：

```bash
git add -A
git commit -m "feat(001): foundation contracts infra and env"
git checkout main
git merge 001-foundation-contracts
```

---

## 7. Feature 002：Realtime Gateway、Telemetry Mock、MongoDB History

Branch：

```bash
git checkout main
git checkout -b 002-realtime-gateway-history
```

### 7.1 `/speckit.specify` prompt

```text
建立 flow-gatekeeper 的 NestJS realtime gateway 與 MongoDB history layer。

範圍：
- WebSocket Gateway 支援 client connect/disconnect、ping/pong heartbeat、machine subscribe/unsubscribe。
- Mock telemetry producer 每 10-50ms 產生 machine telemetry。
- Gateway 只把 telemetry 推給訂閱該 machineId 的 client。
- MongoDB 建立 telemetry time-series collection，TTL 7 天。
- 建立 errorlogs、maintenanceRecords collections 與 seed script。
- 當 telemetry 達到 warning/critical threshold 時寫入 errorlogs。

成功條件：
- 多個 client 訂閱不同 machineIds，只收到自己訂閱的資料。
- telemetry 會寫入 MongoDB time-series collection。
- critical/warning event 會產生 errorlogs。
- heartbeat 與 disconnect cleanup 正常。
```

### 7.2 MongoDB collection 設計

| Collection | 用途 | 索引/TTL |
| --- | --- | --- |
| `telemetry` | 高頻時序資料 | time-series，`timeField: timestamp`，`metaField: metadata`，TTL `TELEMETRY_TTL_SECONDS` |
| `errorlogs` | warning/critical 事件 | index `{ machineId: 1, timestamp: -1 }` |
| `maintenanceRecords` | 維修紀錄 | index `{ machineId: 1, performedAt: -1 }` |

`apps/api/src/modules/history/history.service.ts` 範例：

```ts
import { Injectable, OnModuleInit } from '@nestjs/common';
import { MongoClient, Db } from 'mongodb';
import type { MachineState, TelemetryPoint } from '@flow-gatekeeper/contracts';

@Injectable()
export class HistoryService implements OnModuleInit {
  private client!: MongoClient;
  private db!: Db;

  // 記住每台機台「上一個 state」，errorlog 只在狀態轉換時寫，避免高頻洪水。
  private lastState = new Map<string, MachineState>();

  async onModuleInit() {
    this.client = new MongoClient(process.env.MONGO_URL!);
    await this.client.connect();
    this.db = this.client.db(process.env.MONGO_DB ?? 'flow-gatekeeper');
    await this.ensureCollections();
  }

  private async ensureCollections() {
    const names = (await this.db.listCollections().toArray()).map((c) => c.name);

    if (!names.includes('telemetry')) {
      await this.db.createCollection('telemetry', {
        timeseries: {
          timeField: 'timestamp',
          metaField: 'metadata',
          granularity: 'seconds',
        },
        expireAfterSeconds: Number(process.env.TELEMETRY_TTL_SECONDS ?? 604800),
      });
    }

    await this.db.collection('errorlogs').createIndex({ machineId: 1, timestamp: -1 });
    await this.db.collection('maintenanceRecords').createIndex({ machineId: 1, performedAt: -1 });
  }

  /**
   * 一個 tick 的所有機台一起寫，降低 DB round-trip。
   * 注意：呼叫端用 fire-and-forget（void），不要 await 卡住即時推送的 cadence。
   */
  async persistBatch(points: TelemetryPoint[]) {
    if (points.length === 0) return;

    const now = new Date();

    // 1) telemetry：一次 insertMany，而不是逐筆 insertOne。
    const telemetryDocs = points.map((point) => ({
      ...point,
      timestamp: new Date(point.timestamp),
      metadata: { machineId: point.machineId },
    }));

    // 2) errorlogs：只挑「轉換成 warning/critical」的機台。
    const errorDocs: Array<Record<string, unknown>> = [];
    for (const point of points) {
      const prev = this.lastState.get(point.machineId);
      if (point.state !== prev && point.state !== 'healthy') {
        errorDocs.push({
          machineId: point.machineId,
          state: point.state,
          message: `${point.machineId} ${prev ?? 'unknown'} -> ${point.state}`,
          telemetry: point.telemetry,
          timestamp: now,
        });
      }
      this.lastState.set(point.machineId, point.state);
    }

    await this.db.collection('telemetry').insertMany(telemetryDocs, { ordered: false });
    if (errorDocs.length > 0) {
      await this.db.collection('errorlogs').insertMany(errorDocs, { ordered: false });
    }
  }
}
```

### 7.3 Mock telemetry producer

`apps/api/src/modules/telemetry/mock-telemetry.service.ts`：

```ts
import { Injectable } from '@nestjs/common';
import type { TelemetryPoint } from '@flow-gatekeeper/contracts';

const MACHINE_IDS = ['mixer-01', 'press-02', 'pack-03', 'oven-04', 'sorter-05'];

@Injectable()
export class MockTelemetryService {
  private tick = 0;

  nextBatch(): TelemetryPoint[] {
    this.tick += 1;

    return MACHINE_IDS.map((machineId, index) => {
      const noise = Math.sin((this.tick + index * 7) / 12);
      const criticalSpike = this.tick % 240 > 210 && index === 1;
      const warningSpike = this.tick % 180 > 150 && index === 3;

      const temperature = 62 + noise * 8 + (criticalSpike ? 38 : warningSpike ? 18 : 0);
      const vibration = 0.2 + Math.abs(noise) * 0.5 + (criticalSpike ? 1.8 : warningSpike ? 0.8 : 0);
      const throughput = 120 - (criticalSpike ? 45 : warningSpike ? 18 : 0) + noise * 6;
      const errorRate = criticalSpike ? 0.16 : warningSpike ? 0.06 : Math.max(0, noise * 0.01);

      const state =
        temperature > 95 || vibration > 1.7 || errorRate > 0.12
          ? 'critical'
          : temperature > 78 || vibration > 0.9 || errorRate > 0.04
            ? 'warning'
            : 'healthy';

      return {
        type: 'machine/data',
        machineId,
        timestamp: new Date().toISOString(),
        telemetry: {
          temperature: Number(temperature.toFixed(1)),
          vibration: Number(vibration.toFixed(2)),
          throughput: Number(throughput.toFixed(0)),
          errorRate: Number(errorRate.toFixed(3)),
        },
        state,
      };
    });
  }
}
```

### 7.4 WebSocket Gateway 行為

核心需求：

- 用**原生 `ws`** server（掛在 NestJS HTTP server，path `/ws`），不要用 Socket.IO（見 1.5）。
- 自己用 `randomUUID()` 產生 `clientId`，維護 `clientId -> subscribed machineIds`。
- 收到 `{ type: 'machine/subscribe', token, machineIds }`：先驗 token（dev 用 `WS_AUTH_SECRET`），再更新訂閱。
- telemetry producer 每 N ms 產生 batch。
- 對每個 client 只送其訂閱的 machineIds，**送出格式是 `TelemetryPoint` 陣列**。
- `ping` 回 `pong`。
- 持久化用 fire-and-forget，不要 await 卡住推送 cadence。
- disconnect 時清掉 subscription 與 client。
- 對外提供 `send(clientId, payload)`，給 AI relay（8.11）轉發 token/job status 用。

簡化骨架（原生 ws，依 `type` 自行分派，不用 `@SubscribeMessage` 的 event 信封）：

```ts
import { Injectable, OnModuleInit } from '@nestjs/common';
import { WebSocketServer, WebSocket } from 'ws';
import type { Server as HttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { MockTelemetryService } from '../telemetry/mock-telemetry.service.js';
import { HistoryService } from '../history/history.service.js';

type ClientId = string;

@Injectable()
export class MonitoringGateway implements OnModuleInit {
  private wss?: WebSocketServer;
  private clients = new Map<ClientId, WebSocket>();
  private subscriptions = new Map<ClientId, Set<string>>();
  private producerTimer?: NodeJS.Timeout;

  constructor(
    private readonly telemetry: MockTelemetryService,
    private readonly history: HistoryService,
  ) {}

  onModuleInit() {
    const intervalMs = Number(process.env.MOCK_TELEMETRY_INTERVAL_MS ?? 50);
    this.producerTimer = setInterval(() => this.publishTelemetry(), intervalMs);
  }

  /** 由 main.ts 在 app.listen() 後呼叫，與 HTTP 共用同一個 port（ws://localhost:3000/ws）。 */
  attach(server: HttpServer) {
    this.wss = new WebSocketServer({ server, path: '/ws' });
    this.wss.on('connection', (socket) => this.handleConnection(socket));
  }

  private handleConnection(socket: WebSocket) {
    const clientId = randomUUID();
    this.clients.set(clientId, socket);
    this.subscriptions.set(clientId, new Set());
    this.send(clientId, { type: 'system/connected', clientId });

    socket.on('message', (raw) => this.handleMessage(clientId, raw.toString()));
    socket.on('close', () => {
      this.clients.delete(clientId);
      this.subscriptions.delete(clientId);
    });
  }

  private handleMessage(clientId: ClientId, raw: string) {
    let msg: { type?: string; token?: string; machineIds?: string[] };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    switch (msg.type) {
      case 'ping':
        this.send(clientId, { type: 'pong', ts: Date.now() });
        break;
      case 'machine/subscribe': {
        const secret = process.env.WS_AUTH_SECRET;
        if (secret && msg.token !== secret) {
          this.send(clientId, { type: 'system/unauthorized' });
          return;
        }
        this.subscriptions.set(clientId, new Set(msg.machineIds ?? []));
        this.send(clientId, { type: 'machine/subscribed', machineIds: msg.machineIds ?? [] });
        break;
      }
    }
  }

  /** 給 AI relay / job status relay 用：把任意 payload 推給單一 client。 */
  send(clientId: ClientId, payload: unknown) {
    const socket = this.clients.get(clientId);
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(payload));
    }
  }

  private publishTelemetry() {
    const points = this.telemetry.nextBatch();

    // 即時推送：只送訂閱者，格式是 TelemetryPoint[]。
    for (const [clientId, machineIds] of this.subscriptions) {
      const selected = points.filter((point) => machineIds.has(point.machineId));
      if (selected.length > 0) {
        this.send(clientId, selected);
      }
    }

    // 持久化與推送解耦：fire-and-forget，批次寫庫（見 7.2 persistBatch）。
    void this.history.persistBatch(points);
  }
}
```

`apps/api/src/main.ts` 要在 `listen` 後把 HTTP server 交給 gateway：

```ts
const app = await NestFactory.create(AppModule);
await app.listen(Number(process.env.API_PORT ?? 3000));
app.get(MonitoringGateway).attach(app.getHttpServer());
```

### 7.5 Seed maintenance records

`apps/api/src/scripts/seed.ts`：

```ts
import { MongoClient } from 'mongodb';

const client = new MongoClient(process.env.MONGO_URL ?? 'mongodb://127.0.0.1:27017/flow-gatekeeper');

await client.connect();
const db = client.db(process.env.MONGO_DB ?? 'flow-gatekeeper');

await db.collection('maintenanceRecords').deleteMany({});
await db.collection('maintenanceRecords').insertMany([
  {
    machineId: 'press-02',
    performedAt: new Date(Date.now() - 1000 * 60 * 60 * 4),
    summary: 'Replaced vibration damper. Operator noted mild overheating after restart.',
  },
  {
    machineId: 'oven-04',
    performedAt: new Date(Date.now() - 1000 * 60 * 60 * 18),
    summary: 'Temperature sensor calibration completed.',
  },
]);

await client.close();
```

`apps/api/package.json` 要有對應 script（後面 `pnpm --filter api seed` 才跑得起來）：

```json
{
  "scripts": {
    "start:dev": "nest start --watch",
    "seed": "tsx src/scripts/seed.ts"
  }
}
```

### 7.6 Feature 002 驗收

```bash
docker compose up -d
pnpm --filter api start:dev
pnpm --filter api seed
```

因為 Gateway 採**原生 ws**，可直接用 `wscat` 連線驗證：

```bash
wscat -c ws://localhost:3000/ws
# 連上後送：
> {"type":"machine/subscribe","token":"replace_me_dev_only","machineIds":["press-02"]}
```

應陸續收到 `system/connected`、`machine/subscribed`，以及 `TelemetryPoint` 陣列。完整整合驗收在 Feature 004 用前端做。

通過條件：

- 多 client 訂閱不同 machineIds 不串資料。
- MongoDB `telemetry` 有資料。
- `errorlogs` 有 warning/critical 事件。
- client disconnect 後 `subscriptions` map 被清理。

commit：

```bash
git add -A
git commit -m "feat(002): realtime gateway telemetry mock and mongo history"
git checkout main
git merge 002-realtime-gateway-history
```

---

## 8. Feature 003：BullMQ Worker、AI Streaming、Redis Cache

Branch：

```bash
git checkout main
git checkout -b 003-bullmq-ai-streaming
```

### 8.1 `/speckit.specify` prompt

```text
建立 flow-gatekeeper 的 BullMQ 診斷任務、獨立 worker process、AI streaming、Redis cache-aside、MongoDB diagnosis persistence。

範圍：
- API 提供 POST /diagnoses 建立 diagnosis job。
- BullMQ queue 使用 Redis，設定 limiter、attempts、exponential backoff。
- Worker 獨立 process 消化 job。
- Worker 先用 prompt signature 查 Redis ai-cache。
- Cache miss 才呼叫 LLM provider streaming。
- Worker 每個 token publish 到 Redis Pub/Sub channel ai-stream:<jobId>。
- Gateway 訂閱 ai-stream:*，把 token/done/error 轉發給對應 client。
- Worker 讀 MongoDB 最近 telemetry/errorlogs/maintenanceRecords 組 prompt。
- Final diagnosis 寫入 MongoDB diagnoses collection。

成功條件：
- 連續觸發 20 個 diagnosis request 不超過 AI_RPM。
- Cache hit 回傳 cached:true 且不呼叫 LLM。
- Worker 掛掉時 API/Gateway 不崩潰。
- 前端可看到 token streaming 與 job status。
```

### 8.2 先做 Gemini smoke test

在接 queue 前先確認 API key 與模型可用。

`apps/worker/src/ai/smoke-gemini.ts`：

```ts
import 'dotenv/config';
import { GoogleGenerativeAI } from '@google/generative-ai';

const key = process.env.GEMINI_API_KEY;
if (!key) throw new Error('GEMINI_API_KEY is missing');

const modelName = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash';
const genAI = new GoogleGenerativeAI(key);
const model = genAI.getGenerativeModel({ model: modelName });

const result = await model.generateContent('Reply with one short sentence: flow-gatekeeper ready.');
console.log(result.response.text());
```

執行：

```bash
pnpm --filter worker smoke:gemini
```

若失敗，先修 API key、模型名稱或帳號額度，不要急著接 BullMQ。

### 8.3 Queue constants 與 payload

`packages/contracts/src/jobs.ts`：

```ts
export const DIAGNOSIS_QUEUE = 'diagnosis';

export type DiagnosisJobPayload = {
  jobId: string;
  machineId: string;
  requestedBy: string;
  requestedAt: string;
  windowMinutes: number;
  promptVersion: string;
};
```

`packages/contracts/src/index.ts`（在 6.9 既有的 schemas/events 之外，補上 jobs；三者都要保留，worker 才 import 得到 `DiagnosisResultSchema`）：

```ts
export * from './schemas.js';
export * from './events.js';
export * from './jobs.js';
```

### 8.4 API 建立 job

`apps/api/src/modules/jobs/jobs.service.ts`：

```ts
import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { DIAGNOSIS_QUEUE, type DiagnosisJobPayload } from '@flow-gatekeeper/contracts';
import { AiStreamRelayService } from '../websocket/ai-stream-relay.service.js';

@Injectable()
export class JobsService {
  constructor(
    @InjectQueue(DIAGNOSIS_QUEUE) private readonly queue: Queue<DiagnosisJobPayload>,
    private readonly relay: AiStreamRelayService,
  ) {}

  async createDiagnosis(machineId: string, requestedBy: string, socketId: string) {
    const jobId = randomUUID();

    // 關鍵：把 jobId 綁到觸發的 WS client，relay 才知道 token/job status 要推給誰。
    // socketId 是前端從 system/connected 收到的 clientId。
    this.relay.bindJobToClient(jobId, socketId);

    const payload: DiagnosisJobPayload = {
      jobId,
      machineId,
      requestedBy,
      requestedAt: new Date().toISOString(),
      windowMinutes: 5,
      promptVersion: 'diagnosis-v1',
    };

    await this.queue.add('diagnose-machine', payload, {
      jobId,
      removeOnComplete: { age: 3600, count: 1000 },
      removeOnFail: { age: 86400, count: 5000 },
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
    });

    return { jobId, machineId, status: 'waiting' as const };
  }
}
```

> **綁定的邊界要講清楚**：`jobId -> clientId` 是記憶體 Map，client 一旦重連，`clientId` 會換新，舊綁定就失效。正式做法是讓前端「重連後用 jobId 重新訂閱」，或把對應關係寫進 Redis（key `ai-job-client:<jobId>`，短 TTL）。Side project demo 用記憶體 Map 可接受，但 README/驗收要註明這個限制。

`apps/api/src/modules/jobs/jobs.controller.ts`：

```ts
import { Body, Controller, Post } from '@nestjs/common';
import { JobsService } from './jobs.service.js';

@Controller('diagnoses')
export class JobsController {
  constructor(private readonly jobs: JobsService) {}

  @Post()
  create(@Body() body: { machineId: string; requestedBy?: string; socketId: string }) {
    return this.jobs.createDiagnosis(
      body.machineId,
      body.requestedBy ?? 'demo-user',
      body.socketId,
    );
  }
}
```

> 前端按下 Diagnose 時，POST body 要帶上目前的 `socketId`（即連線時收到的 `clientId`）。沒有 `socketId` 就無法把 streaming 推回正確的 client。

### 8.5 BullMQ limiter

`apps/api/src/modules/jobs/jobs.module.ts` 與 worker 都要使用相同 queue name。Limiter 建議放 worker 建立處：

```ts
import { Worker } from 'bullmq';
import { DIAGNOSIS_QUEUE } from '@flow-gatekeeper/contracts';

const connection = {
  host: process.env.REDIS_HOST ?? '127.0.0.1',
  port: Number(process.env.REDIS_PORT ?? 6379),
};

const worker = new Worker(
  DIAGNOSIS_QUEUE,
  async (job) => {
    // process job
  },
  {
    connection,
    concurrency: 2,
    limiter: {
      max: Number(process.env.AI_RPM ?? 8),
      duration: 60_000,
    },
  },
);
```

### 8.6 Redis connection 分工

不要把 BullMQ connection、publisher、subscriber 混用：

```ts
import IORedis from 'ioredis';

export function createRedisConnection() {
  return new IORedis({
    host: process.env.REDIS_HOST ?? '127.0.0.1',
    port: Number(process.env.REDIS_PORT ?? 6379),
    maxRetriesPerRequest: null,
  });
}

export const queueConnection = createRedisConnection();
export const pubConnection = createRedisConnection();
export const subConnection = createRedisConnection();
export const cacheConnection = createRedisConnection();
```

### 8.7 Cache signature

簽章不要含秒級 timestamp，否則永遠 miss。也不要太粗，否則不同問題撞同一份診斷。

```ts
import { createHash } from 'node:crypto';

export function buildDiagnosisSignature(input: {
  machineId: string;
  state: string;
  topErrorCodes: string[];
  promptVersion: string;
  model: string;
}) {
  const stable = JSON.stringify({
    machineId: input.machineId,
    state: input.state,
    topErrorCodes: [...input.topErrorCodes].sort(),
    promptVersion: input.promptVersion,
    model: input.model,
  });

  return createHash('sha256').update(stable).digest('hex').slice(0, 24);
}
```

### 8.8 Context builder

`apps/worker/src/context/context-builder.ts`：

```ts
import { MongoClient } from 'mongodb';

export async function buildDiagnosisContext(input: {
  mongo: MongoClient;
  machineId: string;
  windowMinutes: number;
}) {
  const db = input.mongo.db(process.env.MONGO_DB ?? 'flow-gatekeeper');
  const since = new Date(Date.now() - input.windowMinutes * 60_000);

  const telemetryAgg = await db.collection('telemetry').aggregate([
    { $match: { 'metadata.machineId': input.machineId, timestamp: { $gte: since } } },
    {
      $group: {
        _id: '$metadata.machineId',
        avgTemp: { $avg: '$telemetry.temperature' },
        maxTemp: { $max: '$telemetry.temperature' },
        avgVibration: { $avg: '$telemetry.vibration' },
        maxVibration: { $max: '$telemetry.vibration' },
        avgErrorRate: { $avg: '$telemetry.errorRate' },
        maxErrorRate: { $max: '$telemetry.errorRate' },
        count: { $sum: 1 },
      },
    },
  ]).toArray();

  const errorlogs = await db.collection('errorlogs')
    .find({ machineId: input.machineId, timestamp: { $gte: since } })
    .sort({ timestamp: -1 })
    .limit(5)
    .toArray();

  const maintenance = await db.collection('maintenanceRecords')
    .find({ machineId: input.machineId })
    .sort({ performedAt: -1 })
    .limit(3)
    .toArray();

  const latest = await db.collection('telemetry')
    .find({ 'metadata.machineId': input.machineId })
    .sort({ timestamp: -1 })
    .limit(1)
    .toArray();

  // 給 cache signature 用：當前狀態 + 近期錯誤類型，cache 才會反映嚴重度。
  const latestState = String(latest[0]?.state ?? 'unknown');
  const topErrorCodes = errorlogs.map((e) => String(e.state ?? 'unknown'));

  return {
    telemetrySummary: telemetryAgg[0] ?? null,
    errorlogs,
    maintenance,
    latestState,
    topErrorCodes,
  };
}
```

### 8.9 Prompt builder

```ts
export function buildPrompt(input: {
  machineId: string;
  context: {
    telemetrySummary: unknown;
    errorlogs: unknown[];
    maintenance: unknown[];
  };
}) {
  return `
You are an industrial operations assistant for flow-gatekeeper.

Machine: ${input.machineId}

Most important recent errors:
${JSON.stringify(input.context.errorlogs, null, 2)}

Telemetry aggregate:
${JSON.stringify(input.context.telemetrySummary, null, 2)}

Recent maintenance records:
${JSON.stringify(input.context.maintenance, null, 2)}

Return a concise diagnosis as JSON with this shape:
{
  "summary": "string",
  "severity": "ok | warning | critical",
  "likelyCauses": ["string"],
  "suggestedActions": [
    { "label": "string", "priority": "low | medium | high", "command": "optional string" }
  ],
  "evidence": [
    { "source": "telemetry | errorlog | maintenance", "id": "optional string", "excerpt": "string" }
  ]
}
`.trim();
}
```

### 8.9.1 AI provider 隔離（換 LLM 不動主邏輯）

決策 1.3 說 provider 要包在 interface 後面。worker 主邏輯只依賴這個 interface，換 Claude API 只要再寫一個 adapter。

`apps/worker/src/ai/provider.ts`：

```ts
export interface AiProvider {
  /**
   * 串流回傳診斷文字；每段 token 觸發 onToken，最後回傳完整文字。
   * 不在這裡解析 JSON，解析與 schema 驗證留在 worker。
   */
  streamDiagnosis(prompt: string, onToken: (text: string) => Promise<void> | void): Promise<string>;
}
```

`apps/worker/src/ai/gemini-provider.ts`：

```ts
import { GoogleGenerativeAI } from '@google/generative-ai';
import type { AiProvider } from './provider.js';

export class GeminiProvider implements AiProvider {
  private readonly model;

  constructor(apiKey: string, modelName: string) {
    this.model = new GoogleGenerativeAI(apiKey).getGenerativeModel({ model: modelName });
  }

  async streamDiagnosis(prompt: string, onToken: (text: string) => Promise<void> | void) {
    const stream = await this.model.generateContentStream(prompt);
    let full = '';
    for await (const chunk of stream.stream) {
      const text = chunk.text();
      if (!text) continue;
      full += text;
      await onToken(text);
    }
    return full;
  }
}
```

> 未來要換 Claude，就新增 `claude-provider.ts implements AiProvider`，worker 只改一行 `const ai = new GeminiProvider(...)`。

### 8.10 Worker processor

`apps/worker/src/main.ts`：

```ts
import 'dotenv/config';
import { Worker } from 'bullmq';
import { MongoClient } from 'mongodb';
import {
  DIAGNOSIS_QUEUE,
  DiagnosisResultSchema,
  type DiagnosisJobPayload,
  type DiagnosisResult,
} from '@flow-gatekeeper/contracts';
import { createRedisConnection } from './redis.js';
import { buildDiagnosisContext } from './context/context-builder.js';
import { buildDiagnosisSignature } from './cache/signature.js';
import { buildPrompt } from './ai/prompt.js';
import { GeminiProvider } from './ai/gemini-provider.js';
import type { AiProvider } from './ai/provider.js';

const queueConnection = createRedisConnection();
const pub = createRedisConnection();
const cache = createRedisConnection();
const mongo = new MongoClient(process.env.MONGO_URL!);
await mongo.connect();

const modelName = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash';
// 換 LLM 只改這一行；其餘邏輯只依賴 AiProvider interface（見 1.3 / 8.9.1）。
const ai: AiProvider = new GeminiProvider(process.env.GEMINI_API_KEY!, modelName);

const CACHE_TTL = Number(process.env.AI_CACHE_TTL_SECONDS ?? 600);
const LOCK_TTL = Number(process.env.AI_DEDUPE_LOCK_SECONDS ?? 45);

async function publish(jobId: string, event: unknown) {
  await pub.publish(`ai-stream:${jobId}`, JSON.stringify(event));
}

async function saveDiagnosis(machineId: string, jobId: string, result: DiagnosisResult, cached: boolean) {
  const db = mongo.db(process.env.MONGO_DB ?? 'flow-gatekeeper');
  await db.collection('diagnoses').insertOne({ machineId, jobId, cached, result, createdAt: new Date() });
}

/** 從串流文字抽 JSON 並用 Zod 驗證；驗證失敗就丟錯（由 failed handler 轉成 ai/error）。 */
function parseResult(text: string): DiagnosisResult {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('AI response does not contain JSON object');
  }
  return DiagnosisResultSchema.parse(JSON.parse(text.slice(start, end + 1)));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const worker = new Worker<DiagnosisJobPayload>(
  DIAGNOSIS_QUEUE,
  async (job) => {
    const payload = job.data;
    await job.updateProgress(5);

    const context = await buildDiagnosisContext({
      mongo,
      machineId: payload.machineId,
      windowMinutes: payload.windowMinutes,
    });

    // signature 含「當前 state」，cache 才會反映嚴重度，不會把舊 critical 診斷命中現在 healthy 的機台。
    const signature = buildDiagnosisSignature({
      machineId: payload.machineId,
      state: context.latestState,
      topErrorCodes: context.topErrorCodes,
      promptVersion: payload.promptVersion,
      model: modelName,
    });

    const cacheKey = `ai-cache:${signature}`;
    const lockKey = `ai-lock:${signature}`;

    const replyCached = async () => {
      const hit = await cache.get(cacheKey);
      if (!hit) return false;
      const result = JSON.parse(hit) as DiagnosisResult;
      await publish(payload.jobId, { type: 'ai/done', jobId: payload.jobId, cached: true, result });
      await job.updateProgress(100);
      return true;
    };

    // 1) cache hit 直接回。
    if (await replyCached()) return;

    // 2) dedupe lock：同 signature 同時間只有一個 worker 真的打 LLM。
    const locked = await cache.set(lockKey, '1', 'EX', LOCK_TTL, 'NX');
    if (!locked) {
      // 別人正在算：短暫等待後改吃 cache，避免重複消耗 RPM。
      for (let i = 0; i < 10; i++) {
        await sleep(500);
        if (await replyCached()) return;
      }
      // 仍沒有結果就放行自己算（lock 可能已過期）。
    }

    try {
      const prompt = buildPrompt({ machineId: payload.machineId, context });
      let seq = 0;
      await job.updateProgress(20);

      const fullText = await ai.streamDiagnosis(prompt, async (text) => {
        await publish(payload.jobId, { type: 'ai/token', jobId: payload.jobId, seq: seq++, text });
      });

      const result = parseResult(fullText);
      await cache.set(cacheKey, JSON.stringify(result), 'EX', CACHE_TTL);
      await saveDiagnosis(payload.machineId, payload.jobId, result, false);
      await publish(payload.jobId, { type: 'ai/done', jobId: payload.jobId, cached: false, result });
      await job.updateProgress(100);
      return result;
    } finally {
      await cache.del(lockKey);
    }
  },
  {
    connection: queueConnection,
    concurrency: 2,
    limiter: {
      max: Number(process.env.AI_RPM ?? 8),
      duration: 60_000,
    },
  },
);

worker.on('failed', async (job, err) => {
  if (!job) return;
  await publish(job.data.jobId, {
    type: 'ai/error',
    jobId: job.data.jobId,
    code: 'worker_failed',
    message: err.message,
  });
});

process.on('SIGTERM', async () => {
  await worker.close();
  await mongo.close();
  process.exit(0);
});
```

### 8.11 Gateway 轉發 AI Pub/Sub 與 QueueEvents

`apps/api/src/modules/websocket/ai-stream-relay.service.ts`：

```ts
import { Injectable, OnModuleInit } from '@nestjs/common';
import IORedis from 'ioredis';
import { MonitoringGateway } from './monitoring.gateway.js';

@Injectable()
export class AiStreamRelayService implements OnModuleInit {
  private sub!: IORedis;
  private jobRooms = new Map<string, string>(); // jobId -> clientId

  constructor(private readonly gateway: MonitoringGateway) {}

  bindJobToClient(jobId: string, clientId: string) {
    this.jobRooms.set(jobId, clientId);
  }

  async onModuleInit() {
    // subscriber connection 專用，不要拿去跑一般 command。
    this.sub = new IORedis({
      host: process.env.REDIS_HOST ?? '127.0.0.1',
      port: Number(process.env.REDIS_PORT ?? 6379),
    });

    await this.sub.psubscribe('ai-stream:*');
    this.sub.on('pmessage', (_pattern, channel, payload) => {
      const jobId = channel.replace('ai-stream:', '');
      const clientId = this.jobRooms.get(jobId);
      if (!clientId) return;

      const event = JSON.parse(payload) as { type?: string };
      this.gateway.send(clientId, event);

      // 終態後清掉綁定，避免 Map 無限成長。
      if (event.type === 'ai/done' || event.type === 'ai/error') {
        this.jobRooms.delete(jobId);
      }
    });
  }
}
```

QueueEvents relay 可在 API process 內訂閱 `active/completed/failed/progress`，組成 `job/status` 後一樣用 `gateway.send(clientId, payload)` 推給綁定的 client（clientId 一樣從 `jobRooms` 查）。

### 8.12 Feature 003 驗收

```bash
docker compose up -d
pnpm --filter api start:dev
pnpm --filter worker start:dev
```

另開 terminal：

`socketId` 正常來自連線中的前端（`system/connected` 給的 `clientId`）。純後端 smoke test 可先填任意字串——job 仍會跑完、寫 Mongo、進 cache，只是沒有 client 收得到 streaming。

```bash
curl -X POST http://localhost:3000/diagnoses \
  -H "Content-Type: application/json" \
  -d '{"machineId":"press-02","requestedBy":"demo","socketId":"manual-test"}'
```

PowerShell：

```powershell
Invoke-RestMethod `
  -Method Post `
  -Uri http://localhost:3000/diagnoses `
  -ContentType "application/json" `
  -Body '{"machineId":"press-02","requestedBy":"demo","socketId":"manual-test"}'
```

通過條件：

- API 回傳 `jobId`。
- Worker log 顯示 job active。
- Redis Pub/Sub 有 `ai-stream:<jobId>` event。
- Gateway 能把 token 轉給 client。
- 同一 signature 第二次呼叫回 `cached: true`。
- MongoDB `diagnoses` 有結果。
- 停掉 worker 時，API/Gateway 不崩潰。

commit：

```bash
git add -A
git commit -m "feat(003): bullmq worker ai streaming cache and context"
git checkout main
git merge 003-bullmq-ai-streaming
```

---

## 9. 設計階段：Claude Design 交接

> 這個階段在 Feature 004/005 前做，因為前端元件要共用同一套視覺 token。

**本階段不是 Spec Kit feature，而是一次性的「設計固化 + 前端視覺地基」交接。** 產出雖然不多，
但都是 Feature 004/005 元件的共同前提：`apps/web/design/`（design-spec + refs 截圖）與可用的
Tailwind token 設定。做完這一階段，後續 feature 才有「唯一視覺真實來源」可依。

**與 constitution / CLAUDE.md 的關係**：CLAUDE.md 明訂視覺真實來源是
`apps/web/design/design-spec.md` 與 `apps/web/design/refs/*.png`——不是 `docs/design-spec.md`。
本專案的完整規格目前放在 `docs/design-spec.md`（v0.3），本階段的第一件事就是把它落地到
`apps/web/design/`，之後 **以 `apps/web/design/design-spec.md` 為單一 canonical 檔**，避免兩處
內容分岔。（見下方 9.1 的「single source」註記。）

> ⚠️ **不要重寫這一段的規格細節。** `docs/design-spec.md` 已經有完整的 token、Tailwind
> `theme.extend`（§5）、component states（§7）、interaction states（§8）、file mapping（§9）、
> screenshot 驗收（§11）與驗收清單（§12）。本章只負責「交接流程與落地步驟」，token/尺寸/狀態
> 的細節一律回去讀 design-spec，衝突時以 design-spec 為準。

### 9.1 建立設計資料夾並落地 design-spec

環境為 Windows / PowerShell，**以 PowerShell 為主**：

```powershell
New-Item -ItemType Directory -Force apps/web/design/refs

# 把完整規格落地為前端 canonical 檔（首次交接時執行一次）
Copy-Item docs/design-spec.md apps/web/design/design-spec.md
```

POSIX（Bash 工具）等價：

```bash
mkdir -p apps/web/design/refs
cp docs/design-spec.md apps/web/design/design-spec.md
```

**Single source 註記**：落地後，前端一切以 `apps/web/design/design-spec.md` 為準。若日後
Claude Design 更新規格，建議只維護這一份（可把 `docs/design-spec.md` 留成歷史起點，或在其
開頭加一行「已移轉至 `apps/web/design/design-spec.md`，本檔不再更新」指標），避免兩份分岔造成
coding agent 讀到過期 token。

### 9.2 為什麼要截圖 + token

Claude Code 讀的是 repo 檔案，不會自動看到你另一個視窗的 Claude Design 畫布，也讀不到雲端
畫布連結。**視覺若不固化進 repo，coding agent 只能憑空猜**——這正是硬規則要禁止的。  
所以必須把設計固化成下列五項 artifact，全部進 repo：

1. `apps/web/design/refs/layout.png`
2. `apps/web/design/refs/node-states.png`
3. `apps/web/design/refs/copilot-drawer.png`
4. `apps/web/design/design-spec.md`（token 與 component state 的文字真實來源）
5. Tailwind `theme.extend`（把 design-spec §5 的 token 變成程式可用的具名 class）

前 4 項是「設計」，第 5 項是「讓設計可被元件引用」。少了第 5 項，元件就會開始散落 hex，違反
硬規則。落地步驟見 9.4、9.5。

### 9.3 Claude Design 三個 prompt

請依序做，不要一次要求整個產品。這三個 prompt 與 design-spec §2.2–2.4 的三段 prompt 對齊
（layout → node states → copilot drawer）；若 design-spec 有更新，以 design-spec 版本為準。
每做完一層就輸出對應截圖並更新 design-spec 對應段落，再做下一層。

**Prompt 1：Layout**

```text
Design a dark operational dashboard for a side project called flow-gatekeeper, inspired by the topology/status language of Argo CD but not copying its brand assets.

The first screen must be the actual monitoring console, not a marketing page.
Create a dense but readable layout with:
- left sidebar for machine groups
- top bar with connection status, search, mock frequency control, and diagnose action
- central topology or node grid
- right AI Copilot drawer
- optional bottom event strip

Use a restrained engineering visual style. Avoid purple gradients, decorative blobs, and rounded oversized cards. Provide design tokens for colors, typography, spacing, border radius, shadows, and component states.
Output one desktop reference image and list the exact tokens.
```

**Prompt 2：Node states**

```text
Using the same flow-gatekeeper design tokens, design the MachineNodeCard component states:
- healthy
- warning
- critical
- selected
- stale
- hover

Each card must show machine id, current state, temperature, vibration, throughput, error rate, and a diagnose icon button.
Critical state should be urgent but not visually noisy. Provide exact color tokens, border styles, status light behavior, and animation guidance.
```

**Prompt 3：Copilot drawer**

```text
Using the same flow-gatekeeper design tokens, design the AI Copilot drawer.

It must support:
- idle state
- active BullMQ job with progress
- streaming AI tokens
- completed diagnosis with severity, likely causes, evidence, and suggested actions
- failed state with retry

The drawer should feel like an engineering tool: compact, readable, and suitable for repeated use. Provide exact spacing, typography, colors, component states, and mobile bottom-sheet behavior.
```

### 9.4 把截圖放進 repo

Claude Design 的畫布在雲端，coding agent 看不到，所以要手動把每一層匯出成 PNG 放進
`apps/web/design/refs/`：

1. 在 Claude Design 對每個畫布 **Export / Download** 成 PNG（desktop 尺寸，建議 ≥1440 寬）。
2. 存檔時 **檔名必須完全對上** design-spec 的引用（大小寫、連字號都要一致）：
   - `layout.png`
   - `node-states.png`
   - `copilot-drawer.png`
3. 放到 `apps/web/design/refs/`，本機開圖確認不是空檔 / 破圖。
4. 這些是二進位資產，直接 commit 進 repo（見 9.7）；不要放進 `.gitignore`，也不要塞進
   `apps/web/public/`（refs 是設計交接資產，不是 runtime 靜態檔）。

> 檔名對不上就等於沒交接：design-spec §6/§7 用 `refs/layout.png` 之類的相對路徑引用，
> coding agent 依這些路徑找圖，命名不一致會讓引用失效。

### 9.5 Tailwind token 落地（前端視覺地基）

這一步把 design-spec §5 的 token 變成元件可引用的具名 class，是 Feature 004 元件能「只用
token、不散落 hex」的前提。`tailwindcss` / `postcss` / `autoprefixer` 相依已在
`apps/web/package.json`，只差設定檔與 CSS 進入點（目前 `apps/web` 尚無 `tailwind.config.ts`、
`postcss.config.js` 或 CSS 進入點）。

**1) `apps/web/tailwind.config.ts`** — `content` 掃描 Vue/TS 來源，`theme.extend` **直接貼上
design-spec §5 的區塊**（colors / borderRadius / boxShadow / fontFamily / keyframes / animation）。
不要在這裡自行改色票；要改色去改 design-spec，再同步過來。

```ts
import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{vue,ts}'],
  theme: {
    extend: {
      // ⬇⬇ 原封不動貼上 apps/web/design/design-spec.md §5 的 theme.extend 內容
      // colors / borderRadius / boxShadow / fontFamily / keyframes / animation
    },
  },
  plugins: [],
} satisfies Config;
```

**2) `apps/web/postcss.config.js`**：

```js
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
```

**3) CSS 進入點** `apps/web/src/styles/tailwind.css`：

```css
@tailwind base;
@tailwind components;
@tailwind utilities;
```

**4) 在 entry 匯入** `apps/web/src/main.ts` 頂部加：

```ts
import './styles/tailwind.css';
```

**5) 驗證**：`pnpm --filter web dev` 起得來、`pnpm --filter web build` 過，且用一個 token class
（如 `class="bg-base text-fg"`）試出正確色。**token 名稱必須與 design-spec §5 一字不差**
（`base`、`surface`、`fg-muted`、`accent`、`ok`/`warn`/`crit`、`rounded-card`、`shadow-drawer`、
`animate-critical-pulse` 等），元件才能照 design-spec 直接引用。

> 這個 Tailwind 設定要不要算進本階段、還是併入 Feature 004 的第一個 commit，取捨見 9.7。
> 無論放哪，token 名稱都以 design-spec §5 為單一來源。

### 9.6 沒有 Claude Design 存取時的 fallback

若當下拿不到 Claude Design（沒帳號 / 時間不夠），仍可讓 Feature 004 先動起來：

- design-spec §4 的 token 全都附了「**建議預設**」值，§5 也已給出可直接用的 `theme.extend`，
  足以 bootstrap 第一版視覺——先照 9.5 把 Tailwind 設定接起來即可開工。
- 但 `refs/*.png` 仍是 **驗收硬需求**（design-spec §12、下方 9.7）。fallback 只是「延後截圖」，
  不是「免截圖」：等有 Claude Design 後補齊三張圖，並回頭核對實作與截圖一致。
- 用 fallback 開工時，MUST 在該 feature 的實作摘要 / PR 描述標註「refs 待補」，避免驗收時
  才發現缺圖。

### 9.7 設計階段驗收與收尾

驗收清單以 **design-spec §12** 為 canonical（`refs` 三張圖存在、token 與 Tailwind 一致、
component states 齊全、第一屏是監控台、未用 Argo CD 官方素材等）。本階段另外補查 Tailwind 落地：

- `apps/web/design/design-spec.md` 已落地，且與 `docs/design-spec.md` 未分岔（見 9.1）。
- `apps/web/design/refs/{layout,node-states,copilot-drawer}.png` 三張都存在且可開啟。
- `apps/web/tailwind.config.ts` 的 `theme.extend` 與 design-spec §5 逐項一致（無自行新增/改動色票）。
- `apps/web/postcss.config.js` 與 CSS 進入點就緒，`pnpm --filter web build` 通過。
- 前端 component 引用 token class，不散落 hex（此點在 Feature 004 元件落地時持續把關）。

**分支與 commit（本階段不是 `/speckit.implement`，回到「只在使用者要求時才 commit」的預設）**：

- 不在 `develop` 直接 commit。二選一：
  1. 開一條短命分支（如 `design/003-handoff`）承接本階段產出，完成後 `--no-ff` 併回 `develop`；或
  2. 直接把本階段產出併進 Feature 004 分支的最前面（design-spec 落地 + refs + Tailwind 設定當
     004 的第一批 commit）。**推薦此法**，因為 9.5 的 Tailwind 設定本就是 004 元件的直接前提。
- commit type 建議：design-spec 落地與 refs → `docs`；Tailwind/PostCSS 設定 → `build`。
  例如 `docs(design): 落地 design-spec 與 refs 截圖至 apps/web/design` 、
  `build(web): 接上 Tailwind theme.extend 與 PostCSS`。
- refs 是二進位資產，直接 commit；祕密防護（硬規則 7）不受影響——refs/token 不含祕密。

---

## 10. Feature 004：前端高頻 WebSocket Gatekeeper

Branch：

```bash
git checkout main
git checkout -b 004-frontend-ws-gatekeeper
```

### 10.1 `/speckit.specify` prompt

```text
在 apps/web 實作 monitoring domain 與高頻 WebSocket gatekeeper。

範圍：
- Vue 3 + Pinia 建立 monitoring store。
- useHighFrequencyWs hook：onmessage 只 push buffer，不直接寫 reactive state。
- requestAnimationFrame 每幀批次提交 telemetry。
- 支援 ping/pong heartbeat、指數退避重連、manual close。
- AppLayout、MachineNodeCard、StatusLight 使用 design-spec token。
- UI 可訂閱 machineIds，顯示最新 telemetry、state、lastUpdated。
- TopBar 放 BackpressureBadge，顯示 `receivedMessages`、`renderedBatches` 與比值（store getter `batchRatio`）。

成功條件：
- 10-50ms telemetry 下 UI 不明顯卡頓。
- Performance recording 中 reactive update 次數小於 message 次數。
- 斷線後自動重連。
- 卡片文字不溢出、不互相遮擋。
- BackpressureBadge 在畫面上即時顯示比值（高頻時應遠大於 1:1）。
```

### 10.2 Pinia store

```ts
import { defineStore } from 'pinia';
import type { TelemetryPoint } from '@flow-gatekeeper/contracts';

export const useMonitoringStore = defineStore('monitoring', {
  state: () => ({
    machines: new Map<string, TelemetryPoint>(),
    selectedMachineId: null as string | null,
    connectionStatus: 'disconnected' as 'connected' | 'reconnecting' | 'disconnected',
    receivedMessages: 0,
    renderedBatches: 0,
  }),
  getters: {
    // 背壓比值：收到 N 筆訊息只觸發 M 次渲染批次。給 TopBar 的 BackpressureBadge 用。
    batchRatio(state): number {
      return state.renderedBatches > 0
        ? Math.round(state.receivedMessages / state.renderedBatches)
        : 0;
    },
  },
  actions: {
    applyTelemetryBatch(batch: TelemetryPoint[]) {
      for (const point of batch) {
        this.machines.set(point.machineId, point);
      }
      this.receivedMessages += batch.length;
      this.renderedBatches += 1;
    },
    selectMachine(machineId: string) {
      this.selectedMachineId = machineId;
    },
  },
});
```

### 10.3 `useHighFrequencyWs`

```ts
import { onUnmounted, ref } from 'vue';

type Options<T> = {
  url: string;
  onBatch: (events: T[]) => void;
  onStatus?: (status: 'connected' | 'reconnecting' | 'disconnected') => void;
  onConnected?: (clientId: string) => void;
  heartbeatMs?: number;
  maxReconnectMs?: number;
  /** buffer 上限，避免分頁切到背景（rAF 暫停）時 buffer 無限成長吃記憶體。 */
  maxBufferSize?: number;
};

export function useHighFrequencyWs<T>(opts: Options<T>) {
  const buffer: T[] = [];
  const cap = opts.maxBufferSize ?? 2000;
  const clientId = ref<string | null>(null);

  let ws: WebSocket | null = null;
  let rafId = 0;
  let heartbeatTimer: number | undefined;
  let pongTimer: number | undefined;
  let reconnectTimer: number | undefined;
  let attempt = 0;
  let manualClose = false;

  const push = (item: T) => {
    buffer.push(item);
    // 超過上限就丟最舊的，保最新（telemetry 舊值無意義）。
    if (buffer.length > cap) buffer.splice(0, buffer.length - cap);
  };

  const pump = () => {
    // 注意：分頁在背景時 rAF 不觸發，buffer 由上述 cap 護住；切回前景會一次 flush。
    if (buffer.length > 0) {
      opts.onBatch(buffer.splice(0, buffer.length));
    }
    rafId = window.requestAnimationFrame(pump);
  };

  const startHeartbeat = () => {
    heartbeatTimer = window.setInterval(() => {
      if (ws?.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: 'ping' }));
      pongTimer = window.setTimeout(() => ws?.close(), 5000);
    }, opts.heartbeatMs ?? 15000);
  };

  const connect = () => {
    if (attempt > 0) opts.onStatus?.('reconnecting');
    ws = new WebSocket(opts.url);

    ws.onopen = () => {
      attempt = 0;
      opts.onStatus?.('connected');
      startHeartbeat();
    };

    ws.onmessage = (event) => {
      const parsed = JSON.parse(event.data);

      // 1) 陣列 = telemetry batch，逐筆進 buffer。
      if (Array.isArray(parsed)) {
        for (const item of parsed) push(item as T);
        return;
      }

      // 2) 控制訊息：依 type 分流，不要污染 telemetry buffer。
      switch ((parsed as { type?: string }).type) {
        case 'pong':
          window.clearTimeout(pongTimer);
          return;
        case 'system/connected':
          clientId.value = (parsed as { clientId: string }).clientId;
          opts.onConnected?.(clientId.value);
          return;
        case 'machine/subscribed':
        case 'system/unauthorized':
          return;
        default:
          // 其餘（ai/token、ai/done、job/status…）視為事件，交給 onBatch 處理。
          push(parsed as T);
      }
    };

    ws.onclose = () => {
      window.clearInterval(heartbeatTimer);
      window.clearTimeout(pongTimer);
      opts.onStatus?.('disconnected');
      if (!manualClose) reconnect();
    };

    ws.onerror = () => ws?.close();
  };

  const reconnect = () => {
    opts.onStatus?.('reconnecting');
    const base = Math.min(1000 * 2 ** attempt, opts.maxReconnectMs ?? 30000);
    attempt += 1;
    reconnectTimer = window.setTimeout(connect, base + Math.random() * base * 0.3);
  };

  connect();
  rafId = window.requestAnimationFrame(pump);

  onUnmounted(() => {
    manualClose = true;
    window.cancelAnimationFrame(rafId);
    window.clearInterval(heartbeatTimer);
    window.clearTimeout(pongTimer);
    window.clearTimeout(reconnectTimer);
    ws?.close();
  });

  return {
    clientId, // ref<string | null>：給 POST /diagnoses 的 socketId 用。
    send: (payload: unknown) => ws?.send(JSON.stringify(payload)),
    close: () => {
      manualClose = true;
      ws?.close();
    },
  };
}
```

### 10.4 Feature 004 驗收

- 開 DevTools Performance 錄製 30 秒，沒有明顯 long task。
- mock frequency 拉到 10ms，UI 仍可操作。
- `receivedMessages` 遠大於 `renderedBatches`，代表 batching 成立。
- TopBar 的 BackpressureBadge 直接在畫面上顯示這個比值（不用開 DevTools 就看得到）。
- 關掉 API 再打開，前端 reconnect。

commit：

```bash
git add -A
git commit -m "feat(004): frontend websocket gatekeeper and monitoring UI"
git checkout main
git merge 004-frontend-ws-gatekeeper
```

---

## 11. Feature 005：AI Copilot Drawer

Branch：

```bash
git checkout main
git checkout -b 005-copilot-ui-design
```

### 11.1 `/speckit.specify` prompt

```text
在 apps/web 實作 AI Copilot drawer。

範圍：
- 使用 design-spec token 與 refs/copilot-drawer.png 視覺。
- 顯示 selected machine 的 diagnosis job 狀態。
- job/status 事件更新 progress：waiting/active/completed/failed。
- ai/token 事件 append streaming text。
- ai/done 顯示 severity、summary、likely causes、evidence、suggestedActions。
- ai/error 顯示錯誤與 retry。
- 同一 machine active job 期間 disable duplicate submit。
- Cache hit 顯示 cached badge。

成功條件：
- 點 Diagnose 後 drawer 立刻進入 active。
- token 逐段顯示，不等 done。
- done 後 structured result 正確渲染。
- failed 可 retry。
- desktop/mobile 不溢出。
```

### 11.2 Copilot store state machine

```ts
type CopilotState =
  | { status: 'idle' }
  | { status: 'active'; jobId: string; machineId: string; progress: number; text: string }
  | { status: 'completed'; jobId: string; machineId: string; cached: boolean; text: string; result: DiagnosisResult }
  | { status: 'failed'; jobId?: string; machineId: string; message: string };
```

事件對應：

| Event | UI 更新 |
| --- | --- |
| `job/status waiting` | 建立 active state，progress 0 |
| `job/status active` | progress 10-80 |
| `ai/token` | append `text` |
| `ai/done` | completed，顯示 result |
| `ai/error` | failed |
| `job/status failed` | failed |

### 11.3 Feature 005 驗收

- 點 critical node 的 Diagnose，drawer active。
- progress bar 動作。
- token streaming 可見。
- final result 顯示 severity badge、evidence、suggested actions。
- 第二次同樣診斷顯示 cached。
- mobile bottom sheet 可用。

commit：

```bash
git add -A
git commit -m "feat(005): ai copilot drawer with streaming diagnosis"
git checkout main
git merge 005-copilot-ui-design
```

---

## 12. 本機啟動與端到端 Demo

### 12.1 第一次啟動

Terminal 1：infra

```bash
docker compose up -d
docker compose ps
```

Terminal 2：API

```bash
pnpm --filter api seed
pnpm --filter api start:dev
```

Terminal 3：worker

```bash
pnpm --filter worker start:dev
```

Terminal 4：web

```bash
pnpm --filter web dev
```

### 12.2 Demo 劇本

1. 開 `http://localhost:5173`。
2. 看到 machine cards 持續更新。
3. 顯示 connection status 為 connected。
4. 把 mock frequency 調快，指著 TopBar 的 BackpressureBadge 說明：收進上萬筆訊息、只觸發數百次渲染批次（例如 41:1），這就是 rAF batching 的背壓效果，把抽象說法變成畫面上看得見的數字。
5. 等待或手動切出 critical machine。
6. 點 Diagnose。
7. drawer 顯示 job active。
8. token streaming 開始。
9. done 後顯示 severity、likely causes、evidence、suggested actions。
10. 再點同一台同類型錯誤，顯示 cached。
11. 暫停 worker，再建立 job，說明 API/Gateway 不崩潰且 job 可追蹤。

### 12.3 面試時 60 秒講法

```text
flow-gatekeeper 是我用 Spec Kit 做的一個即時監控與 AI 診斷 side project。
前端面對 10-50ms 級 WebSocket telemetry，不逐筆寫 reactive state，而是先進 buffer，再用 requestAnimationFrame 批次提交，所以能穩住 UI。
後端用 NestJS Gateway 處理 WebSocket，BullMQ 把診斷任務丟給獨立 worker，避免 AI 呼叫阻塞主服務。
Worker 沒有 WebSocket connection，所以 AI token streaming 走 Redis Pub/Sub 回 Gateway，再轉送前端。
MongoDB 存 telemetry、errorlogs、maintenanceRecords 與 diagnoses；Redis 負責 queue、cache、Pub/Sub、dedupe lock。
整個開發流程用 Spec Kit 的 constitution/spec/plan/tasks/implement 管理，每個 feature 都有驗收條件。
```

---

## 13. 常見坑

| 問題 | 解法 |
| --- | --- |
| 前端 `new WebSocket` 連不上後端 | 後端不能用 Socket.IO，要用原生 `ws`（見 1.5）。兩者協定不相容。 |
| streaming 推不到前端 | 檢查 `POST /diagnoses` 有沒有帶 `socketId`，以及 relay 是否 `bindJobToClient`。 |
| `.env` 不小心出現在 `git status` | 立刻確認 `.gitignore`，不要 commit；若已 commit，要移除歷史或換 key。 |
| Worker 想直接 emit WebSocket | 不要。Worker 透過 Redis Pub/Sub，Gateway 負責 WebSocket。 |
| Pub/Sub connection 卡住 | Redis subscriber connection 不要拿去做一般 command。 |
| Cache 永遠 miss | 檢查 signature 是否含 timestamp 或過細欄位。 |
| Cache 錯誤命中 | signature 加入 promptVersion、model、machineId、error summary。 |
| 前端仍卡頓 | 確認 `onmessage` 沒有直接寫 store，並量測 renderedBatches。 |
| AI 回傳非 JSON | final result 要 schema validation；必要時做 repair prompt 或 fallback error。 |
| 429 | 降低 `AI_RPM`，確認 BullMQ limiter 與 retry/backoff 生效。 |
| 設計對不齊 | 更新 `refs/*.png` 與 `design-spec.md`，不要只憑口頭描述。 |

---

## 14. 指令速查

```bash
# install Spec Kit
uv tool install specify-cli --from git+https://github.com/github/spec-kit.git@vX.Y.Z
specify init flow-gatekeeper --integration claude

# feature flow
/speckit.constitution
/speckit.specify
/speckit.clarify
/speckit.plan
/speckit.checklist
/speckit.tasks
/speckit.analyze
/speckit.implement
/speckit.converge

# env
cp .env.example apps/api/.env
cp .env.example apps/worker/.env
git status --short

# infra
docker compose up -d
docker compose ps

# checks
pnpm install
pnpm contract:lint
pnpm typecheck
pnpm lint

# run
pnpm --filter api seed
pnpm --filter api start:dev
pnpm --filter worker start:dev
pnpm --filter web dev
```

---

## 15. 參考來源

- 架構決策 ADR-001（原生 WebSocket vs Socket.IO）：`docs/adr-001-native-websocket.md`
- GitHub Spec Kit 官方 repo：`https://github.com/github/spec-kit`
- Spec Kit installation guide：`https://github.com/github/spec-kit/blob/main/docs/installation.md`
- BullMQ 官方文件：`https://docs.bullmq.io/`
- MongoDB time-series collections：`https://www.mongodb.com/docs/manual/core/timeseries-collections/`
- AsyncAPI 2.6：`https://www.asyncapi.com/docs/reference/specification/v2.6.0`

