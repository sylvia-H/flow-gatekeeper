<!-- SPECKIT START -->
For additional context about technologies to be used, project structure,
shell commands, and other important information, read the current plan
<!-- SPECKIT END -->

# flow-gatekeeper — Agent 操作指引

flow-gatekeeper 是一個致敬 Argo CD 的即時流程監控與 AI 診斷 side project，用 GitHub Spec Kit（SDD）開發。
**工程原則以 `memory/constitution.md` 為準**；本檔只放 constitution 不會逐 feature 重述的操作層約束。

## 真實來源（Source of Truth，不得憑空發明）

- **視覺**：一律依 `apps/web/design/design-spec.md` 與 `apps/web/design/refs/*.png`。顏色、圓角、陰影、間距一律用具名 token，**不在元件內散落 hex**。
- **通訊契約**：一律依 `packages/contracts`（Zod schema 為單一來源，type 由 `z.infer` 推導）與 `asyncapi.yaml`。新增 event/payload 先改契約，再改 API/worker/web。
- **開發步驟**：依 `docs/Flow-Gatekeeper-SDD-完整實作指南.md`。指南中的完整 code 區塊是「期望產出 / reference」，正式流程仍走 Spec Kit。
- **架構決策**：重大技術取捨記錄在 `docs/adr-*.md`。即時通道為何用原生 ws 而非 Socket.IO，見 `docs/adr-001-native-websocket.md`。

## 環境

- 作業系統 **Windows**。終端機預設 **PowerShell**：用 `Copy-Item`、`New-Item -ItemType Directory -Force`、`Remove-Item -Recurse -Force`，不要用 `cp`/`mkdir -p`/`rm -rf`。Bash 工具是 POSIX，兩者語法不要混。
- 套件管理用 **pnpm workspace**；指令用 `pnpm --filter <pkg> <script>`。
- monorepo 佈局：`apps/{api,worker,web}`、`packages/{contracts,shared}`。
- 全棧 **strict TypeScript**，避免 `any` 擴散。
- 本機 infra 用 `docker compose up -d`（Redis 7 + MongoDB 7）。

## 工程硬規則（最容易被違反，務必遵守）

1. **高頻事件不得逐筆寫 reactive state**：WebSocket telemetry 先進 buffer，再用 `requestAnimationFrame` 每幀批次提交。
2. **即時通道一律用原生 `ws`，不要用 Socket.IO**：前端是 `new WebSocket()`，後端是 `ws` 套件掛在 NestJS HTTP server（path `/ws`）。兩者協定不相容，混用會在整合階段壞掉。決策理由見 `docs/adr-001-native-websocket.md`。
3. **Worker 不得直接 emit WebSocket**：worker 是獨立 process，AI token 走 Redis Pub/Sub（`ai-stream:<jobId>`）→ Gateway 轉發。
4. **LLM provider 必須包在 `AiProvider` interface 後面**：worker 主邏輯只依賴 interface，換 provider 只改 adapter。
5. **Cache before API**：可重複的診斷先查 Redis cache；signature 含 `state`/`promptVersion`/`model`，並用 `ai-lock:<sig>` 去重，避免重複打 LLM。
6. **AI 回傳必須 schema 驗證**：用 `DiagnosisResultSchema.parse()`，失敗走 `ai/error`，不要把未驗證物件當結果。
7. **Secrets hygiene**：只提交 `.env.example`，絕不提交 `.env`、API key、token。

## Commit 規範

- 沿用 Conventional Commits 前綴（`feat:`、`fix:`、`chore:`、`docs:`、`refactor:`、`test:`…），**前綴後的描述一律用中文撰寫**。
- 可帶 scope，例如 feature 編號：`feat(001): ...`。
- 範例：
  - `feat(004): 加入高頻 WebSocket gatekeeper 與監控 UI`
  - `fix: 修正 worker dedupe lock 過期後重複呼叫 LLM`
  - `chore: 初始化 spec kit workspace`
- 只在使用者要求時才 commit；在預設分支上要先開 feature branch。

## SDD 流程提醒

- 每個正式 feature 從 `main` 開新 branch，走完整流程：
  `/speckit.specify -> clarify -> plan -> checklist -> tasks -> analyze -> implement -> 驗收 -> commit/merge`。
- 不要在同一 branch 混多個大 feature；不要又手貼完整 code 又跑 `/speckit.implement`（會互相覆蓋）。
