# Research: Full-Stack Containerization & One-Command Demo（Phase 0）

前提：監督者選型與生產化分期已由 [ADR-002](../../docs/adr-002-productionization-scope.md) §2／§4／§5 定案，非本檔議題；入口拓樸（單一入口、同源相對路徑）、模式分組命名（`demo`）、seed 時機（一次性服務）、監督參數（重啟 5 次／寬限 15s）、健康判定依據（`/ws` 握手）與祕密缺漏處置（沿用現行語意）已由 [spec.md Clarifications](./spec.md#clarifications) 定案，本檔不重議、只收斂其之下的實作層決策。

所有 Technical Context 項目皆已解析，無殘留 NEEDS CLARIFICATION。

## D1：web 映像的靜態伺服 ＋ 反向代理——`nginx:alpine`

- **Decision**: web runtime 階段用 `nginx:alpine`，以 `apps/web/nginx.conf` 同時提供 `vite build` 產物的靜態檔與 `/ws`、`/diagnoses` 至 `api:3000` 的反向代理。upstream 以 `resolver` + **變數式** `proxy_pass` 宣告（理由見下「upstream 解析」），`/ws` 另須顯式帶 WebSocket 升級標頭：

  ```nginx
  resolver 127.0.0.11 valid=10s ipv6=off;   # Docker 內建 DNS
  set $api_upstream api:3000;

  location /ws {
    proxy_pass http://$api_upstream;        # 變數式：延後解析（見「upstream 解析」）
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600s;
  }
  ```

- **Rationale**: spec 的入口拓樸要求「靜態檔 + 同源反向代理」兩件事由同一個容器承擔，nginx 是唯一兩者皆為內建能力、零應用程式碼的選項；`proxy_http_version 1.1` + `Upgrade`/`Connection` 標頭是 ws 穿透反向代理的必要條件（HTTP/1.0 不支援 upgrade），漏掉會讓握手退化為一般 HTTP 請求而失敗——這正是 FR-006 最容易破的地方。SPA fallback 以 `try_files $uri $uri/ /index.html` 處理。
- **`proxy_read_timeout` 的理由**: nginx 預設 60s 無資料即斷讀。api 的 `WS_HEARTBEAT_MS=15000` 使通道不會靜默 60s，故預設值其實夠用；但把它設為 3600s 是**移除一個隱形變因**——FR-014 要求行為與現行模式逐項一致，而現行 vite dev proxy 無此上限，留著預設值等於在 demo 路徑上埋一顆與 dev 模式不一致的計時器。
- **upstream 解析（`resolver` + 變數式 `proxy_pass`）**: `proxy_pass http://api:3000;` 這種**字面 hostname 的寫法，nginx 只在啟動時解析一次並永久快取結果**。api 容器因 `restart: on-failure` 重啟後若取得不同 IP，nginx 會持續轉發到失效位址——症狀是「web 入口載入正常、即時通道永遠連不上」，**直接使 SC-003（≤30s 自行重連、不需人工介入）失敗**。更糟的是它與「重啟上限耗盡」的症狀**完全同形**，展示者當下無從分辨（唯一的區分點是 `docker compose ps` 顯示 api 為 `running`）。
  改法：宣告 `resolver 127.0.0.11 valid=10s ipv6=off;`（Docker 內建 DNS 位址，compose 環境固定）並以 `set $api_upstream api:3000;` + `proxy_pass http://$api_upstream;` 讓解析延後到請求當下、每 10s 失效重查。`proxy_pass` 後**不接 URI 路徑**，以保留原始請求 URI 不被改寫（接了 `/` 才會觸發 nginx 的 URI 替換語意）。
  **風險量級的誠實評估**: `restart:` 重啟的是**同一個容器**，Docker 通常保留其 network endpoint 與 IP，故此問題**未必**每次都發生——但「未必」不等於「不會」，而其代價是 SC-003 這條明文 success criterion 在 demo 當下無聲失敗、且症狀誤導。修正成本為 2 行設定，故不接受此風險。由 quickstart 場景 2f 實測驗證。
  > **修訂註（analyze 修正）**: 本段為 analyze 發現 C2 後補入——原 D1 只討論 ws 升級標頭，未觸及 upstream 解析；且原 tasks 的崩潰重啟驗收只在場景 1c（dev 前端直連 api、不經 nginx），此路徑在 demo 拓樸下從未被驗證。
- **Alternatives considered**: Caddy——設定更短且自動處理 ws 升級，但引入團隊不熟的第二套代理心智、且其賣點（自動 TLS）在明文本機 demo 完全用不到，捨棄；Node 端（`serve` + `http-proxy`）——可復用既有工具鏈，但要為此寫應用程式碼與相依，等於自造一個弱化版 nginx，違反 ADR-002「不造輪子」，捨棄；把靜態檔交給 api 服務（NestJS `ServeStaticModule`）——會讓 api 兼任前端伺服、與「api 不對外暴露連接埠」的拓樸直接矛盾，且屬執行語意變更（FR-014），捨棄。
- **待驗證（實作時）**: `nginx:alpine` 的 healthcheck 需要一個 HTTP 探測工具。alpine 的 busybox 提供 `wget`，故 `wget -q --spider http://127.0.0.1/` 應可用；若該映像實際不含 `wget`，改以 nginx 自身的 `stub_status` 或退回 `nc -z`。此為 tasks 階段的實測項，不影響本決策。

## D2：入口連接埠——`8080`

- **Decision**: 全棧 demo 的單一入口為 `http://localhost:8080`（compose `ports: ["8080:80"]`）。api MUST NOT 宣告 `ports`。
- **Rationale**: 必須避開兩個既有佔用——`5173`（vite dev server）與 `3000`（api dev 直跑）。Edge case「同時啟動兩種模式」要求衝突可預期；若 demo 入口沿用 5173，開發模式與 demo 模式就會在**同一個埠**上互撞，症狀是「連上了但不知道連到哪一個」——這比啟動失敗更難診斷。選一個兩模式都沒用過的埠，使衝突退化為「埠被佔用」這種一眼可辨的失敗。8080 是 HTTP 替代埠的通用慣例，對評估者無需解釋。
- **Alternatives considered**: `80`——免打埠號最漂亮，但 Windows 上常被 IIS／`http.sys` 佔用，且低於 1024 在部分環境需特權，為了省 5 個字元換一類難解的環境問題，捨棄；沿用 `5173`——與 dev 模式互撞（見上），捨棄；`3000`——與 api dev 互撞，且語意上是後端埠，捨棄。
- **可設定性**: 入口埠以 compose 的 `ports` 直接寫定即可，MUST NOT 為此引入根目錄 `.env` 插值——理由同 Clarifications 對「編排宣告必填」的排除（會產生第二層語意不同的 `.env`，傷及 SC-007）。需改埠者直接改 compose 一行；Edge case「入口位址非預設值」的驗收即以此方式實測（改為非 8080 後前端仍須能連上，同源相對路徑使其自然成立）。

## D3：api／web 映像建置形態——沿用 007 的多階段 + `pnpm deploy`

- **Decision**: `apps/api/Dockerfile` 全面沿用 [apps/worker/Dockerfile](../../apps/worker/Dockerfile) 的形狀：`node:22-alpine` builder → 先複製 manifests 裝依賴（layer cache）→ 複製源碼 → 依序 build `contracts`／`shared`／`api` → `pnpm deploy --filter @flow-gatekeeper/api --prod /out` → runtime 階段 `COPY --from=builder /out .`、`CMD ["node", "dist/main.js"]`。`apps/web/Dockerfile` 的 builder 階段同理（build `contracts`／`shared`／`web`），但 runtime 換成 `nginx:alpine`、只 `COPY --from=builder /repo/apps/web/dist /usr/share/nginx/html`（web 產物是純靜態檔，不需要 node runtime 與 `pnpm deploy` 裁剪）。
- **Rationale**: 007 的形態已在本 repo 實證可用（含 pnpm workspace 的 frozen lockfile 陷阱與 workspace 依賴實體化），複製既有解遠優於重新推導；三個 Dockerfile 形狀一致也讓 FR-009「注入方式在三端間一致」在建置層先成立。
- **api 的 `dist` 佈局**: `tsc -p tsconfig.build.json` 只排除 `*.test.ts`／`*.check.ts`，故 `src/` 的其餘檔案皆鏡射到 `dist/`——`dist/main.js`（入口）、`dist/scripts/seed.js`（D7）、`dist/healthcheck.js`（D6）三個進入點全部由**同一次建置、同一個映像**產出，不需額外映像。此為 007「healthcheck 作為映像第二進入點」模式的直接沿用。
- **Alternatives considered**: 單一 Dockerfile 以 `target` 分支產出三映像——省一個檔案，但把三種 runtime（node ×2、nginx ×1）擠進一檔會讓 layer cache 與可讀性都變差，捨棄。

## D4：`.dockerignore` 由「worker 專用」改為「三映像共用」

- **Decision**: 重寫 [.dockerignore](../../.dockerignore)——移除 `apps/api/src`、`apps/api/test`、`apps/web/src`、`apps/web/public`、`apps/web/design`、`apps/web/index.html` 六條排除；祕密防線（`**/.env`、`!**/.env.example`）、依賴與產物（`**/node_modules`、`**/dist`）、版控與工具狀態（`.git`、`.specify`、`.claude` 等）一律維持。
- **Rationale**: **這是本 feature 最容易被忽略的破壞點**。現行 `.dockerignore` 的註解明講「與 worker 映像無關的內容」——它是為單一映像調校的，但 build context 由 repo root 起算、**三個映像共用同一份 `.dockerignore`**。不改的話 api／web 映像會在 builder 階段找不到自己的源碼而建置失敗（web 連 `index.html` 都不在 context 裡）。註解也須同步改寫，否則會留下「排除 api/web 源碼是刻意的」這種與現況矛盾的敘述。
- **祕密防線不受影響**: 放行的是源碼目錄，`**/.env` 的排除與 `!**/.env.example` 的放行完全不動，SC-006（映像內祕密數為 0）的機制保證不變。
- **代價（明文接受）**: build context 變大（多了 api/web 源碼與 design 資產）。以本 repo 規模屬可忽略；`**/node_modules`、`**/dist`、`.git` 這三個真正的大宗仍被排除。

## D5：api 優雅關閉的實作形狀——`enableShutdownHooks()` + 顯式 SIGTERM handler

- **Decision**: `apps/api/src/main.ts` 的 `bootstrap()` 補上 `app.enableShutdownHooks()`，並顯式註冊 `SIGTERM`／`SIGINT` handler：`await app.close()` → `process.exit(0)`；收尾錯誤記 log 後仍以 0 退出（形狀對齊 [apps/worker/src/main.ts:257-258](../../apps/worker/src/main.ts#L257-L258)）。
- **Rationale**: 查證確認 [apps/api/src/main.ts:24-28](../../apps/api/src/main.ts#L24-L28) 的 `bootstrap()` **既無 `enableShutdownHooks()` 也無任何訊號 handler**，故四個既有 `onModuleDestroy`（[history](../../apps/api/src/modules/history/history.service.ts#L33)、[ai-stream-relay](../../apps/api/src/modules/websocket/ai-stream-relay.service.ts#L51)、[job-status-relay](../../apps/api/src/modules/websocket/job-status-relay.service.ts#L64)、[monitoring.gateway](../../apps/api/src/modules/websocket/monitoring.gateway.ts#L55)）**從未被觸發**——這不是容器化才出現的問題，是既有缺口，只是 host 直跑時沒人送 SIGTERM 所以沒人發現。`enableShutdownHooks()` 本身即會攔訊號並呼叫 `app.close()`，理論上單獨使用就夠；仍加顯式 handler 的理由是**讓退出碼成為明確的、可讀的決策**——FR-003 的 `on-failure:5` 完全靠退出碼區分「崩潰」與「優雅關閉」，把 exit(0) 寫在眼前遠比依賴框架的隱含行為安全。
- **Alternatives considered**: 只加 `enableShutdownHooks()`——少兩行，但退出碼交給框架隱含決定，與 007 worker 的顯式形狀不一致，且監督語意的正確性難以在 review 時一眼確認，捨棄；在容器層以 `init: true` 的 tini 轉發訊號但不改 code——tini 只負責轉發，行程本身仍不處理 SIGTERM，收到即死，問題原封不動，捨棄。
- **範圍紀律（FR-014）**: 本項僅觸碰**關閉路徑**。`app.close()` 觸發的是既有的四個 `onModuleDestroy`——它們的內容一行都不改，本 feature 只是讓它們**第一次真的被執行**。ADR-002 §6.4 已接受的有損寫入語意（in-flight 遙測可丟失）維持不變，MUST NOT 藉此改為不可丟失。
- **已知副作用（記錄而非缺陷）**: 開發模式（`nest start --watch`）下 Ctrl-C 現在也會走優雅關閉。這是修好既有缺口的自然結果，對 dev 迴圈無可觀察影響（SC-004 關注的是服務清單與步驟數，兩者不變）。

## D6：api 健康探針——`/ws` 握手（映像第二進入點）

- **Decision**: 新增 `apps/api/src/healthcheck.ts`（→ `dist/healthcheck.js`）：以 `ws` 連 `ws://127.0.0.1:${API_PORT}/ws`，收到 `system/connected` 即 exit 0，逾時／錯誤 exit 1。compose healthcheck `test: ["CMD", "node", "dist/healthcheck.js"]`，參數沿用 007 的 `interval: 30s`／`timeout: 5s`／`retries: 3`／`start_period: 30s`。
- **Rationale**: 已查證 [monitoring.gateway.ts:66-72](../../apps/api/src/modules/websocket/monitoring.gateway.ts#L66-L72)——`handleConnection` 在連線當下**無條件**送出 `system/connected`，不需 token、不受 `WS_AUTH_SECRET` 影響（授權只在 `machine/subscribe` 時檢查）。故握手成功精確證明「HTTP server 在聽 **且** Gateway 已 `attach`」，正是 FR-011 要的能力證明；探 HTTP 埠只能證明前者（api 無任何 GET 路由，探測必得 404，等於把 404 當健康）。`ws` 已是 api 的 production 相依，探針零新增依賴——與 007 worker 的 heartbeat 探針同形狀。
- **Alternatives considered**: `GET /healthz`——ADR-002 §5.3 已將其劃歸 Feature 009，於 008 提前實作會推翻既定範圍並產生註定被重寫的半成品（spec FR-011 明文拒絕），捨棄；TCP 埠探測（`nc -z`）——同「把 404 當健康」的問題，捨棄。
- **已知限制（spec 明文接受）**: 不涵蓋 Mongo／Redis 連通性——api 可能握手成功但資料層斷線而仍顯示健康。屬 Feature 009 的觀測基線範圍。

## D7：seed 一次性服務——復用 api 映像的第三進入點

- **Decision**: 新增 `seed` service：與 api 同 `build:`／同 `image:` 名稱（`flow-gatekeeper-api:local`），`command: ["node", "dist/scripts/seed.js"]`、`restart: "no"`、`profiles: ["demo"]`、`depends_on: [mongo]`、`env_file: apps/api/.env` + `MONGO_URL` 覆蓋。api 則 `depends_on: seed: { condition: service_completed_successfully }`。
- **Rationale**: 已查證 [apps/api/src/scripts/seed.ts](../../apps/api/src/scripts/seed.ts) 為 `deleteMany` → `insertMany` → `client.close()` 的破壞性重置，結果決定性、重複執行不堆積（正是 FR-012 要的語意，無需改寫），且會隨既有 build 產出 `dist/scripts/seed.js`。現行以 `tsx` 執行（devDependency），容器內 `--prod` 裁剪後無 `tsx`，故**必須**改以 `node dist/scripts/seed.js` 執行——這是容器情境下的執行方式差異，不是語意變更。`mongodb` 已是 api 的 production 相依。
- **同映像共用的接法**: api 與 seed 兩個 service 宣告相同的 `build:` 與相同的 `image:` 名稱，compose 因 layer cache 第二次建置為即時完成，且保證兩者跑的是同一份產物。若 seed 只寫 `image:` 而不寫 `build:`，compose 會嘗試 pull 一個不存在的遠端映像而失敗。
- **崩潰重啟不重置資料（FR-012／US2 場景 5）**: `depends_on` 只在**啟動編排**時求值，容器因 `restart: on-failure` 重啟**不會**重新觸發相依服務。故 api 崩潰重啟時 seed 不會重跑，示範資料維持原狀——這正是 Clarifications 排除「把 seed 綁進 api 啟動路徑」的理由，機制上自然成立。
- **重複啟動不堆積（US2 場景 4）**: 重跑 `up` 會讓已 exited 的 seed 再跑一次，而其 `deleteMany` → `insertMany` 語意使結果冪等。
- **失敗處置（Edge case「示範資料備妥失敗」）**: seed 非零退出 → `service_completed_successfully` 不成立 → api 不啟動 → 展示者看到的是 compose 的明確錯誤，而非「畫面在跑但診斷沒有佐證資料」的半殘狀態。
- **`dotenv/config` 在容器內的行為**: seed.ts 首行 `import "dotenv/config"` 會找 cwd 的 `.env`；容器內無該檔（`.dockerignore` 擋著），dotenv 找不到檔案時靜默略過、`process.env` 照常由 compose 注入，故無需改 code。

## D8：模式分組——`supervised` 退場、單一 `demo` 分組涵蓋三端

- **Decision**: `docker-compose.yml` 的 worker service `profiles: ["supervised"]` → `["demo"]`；新增的 web／api／seed 同掛 `["demo"]`。redis／mongo 不掛 profile（兩模式共用）。開發模式維持 `docker compose up -d`（只起 infra，行為零變化）；全棧為 `docker compose --profile demo up -d --build`。
- **Rationale**: clarify 已定案，理由不重述。機制上，未帶 `--profile` 的既有指令語意完全不變，SC-004（開發模式零回歸）由 compose profiles 的機制本身保證，不靠紀律。
- **回補範圍（FR-016）**: `supervised` 字面的**全部出處**（analyze 階段全域搜尋，`specs/007-*` 的已結案工件除外）為四處：[README.md](../../README.md)（第 431／432／448 行）、[apps/worker/Dockerfile:4](../../apps/worker/Dockerfile#L4)（檔頭註解）、[docker-compose.yml](../../docker-compose.yml)（第 18 行註解 + 第 20 行 profile 宣告）、[.claude/settings.json](../../.claude/settings.json)（**17 條**允許清單）。回補時 MUST NOT 重寫歷史——007 的決策背景保留原敘述，僅更新現況描述（必要時標註「已更名為 `demo`，現況見 §14」）。
  > **修訂註（analyze 修正）**: 本段起草時寫「出現在 README 與**指南 §13**」，經全域搜尋確認**指南全檔 0 處** `supervised`——§13 通篇是 007 的決策背景與待決問題（第 2793 行仍寫「compose profile？獨立 script？」），分組名是 007 實作期才定的，從未寫回 §13，故無標的可更名（spec FR-016 的列舉已同步校正）。指南的實際回補處是 **§14**（現況已落地，且第 2904 行殘留 `--profile full` 這個從未存在的分組名）與 **§16**（啟動說明雙軌化，FR-015；該章開頭自陳「Feature 008 完成後，本章會補上『一鍵 demo』路徑」，且 §16.2 劇本第 1 步仍寫 `http://localhost:5173`）。
- **單獨起某一端**: 以指名服務達成（`docker compose --profile demo up -d worker`），分組不影響指名，故無 granularity 損失。

## D9：停止、重設與既有 script 的定位

- **Decision**: 停止＝`docker compose --profile demo down`（各服務依自身 `stop_grace_period` 收尾）；連同資料清除的重設＝`docker compose --profile demo down -v`（移除 `redis-data`／`mongo-data` volume）後重跑啟動指令。既有 [scripts/demo-reset.ps1](../../scripts/demo-reset.ps1) **不改、不退場**。
- **Rationale**: FR-013 的「乾淨收場」與「連同資料清除的重設」皆為 compose 內建能力，無需新增 script（ADR-002 不造輪子）。`down -v` 清掉 volume 後重起會重跑 seed（D7），使系統回到初始狀態、劇本可重跑（SC-005）。
- **`demo-reset.ps1` 為何不動**: 它的職責是**只清 AI 快取與去重鎖**（`ai-cache:*`／`ai-lock:*`），不碰 Mongo、不碰佇列——用途是「讓下一次診斷真的走 LLM、看得到 token 串流」，與 `down -v` 的「全清重來」是**不同粒度的兩件事**，demo 前想重看串流但保留遙測歷史時仍需要它。它透過 `docker compose exec -T redis` 運作，兩種模式下 redis 服務名皆為 `redis`，故在 demo 模式下同樣可用，無需修改。
- **`dev-up.ps1` 為何不動（FR-007／FR-015）**: 它是開發模式的入口，本 feature 不觸碰。唯一需注意的是它的尾註仍指向 `5173`／`3000`——那是開發模式的正確位址，與 demo 入口 8080 不衝突，不需改。

## D10：重啟上限耗盡後的可辨識性

- **Decision**: 不新增任何機制。`restart: on-failure:5` 耗盡後容器停在 `exited`，以 `docker compose ps`（狀態欄）與 `docker inspect`（`RestartCount`／`State.Status`）判讀——與 007 worker 的處置完全一致（[007 research D4](../007-worker-process-supervision/research.md)）。
- **Rationale**: 這是 clarify 階段被我列為候選、最終未問的一題，在此明文記錄以免它無聲消失。展示者實際看到的是「web 入口正常載入、但即時通道永遠連不上」——與 FR-008 併分組所要避免的無聲失敗**形狀相同**，故值得寫下處置而非略過。之所以不加機制：(1) 該狀態容器層即可辨識，不像「行程活著但卡住」那種需要 heartbeat 才看得見的盲點；(2) 加任何「上限耗盡後通知」都是新的觀測能力，屬 Feature 009 範圍；(3) api 連續崩潰 5 次代表的是真實故障，demo 當下的正解是看 log，而非多一層告警。
- **文件義務**: quickstart 的 **場景 1e** MUST 附上判讀指令（`docker compose ps` / `docker compose logs api`），使展示者知道去哪看。（原文寫「US1 場景 3」——那是 spec 的 acceptance scenario 編號，對應的是 quickstart 場景 **1c**（崩潰自動重啟）；判讀指令實際落在 **1e**，兩套編號不可混用。）

## D11：FR-017 的實測與條件性映射補齊

- **Decision**: 驗收 MUST 實測「`GEMINI_API_KEY` 留空」的完整路徑並記錄畫面實際文案。若落入通用文案（「診斷失敗，請重試。」），MUST 於 [copilot-reducer.ts:76](../../apps/web/src/domains/ai-copilot/lib/copilot-reducer.ts#L76) 的金鑰條目補上實測到的錯誤字串，並補一則對應的單元測試。
- **Rationale**: 已查證告警機制**已存在**——worker 的 [`failed` handler](../../apps/worker/src/main.ts#L230) 把供應商原始訊息放進 `ai/error.message`，web 的 `humanizeError` 有金鑰專屬條目回「AI 服務金鑰無效或未授權」。但該條目比對的是 `api key not valid`／`api_key_invalid`／`unauthorized`／`permission`，而**空**金鑰與**無效**金鑰的供應商回應未必相同（空金鑰有可能回 `Method doesn't allow unregistered callers...`，該句不含上列任一字串，且長度 > 120 會被 [第 86 行](../../apps/web/src/domains/ai-copilot/lib/copilot-reducer.ts#L86)的後備邏輯轉為通用文案）。故 MUST NOT 以無效金鑰的結果推斷空金鑰的行為——必須真的留空跑一次。
- **為何不算 FR-014 例外**: 補映射是讓**本應命中既有條目**的同類錯誤命中它，不改變錯誤的觸發時機、重試次數或事件流，屬 004 既有覆蓋缺口的缺陷修復（spec FR-014「不構成例外者」已明文界定）。
- **文案（無條件執行，非 SHOULD）**: 現行「AI 服務金鑰無效或未授權，**請聯繫管理員**。」預設使用者另有管理員可找，但 demo 的評估者自己就是管理員——FR-017 對此有明文 **MUST NOT**（「MUST NOT 假設使用者另有管理員可聯繫」），故文案改寫是**無條件義務**（tasks T016a），**不依賴 T015 的實測結果**；只有「指名應填的設定項與其所在範本」這個更好的形式是 SHOULD。改寫會牽動 [copilot-reducer.test.ts:146](../../apps/web/src/domains/ai-copilot/lib/copilot-reducer.test.ts#L146) 的既有斷言——該斷言驗的是**呈現層文案**，更新它不觸及 FR-014（文案不是執行語意）；真正 MUST NOT 動的是比對條件、觸發時機、重試次數與事件流。
  > **修訂註（analyze 修正）**: 本項起草時列為 SHOULD，與 FR-017 的 MUST NOT 字面衝突，且使其在「T015 命中金鑰條目」的分支下無任務涵蓋（analyze 發現 C1）。現改為無條件義務並拆為 T016a／T016b。

## D13：崩潰自癒的驗證與 demo 指令——用 in-process kill，非 `docker kill`（implement 期實測）

- **Decision**: SC-003／US1 場景 3 的「崩潰自動重啟」驗證與 demo，MUST 以**殺容器內的行程**觸發——
  `docker exec flow-gatekeeper-api-1 pkill -KILL -f "dist/main.js"`（映像內 busybox 附 `pkill`，已實測存在）。
  **MUST NOT 用 `docker kill --signal=SIGKILL <容器>`**——該指令在本平台不會觸發任何 restart policy。
  quickstart 場景 1c／2f 與指南 §16 demo 劇本一律改用 in-process kill；api 的 code、compose 監督參數
  **完全不動**（機制本身正確，改的只有「怎麼觸發崩潰來驗證/展示」）。
- **Rationale（implement 期實測，Docker Desktop 29.0.1）**:
  - 殺容器內 `node dist/main.js` 子行程（PID 7，tini 為 PID 1）→ events `die`→`start`→`health_status: healthy`，
    `RestartCount=1`、狀態回 `running`——**崩潰自癒成立**（FR-003／SC-003 在機制層通過）。
  - `docker kill --signal=SIGKILL <容器>` → `exited(137)`、`RestartCount=0`、**不重啟**。且以拋棄式容器實測
    `restart: always`／`unless-stopped`／`on-failure` **三者皆不重啟**——證實這不是策略選型問題，而是 Docker 的
    平台語意：**經 daemon 對容器下的 stop／kill 會設「手動停止」旗標，抑制所有 restart policy，直到手動 start
    或 daemon 重啟**（避免啟動即失敗的容器陷入重啟迴圈）。只有「行程自身非零退出」才被視為 failure。
  - 這與 007 一致——007 驗證 worker 自癒用的是 `WORKER_CHAOS` 讓行程 `exit(1)`，從未用 `docker kill` 對 PID1。
- **為何忠實**: FR-003 原文是「因非預期錯誤以**非零碼結束**」、SC-003 是「行程被強制終結後自動恢復」。in-process
  kill 精確命中此語意——它就是一次真實崩潰；`docker kill` 是「手動停止」，是 spec 未要求展示的另一回事。以
  `docker kill` 驗收會得到**假失敗**（機制正確卻顯示沒過），且展示者在 demo 當下若直覺地 `docker kill`，Gateway
  不會回來，直接傷及 SC-003 的展示價值。
- **PID1 訊號的旁註**: 從容器**內部**對 PID1（tini）送 SIGKILL 會被核心忽略（namespace-init 保護，與 worker
  compose 註解「同 namespace 對 PID 1 送訊號會被核心忽略」同源），故驗證 MUST 殺**子行程**（`pkill -f "dist/main.js"`
  精準命中 node，不誤傷 tini）。
- **回補範圍**: 本檔（D13）；quickstart 場景 1c／2f（換指令 + 註明 `docker kill` 是手動停止不重啟）；指南 §16 demo
  劇本由 **T021**（Phase 7）一併改用 in-process kill。api code／compose 不動。

## D12：設定與祕密的注入——維持各 app 一份 `.env`，compose `env_file` 注入

- **Decision**: 三端一致地以 compose `env_file` 注入（web 無祕密、不需 `.env`），容器內定址由 `environment` 覆蓋（`REDIS_HOST: redis`、`MONGO_URL: mongodb://mongo:27017/flow-gatekeeper`）——與現行 worker service 完全同形。MUST NOT 引入根目錄 `.env`。
- **Rationale**: Clarifications 已排除根目錄 `.env`（compose 插值不讀 `env_file`，強行採用須搬動祕密佈局並使根目錄 [.env.example](../../.env.example) 的既有敘述失效、產生兩層語意不同的 `.env`）。維持現狀則 [.env.example](../../.env.example) 的「執行期不會讀取根目錄的 `.env`」這句仍然成立，無需回補。
- **前置需求（FR-005／SC-001）**: 展示者需複製並填寫兩份範本——`apps/api/.env`（可全用預設值）與 `apps/worker/.env`（填 `GEMINI_API_KEY`）。這符合 FR-005「依範本填妥的祕密」的前置定義，README MUST 明列這兩步。
- **`env_file` 檔案不存在時**: compose 直接以明確錯誤中止（指名缺哪個檔），故「忘了複製範本」這個情境**本就是可辨識的失敗**——FR-017 涵蓋的是「檔案在、但變數留空」那個更隱蔽的情境。
