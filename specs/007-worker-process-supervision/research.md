# Research: Worker Process Supervision（Phase 0）

前提：監督者選型（容器化 vs pm2/systemd）已由 [ADR-002](../../docs/adr-002-productionization-scope.md) §4 定案，非本檔議題。本檔只收斂 spec/clarify 之下的實作層決策；所有 Technical Context 項目皆已解析，無殘留 NEEDS CLARIFICATION。

## D1：容器基底映像——`node:22-alpine`

- **Decision**: builder 與 runtime 皆用 `node:22-alpine`，以 `corepack enable` 取得 lockfile 對應的 pnpm 9。
- **Rationale**: host dev 實測為 Node v22.21.1（LTS），容器與 host 同大版消除「受監督模式 vs 直跑模式」的執行環境變因——SC-001 要求兩模式行為一致，版本差異是最無謂的干擾源；alpine 縮小映像。
- **Alternatives considered**: `node:24-alpine`（指南 §13.6 Q6 草案）——同為 LTS 但與 host 不一致，兩模式一致性驗收會多一個解釋變因，捨棄；Debian slim——體積較大、無 alpine 相容性疑慮的依賴（純 JS + 原生模組皆有 musl 預編譯），無必要。

## D2：pnpm workspace 依賴裁剪與 runtime 形態

- **Decision**: 多階段建置——builder 階段以 repo root 為 context：複製 `pnpm-lock.yaml`／`pnpm-workspace.yaml`／各 `package.json` → `pnpm install --frozen-lockfile` → 複製源碼 → 依序 build `contracts`、`shared`、`worker` → `pnpm deploy --filter worker --prod <out>` 產出含 production 依賴與 workspace dist 的獨立目錄；runtime 階段只 COPY 該目錄，入口 `node dist/main.js`。
- **Rationale**: `packages/contracts` 與 `packages/shared` 的 `main`/`exports` 皆指向 `dist/index.js`（已驗證），build 後即可被 node 原生解析，不需 bundler；`pnpm deploy` 是官方 workspace 裁剪路徑，把 workspace 依賴實體化進輸出目錄，runtime 不需 pnpm；容器內跑建置產物而非 `tsx`（dev 工具不進 prod image，指南 §13.6 Q6 方向）。
- **Alternatives considered**: 容器內直接 `tsx src/main.ts`——免 build 但把 dev runner 與 devDependencies 帶進 runtime，映像大且與「生產形態」定位矛盾，捨棄；esbuild/tsup 單檔 bundle——最小映像，但引入新工具鏈且遮蔽 workspace 多階段建置這個本 feature 想展示的工程點，捨棄。

## D3：雙模式切換——compose profiles（clarify 定案）

- **Decision**: worker service 掛 `profiles: ["supervised"]`。開發模式照舊 `docker compose up -d`（只起 redis/mongo，行為零變化）＋ `scripts/dev-up.ps1`；受監督模式 `docker compose --profile supervised up -d --build`。
- **Rationale**: 單一 compose 檔＝單一真實來源（憲章 II 精神）；未帶 profile 的既有指令語意完全不變，SC-008（開發體驗零差異）由機制本身保證，不靠紀律。
- **Alternatives considered**: 獨立 `docker-compose.worker.yml` 以 `-f` 疊加——指令冗長、兩檔同步維護；pnpm script 包裝——只是糖衣，底層仍要先定機制。皆捨棄（clarify Q4）。

## D4：重啟策略——`restart: on-failure:5`，退避交 Docker 內建（clarify 定案）

- **Decision**: `restart: on-failure:5`。退避不自行實作：Docker 內建指數退避（100ms 起、逐次翻倍、封頂；容器成功運行約 10s 後計數重置）。
- **Rationale**: `on-failure` 只在**非零退出**時重啟——與 D7 的 exit code 語意閉合（優雅關閉 `exit(0)` 不觸發重啟）；上限 5 次（clarify Q2）足以觀察退避遞增又不拖長演練；達上限後容器停在 `exited` 狀態，`docker inspect` 的 `RestartCount`／`State.Status` 與 `docker ps -a` 可判讀（FR-006、SC-004）。
- **Alternatives considered**: `unless-stopped`（無上限）——崩潰迴圈不會停下，與 US4「達上限停止」直接衝突，捨棄；自寫 wrapper script 實作退避——ADR-002 明言不造輪子，捨棄。
- **已知邊界（記錄而非風險）**: compose/Docker **不會**因 unhealthy 自動重啟容器——與 spec「健康判定僅示警」定位一致，屬特性而非缺口。

