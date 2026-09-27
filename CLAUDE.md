<!-- SPECKIT START -->
<!-- 提醒：下次執行 speckit-agent-context-update 會覆寫本區塊，屆時再把 current plan 指向新 feature 的 plan.md。 -->
目前**無進行中的 SDD feature**；最近一次完成的是 009（`specs/009-observability-baseline/plan.md`）。
009 之後的修復與升級見兩輪審查報告 `docs/20260927-research-review.md`、`docs/20260927-research-review02.md`（數字與結論以第二輪為準；`fix/20260927-research-review`、`upgrade/20260927-tech-stack`、`fix/20260927-research-review02` 皆已併入 `develop`），
現況摘要見 `docs/Flow-Gatekeeper-SDD-完整實作指南.md` §15.6「v1.0.0 之後的現況摘要」。技術棧、結構與指令以 README 與指南為準。
<!-- SPECKIT END -->

# flow-gatekeeper — Agent 操作指引

flow-gatekeeper 是一個致敬 Argo CD 的即時流程監控與 AI 診斷 side project，用 GitHub Spec Kit（SDD）開發。
**工程原則以 `.specify/memory/constitution.md` 為準**；本檔只放 constitution 不會逐 feature 重述的操作層約束。

## 溝通語言

- 與使用者的**對話輸出一律用繁體中文**：回報成果、說明、詢問問題、摘要都用繁體中文。
- 技術識別項照原文：程式碼、指令、檔名/路徑、Conventional Commits 前綴、API/token 名稱、既有英文術語不翻譯。

## 真實來源（Source of Truth，不得憑空發明）

- **視覺**：一律依 `apps/web/design/design-spec.md` 與 `apps/web/design/refs/*.png`。顏色、圓角、陰影、間距一律用具名 token，**不在元件內散落 hex**。
- **通訊契約**：一律依 `packages/contracts`（Zod schema 為單一來源，type 由 `z.infer` 推導）與 `asyncapi.yaml`。新增 event/payload 先改契約，再改 API/worker/web。
- **開發步驟**：依 `docs/Flow-Gatekeeper-SDD-完整實作指南.md`。指南中的完整 code 區塊是「期望產出 / reference」，正式流程仍走 Spec Kit。
- **架構決策**：重大技術取捨記錄在 `docs/adr-*.md`。即時通道為何用原生 ws 而非 Socket.IO，見 `docs/adr-001-native-websocket.md`。
- **跨 Feature 決策 MUST 回補真實來源**（核心規則已收錄於憲章 Governance；本段保留操作細節）：SDD 流程**任一階段**（specify／clarify／plan／checklist／tasks／analyze／implement／驗收）**與所有維護分支**（`fix/*`、`upgrade/*`、`docs/*`，見「維護分支」小節）修正或新定的決策，若影響**當前 feature／分支以外**的範圍（修改既定藍圖方向、推翻先前假設、調整共用契約／參數／指令形狀、變更後續 feature 依賴的行為語意），MUST 在該 feature／分支收尾（merge 回 `develop`）前寫入對應的真實來源，**並同步修訂既有內容使其與新決策一致、消除矛盾**（受影響的舊段落須一併改寫，不得留下自相矛盾的敘述）：
  - 架構／執行／設計細節與 feature 藍圖 → `docs/Flow-Gatekeeper-SDD-完整實作指南.md` 相關章節、後續 feature 的方向藍圖／spec 草稿；
  - 重大技術取捨 → `docs/adr-*.md`；
  - 涉及**非協商原則**時 → `.specify/memory/constitution.md`（走 `/speckit-constitution` 修訂）；
  - 影響使用者操作面時 → `README.md`；
  - 契約或產品版本變更 → `asyncapi.yaml` 的 `info.version` 與 `CHANGELOG.md`（見「維護分支」小節的契約升版規則）。

  **MUST NOT** 只寫進 Agent memory、或僅留在當前 feature 的 spec/clarify/tasks 工件（或維護分支的審查報告）就當作已定案——Agent memory 可作輔助備忘，但不是專案真實來源；**未同步到上述文件前，該跨 Feature 決策一律視為「未落地」**。理由：下一條 feature 起草時以這些文件為據，決策未回補就會拿過時決策開發、造成邏輯衝突。回補時**不重寫歷史**：ADR 的決策背景、指南的「由來」段保留原敘述（必要時改過去式、標註「已落地／已變更，現況見 ×××」），只更新「現況描述」。範例：007 把崩潰語意翻轉落地後，指南 §13 狀態改為「已落地」、「log + 續跑」但書收斂為歷史敘述。

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