## D5：健康探針——Redis heartbeat key ＋ compose healthcheck（clarify 定案）

- **Decision**: worker 以既有 `cache` 連線每 **10s** 執行 `SET worker:heartbeat <ISO ts> EX 30`（TTL **30s**）；`healthcheck.ts` 建獨立短命 Redis 連線檢查 key 存在（`PTTL > 0`）→ exit 0/1；compose healthcheck `interval: 30s`／`timeout: 5s`／`retries: 3`／`start_period: 30s`。不健康最遲約 90s 反映（< SC-005 的 2min 上限）。
- **Rationale**: heartbeat 由 `setInterval` 驅動——事件迴圈被卡死（活鎖）時 timer 不觸發、key 過期、healthcheck 連續失敗轉 unhealthy，正好補「行程活著但不做事」盲點；3 次失敗容忍（≈3 個心跳週期的延遲）避免把繁忙高峰誤判為卡死（Edge case「存活訊號的誤判」）；TTL（30s）為心跳週期 3 倍，單次寫入延遲不會閃斷。
- **Alternatives considered**: healthcheck 直接檢查行程存在——偵測不到活鎖，等於沒做；HTTP 健康端點——worker 無 HTTP surface，為探針開埠屬 009（api healthz）範疇的過度設計；BullMQ metrics 判定「在做事」——把「閒置無 job」誤判為不健康，語意錯誤。
- **單實例假設**: key 不帶實例後綴——本 feature 明確單 worker 實例（Technical Context / ADR-002 §6），多實例命名留給日後 feature。
- **活鎖模擬（US5 驗收）**: 凍結 node 行程（heartbeat 停寫、容器仍 running、healthcheck exec 照常執行）→ 觀察轉 unhealthy；`kill -CONT` 恢復。不需要為模擬新增第三種 chaos 型態。注意 **不可對 PID 1 送 SIGSTOP**——`docker exec` 在容器同一 PID namespace 內執行，而同 namespace 對 PID 1 送 SIGSTOP/SIGKILL 會被核心忽略（`pid_namespaces(7)`；僅祖先 namespace 送出才生效）。因此 worker service 設 `init: true`（tini 為 PID 1、node 為子行程；tini 照常轉發 SIGTERM、以子行程退出碼結束，優雅關閉與 on-failure 語意不受影響），模擬指令為 `docker exec <worker> sh -c 'kill -STOP $(pgrep -f dist/main.js)'`。

## D6：故障注入旗標——`WORKER_CHAOS` × `WORKER_CHAOS_AT`（clarify 定案）

- **Decision**: 兩個 env 變數：
  - `WORKER_CHAOS`：`uncaught`（丟未捕捉例外）｜`rejection`（丟未處理拒絕）｜未設定＝關閉。
  - `WORKER_CHAOS_AT`：`startup`（bootstrap 完成後約 2s 拋，供 US4 崩潰迴圈）｜`job`（下一筆 job 進入 active 時拋，供 US2 進行中工作重派）；預設 `startup`。
  - 非法值：記 warn 後**視為關閉**（零影響原則優先於 fail-fast——演練工具壞了不該把正常啟動變成致命）。
- **Rationale**: 時點語意齊 clarify Q1；`job` 時點掛在 BullMQ worker `active` 事件、以 `setImmediate` 拋出——**脫離 processor 的 try/catch 與 BullMQ 的 job 級錯誤處理**，成為真正的 process 級致命錯誤（否則只會走 `ai/error` 重試路徑，演練不到 US2）；`rejection` 型態以浮空 `Promise.reject` 觸發真實 `unhandledRejection` 路徑。
- **Alternatives considered**: 單一變數編碼 `uncaught@job` 式複合值——省一個變數但解析與文件都變醜；CLI 參數——容器/compose 情境下 env 才是標準注入面，且 spec 要求「環境設定」。

## D7：致命退出與優雅關閉的界線（clarify 定案）

- **Decision**:
  - `fatal(kind, value)`：以 `formatFatal`（純函式）組訊息——`<kind>（致命，worker 將結束交由監督者重啟）：<detail>`（Error 取 `stack ?? message`、非 Error 值 `String()`）→ `log("error", ...)` → **立即 `process.exit(1)`**，不嘗試關閉任何連線。
  - 優雅關閉路徑零改動：SIGTERM/SIGINT → `worker.close()` → `mongoClient.close()` → redis `quit()` → `exit(0)`（僅加入 heartbeat timer 的清除）。
  - 兩路徑以 **exit code 為唯一交會點**：`0`＝正常停止、監督者不重啟；`1`＝致命、監督者重啟。優雅關閉進行中若發生致命，`process.exit(1)` 立即生效、直接搶先結束（Edge case「停止指令與致命事件重疊」）——不存在互相等待。
  - `stop_grace_period: 45s`：`docker stop` 的 SIGTERM → SIGKILL 寬限需涵蓋 `worker.close()` 最長收尾（等待 in-flight job 完成，上限 ≈ `AI_TIMEOUT_MS` 30s）+ Mongo/Redis 關閉緩衝（Edge case「寬限期不足」、SC-007）。
- **Rationale**: 致命後行程狀態未定義，任何「盡力收尾」都可能卡住或二次拋錯（clarify Q5 定案「立即結束」）；殘留的 Redis/Mongo/BullMQ 連線由 TCP 斷線與 BullMQ lock 過期自然回收（`ai-lock:<sig>` 去重鎖本就帶 TTL、過期自然釋放；BullMQ job lock ≤30s 過期後由 stalled 掃描重派，見 D9），不會使外部服務不可用（Edge case「崩潰瞬間的外部連線」）。
- **Alternatives considered**: 退出前短逾時盡力收尾——界線模糊、可能卡住，捨棄；致命也走完整 graceful——與 let-it-crash 相悖，捨棄。

## D8：開發模式零改動與已知差異

- **Decision**: `tsx watch`／`scripts/dev-up.ps1`／`.env` 載入方式全部不動。dev 模式下致命錯誤 → 行程 `exit(1)` → `tsx watch` 停在「等待檔案變更」，**不自動重啟**——此為已知、已文件化差異（README 雙模式章節 + US2 場景 5）。
- **Rationale**: 熱重載價值 > 監督價值、人在場看 log 即可（ADR-002 §4.4）；注意翻轉後 dev 模式的致命行為也從「續跑」變「結束」——這是 spec 的刻意決定（行為一致性），不是回歸。
- **Alternatives considered**: dev 也跑容器——熱重載體驗劣化，ADR-002 已拒絕。

## D9：in-flight job 重派——沿用 BullMQ 既有機制並驗證

- **Decision**: 不調整任何 job 級參數（`attempts: 3`＋exponential backoff 5s 由 api enqueue 設定；worker `lockDuration`／`stalledInterval`／`maxStalledCount` 維持 BullMQ 預設 30s／30s／1）。本 feature 只**驗證**：worker 崩潰 → job lock 過期（≤30s）→ 重啟後 worker 的 stalled 檢查（≤30s 週期）把 job 移回佇列 → 重新消化。
- **Rationale**: spec 明定「沿用既有工作級語意、不新增去重」（Edge case「重複消化的邊界」；至少一次語意由 cache/簽章去重承接）；`maxStalledCount: 1` 意味同一 job 第二次 stall 會轉 failed → 走既有 `ai/error` 最終語意——符合 FR-005「重新消化**或走既有錯誤語意**」。
- **時間預算（與 SC 對齊）**: 「恢復消化」（SC-002 ≤60s）指重啟後的 worker 立即可接**新** job——Docker 首次重啟延遲僅百 ms 級＋worker bootstrap 數秒，遠低於 60s；崩潰當下 in-flight 那筆的**重派**最壞另需 lock 過期＋stalled 掃描 ≈ 60s，屬 SC-003「最終被消化」範疇，兩者在 quickstart 分開量測。