- 沿用 Conventional Commits 前綴（`feat:`、`fix:`、`build:`、`ci:`、`chore:`、`docs:`、`refactor:`、`test:`…），**前綴後的描述一律用中文撰寫**。
- **type 選用準則**（依該 commit 的主要性質擇一）：
  - `feat`：交付對使用者/產品有意義的**能力增量**（如共用契約、可連線 infra、祕密防護門檻）。
  - `fix`：修正錯誤行為。
  - `build`：建置系統、相依與工具設定（`pnpm-workspace`、root/套件 `package.json`、`tsconfig`、`eslint` 設定、lockfile、`vite.config` 等）。
  - `ci`：CI 設定（如 `.github/workflows/*`）。
  - `chore`：上述未涵蓋的雜項維護與純鷹架（如尚無內容的 placeholder 模組）。
  - `docs` / `test` / `refactor`：文件 / 測試 / 不改行為的重構。
- 可帶 scope，例如 feature 編號：`feat(001): ...`。
- 範例：
  - `feat(004): 加入高頻 WebSocket gatekeeper 與監控 UI`
  - `fix: 修正 worker dedupe lock 過期後重複呼叫 LLM`
  - `build: 初始化 pnpm workspace 與 tsconfig`
  - `ci: 新增 GitHub Actions 契約 lint 與 typecheck 流程`
- **預設**：只在使用者要求時才 commit；在開發主支 `develop` 上要先開 feature branch 或維護分支（見「維護分支」小節）。

### `/speckit-implement` 階段的 phase-by-phase 自動 commit（預設規則的例外）

在執行 `/speckit-implement` 時，**以 tasks.md 的 phase 為遞交單位，每完成一個 phase 就自動
commit**，不需逐次徵詢；流程為：

1. 完成該 phase 的所有任務並就地驗證（typecheck/test/lint 等該 phase 可驗的部分）。
2. 先在 `tasks.md` 把該 phase 的對應任務勾選為 `[X]`。
3. 就該 phase 的成果建立 commit。**目標：讓人看 commit 歷史就能還原開發的順序與過程。**
   顆粒度規則：
   - **基本規律**：一個 phase 一個 commit。
   - **大 phase 拆細**：當該 phase 更動範圍大、檔案多，或混入不同性質產物時，SHOULD 依
     **主要開發大項**（子模組或性質）拆成顆粒度更細的多個 commit，使過程更清楚（例如
     Foundational 可拆成「packages 骨架」「apps 骨架」「安裝與 lockfile」）。
   - **顆粒度以「開發大項」為界**：不設死的數字上限——以「自然的大項」決定切幾個即可，
     依大項拆成 6 個也屬合理；真正要避免的是**切得過細的零碎 commit**。若一個 phase 切出
     明顯瑣碎、難以一眼看懂順序的 commit，應回頭合併同性質者（一般落在數個以內）。
   - 拆分後每個 commit 仍標記**同一 phase**，並以子題中文描述區分；commit 順序須反映實際
     建置順序。
4. **commit 標題 MUST 標記 phase**：格式為
   `<type>(<feature>): [Phase <n>: <名稱>] <中文描述>`。
   - `<type>` 依該 commit 主要性質擇一（見上方「type 選用準則」）：Setup 的工具/設定 → `build`；
     相依/lockfile → `build`；CI 設定 → `ci`；純鷹架（空骨架）→ `chore`；User Story 能力增量 →
     `feat`；測試 → `test`；Polish/文件 → `docs`。同一 phase 拆出的多個 commit 可有不同 type。
   - 單一 phase 範例（未拆）：
     - `build(001): [Phase 1: Setup] 初始化 pnpm workspace 與工具鏈`
     - `feat(001): [Phase 3: US1] 一鍵啟動可驗證工作區與本機 infra`
     - `feat(001): [Phase 4: US2] 共用契約、AsyncAPI 與三端匯入`
     - `docs(001): [Phase 6: Polish] 驗收與 tasks/checklist 勾選`
   - 大 phase 拆細範例（依主要開發大項，type 可不同）：
     - `chore(001): [Phase 2: Foundational] 建立 packages 契約與 shared 骨架`
     - `chore(001): [Phase 2: Foundational] 建立 api/worker/web app 骨架`
     - `build(001): [Phase 2: Foundational] 安裝相依並產生 lockfile`
     - `ci(001): [Phase 5: US3] 新增 GitHub Actions 四道檢查`
5. 該 phase 的 `tasks.md` 勾選變更**併入該 phase 的 commit**（若拆多個，併入收尾的那個），
   使勾選與成果在 git 歷史對齊。

> 注意：此自動 commit 僅限 `/speckit-implement` 執行期間。其餘所有情境仍回到「只在使用者
> 要求時才 commit」的預設。仍 MUST 在 feature branch 上進行（不在 `develop` 直接 commit），
> 且絕不提交祕密（見工程硬規則 7）。

## SDD 流程提醒

- 開發主支為 `develop`。每個正式 feature 從 `develop` 開新 branch，走完整流程：
  `/speckit-specify -> clarify -> plan -> checklist -> tasks -> analyze -> implement -> 驗收 -> merge 回 develop`，完成後再從 `develop` 開下一條 feature branch。
- 不要在同一 branch 混多個大 feature；不要又手貼完整 code 又跑 `/speckit-implement`（會互相覆蓋）。

### 維護分支（fix／upgrade／docs）

不走 SDD 流程的修復、升級與文件工作（例如審查報告的修復批次、技術棧升級）一律走**維護分支**，不直接 commit 到 `develop`。

- **命名**：`fix/<yyyymmdd>-<topic>`、`upgrade/<yyyymmdd>-<topic>`、`docs/<topic>`（審查報告等有日期意義者可用 `docs/<yyyymmdd>-<topic>`）。
  實例：`fix/20260927-research-review02`、`upgrade/20260927-tech-stack`、`docs/20260927-research-review02`。
- **分支來源與併回**：一律從 `develop` 開、驗收後以 `--no-ff` 併回 `develop`（規則同下節「Merge 回 `develop` 的方式」）。
- **commit scope**：用 topic 短名作 scope，描述照樣用中文；分批工作可在描述前加批次標記（類比 SDD 的 `[Phase <n>: <名稱>]`），
  如 `[Batch A]`、`[final-review]`。實例：
  - `fix(review02): [Batch A] shared logger 遮蔽 Redis 密碼、interval／timer 驗證…`
  - `build(review02): [Batch A] compose 綁定與限流、restart 策略…`
  - `docs(upgrade): 回補升級後的文件矛盾（pnpm 10、SystemMetrics Zod 化…）`
- **merge 訊息**：`merge(<topic>): 併入 <branch>`，`<topic>` 取能辨識該分支的短名。
  實例：`merge(fix-review02): 併入 fix/20260927-research-review02`、`merge(upgrade): 併入 upgrade/20260927-tech-stack`、
  `merge(docs): 併入 docs/20260927-research-review02`。
- **收尾前 MUST 回補真實來源**：「跨 Feature 決策 MUST 回補真實來源」同樣適用於維護分支——merge 回 `develop` 前 MUST 把影響範圍外的決策
  寫進 `README.md`、指南 §15.6「v1.0.0 之後的現況摘要」（及相關章節）、`docs/adr-*.md`、`CHANGELOG.md`；只寫在審查報告或 Agent memory 不算落地。
- **契約變更 MUST 升版**：動到 `packages/contracts` 的 message／payload（WS 或 HTTP）時，MUST 升 `asyncapi.yaml` 的 `info.version`
  並在 `CHANGELOG.md` 的契約小節記一筆（SDD feature 分支同樣適用）。版本策略：**release 時** git tag、六份 `package.json` 的 `version`
  與 `CHANGELOG.md` 頂端條目三者 MUST 一致；開發期 `package.json` 可先升到預定版本，`CHANGELOG.md` 頂端維持 `[Unreleased]`，
  於 release 步驟 1 改為版本與日期（詳見 `CHANGELOG.md`「版本策略」）。契約版本（`asyncapi.yaml` `info.version`）獨立演進、不跟產品版本綁定。
- 既有歷史中未帶日期的舊分支（如 `fix/copilot-panel-and-stuck-diagnosis`、`docs/readme`、`chore/dev-scripts`）**不改名、不改寫歷史**；本小節自此對之後的維護分支生效。

### Merge 回 `develop` 的方式：MUST `--no-ff`，不得 fast-forward

- 驗收通過、要把 feature branch（或維護分支，見上節）併回 `develop` 時，**MUST** 使用
  `git merge --no-ff <feature-branch>`，明確建立一個 merge commit。
  **MUST NOT** 用 fast-forward（不可用 `--ff-only`，也不可讓預設行為悄悄 fast-forward）。
- **理由**：fast-forward 會把 feature 的所有 commit 直接攤平接到 `develop` 的歷史上，
  不會留下任何「這個 feature 在此結束」的標記。`--no-ff` 強制產生一個 merge commit，
  讓 `develop` 的 git log（`git log --oneline --graph`）能清楚看出每個 feature 的收尾點，
  也方便之後用 `git log develop --merges` 快速列出每次 feature 完成的時間點。
- **執行步驟**：
  ```bash
  git checkout develop
  git merge --no-ff <feature-branch>
  git push origin develop
  ```
- **merge commit 訊息**：MUST 標記 feature 編號與名稱，格式為
  `merge(<feature>): 併入 <feature-branch>`，例如：
  `merge(001): 併入 001-foundation-contracts`。
- 若 `git merge --no-ff` 因故仍判定為 fast-forward 而未產生 merge commit（例如 git 版本
  差異），MUST 改用 `git merge --no-ff --no-edit` 或確認後手動補一個空 merge commit，
  不得放任 fast-forward 結果留在 `develop` 上。
- merge 完成後的 push 會改變共享的遠端狀態，SHOULD 先與使用者確認再 push，除非使用者已明確授權。
- 既有歷史中 006、007 與數個 fix/docs 分支的 merge commit 仍是 git 預設的 `Merge branch '…'`，
  **不改寫既有 git 歷史**；本規則自此對之後的 merge 生效。

### `main` 的 release 流程

`main` 只接收**發布**，日常開發與 feature merge 一律在 `develop`。發布時：

1. 確認 `develop` 上 `pnpm check` 與 `pnpm build` 通過、README／指南／ADR 已回補（見「跨 Feature 決策 MUST 回補真實來源」），
   契約有變更時 `asyncapi.yaml` 的 `info.version` 已升版且 `CHANGELOG.md` 契約小節有紀錄；六份 `package.json`（root、
   `apps/{api,worker,web}`、`packages/{contracts,shared}`）的 `version` 已升到目標版本，並與 `CHANGELOG.md` 頂端條目一致
   （把 `[Unreleased]` 改為該版本與發布日期）。
2. `git checkout main` → `git merge --no-ff develop`，merge commit 訊息格式為
   `merge(release): 併入 develop 準備 <版本> 發布`（前例：`merge(release): 併入 develop 準備第一版發布（v1.0.0）`）。
3. 在該 merge commit 上打 annotated tag：`git tag -a vX.Y.Z -m "flow-gatekeeper vX.Y.Z：<中文摘要>"`（前例：`flow-gatekeeper v1.0.0：第一版正式發布`）。
4. 建立 GitHub Release（對應 tag），上傳 demo 影片等二進位資產；README「端到端操作 Demo」的連結指向
   `releases/download/vX.Y.Z/flow-gatekeeper-demo.mp4`、海報圖指向 `raw/main/docs/demo/...`——重錄 demo 或換版時
   MUST 同步更新這兩個連結，避免 README 指到舊版或不存在的資產。
5. push `main` 與 tag（`git push origin main --follow-tags`）屬影響共享狀態的操作，SHOULD 先與使用者確認。
   發布後若 `main` 上有直接修正（例如 README 連結），MUST 回併 `develop`，不讓兩支分岔。
